/**
 * Parameter sweep — grid expansion, risk-adjusted scoring, ranking.
 *
 * Ported from teo/backtest/sweep.py, with one substantive change: it scores
 * with the REAL strategy (runBacktest over analyzeCandles, net of per-asset
 * costs) rather than the Python EMA-crossover proxy. That proxy was never the
 * dashboard's strategy — on a random walk it fired 34 trades where the real one
 * fires none — so every ranking it produced described a different system.
 *
 * Running natively also removes the subprocess hop the Python side needed to
 * reach this code at all.
 */

import type { AssetDefinition } from "./assets";
import {
  type BacktestMetrics,
  computeMetrics,
  runBacktest,
  toBacktestModel,
} from "./backtest";
import type { Candle, StrategyConfig } from "./strategy";

/** Knobs worth sweeping, and the values to try. Small, because a sweep is O(product). */
export const DEFAULT_GRID: Partial<Record<keyof StrategyConfig, number[]>> = {
  atrSlMultiplier: [1.0, 1.5, 2.0],
  tp2R: [1.5, 2.5, 3.5],
  emaFast: [9, 12],
  emaMid: [21, 26],
};

export interface SweepResult {
  config: StrategyConfig;
  /** In-sample metrics — the window the config was selected on. */
  metrics: BacktestMetrics;
  score: number;
  /** Held-out metrics, when a split was requested. */
  outOfSample?: BacktestMetrics;
  /** Score of the held-out window. Undefined when no split was requested. */
  outOfSampleScore?: number;
}

export interface SweepOptions {
  base?: StrategyConfig;
  grid?: Partial<Record<keyof StrategyConfig, number[]>>;
  minTrades?: number;
  topK?: number;
  /**
   * Fraction of the window used for selection. The remainder is scored
   * separately so a candidate can be checked against data it did not choose.
   */
  splitRatio?: number;
}

/**
 * Sentinel base for configs that did not trade enough to be judged.
 *
 * It exists to keep `sort` total — untradeable configs must rank below every
 * real one — and it is a ranking device, not a measurement. Anything showing a
 * score to a human, or averaging one, must filter with `isScored` first;
 * reporting a regime's best score as -1000000000 is worse than reporting
 * nothing, because it looks like a finding.
 */
export const UNSCORED = -1e9;

/** Is this a real score, or the untradeable sentinel? */
export function isScored(score: number): boolean {
  return score > UNSCORED / 2;
}

/**
 * Risk-adjusted score. Higher is better; negative for losing configs.
 *
 * Rewards return per unit of drawdown, nudged by profit factor and win rate.
 *
 * The drawdown denominator is FLOORED, not merely made non-zero. Dividing by
 * `maxDrawdown + epsilon` meant a config that happened never to draw down
 * scored around 5e10 and dominated every ranking on what is usually a
 * small-sample accident. The floor scales off the trade sizes themselves, so it
 * means the same thing on a $3,400 gold contract as on a $15 LINK.
 *
 * Configs that did not trade enough to be trustworthy are pushed below
 * everything else, ordered among themselves by trade count so the ranking stays
 * stable rather than arbitrary.
 */
export function scoreMetrics(m: BacktestMetrics, minTrades = 10): number {
  if (m.trades < minTrades) return UNSCORED + m.trades;

  const floor = Math.max(Math.abs(m.avgWin), Math.abs(m.avgLoss), 1e-6);
  const calmar = m.netPoints / Math.max(m.maxDrawdown, floor);

  // A null profit factor means there were no losses at all. Treating it as 0
  // would rank a flawless config last; treating it as infinite would let one
  // lucky window dominate. 2.0 credits it as clearly good and no more.
  const pf = m.profitFactor ?? 2.0;

  return (
    Math.round((calmar + 0.5 * (pf - 1) + 0.25 * (m.winRate / 100)) * 1e6) / 1e6
  );
}

/** Every combination of the grid, merged onto `base`. */
export function expandGrid(
  base: StrategyConfig,
  grid: Partial<Record<keyof StrategyConfig, number[]>>,
): StrategyConfig[] {
  const keys = Object.keys(grid) as Array<keyof StrategyConfig>;
  let combos: StrategyConfig[] = [{ ...base }];

  for (const key of keys) {
    const values = grid[key];
    if (!values || values.length === 0) continue;
    const next: StrategyConfig[] = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [key]: value });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * Score every config in the grid against `candles`, best first.
 *
 * With `splitRatio`, configs are selected on the leading slice and additionally
 * scored on the held-out tail. The tail is replayed with the full preceding
 * history so its indicators match what the live engine would have computed at
 * that moment — a warm-up gap would make the held-out result artificially poor.
 */
export function runSweep(
  candles: Candle[],
  asset: AssetDefinition,
  options: SweepOptions = {},
): SweepResult[] {
  const base = options.base ?? asset.config;
  const grid = options.grid ?? DEFAULT_GRID;
  const minTrades = options.minTrades ?? 10;
  const topK = options.topK ?? 5;

  let splitIndex: number | null = null;
  if (options.splitRatio !== undefined) {
    if (options.splitRatio <= 0 || options.splitRatio >= 1) {
      throw new Error("splitRatio must be strictly between 0 and 1");
    }
    const candidate = Math.floor(candles.length * options.splitRatio);
    // Both sides need enough bars to mean anything; below that, decline to
    // split rather than report a held-out score computed from a handful of bars.
    if (candidate >= 61 && candles.length - candidate >= 30) {
      splitIndex = candidate;
    }
  }

  const inSample = splitIndex === null ? candles : candles.slice(0, splitIndex);

  const results: SweepResult[] = expandGrid(base, grid).map(config => {
    const metrics = computeMetrics(
      runBacktest(
        inSample,
        config,
        asset.pricePrecision,
        60,
        asset.costs,
        toBacktestModel(asset.model),
      ),
    );
    const result: SweepResult = {
      config,
      metrics,
      score: scoreMetrics(metrics, minTrades),
    };

    if (splitIndex !== null) {
      const oos = computeMetrics(
        runBacktest(
          candles,
          config,
          asset.pricePrecision,
          splitIndex,
          asset.costs,
          toBacktestModel(asset.model),
        ),
      );
      result.outOfSample = oos;
      result.outOfSampleScore = scoreMetrics(oos, minTrades);
    }
    return result;
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
