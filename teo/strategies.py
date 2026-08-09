"""Explicit strategy modes used by replay and self-heal.

The edge strategy is the directional EMA-cross engine. The hedge strategy is deliberately
conservative: it takes the same directional signal but reserves an inverse protective leg via
``hedge_ratio``. It is a risk overlay, not a claim of a separate predictive edge. Neither strategy
can mutate live configuration; callers only receive a signal and an exposure multiplier.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from teo.models import StrategyConfig, StrategyId


@dataclass(frozen=True)
class StrategySignal:
    side: int  # +1 long, -1 short
    exposure: float  # net exposure after the strategy's hedge overlay


class Strategy(Protocol):
    id: StrategyId

    def signal(
        self,
        *,
        fast_now: float,
        fast_prev: float,
        slow_now: float,
        slow_prev: float,
        config: StrategyConfig,
    ) -> StrategySignal | None: ...


class EdgeStrategy:
    id: StrategyId = "edge"

    def signal(
        self,
        *,
        fast_now: float,
        fast_prev: float,
        slow_now: float,
        slow_prev: float,
        config: StrategyConfig,
    ) -> StrategySignal | None:
        del config
        if fast_now > slow_now and fast_prev <= slow_prev:
            return StrategySignal(side=1, exposure=1.0)
        if fast_now < slow_now and fast_prev >= slow_prev:
            return StrategySignal(side=-1, exposure=1.0)
        return None


class HedgeStrategy:
    id: StrategyId = "hedge"

    def signal(
        self,
        *,
        fast_now: float,
        fast_prev: float,
        slow_now: float,
        slow_prev: float,
        config: StrategyConfig,
    ) -> StrategySignal | None:
        if fast_now > slow_now and fast_prev <= slow_prev:
            side = 1
        elif fast_now < slow_now and fast_prev >= slow_prev:
            side = -1
        else:
            return None
        # Keep an inverse protective leg. This is intentionally explicit and bounded.
        return StrategySignal(side=side, exposure=1.0 - config.hedge_ratio)


STRATEGIES: dict[StrategyId, Strategy] = {
    "edge": EdgeStrategy(),
    "hedge": HedgeStrategy(),
}


def get_strategy(strategy_id: str) -> Strategy:
    try:
        return STRATEGIES[strategy_id]  # type: ignore[index]
    except KeyError as exc:
        raise ValueError(f"unknown strategy_id {strategy_id!r}; choose edge or hedge") from exc
