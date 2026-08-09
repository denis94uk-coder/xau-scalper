/**
 * Self-heal decision: is the running config degraded, and is there a
 * demonstrably better one?
 *
 * Ported from teo/selfheal.py. Pure decision logic — fetching and orchestration
 * live elsewhere, so this is fully testable from fixtures.
 *
 * It proposes; it never applies. A system that silently rewrites its own trading
 * parameters is one you cannot reason about after the fact.
 */

import type { BacktestMetrics } from "./backtest";
import type { Regime } from "./regime";
import type { StrategyConfig } from "./strategy";
import { type SweepResult, scoreMetrics } from "./sweep";

export interface HealthThresholds {
  /** Below this profit factor on recent data, the config is degraded. */
  minProfitFactor: number;
  /** Below this win rate (0-1) on recent data, the config is degraded. */
  minWinRate: number;
  /** Fewer trades than this and there is nothing to judge. */
  minTrades: number;
  /** A candidate must beat the current score by at least this to be proposed. */
  minScoreImprovement: number;
  /**
   * Require the candidate to hold up on data it was NOT selected on.
   *
   * Without this the loop proposes swaps on noise. Best-of-N on a single window
   * measures selection luck: on a synthetic random walk with no signal at all,
   * the in-sample "improvement" cleared the threshold by 14x. Disable only
   * knowingly.
   */
  requireOutOfSample: boolean;
  /** Minimum held-out score for a candidate to be proposed. */
  minOutOfSampleScore: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  minProfitFactor: 1.0,
  minWinRate: 0.3,
  minTrades: 10,
  minScoreImprovement: 0.15,
  requireOutOfSample: true,
  minOutOfSampleScore: 0,
};

export type HealthStatus = "healthy" | "degraded" | "insufficient_data";
export type HealthAction = "hold" | "propose_swap";

export interface HealthDecision {
  status: HealthStatus;
  action: HealthAction;
  /** Plain-language explanation, suitable for the journal. */
  reason: string;
  currentScore: number;
  proposedConfig: StrategyConfig | null;
  proposedScore: number | null;
  improvement: number | null;
}

/** Format a profit factor for humans; null means there were no losing trades. */
function pf(value: number | null): string {
  return value === null ? "n/a (no losing trades)" : value.toFixed(2);
}

function hold(
  status: HealthStatus,
  reason: string,
  currentScore: number,
  improvement: number | null = null,
): HealthDecision {
  return {
    status,
    action: "hold",
    reason,
    currentScore,
    proposedConfig: null,
    proposedScore: null,
    improvement,
  };
}

/**
 * Compare the running config against the best swept candidate.
 *
 * `candidate` is expected to carry `outOfSampleScore` when the sweep was run
 * with a split. Absent that, and with `requireOutOfSample` set, no swap is
 * proposed — an unvalidated candidate is treated as no candidate.
 */
export function assess(
  current: BacktestMetrics,
  candidate: SweepResult | null,
  options: { regime?: Regime; thresholds?: HealthThresholds } = {},
): HealthDecision {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS;
  const regimeNote = options.regime ? ` (regime: ${options.regime.label})` : "";
  const currentScore = scoreMetrics(current, t.minTrades);

  if (current.trades < t.minTrades) {
    return hold(
      "insufficient_data",
      `only ${current.trades} trades (< ${t.minTrades}); not enough to judge`,
      currentScore,
    );
  }

  // A null profit factor means nothing was lost, which is not degradation.
  const profitFactorOk =
    current.profitFactor === null || current.profitFactor >= t.minProfitFactor;
  const winRateOk = current.winRate / 100 >= t.minWinRate;

  if (profitFactorOk && winRateOk) {
    return hold(
      "healthy",
      `profit factor ${pf(current.profitFactor)} ≥ ${t.minProfitFactor} and ` +
        `win rate ${current.winRate.toFixed(0)}% ≥ ${(t.minWinRate * 100).toFixed(0)}%`,
      currentScore,
    );
  }

  if (!candidate) {
    return hold(
      "degraded",
      "degraded, but the sweep found no candidate to evaluate",
      currentScore,
    );
  }

  const improvement = Math.round((candidate.score - currentScore) * 1e6) / 1e6;

  if (t.requireOutOfSample) {
    if (candidate.outOfSampleScore === undefined) {
      return hold(
        "degraded",
        "degraded, but the candidate was not validated out of sample — " +
          `holding rather than swapping on in-sample fit${regimeNote}`,
        currentScore,
        improvement,
      );
    }
    if (candidate.outOfSampleScore < t.minOutOfSampleScore) {
      return hold(
        "degraded",
        `degraded, and the best candidate improves in-sample by ${improvement.toFixed(3)} ` +
          `but scores ${candidate.outOfSampleScore.toFixed(3)} out of sample — ` +
          `that is selection noise, not edge${regimeNote}`,
        currentScore,
        improvement,
      );
    }
  }

  if (improvement < t.minScoreImprovement) {
    return hold(
      "degraded",
      `degraded, but no candidate clears the ${t.minScoreImprovement} improvement bar ` +
        `(best gain ${improvement.toFixed(3)})${regimeNote}`,
      currentScore,
      improvement,
    );
  }

  const oosNote =
    candidate.outOfSampleScore !== undefined
      ? `, held up out of sample at ${candidate.outOfSampleScore.toFixed(3)}`
      : "";

  return {
    status: "degraded",
    action: "propose_swap",
    reason:
      `degraded — best swept config improves score by ${improvement.toFixed(3)} ` +
      `(${currentScore.toFixed(3)} → ${candidate.score.toFixed(3)})${oosNote}${regimeNote}`,
    currentScore,
    proposedConfig: candidate.config,
    proposedScore: candidate.score,
    improvement,
  };
}
