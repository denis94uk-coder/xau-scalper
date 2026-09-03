/**
 * London Strategic Edge vault client — the server's window onto real-market
 * data: incremental candles, COT positioning and the economic calendar.
 *
 * REST only here (the live engine reads bars from the database; the intel
 * loop refreshes them on a cadence). One key authorizes everything and comes
 * from LSE_API_KEY or the `lse auth` config file — no credential is ever
 * logged or embedded.
 *
 * Pagination is date-granular: the vault's `start` filter takes YYYY-MM-DD,
 * and one day of 15m bars is ~96 rows, far under the 5000-row page cap, so a
 * full page always spans several days and the cursor always advances.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import type { Candle } from "../core/strategy";

const VAULT_URL = "https://api.londonstrategicedge.com/vault";
const USER_AGENT = "jcode-xau-scalper live server";

/** Injectable so tests never touch the network. */
export type Fetcher = typeof fetch;

export interface LseOptions {
  fetcher?: Fetcher;
  apiKey?: string;
}

export function lseApiKey(): string | null {
  if (process.env.LSE_API_KEY) return process.env.LSE_API_KEY;
  const cfgPath = `${homedir()}/.lse/config.json`;
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<
      string,
      unknown
    >;
    const key = cfg.api_key ?? Object.values(cfg)[0];
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

interface RawCandleRow {
  ts?: string;
  timestamp?: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume?: number | string;
}

/** Bar-open time ("2024-03-05 14:30:00" or ISO) → epoch seconds. */
export function barTime(raw: string): number {
  const norm = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  return Math.floor(Date.parse(norm) / 1000);
}

function toCandle(r: RawCandleRow): Candle | null {
  const tsRaw = r.ts ?? r.timestamp;
  if (!tsRaw) return null;
  const time = barTime(tsRaw);
  const open = Number(r.open);
  const high = Number(r.high);
  const low = Number(r.low);
  const close = Number(r.close);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    close <= 0
  ) {
    return null;
  }
  return { time, open, high, low, close, volume: Number(r.volume ?? 0) || 0 };
}

async function vaultGet(
  path: string,
  params: Record<string, string | undefined>,
  opts: LseOptions,
): Promise<unknown> {
  const apiKey = opts.apiKey ?? lseApiKey();
  if (!apiKey)
    throw new Error("no LSE API key (set LSE_API_KEY or run lse auth)");
  const doFetch = opts.fetcher ?? fetch;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, v);
  }
  const res = await doFetch(`${VAULT_URL}${path}?${qs.toString()}`, {
    headers: { "x-api-key": apiKey, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `LSE vault ${res.status} for ${path}: ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}

/**
 * Candles for one symbol/timeframe. `since` (epoch seconds of the newest bar
 * already stored) makes the pull incremental — the date cursor starts at the
 * day of the last stored bar so the still-open bar is re-fetched and its
 * high/low/close finalise, exactly like the Binance path.
 */
export async function fetchLseCandles(
  symbol: string,
  timeframe: string,
  opts: LseOptions & { since?: number | null; maxPages?: number } = {},
): Promise<Candle[]> {
  let cursor = opts.since != null ? isoDate(opts.since) : "2003-01-01";
  const out: Candle[] = [];
  const maxPages = opts.maxPages ?? 20;

  for (let page = 0; page < maxPages; page++) {
    const rows = (await vaultGet(
      "/candles",
      { symbol, timeframe, order: "asc", limit: "5000", start: cursor },
      opts,
    )) as RawCandleRow[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const c = toCandle(r);
      if (c) out.push(c);
    }
    const last = rows[rows.length - 1];
    const lastTs = last.ts ?? last.timestamp ?? "";
    const nextDate = lastTs.slice(0, 10);
    if (rows.length < 5000) break;
    // A full page confined to one date would mean a day exceeded the row cap —
    // advance a day instead of looping on the same window forever.
    cursor =
      nextDate > cursor
        ? nextDate
        : isoDate(barTime(lastTs || `${cursor}T00:00:00`) + 86_400);
  }

  return out;
}

// ─── COT positioning ───

export interface CotReport {
  date: string;
  openInterest: number;
  noncommLong: number;
  noncommShort: number;
  pctNoncommLong: number;
  pctNoncommShort: number;
  changeOpenInterest: number;
  changeNoncommLong: number;
  changeNoncommShort: number;
}

export async function fetchLseCot(
  symbol: string,
  opts: LseOptions & { limit?: number } = {},
): Promise<CotReport[]> {
  const rows = (await vaultGet(
    "/ref/cot",
    { symbol, order: "desc", limit: String(opts.limit ?? 156) },
    opts,
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({
    date: String(r.date ?? ""),
    openInterest: Number(r.open_interest ?? 0),
    noncommLong: Number(r.noncomm_long ?? 0),
    noncommShort: Number(r.noncomm_short ?? 0),
    pctNoncommLong: Number(r.pct_noncomm_long ?? 0),
    pctNoncommShort: Number(r.pct_noncomm_short ?? 0),
    changeOpenInterest: Number(r.change_open_interest ?? 0),
    changeNoncommLong: Number(r.change_noncomm_long ?? 0),
    changeNoncommShort: Number(r.change_noncomm_short ?? 0),
  }));
}

// ─── Economic calendar ───

export interface CalendarEvent {
  event: string;
  region: string;
  datetime: number; // epoch seconds
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}

export async function fetchLseCalendar(
  opts: LseOptions & {
    regions?: string[];
    start?: string;
    end?: string;
    limit?: number;
  } = {},
): Promise<CalendarEvent[]> {
  const rows = (await vaultGet(
    "/ref/economic_calendar",
    {
      region: opts.regions?.join(","),
      start: opts.start,
      end: opts.end,
      order: "asc",
      limit: String(opts.limit ?? 5000),
    },
    opts,
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => {
      const dtRaw = r.datetime ?? r.date ?? "";
      const datetime =
        typeof dtRaw === "string" ? barTime(dtRaw) : Number(dtRaw);
      return {
        event: String(r.event ?? r.name ?? ""),
        region: String(r.region_code ?? r.region ?? ""),
        datetime,
        actual: (r.actual as string) ?? null,
        forecast: (r.forecast as string) ?? null,
        previous: (r.previous as string) ?? null,
      };
    })
    .filter(e => Number.isFinite(e.datetime));
}
