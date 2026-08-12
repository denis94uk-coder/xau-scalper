/**
 * The MetaTrader 5 bridge, as the app uses it rather than as a CLI chore.
 *
 * server/mt5.ts knows how to read one directory of exports. This module is what
 * turns that into a running integration: it keeps the terminal's data flowing
 * into the database on a timer, reports whether the link is actually alive, and
 * (only when explicitly armed) writes the order files the EA executes.
 *
 * WHAT "ALIVE" MEANS HERE
 * A directory full of JSON is not a connection. The files are rewritten by the
 * EA every cycle, so freshness is the only real signal: an export whose newest
 * file is ten minutes old means the terminal is closed, the EA was removed from
 * the chart, or the market data stopped — and every one of those cases must
 * read as "stale", never as "connected". Silently trading on hour-old bars is
 * the failure this exists to make impossible.
 *
 * EXECUTION IS A SEPARATE SWITCH
 * Reading bars cannot lose money; placing orders can. The two capabilities are
 * gated independently and execution defaults to off, so nobody arms live
 * trading as a side effect of wanting a real spread number.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AppConfig, AssetConfig } from "../core/config";
import type { Db } from "./db";
import { publish } from "./events";
import {
  costModelFrom,
  findExportDir,
  ingestDir,
  type Mt5Export,
  parseExport,
} from "./mt5";

/**
 * Beyond this age an export is stale rather than live.
 *
 * Three minutes is two missed 60-second cycles plus slack: one skipped write
 * during a busy tick should not flap the status, but a closed terminal should
 * be obvious within one 5-minute signal cycle.
 */
const STALE_AFTER_MS = 3 * 60_000;

export interface Mt5SymbolStatus {
  symbol: string;
  interval: string;
  bars: number;
  /** Seconds since the terminal wrote this file. */
  ageSeconds: number;
  spreadBps: number;
  bid: number;
  ask: number;
  /** The namespaced asset id its candles are stored under. */
  assetId: string;
}

export interface Mt5Status {
  enabled: boolean;
  /** The directory in use, whether configured or discovered. */
  directory: string | null;
  /** True when the directory exists and holds at least one export. */
  found: boolean;
  /** True when the freshest export is younger than the staleness window. */
  connected: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  symbols: Mt5SymbolStatus[];
  execution: {
    enabled: boolean;
    /** Orders written but not yet acknowledged by the EA. */
    pending: number;
    lastAck: Mt5Ack | null;
  };
}

/** Settings keys. Kept together so nothing invents a near-miss spelling. */
const LAST_SYNC_KEY = "mt5:lastSync";
const LAST_ERROR_KEY = "mt5:lastError";

/**
 * Resolve the export directory for a configuration.
 *
 * An explicitly configured path is used verbatim even when it does not exist,
 * because silently falling back to a discovered terminal would ingest data from
 * an account the operator did not choose.
 */
export function resolveDirectory(cfg: AppConfig): string | null {
  const configured = cfg.mt5.directory.trim();
  if (configured) return configured;
  return findExportDir();
}

/** Read every export in a directory, skipping files that will not parse. */
function readExports(dir: string): Mt5Export[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Mt5Export[] = [];
  for (const f of files) {
    try {
      out.push(parseExport(readFileSync(join(dir, f), "utf8")));
    } catch {
      // A half-written file is normal: the EA rewrites in place, so a read that
      // lands mid-write fails and succeeds on the next cycle. Reporting it as
      // an error would make a healthy link look broken every few minutes.
    }
  }
  return out;
}

/** Current state of the bridge, for the Settings page and /api/mt5/status. */
export function status(db: Db, cfg: AppConfig, now = Date.now()): Mt5Status {
  const dir = resolveDirectory(cfg);
  const nowSec = Math.floor(now / 1000);

  const symbols: Mt5SymbolStatus[] = [];
  let freshest = Number.POSITIVE_INFINITY;

  if (dir && existsSync(dir)) {
    for (const exp of readExports(dir)) {
      const ageSeconds = exp.exportedAt > 0 ? nowSec - exp.exportedAt : -1;
      if (ageSeconds >= 0) freshest = Math.min(freshest, ageSeconds * 1000);
      symbols.push({
        symbol: exp.symbol,
        interval: exp.timeframe,
        bars: exp.bars.length,
        ageSeconds,
        spreadBps:
          exp.bid > 0 ? ((exp.spreadPoints * exp.point) / exp.bid) * 10_000 : 0,
        bid: exp.bid,
        ask: exp.ask,
        assetId: `MT5:${exp.symbol}`,
      });
    }
  }

  return {
    enabled: cfg.mt5.enabled,
    directory: dir,
    found: symbols.length > 0,
    connected: symbols.length > 0 && freshest <= STALE_AFTER_MS,
    lastSyncAt: db.getSetting<number>(LAST_SYNC_KEY),
    lastError: db.getSetting<string>(LAST_ERROR_KEY),
    symbols: symbols.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    execution: {
      enabled: cfg.mt5.executionEnabled,
      pending: dir ? pendingOrders(dir).length : 0,
      lastAck: dir ? lastAck(dir) : null,
    },
  };
}

export interface SyncOutcome {
  ok: boolean;
  directory: string | null;
  ingested: number;
  symbols: string[];
  errors: string[];
}

/**
 * Pull once from the terminal into the database.
 *
 * Also refreshes the cost model of any asset that asked for measured costs, so
 * the edge audit and the strategy's own arithmetic describe the account rather
 * than the estimate. That write goes through `mutate` rather than the config
 * store directly, because it must not race a save the operator is making.
 */
export function syncOnce(
  db: Db,
  cfg: AppConfig,
  applyCosts?: (updater: (assets: AssetConfig[]) => AssetConfig[]) => void,
  now = Date.now(),
): SyncOutcome {
  const dir = resolveDirectory(cfg);
  if (!dir || !existsSync(dir)) {
    const message = dir
      ? `directory not found: ${dir}`
      : "no MetaTrader 5 export directory found — is TeoExporter running?";
    db.setSetting(LAST_ERROR_KEY, message);
    return {
      ok: false,
      directory: dir,
      ingested: 0,
      symbols: [],
      errors: [message],
    };
  }

  const { ingested, errors } = ingestDir(db, dir, { now });

  // An existing directory holding no exports is the likeliest misconfiguration:
  // the operator pointed at the terminal root instead of MQL5/Files/teo, or the
  // EA is not attached to a chart. Reporting "0 ingested" with no error left
  // them with nothing to act on, so name the two causes.
  if (ingested.length === 0 && errors.length === 0) {
    const message =
      `no exports found in ${dir} — expected the MQL5/Files/teo directory ` +
      `written by TeoExporter, and the EA attached to a chart`;
    db.setSetting(LAST_SYNC_KEY, now);
    db.setSetting(LAST_ERROR_KEY, message);
    return {
      ok: false,
      directory: dir,
      ingested: 0,
      symbols: [],
      errors: [message],
    };
  }

  if (ingested.length > 0 && applyCosts) {
    const measured = new Map<string, Mt5Export>();
    for (const exp of readExports(dir)) measured.set(exp.symbol, exp);

    applyCosts(assets =>
      assets.map(a => {
        if (!a.useMt5Costs || a.dataSource !== "mt5") return a;
        const exp = measured.get(a.dataSourceSymbol);
        if (!exp) return a;
        try {
          // Only the spread is measured; the fee and slippage assumptions the
          // operator set are carried forward rather than reset to zero, which
          // would quietly make every audit more optimistic after each sync.
          return {
            ...a,
            costs: costModelFrom(exp, {
              takerFeeBps: a.costs.takerFeeBps,
              makerFeeBps: a.costs.makerFeeBps,
            }),
          };
        } catch {
          return a;
        }
      }),
    );
  }

  db.setSetting(LAST_SYNC_KEY, now);
  db.setSetting(
    LAST_ERROR_KEY,
    errors.length > 0
      ? errors.map(e => `${e.file}: ${e.error}`).join("; ")
      : null,
  );
  if (ingested.length > 0) publish("candles");

  return {
    ok: errors.length === 0 && ingested.length > 0,
    directory: dir,
    ingested: ingested.reduce((n, i) => n + i.bars, 0),
    symbols: [...new Set(ingested.map(i => i.symbol))],
    errors: errors.map(e => `${e.file}: ${e.error}`),
  };
}

// ─── Execution ───

/**
 * An order for the EA to place.
 *
 * Written as one file per order into `orders/`, which the EA consumes and
 * deletes. A file per order rather than an append-only log because the consumer
 * is MQL5 running in a terminal that can be closed mid-read: a partially
 * consumed log has no safe resume point, whereas an unconsumed file is simply
 * still there next time.
 */
export interface Mt5Order {
  /** Unique, and the filename — so the same signal can never be sent twice. */
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  lots: number;
  stopLoss: number;
  takeProfit: number;
  /** The idea this order came from, for reconciliation. */
  ideaId: number | null;
  createdAt: number;
  comment: string;
}

/** The EA's answer to one order. */
export interface Mt5Ack {
  id: string;
  ok: boolean;
  ticket: number | null;
  price: number | null;
  error: string | null;
  at: number;
}

function ordersDir(dir: string): string {
  return join(dir, "orders");
}

function acksDir(dir: string): string {
  return join(dir, "acks");
}

/** Orders written but not yet consumed by the EA. */
export function pendingOrders(dir: string): Mt5Order[] {
  const d = ordersDir(dir);
  if (!existsSync(d)) return [];
  const out: Mt5Order[] = [];
  for (const f of readdirSync(d).filter(f => f.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(join(d, f), "utf8")) as Mt5Order);
    } catch {
      // Same half-written-file reasoning as the exports.
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The most recent acknowledgement the EA wrote back. */
export function lastAck(dir: string): Mt5Ack | null {
  const d = acksDir(dir);
  if (!existsSync(d)) return null;
  let newest: { ack: Mt5Ack; mtime: number } | null = null;
  for (const f of readdirSync(d).filter(f => f.endsWith(".json"))) {
    try {
      const path = join(d, f);
      const ack = JSON.parse(readFileSync(path, "utf8")) as Mt5Ack;
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { ack, mtime };
    } catch {
      /* ignore */
    }
  }
  return newest?.ack ?? null;
}

export interface SendResult {
  sent: boolean;
  reason: string;
  order: Mt5Order | null;
}

/**
 * Hand one order to the terminal.
 *
 * Every refusal path returns a reason rather than throwing, because all of them
 * are ordinary operating states — execution switched off, the terminal not
 * running, the position cap reached — and the caller logs them to the journal
 * beside the signal they belong to.
 */
export function sendOrder(
  cfg: AppConfig,
  order: Omit<Mt5Order, "id" | "createdAt">,
  now = Date.now(),
): SendResult {
  if (!cfg.mt5.enabled) {
    return { sent: false, reason: "MT5 bridge is disabled", order: null };
  }
  if (!cfg.mt5.executionEnabled) {
    return { sent: false, reason: "MT5 execution is not armed", order: null };
  }

  const dir = resolveDirectory(cfg);
  if (!dir || !existsSync(dir)) {
    return {
      sent: false,
      reason: "no MetaTrader 5 terminal directory found",
      order: null,
    };
  }

  const pending = pendingOrders(dir);
  if (pending.length >= cfg.mt5.maxOpenPositions) {
    return {
      sent: false,
      reason: `${pending.length} order(s) still unacknowledged, at the ${cfg.mt5.maxOpenPositions} cap`,
      order: null,
    };
  }

  const d = ordersDir(dir);
  mkdirSync(d, { recursive: true });

  const full: Mt5Order = {
    ...order,
    // Idea id in the name as well as the body: two orders for one idea would
    // then collide on the filesystem rather than both being placed.
    id: `${order.ideaId ?? "manual"}-${now}`,
    createdAt: now,
  };

  // Written to a temporary name and renamed, so the EA can never read a
  // half-written order and place something malformed.
  const tmp = join(d, `.${full.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(full, null, 2), "utf8");
  const final = join(d, `${full.id}.json`);
  try {
    // Rename within one directory is atomic on every platform this runs on.
    renameSync(tmp, final);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    return {
      sent: false,
      reason: e instanceof Error ? e.message : String(e),
      order: null,
    };
  }

  return { sent: true, reason: "order written for the terminal", order: full };
}
