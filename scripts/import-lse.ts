/**
 * Import London Strategic Edge vault candles into the candle database.
 *
 * Usage:
 *   bun run scripts/import-lse.ts                       # whole universe, 1h+15m+30m
 *   bun run scripts/import-lse.ts --asset XAUUSD        # one instrument
 *   bun run scripts/import-lse.ts --intervals 1h        # fewer intervals
 *   bun run scripts/import-lse.ts --start 2010-01-01    # from a date
 *
 * Each instrument's spec (digits, spread assumption) is stored under
 * `lse:<assetId>` so backtests resolve it via `lseAsset()` — the same
 * convention mt5:sync uses for broker instruments.
 *
 * The vault caps responses at 5000 rows and the plan at 200 calls/minute;
 * pages walk forward by timestamp and back off on 429/5xx. 23 years of 15m
 * bars is ~120 calls per instrument, well inside the allowance.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { LSE_UNIVERSE } from "../core/assets";
import type { Candle } from "../core/strategy";
import { db as openDb } from "../server/db";

const VAULT_URL = "https://api.londonstrategicedge.com/vault";
const USER_AGENT = "jcode-xau-scalper research importer";
const PAGE_ROWS = 5000;

/** Interval → earliest date to pull. Deep by default; caps allow it. */
const INTERVALS_DEFAULT = ["1h", "15m", "30m"];

function readApiKey(): string {
  if (process.env.LSE_API_KEY) return process.env.LSE_API_KEY;
  const cfgPath = `${homedir()}/.lse/config.json`;
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const key = cfg.api_key ?? Object.values(cfg)[0];
    if (typeof key === "string" && key) return key;
  }
  console.error(
    "No LSE API key. Run '.venv/bin/lse auth <key>' or set LSE_API_KEY.",
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let asset: string | null = null;
  let intervals = INTERVALS_DEFAULT;
  let start: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--asset" && argv[i + 1]) asset = argv[++i];
    else if (argv[i] === "--intervals" && argv[i + 1])
      intervals = argv[++i].split(",");
    else if (argv[i] === "--start" && argv[i + 1]) start = argv[++i];
  }
  return { asset, intervals, start };
}

interface RawRow {
  ts?: string;
  timestamp?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Bar-open ISO ("2024-03-05T14:30:00Z" or "2024-03-05 14:30:00") → epoch s. */
function toEpoch(iso: string): number {
  const norm = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  return Math.floor(Date.parse(norm.endsWith("Z") ? norm : `${norm}Z`) / 1000);
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function vaultFetch(
  apiKey: string,
  params: Record<string, string>,
): Promise<RawRow[]> {
  const qs = new URLSearchParams(params).toString();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${VAULT_URL}/candles?${qs}`, {
      headers: { "x-api-key": apiKey, "User-Agent": USER_AGENT },
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = attempt * 5000;
      console.warn(`  ${res.status} — retry in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`vault ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as RawRow[];
  }
  throw new Error("vault: retries exhausted");
}

async function importOne(
  apiKey: string,
  database: ReturnType<typeof openDb>,
  inst: (typeof LSE_UNIVERSE)[number],
  interval: string,
  start: string | null,
): Promise<number> {
  const from = start ?? "2003-01-01";
  let cursorDate = from;
  let total = 0;
  let firstTs: string | null = null;

  for (;;) {
    const rows = await vaultFetch(apiKey, {
      symbol: inst.lse,
      timeframe: interval,
      order: "asc",
      limit: String(PAGE_ROWS),
      start: cursorDate,
    });
    if (rows.length === 0) break;

    const candles: Candle[] = rows.map(r => ({
      time: toEpoch(r.ts ?? r.timestamp ?? ""),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume ?? 0,
    }));
    const sane = candles.filter(c => Number.isFinite(c.time) && c.close > 0);
    database.saveCandles(inst.id, interval, sane);
    if (!firstTs) firstTs = rows[0].ts ?? rows[0].timestamp ?? null;
    total += sane.length;

    const lastTs =
      rows[rows.length - 1].ts ?? rows[rows.length - 1].timestamp ?? "";
    const nextDate = lastTs.slice(0, 10);
    if (rows.length < PAGE_ROWS) break;
    // `start` is date-granular; a day of 15m bars is ~96 rows so a full page
    // always spans several days. A stall (full page inside one date) means the
    // assumption broke — advance a day rather than loop forever.
    cursorDate = nextDate > cursorDate ? nextDate : advanceDay(cursorDate);
    await sleep(300); // 200 calls/min cap — stay comfortably under
  }

  console.log(
    `${inst.id.padEnd(8)} ${interval.padEnd(4)} +${String(total).padStart(7)} bars` +
      (firstTs ? ` (from ${firstTs.slice(0, 10)})` : ""),
  );
  return total;
}

function advanceDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const apiKey = readApiKey();
  const { asset, intervals, start } = parseArgs(process.argv.slice(2));
  const universe = asset
    ? LSE_UNIVERSE.filter(i => i.id === asset)
    : LSE_UNIVERSE;
  if (universe.length === 0) {
    console.error(
      `Unknown asset "${asset}". Universe: ${LSE_UNIVERSE.map(i => i.id).join(", ")}`,
    );
    process.exit(1);
  }

  const database = openDb();
  for (const inst of universe) {
    // Spec for lseAsset() — backtests resolve `LSE:<id>` through this.
    database.setSetting(`lse:${inst.id}`, {
      symbol: inst.lse,
      digits: inst.digits,
      assetId: inst.id,
      spreadBps: inst.spreadBps,
    });
    for (const interval of intervals) {
      try {
        await importOne(apiKey, database, inst, interval, start);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`${inst.id} ${interval}: FAILED — ${msg}`);
      }
    }
  }
  database.close();
  console.log("done");
}

main();
