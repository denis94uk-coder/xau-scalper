/**
 * The whole backend, in one process.
 *
 *   bun run start
 *
 * Serves the built UI, the REST API and the SSE stream, and runs the signal
 * engine and position monitor on timers. No database server, no scheduler
 * service, no deploy step, no accounts — the only external thing it touches is
 * the public market-data feed.
 *
 * Binds to 127.0.0.1 by default so nothing is exposed beyond this machine.
 * Set TEO_HOST=0.0.0.0 to reach it from your phone on the LAN, but read the
 * note in api.ts first: there is no authentication.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AppConfig,
  enabledAssets,
  toAssetDefinition,
} from "../core/config";
import { handleApi, handleEvents } from "./api";
import { ConfigStore } from "./config";
import { Db } from "./db";
import { generateSignals, monitorIdeas, recoverGap } from "./engine";
import { publish } from "./events";
import { executeIdea } from "./execution";
import { scanLiquiditySweeps } from "./intel/liquiditySweep";
import { fetchMacroData } from "./intel/macroCorrelation";
import { updateCalendar } from "./intel/newsCalendar";
import { detectMarketRegime } from "./intel/regime";
import { syncOnce } from "./mt5bridge";
import { reconcileState } from "./reconciliation";
import { RiskManager, riskConfigFromEnv } from "./risk-manager";
import { runSelfHeal } from "./selfheal";

const HOST = process.env.TEO_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TEO_PORT ?? 4000);
/**
 * Where the built UI lives.
 *
 * When compiled with `bun build --compile`, import.meta.dir points into the
 * binary's virtual filesystem (/$bunfs/root), which contains no assets — so the
 * UI is resolved next to the executable instead. TEO_DIST overrides both.
 */
const COMPILED = import.meta.dir.startsWith("/$bunfs");
const DIST =
  process.env.TEO_DIST ??
  (COMPILED
    ? join(dirname(process.execPath), "dist")
    : join(import.meta.dir, "..", "dist"));

/**
 * Housekeeping that has no reason to be configurable.
 *
 * Every other cadence now comes from the runtime config, because they are the
 * ones an operator has an opinion about. Journal pruning is not one of them:
 * how often the trim runs is invisible, only how much history it keeps, and
 * that IS configurable.
 */
const PRUNE_MS = 6 * 60 * 60_000;
/**
 * Self-heal cadence. Six hours, not minutes: a sweep re-reads the same market
 * a faster loop would, so running it often produces more chances to be fooled
 * by noise rather than more information. Set TEO_SELFHEAL_MS to change it, or
 * TEO_SELFHEAL=off to disable the loop entirely.
 */
const SELFHEAL_MS = Number(process.env.TEO_SELFHEAL_MS ?? 6 * 60 * 60_000);
const SELFHEAL_ON = process.env.TEO_SELFHEAL !== "off";

const db = new Db();
const config = new ConfigStore(db);
const risk = new RiskManager(db, riskConfigFromEnv());

/**
 * Run a job, never letting a failure kill the timer.
 *
 * An unhandled rejection inside setInterval would take the process down and
 * stop the monitor — the one loop that must not stop.
 */
async function safely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.recordRun(name, false, msg);
    console.error(`[${name}]`, msg);
  }
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

/** Serve the built SPA, falling back to index.html for client-side routes. */
async function serveStatic(pathname: string): Promise<Response> {
  if (!existsSync(DIST)) {
    return new Response(
      "UI not built yet — run `bun run build`, then reload.",
      { status: 503, headers: { "Content-Type": "text/plain" } },
    );
  }

  // Reject traversal before touching the filesystem.
  const clean = pathname.replace(/\.\.+/g, "");
  const candidate = join(DIST, clean === "/" ? "index.html" : clean);

  if (candidate.startsWith(DIST) && existsSync(candidate)) {
    const file = Bun.file(candidate);
    if ((await file.exists()) && !candidate.endsWith("/")) {
      return new Response(file, {
        headers: { "Content-Type": contentType(candidate) },
      });
    }
  }

  const index = Bun.file(join(DIST, "index.html"));
  return new Response(index, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0, // SSE connections are long-lived by design
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/events") return handleEvents();

    const api = await handleApi(db, req, url, config, risk);
    if (api) return api;

    return serveStatic(url.pathname);
  },
  error(e) {
    console.error("[server]", e);
    return new Response("internal error", { status: 500 });
  },
});

console.log(`
  Teo — local trading dashboard
  ─────────────────────────────
  UI + API   http://${HOST}:${PORT}
  Database   ${process.env.TEO_DB_PATH ?? "data/teo.db"}
  UI assets  ${DIST}
  Assets     ${enabledAssets(config.get()).length} enabled
  Settings   http://${HOST}:${PORT}/settings — everything is editable there
  Feed       public market data (no account, no key)
`);

/**
 * Engine dependencies built from the CURRENT configuration.
 *
 * Rebuilt per run rather than captured once: a save that changes the asset list
 * or the risk cap must affect the very next cycle, and a closed-over snapshot
 * would keep the old rules alive until restart — the exact surprise that makes
 * a settings page untrustworthy.
 */
function engineDeps() {
  const cfg = config.get();
  return {
    db,
    assets: enabledAssets(cfg).map(toAssetDefinition),
    limits: { maxRisk: cfg.risk.maxRisk },
    correlationOptions: {
      prior: cfg.risk.assumedCorrelation,
      minSamples: cfg.risk.minCorrelationSamples,
    },
  };
}

// Resolve anything that happened while this machine was off BEFORE starting the
// timers, so the first monitor tick sees an accurate position set.
await safely("recover", async () => {
  const changed = await recoverGap(engineDeps());
  if (changed > 0) console.log(`[recover] resolved ${changed} state change(s)`);
});

// Safety net for positions that candle-replay could not reach (downtime longer
// than the stored candle window). Compares open ideas against the current live
// price; anything definitively past its SL or TP2 is force-closed here.
await safely("reconcile", async () => {
  const ghosts = await reconcileState({ db });
  if (ghosts > 0) console.log(`[reconcile] closed ${ghosts} ghost trade(s)`);
});

/** The four intel engines, run together. One failing must not stop the rest. */
async function runIntel(): Promise<void> {
  await safely("regime", () => detectMarketRegime(db));
  await safely("macro", () => fetchMacroData(db));
  await safely("news", () => updateCalendar(db));
  await safely("sweeps", () => scanLiquiditySweeps(db));
  publish("regime");
}

/**
 * One signal cycle, honouring the master switch.
 *
 * Pausing stops NEW signals only. The monitor keeps running, because positions
 * that are already open still have to reach their exits — a pause that also
 * abandoned them would be a far more dangerous button than it looks.
 */
async function runSignals(): Promise<void> {
  if (!config.get().engine.autoTradingEnabled) return;

  // Ideas open before the run are remembered so that only the ones this run
  // created are placed. Comparing against "everything currently open" would
  // re-send an order for a position that has simply not closed yet.
  const before = new Set(db.openIdeas().map(i => i.id));

  await generateSignals(engineDeps());

  const cfg = config.get();
  if (!cfg.mt5.enabled || !cfg.mt5.executionEnabled) return;

  for (const idea of db.openIdeas()) {
    if (before.has(idea.id)) continue;
    const outcome = executeIdea(db, cfg, idea);
    if (!outcome.placed) {
      console.log(`[mt5] idea ${idea.id} not placed: ${outcome.reason}`);
    }
  }
}

/** Pull from MetaTrader 5, when the bridge is switched on. */
async function runMt5(): Promise<void> {
  const cfg = config.get();
  if (!cfg.mt5.enabled) return;
  syncOnce(db, cfg, updater => {
    const live = config.get();
    config.save({ ...live, assets: updater(live.assets) });
  });
}

// Prime candles and evaluate immediately rather than idling for a full cycle.
await safely("mt5", runMt5);
await safely("signals", runSignals);
await safely("monitor", () => monitorIdeas(engineDeps()));
await runIntel();

// Catch up if the loop is overdue. A bare interval means a machine that
// restarts more often than the cadence never self-heals at all.
if (SELFHEAL_ON) {
  const last = db.lastRun("selfheal");
  if (last === null || Date.now() - last >= SELFHEAL_MS) {
    void safely("selfheal", async () => {
      await runSelfHeal({ db });
    });
  }
}

/**
 * Timers that can be rebuilt when their cadence changes.
 *
 * A setInterval captures its period at creation, so changing "signal every 5
 * minutes" to "every minute" would otherwise do nothing until restart. The
 * config store notifies on save and the affected timers are recreated — which
 * is the whole reason the store has listeners at all.
 */
let timers: ReturnType<typeof setInterval>[] = [];

function scheduleTimers(cfg: AppConfig): void {
  for (const t of timers) clearInterval(t);
  timers = [
    setInterval(
      () => void safely("monitor", () => monitorIdeas(engineDeps())),
      cfg.engine.monitorSeconds * 1000,
    ),
    setInterval(
      () => void safely("signals", runSignals),
      cfg.engine.signalSeconds * 1000,
    ),
    setInterval(() => void runIntel(), cfg.engine.intelSeconds * 1000),
    setInterval(() => void safely("mt5", runMt5), cfg.mt5.syncSeconds * 1000),
    ...(SELFHEAL_ON
      ? [
          setInterval(
            () =>
              void safely("selfheal", async () => {
                await runSelfHeal({ db });
              }),
            SELFHEAL_MS,
          ),
        ]
      : []),
    setInterval(() => {
      const removed = db.pruneJournal(config.get().engine.journalRetentionDays);
      if (removed > 0) {
        console.log(`[prune] removed ${removed} journal row(s)`);
        publish("journal");
      }
    }, PRUNE_MS),
  ];
}

scheduleTimers(config.get());

config.onChange(cfg => {
  scheduleTimers(cfg);
  console.log("[config] settings saved -- timers rescheduled");
});

/** Milliseconds until the next UTC midnight. */
function msUntilMidnight(): number {
  const now = Date.now();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

// Fire once at the next UTC midnight, then every 24 h, to reset the kill switch
// daily loss accounting for the new trading day.
setTimeout(() => {
  risk.dailyReset();
  timers.push(setInterval(() => risk.dailyReset(), 24 * 60 * 60_000));
}, msUntilMidnight());

function shutdown(signal: string) {
  console.log(`\n${signal} — shutting down`);
  for (const t of timers) clearInterval(t);
  server.stop();
  // Checkpoint WAL and release the file cleanly so the next start is fast.
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
