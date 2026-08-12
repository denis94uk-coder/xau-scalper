/**
 * Macro-conditioned hypotheses for the edge scanner.
 *
 * The claim behind all of these: gold does not trade in isolation. When the US
 * dollar strengthens (DXY up), gold is under mechanical pressure from the
 * same flows. When real yields fall, the opportunity cost of holding gold
 * drops, making it bid. Neither relationship is controversial — they are the
 * textbook drivers — and the question is whether they still carry enough
 * day-to-day signal to gate a scalping strategy.
 *
 * Each hypothesis here takes an external daily time series (passed in at
 * construction time, indexed by YYYY-MM-DD) and returns a signal based on
 * the previous day's reading, so there is no look-ahead: by the time London
 * opens, yesterday's close is known.
 *
 * These are designed to be tested with `scanEdges` on H1 or daily gold bars.
 * Testing on M5 does not make sense here — daily macro data cannot inform a
 * 5-minute entry beyond the coarse directional bias it already provides to H1.
 */

import type { Hypothesis } from "./edgescan";
import type { Candle, Direction } from "./strategy";

/** ISO date string YYYY-MM-DD from a Unix timestamp (seconds). */
function toDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Previous calendar day from an ISO date string. */
function prevDate(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The direction of a macro series on the day before candle `i`.
 *
 * Looks back up to `maxLookback` days to find the previous non-missing value
 * (weekends, holidays). Returns null when the series has no data.
 */
function macroDayDirection(
  series: Map<string, number>,
  candleDate: string,
  maxLookback = 5,
): Direction | null {
  // Walk back from the previous day to find two consecutive valid readings
  let d1: string = prevDate(candleDate);
  let v1: number | undefined;

  for (let k = 0; k < maxLookback; k++) {
    v1 = series.get(d1);
    if (v1 !== undefined) break;
    d1 = prevDate(d1);
  }
  if (v1 === undefined) return null;

  let d2: string = prevDate(d1);
  let v2: number | undefined;
  for (let k = 0; k < maxLookback; k++) {
    v2 = series.get(d2);
    if (v2 !== undefined) break;
    d2 = prevDate(d2);
  }
  if (v2 === undefined) return null;

  if (v1 === v2) return null;
  return v1 > v2 ? "LONG" : "SHORT";
}

/**
 * Two-day change in a macro series, measured in absolute terms.
 *
 * Returns null when either day is missing.
 */
function macroChange(
  series: Map<string, number>,
  candleDate: string,
  maxLookback = 5,
): number | null {
  let d1 = prevDate(candleDate);
  let v1: number | undefined;
  for (let k = 0; k < maxLookback; k++) {
    v1 = series.get(d1);
    if (v1 !== undefined) break;
    d1 = prevDate(d1);
  }

  let d2 = prevDate(d1);
  let v2: number | undefined;
  for (let k = 0; k < maxLookback; k++) {
    v2 = series.get(d2);
    if (v2 !== undefined) break;
    d2 = prevDate(d2);
  }

  if (v1 === undefined || v2 === undefined) return null;
  return v1 - v2;
}

/**
 * DXY-aligned hypothesis.
 *
 * Classic inverse relationship: strong dollar → gold offered. A DXY up day
 * should bias toward SHORT gold on the next session; DXY down → LONG gold.
 *
 * We take the inverse of the DXY direction as the gold signal.
 *
 * `dxy` is a date→price map of daily DXY closes (or a US dollar index proxy).
 */
export function dxyAligned(dxy: Map<string, number>): Hypothesis {
  return {
    name: "dxy-aligned",
    claim:
      "Gold trades inversely to the prior day's DXY direction (dollar up → gold short).",
    signal(candles: Candle[], i: number): Direction | null {
      const date = toDate(candles[i].time);
      const dxyDir = macroDayDirection(dxy, date);
      if (dxyDir === null) return null;
      // Inverse: DXY up = gold SHORT, DXY down = gold LONG
      return dxyDir === "LONG" ? "SHORT" : "LONG";
    },
  };
}

/**
 * DXY-contrarian hypothesis.
 *
 * The opposite bet: when DXY ran hard yesterday, the move is exhausted and
 * gold bounces. This is mean-reversion on the inverse relationship.
 */
export function dxyContrarian(dxy: Map<string, number>): Hypothesis {
  return {
    name: "dxy-contrarian",
    claim:
      "Gold bounces opposite to a DXY extension (fades yesterday's DXY move).",
    signal(candles: Candle[], i: number): Direction | null {
      const date = toDate(candles[i].time);
      const dxyDir = macroDayDirection(dxy, date);
      if (dxyDir === null) return null;
      // Same direction as DXY: if gold truly fades, this should lose
      return dxyDir === "LONG" ? "LONG" : "SHORT";
    },
  };
}

/**
 * 10-year Treasury yield direction → gold.
 *
 * Falling yields reduce the cost of holding non-yielding gold → LONG.
 * Rising yields increase the cost → SHORT.
 *
 * `yields` is a date→yield (in percent) map.
 */
export function yieldDirectionGold(yields: Map<string, number>): Hypothesis {
  return {
    name: "yield-direction",
    claim:
      "Gold trades inversely to the prior day's 10yr Treasury yield direction.",
    signal(candles: Candle[], i: number): Direction | null {
      const date = toDate(candles[i].time);
      const yDir = macroDayDirection(yields, date);
      if (yDir === null) return null;
      // Yields up → gold SHORT; yields down → gold LONG
      return yDir === "LONG" ? "SHORT" : "LONG";
    },
  };
}

/**
 * Large yield move (> threshold bps) the prior day.
 *
 * The claim: a big yield move reprices the gold relationship forcefully, and
 * that repricing is not fully captured intraday, so the next session continues.
 *
 * `threshold` is in percent (e.g. 0.05 = 5bps).
 */
export function largeYieldMove(
  yields: Map<string, number>,
  threshold = 0.05,
): Hypothesis {
  const label = `yield-big-move-${Math.round(threshold * 100)}bps`;
  return {
    name: label,
    claim: `Gold continues the prior day's yield shock (>${Math.round(threshold * 100)}bps) inversely.`,
    signal(candles: Candle[], i: number): Direction | null {
      const date = toDate(candles[i].time);
      const chg = macroChange(yields, date);
      if (chg === null || Math.abs(chg) < threshold) return null;
      // Large yield rise → gold SHORT; large yield fall → gold LONG
      return chg > 0 ? "SHORT" : "LONG";
    },
  };
}

/**
 * Yield curve slope (10yr − 2yr) direction as gold signal.
 *
 * A steepening curve (10yr rising faster than 2yr, or 2yr falling faster)
 * signals reflationary expectations → LONG gold. Flattening/inversion →
 * SHORT gold (risk-off, dollar strength anticipated).
 *
 * `yield10` and `yield2` are date→yield maps.
 */
export function yieldCurveSlope(
  yield10: Map<string, number>,
  yield2: Map<string, number>,
): Hypothesis {
  const slope = new Map<string, number>();
  for (const [date, y10] of yield10) {
    const y2 = yield2.get(date);
    if (y2 !== undefined) slope.set(date, y10 - y2);
  }

  return {
    name: "yield-curve-slope",
    claim:
      "A steepening 10yr−2yr yield curve (reflationary) is LONG gold; flattening is SHORT.",
    signal(candles: Candle[], i: number): Direction | null {
      const date = toDate(candles[i].time);
      const slopeDir = macroDayDirection(slope, date);
      if (slopeDir === null) return null;
      // Steepening (slope rising) → LONG gold
      return slopeDir;
    },
  };
}

/**
 * Real yield proxy: 10yr nominal minus 1-year inflation proxy (not CPI, just
 * the 1yr Treasury as a short-rate proxy). Falling real yields → LONG gold.
 *
 * Note: this is a rough proxy. True real yields use TIPS, which are not always
 * available daily. The 10yr minus 1yr spread captures most of the signal.
 */
export function realYieldProxy(
  yield10: Map<string, number>,
  yield1yr: Map<string, number>,
): Hypothesis {
  const real = new Map<string, number>();
  for (const [date, y10] of yield10) {
    const y1 = yield1yr.get(date);
    if (y1 !== undefined) real.set(date, y10 - y1);
  }

  return {
    name: "real-yield-proxy",
    claim: "Falling 10yr−1yr (real yield proxy) is LONG gold; rising is SHORT.",
    signal(candles: Candle[], i: number): Direction | null {
      const date = toDate(candles[i].time);
      const realDir = macroDayDirection(real, date);
      if (realDir === null) return null;
      // Real yield falling → LONG gold
      return realDir === "LONG" ? "SHORT" : "LONG";
    },
  };
}

/**
 * Build a Map<date, value> from an array of {date, value} records.
 * Normalizes date strings, skips nulls.
 */
export function buildSeries(
  records: { date: string; value: number | null }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of records) {
    if (r.value !== null && r.date) {
      // Normalize: FMP returns "2024-03-15" already; AV sometimes has extra chars
      const d = r.date.slice(0, 10);
      m.set(d, r.value);
    }
  }
  return m;
}
