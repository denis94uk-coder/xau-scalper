"""Self-healing decision logic.

Given the *current* config's recent performance and a fresh parameter sweep, decide whether the
strategy is healthy or degraded, and — if degraded — whether a swept candidate is enough of an
improvement to propose swapping in. Every proposal is tagged with the current market regime so the
dashboard can log *why* it fired and in what conditions. Pure decision logic; orchestration (data
fetch) lives in the API layer.
"""

from __future__ import annotations

from dataclasses import dataclass

from teo.backtest.regime import Regime
from teo.backtest.sweep import SweepResult, score_metrics
from teo.models import BacktestMetrics, StrategyConfig


@dataclass(frozen=True)
class HealthThresholds:
    """A config is 'degraded' if it breaches ANY of these on recent data."""

    min_profit_factor: float = 1.0
    min_win_rate: float = 0.30
    min_trades: int = 10
    # A candidate must beat the current score by at least this margin to be proposed.
    min_score_improvement: float = 0.15
    # A candidate must also hold up on data it was NOT selected on.
    #
    # Without this the sweep proposes swaps on pure noise: picking the best of
    # 36 configs on one window and calling the gain "improvement" measures
    # selection luck, not edge. Measured on a synthetic random walk with zero
    # signal, the in-sample gain cleared the 0.15 bar by 14x.
    require_out_of_sample: bool = True
    # Out-of-sample score must be at least this — a candidate that only works
    # on the window it was chosen from is not a candidate.
    min_out_of_sample_score: float = 0.0


# The engine reports 999 for "no losing trades", because 0 would rank a flawless
# config last. That sentinel should never reach a human as a number.
_PF_SENTINEL = 999.0


def _pf(value: float) -> str:
    return "n/a (no losing trades)" if value >= _PF_SENTINEL else f"{value:.2f}"


@dataclass(frozen=True)
class HealthDecision:
    status: str  # "healthy" | "degraded" | "insufficient_data"
    action: str  # "hold" | "propose_swap"
    reason: str
    current_score: float
    proposed_config: StrategyConfig | None
    proposed_score: float | None
    improvement: float | None


def assess(
    current_metrics: BacktestMetrics,
    best_candidate: SweepResult | None,
    *,
    regime: Regime | None = None,
    thresholds: HealthThresholds | None = None,
    candidate_out_of_sample: BacktestMetrics | None = None,
) -> HealthDecision:
    """Compare current live performance against the best swept candidate.

    `candidate_out_of_sample` is the winner's performance on data it was NOT
    selected on. When thresholds require it and it is absent, no swap is
    proposed — an unvalidated candidate is treated as no candidate.
    """
    t = thresholds or HealthThresholds()
    current_score = score_metrics(current_metrics, min_trades=t.min_trades)

    if current_metrics.trades < t.min_trades:
        return HealthDecision(
            status="insufficient_data",
            action="hold",
            reason=f"only {current_metrics.trades} trades (< {t.min_trades}); not enough to judge",
            current_score=current_score,
            proposed_config=None,
            proposed_score=None,
            improvement=None,
        )

    degraded = (
        current_metrics.profit_factor < t.min_profit_factor
        or current_metrics.win_rate < t.min_win_rate
    )

    if not degraded:
        return HealthDecision(
            status="healthy",
            action="hold",
            reason=(
                f"profit factor {_pf(current_metrics.profit_factor)} ≥ {t.min_profit_factor} "
                f"and win rate {current_metrics.win_rate:.0%} ≥ {t.min_win_rate:.0%}"
            ),
            current_score=current_score,
            proposed_config=None,
            proposed_score=None,
            improvement=None,
        )

    # Degraded — is there a materially better candidate?
    if best_candidate is None:
        return HealthDecision(
            status="degraded",
            action="hold",
            reason="degraded, but the sweep found no candidate to evaluate",
            current_score=current_score,
            proposed_config=None,
            proposed_score=None,
            improvement=None,
        )

    improvement = round(best_candidate.score - current_score, 6)
    regime_note = f" (regime: {regime.label})" if regime else ""

    if t.require_out_of_sample:
        if candidate_out_of_sample is None:
            return HealthDecision(
                status="degraded",
                action="hold",
                reason=(
                    "degraded, but the candidate was not validated out of sample "
                    f"— holding rather than swapping on in-sample fit{regime_note}"
                ),
                current_score=current_score,
                proposed_config=None,
                proposed_score=None,
                improvement=improvement,
            )
        oos_score = score_metrics(candidate_out_of_sample, min_trades=t.min_trades)
        if oos_score < t.min_out_of_sample_score:
            return HealthDecision(
                status="degraded",
                action="hold",
                reason=(
                    f"degraded, and the best candidate improves in-sample by "
                    f"{improvement:.3f} but scores {oos_score:.3f} out of sample "
                    f"— that is selection noise, not edge{regime_note}"
                ),
                current_score=current_score,
                proposed_config=None,
                proposed_score=None,
                improvement=improvement,
            )

    if improvement >= t.min_score_improvement:
        return HealthDecision(
            status="degraded",
            action="propose_swap",
            reason=(
                f"degraded — best swept config improves score by {improvement:.3f} "
                f"({current_score:.3f} → {best_candidate.score:.3f}){regime_note}"
            ),
            current_score=current_score,
            proposed_config=best_candidate.config,
            proposed_score=best_candidate.score,
            improvement=improvement,
        )

    return HealthDecision(
        status="degraded",
        action="hold",
        reason=(
            f"degraded, but no candidate clears the {t.min_score_improvement} improvement bar "
            f"(best gain {improvement:.3f}){regime_note}"
        ),
        current_score=current_score,
        proposed_config=None,
        proposed_score=None,
        improvement=improvement,
    )
