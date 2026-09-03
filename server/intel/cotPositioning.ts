/**
 * COT positioning intel — the crowd gauge for gold.
 *
 * The CFTC Commitments of Traders report (weekly, Fridays) breaks the gold
 * futures market into commercials (hedgers), non-commercials (funds — the
 * crowd) and non-reportables (retail). The vault links the GC report to
 * XAU/USD directly, so the top10 engine can stand down when a signal would
 * join an already-crowded trade: breakouts into a 90th-percentile-long fund
 * positioning are the late arrivals who get squeezed.
 *
 * The percentile is a 3-year rank of net non-commercial positioning. Extremes
 * are a filter, not a signal — this blocks trades, it never opens them.
 */

import type { Db } from "../db";
import { type CotReport, fetchLseCot } from "../lse";

export type { CotReport };

const KEY = "lseCot";
/** GC = COMEX gold futures, the COT mirror of XAU/USD. */
const MARKET = "GC";
/** Trailing reports for the percentile window: weekly × 3 years. */
const WINDOW = 156;
/** Percentile beyond which the crowd is considered crowded on that side. */
const EXTREME_PCT = 90;

export interface CotState {
  market: string;
  reportDate: string;
  netNoncomm: number;
  netNoncommPrev: number;
  percentile: number;
  crowded: "LONG" | "SHORT" | null;
  openInterest: number;
  openInterestChange: number;
  windowSize: number;
  updatedAt: number;
}

/**
 * Pure positioning analysis. Returns null when there is not enough history to
 * rank against — a half-filled window would make every percentile an artefact
 * of the short sample.
 */
export function cotState(reports: CotReport[]): CotState | null {
  if (reports.length < 52) return null;
  const sorted = [...reports].sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = sorted[0];
  const prev = sorted[1];

  const net = (r: CotReport) => r.noncommLong - r.noncommShort;
  const window = sorted.slice(0, WINDOW).map(net);
  const latestNet = net(latest);
  const below = window.filter(n => n <= latestNet).length;
  const percentile = Math.round((below / window.length) * 1000) / 10;

  return {
    market: MARKET,
    reportDate: latest.date,
    netNoncomm: latestNet,
    netNoncommPrev: net(prev),
    percentile,
    crowded:
      percentile >= EXTREME_PCT
        ? "LONG"
        : percentile <= 100 - EXTREME_PCT
          ? "SHORT"
          : null,
    openInterest: latest.openInterest,
    openInterestChange: latest.changeOpenInterest,
    windowSize: window.length,
    updatedAt: Date.now(),
  };
}

export async function updateCotPositioning(
  db: Db,
  fetcher?: typeof fetch,
): Promise<void> {
  try {
    const reports = await fetchLseCot(MARKET, { fetcher });
    const state = cotState(reports);
    if (!state) {
      console.log(`[COT] only ${reports.length} reports — need ≥52 to rank`);
      return;
    }
    db.setSetting(KEY, state);
    console.log(
      `[COT] ${MARKET} ${state.reportDate}: net non-comm ${state.netNoncomm.toLocaleString()} ` +
        `(${state.percentile}th pct${state.crowded ? ` — CROWDED ${state.crowded}` : ""})`,
    );
  } catch (e) {
    console.error("[COT] Error:", e instanceof Error ? e.message : e);
  }
}

/** The stored state, for callers that gate on it. */
export function readCotState(db: Db): CotState | null {
  return db.getSetting<CotState>(KEY);
}
