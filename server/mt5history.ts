/**
 * On-demand history from MetaTrader 5.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE EXPORTER
 * TeoExporter streams a rolling window — a few thousand recent bars, rewritten
 * every minute — which is what a live engine needs and useless for research.
 * "NAS100, 15m, January 2024 to January 2026" is roughly 50,000 bars, and it
 * is a one-off question, not a heartbeat. Streaming it on the live timer would
 * rewrite tens of megabytes a minute for data that never changes.
 *
 * So history is REQUESTED. The server drops a request file, the EA fills it
 * from the broker's own archive, and the server ingests the answer once.
 *
 * THE PROTOCOL, AND WHY IT LOOKS LIKE THIS
 *   requests/<id>.json   server → EA: symbol, timeframe, from, to
 *   history/<id>.json    EA → server: the bars, or an error
 *   history/<id>.status  EA → server: progress while a long pull runs
 *
 * One file per request rather than a shared queue file, because the two sides
 * are a Bun process and an MQL5 terminal that can be closed mid-write, and
 * there is no lock they both understand. Distinct filenames mean neither side
 * can ever read a record the other is still writing: a file is either finished
 * and renamed into place, or it is not there yet.
 *
 * The id is derived from the request itself, so asking the same question twice
 * reuses the first answer instead of pulling 50,000 bars again.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Candle } from "../core/strategy";

/** What to fetch. Times are UTC seconds. */
export interface HistoryRequest {
  id: string;
  symbol: string;
  /** MT5 timeframe name: M1, M5, M15, M30, H1, H4, D1. */
  timeframe: string;
  from: number;
  to: number;
  requestedAt: number;
}

export type HistoryState =
  | { status: "pending"; progress: number; message: string }
  | { status: "working"; progress: number; message: string }
  | { status: "ready"; progress: 1; bars: number; message: string }
  | { status: "failed"; progress: number; message: string };

/** The engine's interval strings ↔ MT5's timeframe names. */
export const INTERVAL_TO_TIMEFRAME: Record<string, string> = {
  "1m": "M1",
  "3m": "M3",
  "5m": "M5",
  "15m": "M15",
  "30m": "M30",
  "1h": "H1",
  "4h": "H4",
  "1d": "D1",
};

export const TIMEFRAME_SECONDS: Record<string, number> = {
  M1: 60,
  M3: 180,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
};

/**
 * A stable id for a request.
 *
 * Content-addressed rather than random: the same question asked twice must
 * resolve to the same file, so a re-run after a page reload finds the answer
 * already sitting there instead of making the terminal re-export two years of
 * bars. Plain and readable so a human debugging the bridge can see what a file
 * in MQL5/Files is for.
 */
export function historyId(
  symbol: string,
  timeframe: string,
  from: number,
  to: number,
): string {
  const safe = symbol.replace(/[^A-Za-z0-9]/g, "");
  return `${safe}_${timeframe}_${from}_${to}`;
}

function requestsDir(dir: string): string {
  return join(dir, "requests");
}
function historyDir(dir: string): string {
  return join(dir, "history");
}

/**
 * Ask the terminal for a range.
 *
 * Returns the id immediately; the answer arrives asynchronously because the
 * terminal may need to download years of bars from the broker first. Writing
 * the request through a temp file and a rename means the EA never sees a
 * half-written request — MQL5's JSON handling would simply fail on one, and
 * the request would be silently dropped.
 */
export function requestHistory(
  dir: string,
  symbol: string,
  timeframe: string,
  from: number,
  to: number,
  now = Date.now(),
): HistoryRequest {
  const id = historyId(symbol, timeframe, from, to);
  const req: HistoryRequest = {
    id,
    symbol,
    timeframe,
    from,
    to,
    requestedAt: Math.floor(now / 1000),
  };

  mkdirSync(requestsDir(dir), { recursive: true });
  mkdirSync(historyDir(dir), { recursive: true });

  const target = join(requestsDir(dir), `${id}.json`);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(req, null, 2));
  renameSync(tmp, target);

  return req;
}

/** Where a request stands, from the files on disk. */
export function historyState(dir: string, id: string): HistoryState {
  const result = join(historyDir(dir), `${id}.json`);
  if (existsSync(result)) {
    try {
      const parsed = JSON.parse(readFileSync(result, "utf8")) as {
        error?: string;
        bars?: unknown[];
      };
      if (parsed.error) {
        return { status: "failed", progress: 0, message: parsed.error };
      }
      const bars = parsed.bars?.length ?? 0;
      return {
        status: "ready",
        progress: 1,
        bars,
        message: `${bars} bars delivered by the terminal.`,
      };
    } catch {
      // Being written right now. Report it as working rather than failed: the
      // next poll a second later will parse cleanly, and showing an error for
      // a file mid-write would make every successful pull look broken.
      return { status: "working", progress: 0.9, message: "Receiving bars…" };
    }
  }

  const statusFile = join(historyDir(dir), `${id}.status`);
  if (existsSync(statusFile)) {
    try {
      const parsed = JSON.parse(readFileSync(statusFile, "utf8")) as {
        progress?: number;
        message?: string;
      };
      return {
        status: "working",
        progress: Math.min(0.95, parsed.progress ?? 0.1),
        message: parsed.message ?? "Terminal is downloading history…",
      };
    } catch {
      return { status: "working", progress: 0.1, message: "Working…" };
    }
  }

  if (existsSync(join(requestsDir(dir), `${id}.json`))) {
    return {
      status: "pending",
      progress: 0,
      message: "Waiting for MetaTrader 5 to pick up the request.",
    };
  }

  return {
    status: "failed",
    progress: 0,
    message: "No request on disk — was the export directory cleared?",
  };
}

/** Parsed bars from a completed request, oldest first. */
export function readHistory(dir: string, id: string): Candle[] {
  const file = join(historyDir(dir), `${id}.json`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    error?: string;
    gmtOffsetSeconds?: number;
    bars?: Array<[number, number, number, number, number, number]>;
  };
  if (parsed.error) throw new Error(parsed.error);
  if (!Array.isArray(parsed.bars)) throw new Error("history file has no bars");

  // Bar stamps are in the broker's server time, which is UTC+2 or +3 and
  // shifts with daylight saving. Normalising here means a range the operator
  // gave in UTC does not silently return bars two hours out of place — which
  // would look like working data and quietly misalign every session filter.
  const offset = parsed.gmtOffsetSeconds ?? 0;

  const candles = parsed.bars.map(b => ({
    time: b[0] - offset,
    open: b[1],
    high: b[2],
    low: b[3],
    close: b[4],
    volume: b[5],
  }));

  candles.sort((a, b) => a.time - b.time);
  return candles;
}

/** Requests whose answers are on disk, for cache reuse and cleanup. */
export function completedHistories(dir: string): string[] {
  try {
    return readdirSync(historyDir(dir))
      .filter(f => f.endsWith(".json"))
      .map(f => f.slice(0, -5));
  } catch {
    return [];
  }
}

/**
 * Delete a request and its answer.
 *
 * History files are large — two years of M15 is several megabytes of JSON —
 * and they live inside the user's MetaTrader directory, so leaving them there
 * indefinitely is rude. Called once the bars are safely in the database.
 */
export function clearHistory(dir: string, id: string): void {
  for (const file of [
    join(requestsDir(dir), `${id}.json`),
    join(historyDir(dir), `${id}.json`),
    join(historyDir(dir), `${id}.status`),
  ]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // Best-effort: a terminal holding the file open on Windows is not a
      // reason to fail a run whose data has already been read.
    }
  }
}
