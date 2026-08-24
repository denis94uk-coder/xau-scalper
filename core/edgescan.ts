/**
 * A hypothesis scanner, for finding an edge rather than tuning one.
 *
 * WHY THIS IS NOT ANOTHER BACKTEST
 * runBacktest answers "what would this strategy have made". That question is
 * only worth asking once something in the signal predicts the next few bars,
 * and the six indicators already in the system do not: split into families,
 * swept, and walked forward, XAUUSD M5 and M15 both landed on their own
 * breakeven win rate — the signature of entries that carry no information.
 *
 * Exit geometry is what makes that hard to see. A backtest mixes the question
 * "does the entry predict anything" with "is the stop in the right place", and
 * a bad answer to the second hides a good answer to the first. So this measures
 * the entry alone: take the direction the hypothesis names, hold a fixed number
 * of bars, close at the market. No stop, no target, no trailing. Whatever
 * survives here has a real directional signal in it and can then be given an
 * exit; whatever does not cannot be rescued by one.
 *
 * WHY THE MULTIPLE-TESTING CORRECTION IS NOT OPTIONAL
 * Scanning twenty hypotheses at p < 0.05 produces roughly one "significant"
 * result from pure noise, every time, by construction. Reporting that result
 * without saying how many were tried is the single most reliable way to invent
 * an edge that does not exist. `scanEdges` therefore takes the whole set at
 * once and reports the Šidák-adjusted threshold alongside each raw p-value, so
 * the count of tests is never separable from the finding.
 */

import { type CostModel, type ExitKind, roundTripCost } from "./costs";
import type { Candle, Direction } from "./strategy";

/**
 * A directional claim about the next few bars.
 *
 * `signal` sees the bars up to and including `i` and returns the direction it
 * claims, or null for "no opinion here". It must never read past `i` —
 * everything in this module is worthless the moment a hypothesis does.
 */
export interface Hypothesis {
  name: string;
  /** What is being claimed, in words, so a result can be argued with. */
  claim: string;
  signal(candles: Candle[], i: number): Direction | null;
}

export interface EdgeResult {
  name: string;
  claim: string;
  /** Number of times the hypothesis fired. */
  n: number;
  /** Mean net points per occurrence, after a round trip's costs. */
  meanNet: number;
  /** Standard deviation of the per-occurrence net result. */
  stdev: number;
  /**
   * meanNet / standard error. Not a p-value: it is the raw distance from zero
   * in standard errors, kept because it is comparable across hypotheses that
   * fired very different numbers of times.
   */
  tStat: number;
  /** Two-sided, from the normal approximation. See `normalTwoSided`. */
  pValue: number;
  /** Fraction of occurrences that were net positive. */
  hitRate: number;
  /**
   * Mean of the worst decile of occurrences.
   *
   * Two hypotheses can share a mean and be nothing alike to trade. The common
   * claim that counter-trend scalping "kills" a system is usually not a claim
   * about expectancy at all — it is that the losses arrive in a shape a stop
   * cannot survive, which a mean hides completely. This is the crudest honest
   * summary of that shape: what the bad tail actually costs.
   */
  worstDecile: number;
  /** Sign of meanNet per window, when windows were requested. */
  windowsPositive: number;
  windowsJudged: number;
  /**
   * Did this fire enough times for the statistic to describe anything?
   *
   * Below MIN_OCCURRENCES the t and p columns are arithmetic performed on too
   * little to mean anything, and printing them next to measured rows invites
   * exactly the misreading this module exists to prevent — a hypothesis that
   * fired four times for +6.13 points reads as the best line on the screen.
   */
  measured: boolean;
}

export interface ScanReport {
  results: EdgeResult[];
  hypothesesTested: number;
  /**
   * The per-test p-value a result must beat for the SET to hold at `familyAlpha`.
   * Šidák: 1 - (1 - alpha)^(1/m). Slightly less brutal than Bonferroni and
   * exact when the tests are independent, which these roughly are not — treat
   * it as a floor on how strict to be, not a ceiling.
   */
  adjustedAlpha: number;
  familyAlpha: number;
  horizonBars: number;
}

/**
 * Two-sided p-value from a z-score, via the Abramowitz-Stegun 7.1.26 erf.
 *
 * A normal approximation rather than an exact test, because the statistic here
 * is a mean of continuous returns and no exact small-sample distribution
 * applies without assuming one. It is accurate to ~1e-7 in the erf itself; the
 * approximation that matters is the central-limit step, which needs n in the
 * hundreds. `scanEdges` refuses to report below MIN_OCCURRENCES for that reason.
 */
export function normalTwoSided(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.min(1, Math.max(0, 1 - y));
}

/**
 * Below this many occurrences a hypothesis is not reported as measured.
 *
 * The central-limit step above needs it, and more practically: gold's per-bar
 * returns are fat-tailed, so a mean over a few dozen bars is usually describing
 * one or two bars.
 */
export const MIN_OCCURRENCES = 100;

/**
 * Measure one hypothesis over one span of bars.
 *
 * Occurrences are non-overlapping: after a signal at `i` the scan resumes at
 * `i + horizon`. Overlapping holds share bars, so their results are correlated,
 * and a t-statistic computed across them counts the same evidence several times
 * — which inflates significance exactly where it is least deserved.
 */
function measure(
  candles: Candle[],
  h: Hypothesis,
  horizon: number,
  costs: CostModel,
  from: number,
  to: number,
  exitKind: ExitKind,
): { nets: number[] } {
  const nets: number[] = [];
  let i = from;
  while (i < to - horizon) {
    const dir = h.signal(candles, i);
    if (dir === null) {
      i++;
      continue;
    }
    const entry = candles[i].close;
    const exit = candles[i + horizon].close;
    const gross = dir === "LONG" ? exit - entry : entry - exit;
    // A flat time-based exit is a market order at both ends, so both legs pay
    // the crossing cost. "TP" would price the exit as a resting limit fill,
    // which this is not — unless the caller asks for that lens explicitly via
    // ScanOptions.exitKind, which is how the cost-sensitivity pass brackets
    // what a strategy with a limit-style exit could achieve.
    nets.push(gross - roundTripCost(entry, exit, exitKind, costs));
    i += horizon;
  }
  return { nets };
}

function summarise(nets: number[]): {
  meanNet: number;
  stdev: number;
  tStat: number;
  pValue: number;
  hitRate: number;
  worstDecile: number;
} {
  const n = nets.length;
  if (n === 0) {
    return {
      meanNet: 0,
      stdev: 0,
      tStat: 0,
      pValue: 1,
      hitRate: 0,
      worstDecile: 0,
    };
  }
  const mean = nets.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? nets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  const se = stdev / Math.sqrt(n);
  const tStat = se > 0 ? mean / se : 0;
  return {
    meanNet: mean,
    stdev,
    tStat,
    pValue: se > 0 ? normalTwoSided(tStat) : 1,
    hitRate: (nets.filter(v => v > 0).length / n) * 100,
    worstDecile: worstDecileOf(nets),
  };
}

/** Mean of the worst 10% of results, or of the single worst when n is tiny. */
function worstDecileOf(nets: number[]): number {
  const sorted = [...nets].sort((a, b) => a - b);
  const take = Math.max(1, Math.floor(sorted.length / 10));
  return sorted.slice(0, take).reduce((a, b) => a + b, 0) / take;
}

export interface ScanOptions {
  /** Bars held after entry. */
  horizonBars?: number;
  /** Bars skipped at the start, for any warm-up a hypothesis needs. */
  warmup?: number;
  /** Consecutive spans checked for sign consistency. 0 disables. */
  windows?: number;
  /** Significance demanded of the SET, before the Šidák adjustment. */
  familyAlpha?: number;
  /**
   * How the exit leg is priced. Default "TRAIL_SL": the time exit is a market
   * order into whatever is moving against you — spread, taker fee and stop
   * slippage all paid, the most expensive honest assumption. "TP" prices it
   * as a resting limit: maker fee only, the cheapest exit a strategy with
   * limit-style take-profits could achieve. The truth of any eventual strategy
   * sits between the two lenses; run both before declaring an entry dead.
   */
  exitKind?: ExitKind;
}

/**
 * Run every hypothesis over the same bars, at the same costs, and report the
 * set together with the threshold its size demands.
 *
 * Ordered by |t|, largest first — deliberately NOT by mean points. A hypothesis
 * that fired eleven times for a huge average is the thing this module exists to
 * stop someone trading, and sorting by return puts it at the top of the screen.
 * Hypotheses that did not fire enough to be measured sort below every one that
 * did, whatever their arithmetic says, for the same reason.
 */
export function scanEdges(
  candles: Candle[],
  hypotheses: Hypothesis[],
  costs: CostModel,
  options: ScanOptions = {},
): ScanReport {
  const horizon = options.horizonBars ?? 12;
  const warmup = options.warmup ?? 60;
  const windows = options.windows ?? 0;
  const familyAlpha = options.familyAlpha ?? 0.05;
  const exitKind = options.exitKind ?? "TRAIL_SL";

  const results: EdgeResult[] = hypotheses.map(h => {
    const { nets } = measure(
      candles,
      h,
      horizon,
      costs,
      warmup,
      candles.length,
      exitKind,
    );
    const s = summarise(nets);

    let windowsPositive = 0;
    let windowsJudged = 0;
    if (windows > 0) {
      const span = Math.floor((candles.length - warmup) / windows);
      for (let w = 0; w < windows && span > horizon * 2; w++) {
        const from = warmup + w * span;
        const to = w === windows - 1 ? candles.length : from + span;
        const part = measure(candles, h, horizon, costs, from, to, exitKind);
        if (part.nets.length === 0) continue;
        windowsJudged++;
        const m = part.nets.reduce((a, b) => a + b, 0) / part.nets.length;
        if (m > 0) windowsPositive++;
      }
    }

    return {
      name: h.name,
      claim: h.claim,
      n: nets.length,
      ...s,
      windowsPositive,
      windowsJudged,
      measured: nets.length >= MIN_OCCURRENCES,
    };
  });

  results.sort((a, b) => {
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    return Math.abs(b.tStat) - Math.abs(a.tStat);
  });

  const m = Math.max(1, hypotheses.length);
  return {
    results,
    hypothesesTested: hypotheses.length,
    adjustedAlpha: 1 - (1 - familyAlpha) ** (1 / m),
    familyAlpha,
    horizonBars: horizon,
  };
}

/**
 * Does this result clear the bar, given how many hypotheses were tried?
 *
 * Three conditions, all required. Enough occurrences for the statistic to mean
 * anything; a p-value below the Šidák-adjusted threshold; and a sign that held
 * in most windows — because a single profitable stretch will clear the first
 * two on its own and is the most common way a scan of this kind lies.
 */
export function survives(r: EdgeResult, report: ScanReport): boolean {
  if (!r.measured) return false;
  if (r.pValue > report.adjustedAlpha) return false;
  if (r.windowsJudged >= 3 && r.windowsPositive * 2 <= r.windowsJudged) {
    return false;
  }
  return r.meanNet > 0;
}
