"""Forecaster protocol + a transparent baseline used when Kronos isn't installed.

The baseline is deliberately simple and deterministic so the whole pipeline is testable
end-to-end before any ML weights are wired in: it projects the recent EMA drift forward and
widens an ATR-scaled cone around it. It is NOT a trading edge — it's a stand-in that keeps the
API contract honest.
"""

from __future__ import annotations

import math
from typing import Protocol

from teo.models import Candle, ForecastPoint, ForecastResponse


class Forecaster(Protocol):
    name: str

    def forecast(
        self, candles: list[Candle], horizon: int, *, symbol: str, interval: str
    ) -> ForecastResponse: ...


def _ema(values: list[float], period: int) -> float:
    if not values:
        return 0.0
    k = 2 / (period + 1)
    ema = values[0]
    for v in values[1:]:
        ema = v * k + ema * (1 - k)
    return ema


def _atr(candles: list[Candle], period: int = 14) -> float:
    if len(candles) < 2:
        return 0.0
    trs: list[float] = []
    for prev, cur in zip(candles[:-1], candles[1:], strict=False):
        tr = max(
            cur.high - cur.low,
            abs(cur.high - prev.close),
            abs(cur.low - prev.close),
        )
        trs.append(tr)
    window = trs[-period:] if len(trs) >= period else trs
    return sum(window) / len(window) if window else 0.0


class BaselineForecaster:
    name = "baseline"

    def forecast(
        self, candles: list[Candle], horizon: int, *, symbol: str, interval: str
    ) -> ForecastResponse:
        closes = [c.close for c in candles]
        last = closes[-1]
        fast = _ema(closes, 9)
        slow = _ema(closes, 21)
        atr = _atr(candles)

        # Per-bar drift from the fast/slow EMA gap, damped and capped for stability.
        drift = 0.0
        if slow > 0:
            drift = max(-0.01, min(0.01, (fast - slow) / slow * 0.25))

        points: list[ForecastPoint] = []
        price = last
        for step in range(1, horizon + 1):
            price = price * (1 + drift)
            cone = atr * math.sqrt(step)
            points.append(
                ForecastPoint(step=step, close=price, lower=price - cone, upper=price + cone)
            )

        expected_return = (points[-1].close - last) / last if last else 0.0
        if expected_return > 0.0005:
            direction = "up"
        elif expected_return < -0.0005:
            direction = "down"
        else:
            direction = "flat"
        # Confidence shrinks as the ATR cone widens relative to price.
        rel_cone = (atr * math.sqrt(horizon)) / last if last else 1.0
        confidence = max(0.0, min(1.0, 1.0 - rel_cone))

        return ForecastResponse(
            symbol=symbol,
            interval=interval,
            model=self.name,
            horizon=horizon,
            last_close=last,
            points=points,
            direction=direction,
            expected_return=expected_return,
            confidence=round(confidence, 4),
            note="baseline forecaster (Kronos weights not loaded)",
        )
