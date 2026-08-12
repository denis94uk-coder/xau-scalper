/**
 * Strategy discovery — search the parameter space for a configuration that
 * survives data it did not choose.
 *
 * WHAT MAKES THIS DIFFERENT FROM A SWEEP
 * `core/sweep.ts` scores a small hand-written grid. That is the right tool when
 * you already know which two knobs you want to move. It is the wrong tool for
 * "find me a strategy on NAS100 15m since 2024", because the grid is O(product)
 * and a meaningful search over twenty knobs would be astronomically large.
 *
 * So this samples instead of enumerating: random configurations drawn from
 * per-knob ranges, which covers a high-dimensional space far better than a grid
 * of the same budget. A grid spends its whole budget on a few values of each
 * knob; random search spends it on many.
 *
 * THE PART THAT MATTERS MORE THAN THE SEARCH
 * Searching thousands of configurations against one history and reporting the
 * best one is not research, it is guaranteed overfitting: with enough attempts
 * something always fits, and the winner's in-sample numbers describe the noise
 * it memorised. Three defences, all of them mandatory rather than optional:
 *
 *   1. THREE WINDOWS, not two. Configurations are selected on the training
 *      slice, filtered on validation, and the survivor is measured ONCE on a
 *      test slice it never influenced. A two-way split leaks, because choosing
 *      the best out-of-sample score makes that window part of the selection.
 *
 *   2. A MULTIPLE-COMPARISONS PENALTY. Trying N configurations and keeping the
 *      luckiest inflates significance by roughly N. The reported p-value is
 *      Šidák-corrected for how many were actually tried, so "significant"
 *      still means something after ten thousand attempts.
 *
 *   3. COSTS, ALWAYS. Every backtest is net of the instrument's real cost
 *      model, and the breakeven win rate is reported beside the achieved one.
 *      A discovery that beats a coin flip but not the spread is not a finding.
 *
 * A candidate that fails any of these is still returned, labelled with why.
 * Hiding rejected candidates would leave the operator unable to tell "the
 * search found nothing" from "the search was never run".
 */

import type { AssetDefinition } from "./assets";
import { type BacktestMetrics, computeMetrics, runBacktest } from "./backtest";
import { assessSignificance, type SignificanceReport } from "./significance";
import {
  type Candle,
  DEFAULT_STRATEGY_CONFIG,
  type StrategyConfig,
} from "./strategy";
import { scoreMetrics } from "./sweep";

/**
 * What each knob is allowed to be during a search.
 *
 * Ranges rather than value lists: the sampler draws continuously (rounded for
 * the integer knobs), so the search is not confined to values someone thought
 * of in advance. Bounds are the same "not nonsense" limits the settings page
 * enforces, narrowed where a value is legal but pointless to search — nobody
 * needs a 400-period EMA on a 15-minute scalp.
 */
export interface SearchSpace {
  [key: string]: { min: number; max: number; integer?: boolean } | undefined;
}

export const DEFAULT_SEARCH_SPACE: SearchSpace = {
  emaFast: { min: 5, max: 20, integer: true },
  emaMid: { min: 15, max: 60, integer: true },
  emaSlow: { min: 40, max: 200, integer: true },
  rsiPeriod: { min: 7, max: 28, integer: true },
  rsiOversold: { min: 15, max: 40 },
  rsiOverbought: { min: 60, max: 85 },
  macdFast: { min: 6, max: 20, integer: true },
  macdSlow: { min: 18, max: 52, integer: true },
  macdSignal: { min: 5, max: 15, integer: true },
  atrPeriod: { min: 7, max: 28, integer: true },
  atrSlMultiplier: { min: 0.8, max: 3.5 },
  atrTrailMultiplier: { min: 0.8, max: 4 },
  stochPeriod: { min: 7, max: 28, integer: true },
  stochOversold: { min: 10, max: 35 },
  stochOverbought: { min: 65, max: 90 },
  bollingerPeriod: { min: 10, max: 40, integer: true },
  bollingerStdDev: { min: 1.2, max: 3 },
  tp1R: { min: 0.6, max: 2.5 },
  tp2R: { min: 1.5, max: 6 },
  gradeAStrength: { min: 55, max: 85 },
  gradeBStrength: { min: 45, max: 75 },
  biasNeutralThreshold: { min: 5, max: 35 },
};

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeded rather than Math.random so a reported result can be reproduced. A
 * discovery you cannot re-run is an anecdote.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw one configuration from the space.
 *
 * Ordering constraints are repaired rather than rejected: a draw where the fast
 * EMA landed above the slow one is a perfectly good sample with its labels
 * swapped, and discarding it would quietly bias the search away from the
 * regions where the bounds overlap.
 */
export function sampleConfig(
  base: StrategyConfig,
  space: SearchSpace,
  rand: () => number,
): StrategyConfig {
  const out: StrategyConfig = { ...base };

  for (const [key, bound] of Object.entries(space)) {
    if (!bound) continue;
    const raw = bound.min + rand() * (bound.max - bound.min);
    const value = bound.integer
      ? Math.round(raw)
      : Math.round(raw * 1000) / 1000;
    (out as unknown as Record<string, number>)[key] = value;
  }

  // ── Repair the cross-field rules ──
  const emas = [out.emaFast, out.emaMid, out.emaSlow].sort((a, b) => a - b);
  // Distinct periods: two identical EMAs cannot disagree, so "aligned" would
  // become a tautology and the trend vote would fire on everything.
  out.emaFast = emas[0];
  out.emaMid = Math.max(emas[1], out.emaFast + 1);
  out.emaSlow = Math.max(emas[2], out.emaMid + 1);

  if (out.macdFast >= out.macdSlow) {
    const fast = Math.min(out.macdFast, out.macdSlow);
    const slow = Math.max(out.macdFast, out.macdSlow);
    out.macdFast = fast;
    out.macdSlow = Math.max(slow, fast + 1);
  }

  if (out.tp1R >= out.tp2R) {
    const lo = Math.min(out.tp1R, out.tp2R);
    const hi = Math.max(out.tp1R, out.tp2R);
    out.tp1R = lo;
    out.tp2R = Math.max(hi, lo + 0.1);
  }

  if (out.rsiOversold >= out.rsiOverbought) {
    const lo = Math.min(out.rsiOversold, out.rsiOverbought);
    const hi = Math.max(out.rsiOversold, out.rsiOverbought);
    out.rsiOversold = lo;
    out.rsiOverbought = Math.max(hi, lo + 1);
  }
  if (out.stochOversold >= out.stochOverbought) {
    const lo = Math.min(out.stochOversold, out.stochOverbought);
    const hi = Math.max(out.stochOversold, out.stochOverbought);
    out.stochOversold = lo;
    out.stochOverbought = Math.max(hi, lo + 1);
  }

  // Grade B must not be stricter than grade A, or B becomes unreachable and
  // the search silently loses half its trades.
  if (out.gradeBStrength > out.gradeAStrength) {
    out.gradeBStrength = out.gradeAStrength;
  }
  out.gradeCStrength = Math.min(out.gradeCStrength, out.gradeBStrength);

  return out;
}

/** Why a candidate did not qualify, or that it did. */
export type CandidateVerdict =
  | "qualified"
  | "too_few_trades"
  | "unprofitable_in_sample"
  | "failed_validation"
  | "failed_test"
  | "not_significant"
  | "below_breakeven";

export interface Candidate {
  config: StrategyConfig;
  /** Selection window. */
  train: BacktestMetrics;
  /** Filtering window. */
  validation: BacktestMetrics;
  /** Measured once, after selection. The only honest estimate here. */
  test: BacktestMetrics;
  /** All three windows combined, for a headline the operator will ask for. */
  overall: BacktestMetrics;
  /** Risk-adjusted score on the training window. */
  score: number;
  /** Significance of the combined record, corrected for the search size. */
  significance: SignificanceReport;
  /** p-value after the multiple-comparisons correction. */
  adjustedPValue: number;
  verdict: CandidateVerdict;
  /** One sentence an operator can act on. */
  summary: string;
}

export interface DiscoveryOptions {
  /** Configurations to try. */
  iterations?: number;
  space?: SearchSpace;
  base?: StrategyConfig;
  seed?: number;
  /** Minimum trades in each window before a candidate is believed. */
  minTrades?: number;
  /** Candidates to return. */
  topK?: number;
  /** Fractions of the history used for training and validation. */
  trainRatio?: number;
  validationRatio?: number;
  /** Called with progress in [0,1] so a long run can report to the UI. */
  onProgress?: (done: number, total: number) => void;
  /** Checked between iterations so a run can be cancelled. */
  shouldStop?: () => boolean;
}

export interface DiscoveryReport {
  asset: string;
  interval: string;
  bars: number;
  from: number;
  to: number;
  iterations: number;
  /** Iterations actually completed — lower when a run was cancelled. */
  evaluated: number;
  seed: number;
  split: { train: number; validation: number; test: number };
  candidates: Candidate[];
  /** The best QUALIFIED candidate, or null when nothing survived. */
  best: Candidate | null;
  /** Plain-language conclusion, including the honest null result. */
  conclusion: string;
}

/** Metrics over a window, using the full preceding history for warm-up. */
function metricsFor(
  candles: Candle[],
  config: StrategyConfig,
  asset: AssetDefinition,
  startIndex: number,
  endIndex: number,
): BacktestMetrics {
  // The replay is given every bar up to `endIndex` so indicators are warm, but
  // only trades from `startIndex`. Slicing the window out instead would cost
  // each split its warm-up and make later windows look worse than they were.
  return computeMetrics(
    runBacktest(
      candles.slice(0, endIndex),
      config,
      asset.pricePrecision,
      startIndex,
      asset.costs,
    ),
  );
}

/**
 * Šidák correction: the chance that the best of `n` independent attempts looks
 * this good by luck.
 *
 * Used rather than Bonferroni because it is exact for independent tests and
 * does not saturate at 1 as quickly, which matters when n is in the thousands.
 * The configurations are not strictly independent — neighbouring parameters
 * produce correlated results — so this is conservative in the safe direction.
 */
export function adjustPValue(p: number, n: number): number {
  if (n <= 1) return p;
  return 1 - (1 - p) ** n;
}

/**
 * Search for a strategy on one history.
 *
 * Synchronous and CPU-bound by design: the caller runs it off the request path
 * and reports progress through `onProgress`.
 */
export function discover(
  candles: Candle[],
  asset: AssetDefinition,
  options: DiscoveryOptions = {},
): DiscoveryReport {
  const iterations = options.iterations ?? 500;
  const space = options.space ?? DEFAULT_SEARCH_SPACE;
  const base = options.base ?? asset.config ?? DEFAULT_STRATEGY_CONFIG;
  const seed = options.seed ?? 1;
  const minTrades = options.minTrades ?? 20;
  const topK = options.topK ?? 10;
  const trainRatio = options.trainRatio ?? 0.5;
  const validationRatio = options.validationRatio ?? 0.25;

  const n = candles.length;
  const trainEnd = Math.floor(n * trainRatio);
  const validationEnd = Math.floor(n * (trainRatio + validationRatio));

  const emptyReport = (conclusion: string): DiscoveryReport => ({
    asset: asset.id,
    interval: "",
    bars: n,
    from: candles[0]?.time ?? 0,
    to: candles.at(-1)?.time ?? 0,
    iterations,
    evaluated: 0,
    seed,
    split: {
      train: trainEnd,
      validation: validationEnd - trainEnd,
      test: n - validationEnd,
    },
    candidates: [],
    best: null,
    conclusion,
  });

  // Each window needs the 60-bar warm-up plus room to actually trade. Below
  // that the numbers would be arithmetic on noise, and reporting them as a
  // three-way validation would be a lie about how much was checked.
  if (
    trainEnd < 200 ||
    validationEnd - trainEnd < 100 ||
    n - validationEnd < 100
  ) {
    return emptyReport(
      `Not enough history: ${n} bars split into ${trainEnd}/${validationEnd - trainEnd}/${n - validationEnd}. ` +
        "A three-way validation needs roughly 800 bars to mean anything — widen the date range.",
    );
  }

  const rand = rng(seed);
  const evaluated: Candidate[] = [];
  let count = 0;

  for (let i = 0; i < iterations; i++) {
    if (options.shouldStop?.()) break;
    count++;

    const config = sampleConfig(base, space, rand);
    const train = metricsFor(candles, config, asset, 60, trainEnd);

    // Cheap rejections first: a configuration that did not trade or lost money
    // on the window it was chosen from cannot become interesting later, and
    // skipping its other two backtests is most of the run's speed.
    if (train.trades < minTrades) {
      evaluated.push(
        reject(
          config,
          train,
          "too_few_trades",
          `Only ${train.trades} trades in training — too few to judge.`,
        ),
      );
      continue;
    }
    if (train.netPoints <= 0) {
      evaluated.push(
        reject(
          config,
          train,
          "unprofitable_in_sample",
          "Lost money on its own training window, after costs.",
        ),
      );
      continue;
    }

    const validation = metricsFor(
      candles,
      config,
      asset,
      trainEnd,
      validationEnd,
    );
    const test = metricsFor(candles, config, asset, validationEnd, n);
    const overall = metricsFor(candles, config, asset, 60, n);

    const score = scoreMetrics(train, minTrades);
    const decided = overall.wins + overall.losses;
    const breakeven = overall.breakevenWinRate ?? 50;
    const significance = assessSignificance(overall.wins, decided, breakeven);
    const adjustedPValue = adjustPValue(significance.pValue, iterations);

    let verdict: CandidateVerdict = "qualified";
    let summary = "";

    if (validation.netPoints <= 0) {
      verdict = "failed_validation";
      summary =
        "Profitable in training and not on the next window — the usual signature of a fit to noise.";
    } else if (test.netPoints <= 0) {
      verdict = "failed_test";
      summary =
        "Survived validation but lost on the untouched test window, which is the only unbiased look.";
    } else if (overall.winRate <= breakeven) {
      verdict = "below_breakeven";
      summary = `Won ${overall.winRate.toFixed(1)}% against a ${breakeven.toFixed(1)}% cost-adjusted breakeven.`;
    } else if (adjustedPValue > 0.05) {
      verdict = "not_significant";
      summary =
        `Profitable in all three windows, but after correcting for ${iterations} attempts ` +
        `the record is still consistent with luck (p = ${adjustedPValue.toFixed(3)}).`;
    } else {
      summary =
        `Profitable in training, validation AND the untouched test window; ` +
        `${overall.winRate.toFixed(1)}% win rate against a ${breakeven.toFixed(1)}% breakeven, ` +
        `p = ${adjustedPValue.toFixed(4)} after correcting for ${iterations} attempts.`;
    }

    evaluated.push({
      config,
      train,
      validation,
      test,
      overall,
      score,
      significance,
      adjustedPValue,
      verdict,
      summary,
    });

    options.onProgress?.(i + 1, iterations);
  }

  // Qualified candidates first, then by how they did on the window that was
  // never used to choose them. Ranking everything by training score would put
  // the best-memorised configuration on top, which is precisely the answer this
  // whole module exists to avoid giving.
  const rank = (c: Candidate) =>
    (c.verdict === "qualified" ? 1e9 : 0) + c.test.netPoints;
  evaluated.sort((a, b) => rank(b) - rank(a));

  const best = evaluated.find(c => c.verdict === "qualified") ?? null;
  const qualified = evaluated.filter(c => c.verdict === "qualified").length;

  return {
    asset: asset.id,
    interval: "",
    bars: n,
    from: candles[0]?.time ?? 0,
    to: candles.at(-1)?.time ?? 0,
    iterations,
    evaluated: count,
    seed,
    split: {
      train: trainEnd,
      validation: validationEnd - trainEnd,
      test: n - validationEnd,
    },
    candidates: evaluated.slice(0, topK),
    best,
    conclusion: best
      ? `${qualified} of ${count} configurations survived all three windows and the search-size correction. ` +
        `The best made ${best.test.netPoints.toFixed(1)} points on the untouched test window over ${best.test.trades} trades. ` +
        "That is evidence, not a guarantee: it is still one instrument over one period."
      : `None of ${count} configurations survived. That is a real result, and the common one — ` +
        "most parameter sets that look good on a training window do not survive the next one, " +
        "which is exactly what this three-way split exists to reveal.",
  };
}

/** A candidate rejected before its later windows were worth computing. */
function reject(
  config: StrategyConfig,
  train: BacktestMetrics,
  verdict: CandidateVerdict,
  summary: string,
): Candidate {
  const empty = computeMetrics([]);
  return {
    config,
    train,
    validation: empty,
    test: empty,
    overall: train,
    score: Number.NEGATIVE_INFINITY,
    significance: assessSignificance(0, 0, 50),
    adjustedPValue: 1,
    verdict,
    summary,
  };
}
