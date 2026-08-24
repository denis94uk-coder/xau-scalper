/**
 * Hypotheses about crypto specifically, for the same scanner.
 *
 * The gold catalogue in hypotheses.ts already contains the instrument-agnostic
 * mechanisms — momentum at three scales, the one-bar spike fade, quiet-trend.
 * What it cannot contain are claims that only make sense on a market that
 * never closes: a weekend is not a session block but a liquidity regime, and
 * the flows that shape an intraday chart are leverage-driven rather than
 * fixings-and-hedging driven. Each claim below is about one of those two
 * differences and could be argued with by someone who trades this market,
 * which is the only kind of hypothesis worth spending a test on.
 *
 * Every `signal` reads bars up to and including `i` and no further, exactly
 * like the gold catalogue — the look-ahead test in the suite enforces it.
 */

import type { Hypothesis } from "./edgescan";
import { isSessionOpen, meanAbsMove } from "./hypotheses";
import type { Candle } from "./strategy";

/** UTC day-of-week of a candle: 0 = Sunday … 6 = Saturday. */
function dayOfWeek(c: Candle): number {
  return new Date(c.time * 1000).getUTCDay();
}

/** Median of the last `n` bars' volume ending at `i`. */
function medianVolume(candles: Candle[], i: number, n: number): number {
  const v: number[] = [];
  for (let k = i - n + 1; k <= i; k++) v.push(candles[k].volume);
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

/** Mean bar range (high − low) over the preceding `n` bars ending at `i`. */
function meanRange(candles: Candle[], i: number, n: number): number {
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    sum += candles[k].high - candles[k].low;
  }
  return sum / n;
}

/**
 * Weekend drift for one UTC day.
 *
 * The claim: with spot desks and most leveraged flow away, the weekend book is
 * thin enough that whatever directional pressure exists moves price without
 * being mean-reverted the way weekday flow reverts it. Traded LONG only and
 * read by sign, like every time-block drift — the two-sided p-value covers
 * both directions, and registering the short side would spend a second test
 * slot to print the same fact negated.
 */
function weekendDrift(day: number): Hypothesis {
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return {
    name: `${names[day]}-drift`,
    claim: `Crypto drifts directionally across ${names[day]} UTC sessions, when institutional flow is thinnest.`,
    signal(candles, i) {
      return dayOfWeek(candles[i]) === day ? "LONG" : null;
    },
  };
}

/**
 * UTC day-open range breakout.
 *
 * The claim: the first hours after 00:00 UTC bracket the Asian session's
 * indecision, and the side price leaves that range on is the side the day
 * runs — the same mechanism claimed for London and New York opens in the gold
 * catalogue, tested here against the clock crypto actually trades on.
 */
function utcDayOpenRange(bars: number): Hypothesis {
  return {
    name: `utc-day-open-range-${bars}`,
    claim: `Price leaving the first ${bars} bars after 00:00 UTC continues that way through the day.`,
    signal(candles, i) {
      let open = -1;
      for (let k = i; k > i - bars - 2 && k > 0; k--) {
        if (isSessionOpen(candles, k, 0)) {
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
 * Fade a multi-bar liquidation cascade.
 *
 * The claim: when several consecutive bars each far exceed the recent average
 * move in the SAME direction, that is not information arriving — it is
 * forced deleveraging (stop cascades, liquidation engines feeding on each
 * other), and the flow exhausts exactly because it was finite. This differs
 * from fade-spike, which fades ONE outsized bar; a cascade is the market
 * structure event people actually describe when they talk about crypto
 * liquidations, and it deserves its own test rather than a nod from the
 * one-bar version.
 *
 * `bars` consecutive same-direction closes each over `multiple`× the average
 * move before the run began.
 */
function fadeCascade(bars: number, multiple: number): Hypothesis {
  return {
    name: `fade-cascade-${bars}x${multiple}`,
    claim: `A run of ${bars} consecutive bars each over ${multiple}× the prior average move retraces.`,
    signal(candles, i) {
      if (i < bars + 20 + 1) return null;
      const avg = meanAbsMove(candles, i - bars, 20);
      if (avg <= 0) return null;

      const first = candles[i - bars + 1].close - candles[i - bars].close;
      if (first === 0) return null;
      const dir = first > 0 ? 1 : -1;

      for (let k = i - bars + 1; k <= i; k++) {
        const move = candles[k].close - candles[k - 1].close;
        if (Math.sign(move) !== dir) return null;
        // Each bar of the run must be oversized on its own, not just the sum:
        // a cascade is repeated forced selling, which slow drift is not.
        if (Math.abs(move) < multiple * avg) return null;
      }
      return dir > 0 ? "SHORT" : "LONG";
    },
  };
}

/**
 * Volume thrust continuation.
 *
 * The claim: a bar whose volume dwarfs the recent median carries real flow,
 * and the direction it closed is the direction that flow continues to push —
 * the entry-side answer to "was that volume absorption or initiative?".
 * Distinct from momentum-over-lookback because the trigger is participation,
 * not price change: a huge-volume doji fires nothing, a modest move on 5×
 * volume does.
 */
function volumeThrust(multiple: number): Hypothesis {
  return {
    name: `volume-thrust-${multiple}x`,
    claim: `A bar on ${multiple}× the recent median volume continues in its close direction.`,
    signal(candles, i) {
      if (i < 51) return null;
      const med = medianVolume(candles, i - 1, 50);
      if (med <= 0) return null;
      if (candles[i].volume < multiple * med) return null;
      const body = candles[i].close - candles[i].open;
      if (body === 0) return null;
      return body > 0 ? "LONG" : "SHORT";
    },
  };
}

/**
 * Squeeze expansion breakout.
 *
 * The claim: after volatility has compressed below its usual level, the first
 * wide bar marks the release of stored positioning and continues — the
 * mechanism behind every "trade the squeeze" system, stated so the scanner can
 * measure it instead of the folklore repeating unmeasured. Bar `i` must be
 * wide relative to its own recent context AND the context must have been
 * genuinely compressed; a wide bar inside normal volatility fires nothing.
 */
function squeezeExpansion(): Hypothesis {
  return {
    name: "squeeze-expansion",
    claim:
      "The first wide bar after compressed volatility continues in its close direction.",
    signal(candles, i) {
      if (i < 121) return null;
      const baseline = meanRange(candles, i - 1, 10);
      if (baseline <= 0) return null;

      // Compression: the ten bars before this one sit in the calmest third of
      // their own recent history, sampled sparsely as quietTrend does.
      const samples: number[] = [];
      for (let k = i - 11; k >= i - 111; k -= 10) {
        samples.push(meanRange(candles, k, 10));
      }
      samples.sort((a, b) => a - b);
      if (baseline > samples[Math.floor(samples.length / 3)]) return null;

      const range = candles[i].high - candles[i].low;
      if (range < 1.5 * baseline) return null;

      const body = candles[i].close - candles[i].open;
      if (body === 0) return null;
      return body > 0 ? "LONG" : "SHORT";
    },
  };
}

/**
 * Fade a directional closing streak.
 *
 * The claim: a run of consecutive same-direction closes on crypto is
 * over-extension of leveraged flow rather than information, and the close
 * after the streak reverts. Derived from measurement, and recorded here as
 * such: the 2026-08 batch scan found short-horizon momentum entries losing
 * far beyond their costs on BTC M5 (t = −15.8, zero of six windows), which
 * is this mechanism's shadow. Registered permanently whatever it scores —
 * a hypothesis added after one look and removed if it disappoints would be
 * indistinguishable from cherry-picking, so it stays in the fixed set and
 * every future scan corrects for having asked.
 *
 * Distinct from fadeCascade, which demands each bar be outsized; a streak is
 * persistence alone, however small the steps.
 */
function streakFade(bars: number): Hypothesis {
  return {
    name: `streak-fade-${bars}`,
    claim: `${bars} consecutive same-direction closes revert on the next bar.`,
    signal(candles, i) {
      if (i < bars) return null;
      const first = candles[i - bars + 1].close - candles[i - bars].close;
      if (first === 0) return null;
      const dir = Math.sign(first);
      for (let k = i - bars + 2; k <= i; k++) {
        const move = candles[k].close - candles[k - 1].close;
        if (Math.sign(move) !== dir) return null;
      }
      return dir > 0 ? "SHORT" : "LONG";
    },
  };
}

/**
 * The crypto catalogue, fixed and named, for the same reason the gold one is:
 * the Šidák correction is only honest if the count is what was actually tried.
 */
export const CRYPTO_HYPOTHESES: Hypothesis[] = [
  weekendDrift(6),
  weekendDrift(0),
  utcDayOpenRange(4),
  utcDayOpenRange(12),
  fadeCascade(3, 2),
  fadeCascade(4, 2),
  volumeThrust(3),
  volumeThrust(5),
  squeezeExpansion(),
  streakFade(3),
  streakFade(5),
];
