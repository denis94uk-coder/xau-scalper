/**
 * The hypotheses the scanner tests, and why each one is worth a test.
 *
 * These are deliberately NOT variations on the six indicators already in the
 * system. Those were measured, split into families, swept and walked forward,
 * and produced win rates sitting on their own breakeven — so more RSI periods
 * would be another look at the same absent signal.
 *
 * What is here instead are claims about gold specifically: that its day has a
 * shape (sessions open, London and New York overlap, liquidity leaves), that a
 * violent bar is information about the next one, and that a quiet range decides
 * the direction of the move that leaves it. Each is a mechanism someone could
 * argue with, which is the only kind of hypothesis worth spending a test on.
 *
 * Every `signal` reads bars up to and including `i` and no further.
 */

import type { Hypothesis } from "./edgescan";
import type { Candle, Direction } from "./strategy";

/** UTC hour of a candle. Broker server time is not UTC; the sync stores UTC. */
function hourOf(c: Candle): number {
  return new Date(c.time * 1000).getUTCHours();
}

/** True when `i` is the first bar at or after `hour` on its day. */
function isSessionOpen(candles: Candle[], i: number, hour: number): boolean {
  if (i === 0) return false;
  const h = hourOf(candles[i]);
  const prev = hourOf(candles[i - 1]);
  return h >= hour && (prev < hour || prev > h);
}

/** Mean absolute close-to-close move over the preceding `n` bars. */
function meanAbsMove(candles: Candle[], i: number, n: number): number {
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    sum += Math.abs(candles[k].close - candles[k - 1].close);
  }
  return sum / n;
}

/**
 * Momentum continuation over `lookback` bars.
 *
 * The claim: a move that has already run keeps running for a few more bars,
 * because the flow that caused it is not finished. This is the oldest
 * documented anomaly in any market and the honest first thing to test.
 */
function momentum(lookback: number): Hypothesis {
  return {
    name: `momentum-${lookback}`,
    claim: `The sign of the last ${lookback} bars' return continues.`,
    signal(candles, i) {
      if (i < lookback) return null;
      const change = candles[i].close - candles[i - lookback].close;
      if (change === 0) return null;
      return change > 0 ? "LONG" : "SHORT";
    },
  };
}

/**
 * Fade an outsized bar.
 *
 * The claim: a single bar far larger than recent ones is a liquidity event —
 * a stop cascade or a thin-book print — rather than information, and price
 * comes back. The opposite claim to momentum at a one-bar scale, and they are
 * both cheap to test, so both are tested.
 */
function fadeSpike(multiple: number): Hypothesis {
  return {
    name: `fade-spike-${multiple}x`,
    claim: `A bar over ${multiple}× the recent average move retraces.`,
    signal(candles, i) {
      if (i < 21) return null;
      const move = candles[i].close - candles[i - 1].close;
      const avg = meanAbsMove(candles, i - 1, 20);
      if (avg <= 0 || Math.abs(move) < multiple * avg) return null;
      return move > 0 ? "SHORT" : "LONG";
    },
  };
}

/**
 * Session opening-range breakout.
 *
 * The claim: gold's range in the first hour after a session opens brackets the
 * indecision, and the side price leaves it on is the side the session runs.
 * London (07:00 UTC) and New York (13:00 UTC) are tested separately because
 * they are different participants; assuming they behave alike is the sort of
 * convenience that turns two weak results into one apparently strong one.
 */
function openingRange(hour: number, label: string, bars: number): Hypothesis {
  return {
    name: `${label}-open-range`,
    claim: `Price leaving the first ${bars} bars' range after ${label} open (${hour}:00 UTC) continues that way.`,
    signal(candles, i) {
      // Find the session open at or before i, within the last `bars` + 1.
      let open = -1;
      for (let k = i; k > i - bars - 2 && k > 0; k--) {
        if (isSessionOpen(candles, k, hour)) {
          open = k;
          break;
        }
      }
      if (open < 0 || i !== open + bars) return null;

      let hi = -Infinity;
      let lo = Infinity;
      for (let k = open; k < open + bars; k++) {
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
 * Time-of-day drift for one session block.
 *
 * The claim: gold is systematically bid or offered during a particular block of
 * the day, from flows that are not trading it for direction — hedging, fixing,
 * options expiry. A directional claim with no price input at all, which makes
 * it the cleanest possible test of whether the day has a shape.
 *
 * Tested LONG only, and the SIGN of the result is read.
 *
 * A short version of the same block is not a second hypothesis — it is the
 * same measurement negated, and registering both spent two slots of the
 * multiple-testing budget on one question while printing one fact twice as
 * though it were corroboration. The two-sided p-value already covers both
 * directions.
 *
 * A negative mean is still not a short signal: costs are paid whichever way you
 * face, so a long losing 6.09 points per hold corresponds to a short losing
 * 6.92, not to a short winning anything.
 */
function sessionDrift(
  fromHour: number,
  toHour: number,
  label: string,
): Hypothesis {
  return {
    name: label,
    claim: `Gold drifts directionally between ${fromHour}:00 and ${toHour}:00 UTC.`,
    signal(candles, i) {
      const h = hourOf(candles[i]);
      const inBlock =
        fromHour <= toHour
          ? h >= fromHour && h < toHour
          : h >= fromHour || h < toHour;
      return inBlock ? "LONG" : null;
    },
  };
}

/**
 * Trend continuation, but only when volatility is low.
 *
 * The claim behind the filter: the trend signals in this system fail because
 * they fire indiscriminately, and a trend is only worth joining when the market
 * is not already thrashing. This is the one hypothesis here that reuses the
 * existing trend read, so a positive result would say the signal was fine and
 * the filter was missing.
 */
function quietTrend(atrPercentile: number): Hypothesis {
  return {
    name: `quiet-trend-p${atrPercentile}`,
    claim: `Moving-average direction continues when volatility is in the calmest ${atrPercentile}% of the last 100 bars.`,
    signal(candles, i) {
      if (i < 120) return null;

      // Mean absolute close-to-close move over 14 bars, not ATR: it measures
      // the same thing for this purpose and is O(1) per sample here, where
      // Wilder's smoothing would make the scan quadratic in the bar count.
      const vol = meanAbsMove(candles, i, 14);
      const recent: number[] = [];
      for (let k = i - 99; k <= i; k += 5)
        recent.push(meanAbsMove(candles, k, 14));
      recent.sort((a, b) => a - b);
      const cut = recent[Math.floor((recent.length * atrPercentile) / 100)];
      if (vol > cut) return null;

      const fast =
        candles.slice(i - 8, i + 1).reduce((s, c) => s + c.close, 0) / 9;
      const slow =
        candles.slice(i - 20, i + 1).reduce((s, c) => s + c.close, 0) / 21;
      if (fast === slow) return null;
      return fast > slow ? "LONG" : "SHORT";
    },
  };
}

/**
 * The catalogue, fixed and named.
 *
 * The list is a constant rather than something a caller assembles, because the
 * Šidák correction is only honest if the count is the number of things actually
 * tried. Adding a hypothesis, running the scan, and removing it again if it
 * looked bad is the same as not correcting at all.
 */
export const HYPOTHESES: Hypothesis[] = [
  momentum(3),
  momentum(12),
  momentum(48),
  fadeSpike(3),
  fadeSpike(5),
  openingRange(7, "london", 12),
  openingRange(13, "newyork", 12),
  sessionDrift(0, 7, "asia-session"),
  sessionDrift(7, 13, "london-session"),
  sessionDrift(13, 21, "ny-session"),
  quietTrend(30),
  quietTrend(50),
];
