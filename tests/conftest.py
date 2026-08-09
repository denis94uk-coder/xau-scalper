"""Shared fixtures: synthetic candles so tests need no network or ML deps."""

from __future__ import annotations

import math

import pytest

from teo.models import Candle


def _make_candles(
    n: int, start: float = 100.0, trend: float = 0.05, noise: float = 0.3
) -> list[Candle]:
    candles: list[Candle] = []
    price = start
    t0 = 1_700_000_000_000
    for i in range(n):
        price += trend + noise * math.sin(i / 5)
        high = price + abs(noise) + 0.2
        low = price - abs(noise) - 0.2
        candles.append(
            Candle(
                time=t0 + i * 300_000,  # 5m bars
                open=price - trend,
                high=high,
                low=low,
                close=price,
                volume=1000 + i,
            )
        )
    return candles


@pytest.fixture
def uptrend_candles() -> list[Candle]:
    return _make_candles(300, trend=0.08)


@pytest.fixture
def choppy_candles() -> list[Candle]:
    return _make_candles(300, trend=0.0, noise=0.6)
