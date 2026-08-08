"""Pure, torch-free helpers for the Kronos integration.

Kronos consumes an OHLCV *context* plus the timestamps of the context and of the horizon, and
returns a predicted OHLCV frame. The glue around that — parsing the kline interval, generating the
future timestamps, and turning predicted OHLCV rows into Teo's `ForecastResponse` cone — is plain
arithmetic with no ML dependency, so it lives here and is fully unit-tested. `kronos.py` handles
only the torch/model side and delegates shaping to these functions.
"""

from __future__ import annotations

import math

from teo.models import Candle, ForecastPoint, ForecastResponse

# Supported kline interval suffixes → milliseconds.
_UNIT_MS = {
    "m": 60_000,
    "h": 3_600_000,
    "d": 86_400_000,
    "w": 604_800_000,
}


def interval_to_ms(interval: str) -> int:
    """Parse a Binance-style interval like '5m', '1h', '1d' into milliseconds."""
    interval = interval.strip().lower()
    if not interval or interval[-1] not in _UNIT_MS:
        raise ValueError(f"unsupported interval: {interval!r}")
    unit = interval[-1]
    try:
        qty = int(interval[:-1])
    except ValueError as e:
        raise ValueError(f"unsupported interval: {interval!r}") from e
    if qty <= 0:
        raise ValueError(f"unsupported interval: {interval!r}")
    return qty * _UNIT_MS[unit]


def future_timestamps(last_time_ms: int, interval_ms: int, horizon: int) -> list[int]:
    """Epoch-ms timestamps for the forecast horizon, one interval apart after the last candle."""
    return [last_time_ms + interval_ms * step for step in range(1, horizon + 1)]


def context_timestamps(candles: list[Candle]) -> list[int]:
    """Epoch-ms timestamps of the supplied context candles, in order."""
    return [c.time for c in candles]


def context_ohlcv(candles: list[Candle]) -> dict[str, list[float]]:
    """Column-oriented OHLCV for the context window, ready to build a DataFrame from."""
    return {
        "open": [c.open for c in candles],
        "high": [c.high for c in candles],
        "low": [c.low for c in candles],
        "close": [c.close for c in candles],
        "volume": [c.volume for c in candles],
    }


def predicted_to_response(
    *,
    symbol: str,
    interval: str,
    model_name: str,
    last_close: float,
    times: list[int],
    close: list[float],
    high: list[float],
    low: list[float],
) -> ForecastResponse:
    """Turn Kronos's predicted OHLCV columns into a `ForecastResponse` cone.

    The predicted per-step high/low form the cone bounds; confidence shrinks as the mean predicted
    bar range widens relative to price. Direction/expected-return come from the final predicted
    close versus the last observed close.
    """
    if not close:
        raise ValueError("empty prediction")

    horizon = len(close)
    points: list[ForecastPoint] = []
    ranges: list[float] = []
    for i in range(horizon):
        hi = high[i]
        lo = low[i]
        # Guard against a model that emits inverted or degenerate bounds.
        upper = max(hi, lo, close[i])
        lower = min(hi, lo, close[i])
        points.append(ForecastPoint(step=i + 1, close=close[i], lower=lower, upper=upper))
        if close[i]:
            ranges.append((upper - lower) / close[i])

    expected_return = (close[-1] - last_close) / last_close if last_close else 0.0
    if expected_return > 0.0005:
        direction = "up"
    elif expected_return < -0.0005:
        direction = "down"
    else:
        direction = "flat"

    mean_range = sum(ranges) / len(ranges) if ranges else 1.0
    confidence = max(0.0, min(1.0, 1.0 - mean_range * math.sqrt(horizon)))

    return ForecastResponse(
        symbol=symbol,
        interval=interval,
        model=model_name,
        horizon=horizon,
        last_close=last_close,
        points=points,
        direction=direction,
        expected_return=expected_return,
        confidence=round(confidence, 4),
        note="kronos inference",
    )
