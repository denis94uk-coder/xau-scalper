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
import { hourOf, isSessionOpen, meanAbsMove } from "./hypotheses";
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

/** UTC midnight of the day containing `time`, in seconds. */
export function dayStartOf(time: number): number {
  return Math.floor(time / 86400) * 86400;
}

/**
 * High and low of the UTC day strictly before bar `i`'s day.
 *
 * Walks backwards from `i - 1` until it leaves that day, so it never reads a
 * bar past `i`. Returns null when history does not reach back a full day —
 * an unmeasurable level is no level.
 */
function priorDayExtremes(
  candles: Candle[],
  i: number,
): { hi: number; lo: number } | null {
  if (i < 1) return null;
  const dayStart = dayStartOf(candles[i].time);
  const prevStart = dayStart - 86400;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = i - 1; k >= 0; k--) {
    const t = candles[k].time;
    if (t < prevStart) break;
    if (t < dayStart) {
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
  }
  return hi === -Infinity ? null : { hi, lo };
}

/** Asian hours end at 07:00 UTC, matching the gold catalogue's asia block. */
export const ASIAN_HOURS = 7;

/**
 * High and low of the Asian-hours window (00:00–07:00 UTC) of the day whose
 * midnight is `ds`, reading only bars at or before `i`.
 */
export function asianRangeOf(
  candles: Candle[],
  i: number,
  ds: number,
): { hi: number; lo: number } | null {
  const asianEnd = ds + ASIAN_HOURS * 3600;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = i; k >= 0; k--) {
    const t = candles[k].time;
    if (t < ds) break;
    if (t >= ds && t < asianEnd) {
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
  }
  return hi === -Infinity ? null : { hi, lo };
}

/**
 * Fade a sweep of the prior UTC day's extreme.
 *
 * The claim, taken from the operator's own execution plan and stated so the
 * scanner can measure it: retail stops pile just beyond yesterday's visible
 * high and low, thin books get pushed through those levels at some point in
 * the session, and once the stops are spent there is nothing left to push —
 * so a bar that trades through the level but CLOSES back inside marks
 * exhaustion rather than breakout. The close-back-inside requirement is what
 * separates the claimed stop-run from genuine continuation: a bar that closes
 * beyond the level fires nothing.
 *
 * One hypothesis covers both levels — LONG off the swept low, SHORT off the
 * swept high — because they are one symmetric mechanism, and registering them
 * apart would spend two budget slots printing the same fact twice. The
 * two-sided p-value already prices both directions.
 */
function sweepPriorDay(): Hypothesis {
  return {
    name: "sweep-prior-day",
    claim:
      "A bar that trades through the prior UTC day's high or low but closes back inside reverts away from the level.",
    signal(candles, i) {
      const ext = priorDayExtremes(candles, i);
      if (!ext) return null;
      const c = candles[i];
      if (c.low < ext.lo && c.close > ext.lo) return "LONG";
      if (c.high > ext.hi && c.close < ext.hi) return "SHORT";
      return null;
    },
  };
}

/**
 * Compressed-Asian-range breakout.
 *
 * The claim, shared by both of the operator's documents: when the overnight
 * (00:00–07:00 UTC) range is unusually narrow, positioning has compressed
 * with it, and the first close outside that range releases stored pressure in
 * the breakout direction through London and New York. The compression gate is
 * what distinguishes this from utc-day-open-range, which died in rounds 1–2:
 * that tested every day's opening range regardless of width, this only the
 * calm ones. Narrow means below the median width of the six prior days'
 * Asian ranges, which makes the gate self-scaling across timeframes.
 *
 * Fires on the crossing bar only — the previous close must still be inside —
 * so one breakout is one occurrence rather than a run.
 */
function asianRangeBreakout(): Hypothesis {
  return {
    name: "asian-range-breakout",
    claim:
      "When the 00:00–07:00 UTC range sits below its recent median width, the first close outside it during London/NY continues.",
    signal(candles, i) {
      const h = hourOf(candles[i]);
      // Breakouts are read between 07:00 and 15:00 UTC: after Asian hours
      // close but before the NY afternoon, past which a stale crossing has
      // nothing left to say and would only duplicate occurrences.
      if (h < ASIAN_HOURS || h >= 15 || i < 1) return null;
      const dayStart = dayStartOf(candles[i].time);
      const today = asianRangeOf(candles, i, dayStart);
      if (!today) return null;

      const samples: number[] = [];
      for (let d = 1; d <= 6; d++) {
        const r = asianRangeOf(candles, i, dayStart - d * 86400);
        if (r) samples.push(r.hi - r.lo);
      }
      if (samples.length < 4) return null;
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      const width = today.hi - today.lo;
      if (width <= 0 || width >= median) return null;

      const prevClose = candles[i - 1].close;
      if (!(prevClose <= today.hi && prevClose >= today.lo)) return null;

      const c = candles[i];
      if (c.close > today.hi) return "LONG";
      if (c.close < today.lo) return "SHORT";
      return null;
    },
  };
}

/**
 * Fade the opening drive at a session open.
 *
 * The operator's plan states this as the base mechanism of their whole
 * strategy: limit orders and stops accumulate just outside the pre-open range,
 * the open pushes through them because the book is thinnest exactly then, and
 * the move stops where real liquidity begins — so the first hour's direction
 * is a stop-run against the session's true direction, and fading it is the
 * trade.
 *
 * The drive is measured open-to-close across the first hour after `hour`:00
 * UTC; the signal fires once, on the first bar completing that hour, entering
 * against the drive. On hourly bars the completion bar sits just after the
 * drive's last bar; on finer bars it is the first bar past 60 minutes, so the
 * entry never uses information from inside the measured window.
 *
 * London (07:00) and New York (13:00, equities cash open) are separate
 * registrations not because the mechanism differs but because the
 * participants do — the same precedent as london/newyork-open-range in the
 * gold catalogue.
 */
function fadeOpenDrive(hour: number, label: string): Hypothesis {
  return {
    name: `fade-${label}-drive`,
    claim: `The first hour after ${label} open (${hour}:00 UTC) sweeps stops against the session direction; fade it.`,
    signal(candles, i) {
      if (i < 1) return null;
      const openTime = dayStartOf(candles[i].time) + hour * 3600;
      if (candles[i].time < openTime + 3600) return null;
      // Only the first bar whose timestamp completes the hour: later session
      // bars are not new events, and firing on each would let one morning
      // print several correlated occurrences.
      if (candles[i - 1].time >= openTime + 3600) return null;

      let firstOpen = -1;
      for (let k = i - 1; k >= 0; k--) {
        const t = candles[k].time;
        if (t < openTime) break;
        if (t < openTime + 3600) firstOpen = candles[k].open;
      }
      if (firstOpen < 0) return null;
      const drive = candles[i - 1].close - firstOpen;
      if (drive === 0) return null;
      return drive > 0 ? "SHORT" : "LONG";
    },
  };
}

/**
 * Trade WITH a close beyond the prior UTC day's extreme.
 *
 * Registered 2026-08-24 as a measurement-derived claim, the way streak-fade
 * was: round 6 found this claim's mirror — sweep-prior-day — losing at ZERO
 * cost on BTCUSDT M15 (gross −35 pts/hold, t = −4.37, 0/6 windows), which is
 * evidence that prior-day breakouts continued there rather than reverted. A
 * hypothesis added after one look and removed if it disappoints would be
 * indistinguishable from cherry-picking, so it enters the fixed set here,
 * declared as derived, and stays registered whatever it scores.
 *
 * The event is the complement of sweep-prior-day's: a bar whose CLOSE sits
 * beyond the prior day's high or low. The firing sets are disjoint by
 * construction — together the two hypotheses partition every pierce of the
 * prior day's extremes into "closed back inside" (faded) and "closed beyond"
 * (traded here).
 */
function breakPriorDay(): Hypothesis {
  return {
    name: "break-prior-day",
    claim:
      "A bar that closes beyond the prior UTC day's high or low continues in that direction.",
    signal(candles, i) {
      const ext = priorDayExtremes(candles, i);
      if (!ext) return null;
      const c = candles[i];
      if (c.close > ext.hi) return "LONG";
      if (c.close < ext.lo) return "SHORT";
      return null;
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
  // Registered 2026-08-24 from the operator's two strategy documents, before
  // any scan was run with them in the set. They stay registered whatever they
  // score.
  sweepPriorDay(),
  breakPriorDay(),
  asianRangeBreakout(),
  fadeOpenDrive(7, "london"),
  fadeOpenDrive(13, "ny"),
];
