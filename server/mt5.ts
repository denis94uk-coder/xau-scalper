/**
 * MetaTrader 5 data ingestion.
 *
 * Reads the JSON files written by mt5/TeoExporter.mq5 from a running terminal
 * and loads them into the local database.
 *
 * WHY FILES
 * The official MetaTrader5 Python package publishes win_amd64 wheels only, so
 * on macOS the usual "Python talks to the terminal" route does not exist. MT5
 * itself runs there under Wine, and its MQL5/Files directory is an ordinary
 * directory on the host filesystem — reading it needs no Python, no DLL and no
 * socket permissions.
 *
 * WHY IT MATTERS BEYOND CANDLES
 * The cost model has been running on ESTIMATED spreads. Given the edge audit
 * shows this strategy needs a 69-87% win rate to break even at TP1, the spread
 * estimate is not a detail — it is most of the answer. The exporter reports the
 * broker's actual spread, so the audit can finally describe the account you
 * would really trade rather than a plausible one.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CostModel } from "../core/costs";
import type { Candle } from "../core/strategy";
import type { Db } from "./db";

/** One exported symbol/timeframe file. */
export interface Mt5Export {
  symbol: string;
  timeframe: string;
  digits: number;
  point: number;
  spreadPoints: number;
  contractSize: number;
  tickValue: number;
  tickSize: number;
  bid: number;
  ask: number;
  /** Seconds the broker's server clock runs ahead of UTC. */
  gmtOffsetSeconds: number;
  exportedAt: number;
  volumeIsTickCount: boolean;
  /** [serverTime, open, high, low, close, tickVolume] */
  bars: Array<[number, number, number, number, number, number]>;
}

/** MT5 timeframe names → the interval strings the engine uses. */
const TIMEFRAME_TO_INTERVAL: Record<string, string> = {
  M1: "1m",
  M3: "3m",
  M5: "5m",
  M15: "15m",
  M30: "30m",
  H1: "1h",
  H4: "4h",
  D1: "1d",
};

/**
 * Candidate locations of the terminal's MQL5/Files directory.
 *
 * MT5 on macOS runs under a Wine prefix, and MetaQuotes has shipped several
 * bottle layouts over the years. Each terminal installation also gets a hashed
 * directory, so the leaf has to be discovered rather than assumed.
 */
function macOsSearchRoots(): string[] {
  const home = homedir();
  return [
    join(
      home,
      "Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files",
    ),
    join(
      home,
      "Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal",
    ),
    join(
      home,
      "Library/Application Support/MetaTrader 5/Bottles/metatrader5/drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal",
    ),
    // Windows and Wine-on-Linux, for completeness.
    join(home, "AppData/Roaming/MetaQuotes/Terminal"),
    join(
      home,
      ".wine/drive_c/users",
      process.env.USER ?? "user",
      "AppData/Roaming/MetaQuotes/Terminal",
    ),
  ];
}

/**
 * Find the exporter's output directory.
 *
 * TEO_MT5_DIR wins when set. Otherwise each terminal's hashed directory is
 * searched for MQL5/Files/<subdir>, and the most recently modified match is
 * used — running two terminals should resolve to whichever is actually live.
 */
export function findExportDir(subdir = "teo"): string | null {
  const configured = process.env.TEO_MT5_DIR;
  if (configured) return existsSync(configured) ? configured : null;

  const found: Array<{ path: string; mtime: number }> = [];

  for (const root of macOsSearchRoots()) {
    if (!existsSync(root)) continue;

    // Root may itself be an MQL5/Files directory.
    const direct = join(root, subdir);
    if (existsSync(direct)) {
      found.push({ path: direct, mtime: statSync(direct).mtimeMs });
      continue;
    }

    // Otherwise it is a Terminal directory containing hashed installations.
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, "MQL5", "Files", subdir);
      if (existsSync(candidate)) {
        found.push({ path: candidate, mtime: statSync(candidate).mtimeMs });
      }
    }
  }

  if (found.length === 0) return null;
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].path;
}

/** Parse and validate one export file. */
export function parseExport(raw: string): Mt5Export {
  const data = JSON.parse(raw) as Partial<Mt5Export>;

  const required: Array<keyof Mt5Export> = [
    "symbol",
    "timeframe",
    "digits",
    "point",
    "spreadPoints",
    "bars",
  ];
  for (const key of required) {
    if (data[key] === undefined) {
      throw new Error(`export is missing "${key}"`);
    }
  }
  if (!Array.isArray(data.bars)) throw new Error("bars must be an array");

  return {
    symbol: data.symbol as string,
    timeframe: data.timeframe as string,
    digits: data.digits as number,
    point: data.point as number,
    spreadPoints: data.spreadPoints as number,
    contractSize: data.contractSize ?? 0,
    tickValue: data.tickValue ?? 0,
    tickSize: data.tickSize ?? 0,
    bid: data.bid ?? 0,
    ask: data.ask ?? 0,
    gmtOffsetSeconds: data.gmtOffsetSeconds ?? 0,
    exportedAt: data.exportedAt ?? 0,
    volumeIsTickCount: data.volumeIsTickCount ?? true,
    bars: data.bars as Mt5Export["bars"],
  };
}

/**
 * Convert exported bars to the engine's Candle shape, in UTC.
 *
 * Bar timestamps arrive in broker server time — usually UTC+2 or +3, and it
 * shifts with daylight saving. Subtracting the exported offset is what keeps
 * these alignable with any other source; guessing it would misplace every bar
 * by hours.
 */
export function toCandles(exp: Mt5Export): Candle[] {
  return exp.bars
    .filter(b => Array.isArray(b) && b.length >= 6)
    .map(([time, open, high, low, close, volume]) => ({
      time: time - exp.gmtOffsetSeconds,
      open,
      high,
      low,
      close,
      volume,
    }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Build a cost model from the broker's own numbers.
 *
 * Only the spread is measured; fees and stop slippage are not observable from a
 * quote, so they stay as assumptions the caller supplies. That is the honest
 * split — this replaces the guessed part with fact and leaves the rest visibly
 * an estimate rather than dressing it up as measured.
 *
 * Commission-free CFD accounts genuinely have zero explicit fee, which is why
 * the fee defaults are 0 here rather than inherited from the crypto profile.
 */
export function costModelFrom(
  exp: Mt5Export,
  assumptions: {
    takerFeeBps?: number;
    makerFeeBps?: number;
    /** Extra adverse fill on a stop, as a multiple of the spread. */
    stopSlippageSpreads?: number;
  } = {},
): CostModel {
  const price = exp.bid > 0 ? exp.bid : exp.bars.at(-1)?.[4];
  if (!price || price <= 0) {
    throw new Error(`cannot derive costs for ${exp.symbol}: no usable price`);
  }

  const spreadPrice = exp.spreadPoints * exp.point;
  const spreadBps = (spreadPrice / price) * 10_000;

  return {
    halfSpreadBps: spreadBps / 2,
    takerFeeBps: assumptions.takerFeeBps ?? 0,
    makerFeeBps: assumptions.makerFeeBps ?? 0,
    // A stop crosses the spread and then slips further into a fast move. One
    // extra spread's worth is a conservative default, not a measurement.
    stopSlippageBps: spreadBps * (assumptions.stopSlippageSpreads ?? 1),
  };
}

export interface IngestResult {
  file: string;
  symbol: string;
  interval: string;
  bars: number;
  /** Seconds since the terminal wrote the file. */
  ageSeconds: number;
  spreadBps: number;
}

/**
 * Load every export in `dir` into the database.
 *
 * Files that fail to parse are reported and skipped rather than aborting the
 * batch — one malformed symbol should not cost you the rest.
 */
export function ingestDir(
  db: Db,
  dir: string,
  opts: { assetPrefix?: string; now?: number } = {},
): {
  ingested: IngestResult[];
  errors: Array<{ file: string; error: string }>;
} {
  const ingested: IngestResult[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch (e) {
    return {
      ingested,
      errors: [
        { file: dir, error: e instanceof Error ? e.message : String(e) },
      ],
    };
  }

  for (const file of files) {
    try {
      const exp = parseExport(readFileSync(join(dir, file), "utf8"));
      const interval = TIMEFRAME_TO_INTERVAL[exp.timeframe.toUpperCase()];
      if (!interval) {
        throw new Error(`unsupported timeframe "${exp.timeframe}"`);
      }

      const candles = toCandles(exp);
      if (candles.length === 0) throw new Error("no usable bars");

      // Namespaced so broker data never collides with an exchange symbol of the
      // same name — XAUUSD from your broker is not PAXGUSDT from an exchange,
      // and silently mixing them would corrupt both histories.
      const assetId = `${opts.assetPrefix ?? "MT5"}:${exp.symbol}`;
      db.saveCandles(assetId, interval, candles);

      const spreadBps =
        exp.bid > 0 ? ((exp.spreadPoints * exp.point) / exp.bid) * 10_000 : 0;

      db.setSetting(`mt5:${exp.symbol}`, {
        ...exp,
        // The bars are already stored; keeping a copy here would duplicate
        // megabytes into a settings row on every ingest.
        bars: undefined,
        barCount: candles.length,
        spreadBps,
        assetId,
      });

      ingested.push({
        file,
        symbol: exp.symbol,
        interval,
        bars: candles.length,
        ageSeconds: exp.exportedAt > 0 ? nowSec - exp.exportedAt : -1,
        spreadBps,
      });
    } catch (e) {
      errors.push({
        file,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { ingested, errors };
}
