"""Parameter-sweep engine — the 'optimizer' half of the brain.

Given a window of candles and a grid of strategy knobs, it backtests every combination, scores each
on a risk-adjusted heuristic, and returns the ranked results plus the winner. The self-healing loop
calls this to find a better config when live performance degrades. Pure + deterministic → tested.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass

from teo.backtest.engine import run_backtest
from teo.models import BacktestMetrics, Candle, StrategyConfig

# Default grid: the knobs that move exits the most, kept small so a sweep is cheap.
DEFAULT_GRID: dict[str, list] = {
    "atr_sl_mult": [1.0, 1.5, 2.0],
    "tp2_r": [1.5, 2.5, 3.5],
    "ema_fast": [9, 12],
    "ema_slow": [21, 26],
}


@dataclass(frozen=True)
class SweepResult:
    config: StrategyConfig
    metrics: BacktestMetrics
    score: float


def score_metrics(m: BacktestMetrics, *, min_trades: int = 10) -> float:
    """Risk-adjusted score for ranking configs.

    Configs that didn't trade enough to be trustworthy are pushed to the bottom. Otherwise the
    score rewards return earned per unit of drawdown (a Calmar-like ratio), nudged by profit factor
    and win rate. Higher is better; it can be negative for losing configs.
    """
    if m.trades < min_trades:
        return -1e9 + m.trades  # keep a stable order among under-traded configs
    calmar = m.net_points / (m.max_drawdown + 1e-9)
    return round(calmar + 0.5 * (m.profit_factor - 1.0) + 0.25 * m.win_rate, 6)


def _expand_grid(base: StrategyConfig, grid: dict[str, list]) -> list[StrategyConfig]:
    keys = list(grid.keys())
    combos = itertools.product(*(grid[k] for k in keys))
    out: list[StrategyConfig] = []
    for combo in combos:
        overrides = dict(zip(keys, combo, strict=True))
        out.append(base.model_copy(update=overrides))
    return out


def run_sweep(
    candles: list[Candle],
    *,
    base: StrategyConfig | None = None,
    grid: dict[str, list] | None = None,
    min_trades: int = 10,
    top_k: int = 5,
    strategy_id: str = "edge",
) -> list[SweepResult]:
    """Backtest every config in the grid and return the top_k, best score first."""
    base = base or StrategyConfig()
    grid = grid or DEFAULT_GRID
    results: list[SweepResult] = []
    for cfg in _expand_grid(base, grid):
        m = run_backtest(candles, cfg, strategy_id=strategy_id)
        results.append(
            SweepResult(config=cfg, metrics=m, score=score_metrics(m, min_trades=min_trades))
        )
    results.sort(key=lambda r: r.score, reverse=True)
    return results[:top_k]
