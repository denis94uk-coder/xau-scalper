/**
 * Positioning hypotheses: claims about who is crowded, built from the
 * perp market's own measurements (funding rates, open interest) rather than
 * from price alone.
 *
 * These are FACTORIES, not a static catalogue, because each needs an aux
 * series injected. The factory closes over the series and returns an ordinary
 * `Hypothesis`, so `scanEdges` neither knows nor cares that positioning data
 * exists — costs, windows, corrections all apply unchanged. The runner script
 * composes the full list and therefore pays the honest Šidák price for every
 * extra question asked here.
 *
 * ALIGNMENT CONTRACT, shared by everything below
 * Aux observations are timestamped by their own publication. A hypothesis at
 * bar `i` may use only observations whose time is ≤ the bar's OPEN time — the
 * strictest defensible rule, since it never assumes the bar's own outcome was
 * known at entry. `stepAt` implements it by binary search.
 *
 * CAVEAT inherited from the feed: these series describe the perpetual futures
 * market while candles are spot. On majors the basis is small; the claims
 * below are still strictly about perp positioning expressed through spot
 * prices.
 */

import type { FundingEvent, OpenInterestPoint } from "../server/market-futures";
import type { Hypothesis } from "./edgescan";
import type { Candle, Direction } from "./strategy";

/** Index of the most recent observation at or before `t`, or -1. */
export function stepIndex<T extends { time: number }>(
  series: T[],
  t: number,
): number {
  if (series.length === 0) return -1;
  let lo = 0;
  let hi = series.length - 1;
  if (series[0].time > t) return -1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (series[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Most recent observation at or before `t`, or null when none existed yet. */
export function stepAt<T extends { time: number }>(
  series: T[],
  t: number,
): T | null {
  const idx = stepIndex(series, t);
  return idx === -1 ? null : series[idx];
}

/** Percentile of a sorted-in-place numeric slice. */
function pct(sorted: number[], p: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  ];
}

/**
 * Fade whichever side of the funding book is paying through the nose.
 *
 * The claim: funding is the perp longs' rent for being crowded. When the
 * settlement rate sits in the top decile of its own trailing year of prints,
 * leveraged demand has bid past every reasonable carry — the marginal long is
 * there because they MUST be, not because they want to be — and price gives
 * some of it back once the urgency passes. Deep-negative funding is the same
 * claim about crowded shorts. Both tails are ONE mechanism (crowding rent),
 * so both directions live in one hypothesis rather than spending two slots of
 * the testing budget to ask it twice.
 *
 * Trailing distribution: the 270 settlements (~90 days) strictly before the
 * visible one, so the comparison never uses information newer than entry.
 */
export function fundingExtreme(
  events: FundingEvent[],
  tailPct = 10,
  windowEvents = 270,
): Hypothesis {
  return {
    name: "funding-extreme",
    claim:
      "Funding in the extreme deciles of its trailing year marks a crowded side; price reverts away from the crowd.",
    signal(candles: Candle[], i: number): Direction | null {
      const idx = stepIndex(events, candles[i].time);
      if (idx < 30) return null;
      const from = Math.max(0, idx - windowEvents);
      const trail = events.slice(from, idx).map(e => e.rate);
      if (trail.length < 30) return null;
      const sorted = [...trail].sort((a, b) => a - b);
      const hiCut = pct(sorted, 100 - tailPct);
      const loCut = pct(sorted, tailPct);
      const rate = events[idx].rate;
      if (rate >= hiCut) return "SHORT";
      if (rate <= loCut) return "LONG";
      return null;
    },
  };
}

/**
 * A range break taken only when new money confirms it.
 *
 * The claim: price leaving an N-bar range on rising open interest is real
 * participation — positions being OPENED into the move — while the same break
 * on flat or falling OI is locals fading each other inside the range and can
 * just as easily walk back in. Plain momentum measured nothing here (2026-08
 * scans), so the question is whether the participation filter separates the
 * breaks that run from the ones that don't.
 *
 * OI confirmation: the visible observation sits above the median of the 96
 * observations strictly preceding it.
 */
export function oiConfirmedBreakout(
  points: OpenInterestPoint[],
  lookbackBars = 24,
): Hypothesis {
  return {
    name: `oi-breakout-${lookbackBars}`,
    claim: `A ${lookbackBars}-bar range break continues only when open interest confirms new positions.`,
    signal(candles: Candle[], i: number): Direction | null {
      if (i < lookbackBars + 1) return null;
      const idx = stepIndex(points, candles[i].time);
      if (idx < 48) return null;
      const trail = points
        .slice(Math.max(0, idx - 96), idx)
        .map(p => p.contracts);
      const sorted = [...trail].sort((a, b) => a - b);
      if (points[idx].contracts <= pct(sorted, 50)) return null;

      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - lookbackBars; k < i; k++) {
        hi = Math.max(hi, candles[k].high);
        lo = Math.min(lo, candles[k].low);
      }
      const close = candles[i].close;
      if (close > hi) return "LONG";
      if (close < lo) return "SHORT";
      return null;
    },
  };
}

/**
 * Buy the flush that closed positions rather than opened shorts.
 *
 * The claim: a sharp drop accompanied by COLLAPSING open interest is longs
 * being forcibly closed out — the selling is finite by construction, because
 * every closed position removes a seller — and the book refills afterwards.
 * A drop on RISING interest would be fresh shorts pressing, which is the
 * opposite situation and deliberately NOT registered here: it would nearly
 * negate this test and double-spend the budget asking one question twice.
 * One-sided, read by sign, like every directional-drift claim.
 */
export function oiWashout(
  points: OpenInterestPoint[],
  priceDropPct = 3,
  oiDropPct = 4,
  lookbackBars = 12,
): Hypothesis {
  return {
    name: `oi-washout-${lookbackBars}`,
    claim: `A ≥${priceDropPct}% drop over ${lookbackBars} bars alongside collapsing open interest marks finished liquidation.`,
    signal(candles: Candle[], i: number): Direction | null {
      if (i < lookbackBars) return null;
      const idx = stepIndex(points, candles[i].time);
      if (idx < 48) return null;

      // Peak OI over the two days of observations before now.
      const trail = points.slice(Math.max(0, idx - 96), idx + 1);
      const peak = Math.max(...trail.map(p => p.contracts));
      if (peak <= 0) return null;
      if (1 - points[idx].contracts / peak < oiDropPct / 100) return null;

      const change =
        (candles[i].close - candles[i - lookbackBars].close) /
        candles[i - lookbackBars].close;
      if (change > -priceDropPct / 100) return null;
      return "LONG";
    },
  };
}
