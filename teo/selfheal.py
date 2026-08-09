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
) -> HealthDecision:
    """Compare current live performance against the best swept candidate."""
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
                f"profit factor {current_metrics.profit_factor:.2f} ≥ {t.min_profit_factor} and "
                f"win rate {current_metrics.win_rate:.0%} ≥ {t.min_win_rate:.0%}"
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
