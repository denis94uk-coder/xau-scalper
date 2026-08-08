"""Unit tests for the torch-free Kronos glue (no ML deps required)."""

import pytest

from teo.forecasting.kronos_adapt import (
    context_ohlcv,
    context_timestamps,
    future_timestamps,
    interval_to_ms,
    predicted_to_response,
)
from teo.models import Candle


def _candles(n: int, start_ms: int = 1_700_000_000_000, step_ms: int = 300_000) -> list[Candle]:
    return [
        Candle(time=start_ms + i * step_ms, open=100 + i, high=101 + i,
               low=99 + i, close=100.5 + i, volume=10 + i)
        for i in range(n)
    ]


@pytest.mark.parametrize(
    "interval,expected",
    [("1m", 60_000), ("5m", 300_000), ("15m", 900_000), ("1h", 3_600_000),
     ("4h", 14_400_000), ("1d", 86_400_000), ("1w", 604_800_000)],
)
def test_interval_to_ms(interval, expected):
    assert interval_to_ms(interval) == expected


@pytest.mark.parametrize("bad", ["", "5", "m", "0m", "-1h", "5x", "abc"])
def test_interval_to_ms_rejects_bad(bad):
    with pytest.raises(ValueError):
        interval_to_ms(bad)


def test_future_timestamps_are_spaced_after_last():
    ts = future_timestamps(1_000_000, 300_000, 3)
    assert ts == [1_300_000, 1_600_000, 1_900_000]


def test_context_helpers_preserve_order():
    cs = _candles(4)
    assert context_timestamps(cs) == [c.time for c in cs]
    cols = context_ohlcv(cs)
    assert cols["close"] == [c.close for c in cs]
    assert set(cols) == {"open", "high", "low", "close", "volume"}


def test_predicted_to_response_builds_cone_and_direction():
    resp = predicted_to_response(
        symbol="BTCUSDT",
        interval="5m",
        model_name="kronos:test",
        last_close=100.0,
        times=[1, 2, 3],
        close=[101.0, 102.0, 103.0],
        high=[101.5, 102.5, 103.5],
        low=[100.5, 101.5, 102.5],
    )
    assert resp.model == "kronos:test"
    assert resp.horizon == 3
    assert len(resp.points) == 3
    assert resp.direction == "up"
    assert resp.expected_return == pytest.approx(0.03)
    assert 0.0 <= resp.confidence <= 1.0
    for p in resp.points:
        assert p.lower <= p.close <= p.upper


def test_predicted_to_response_handles_inverted_bounds():
    # Model emits high < low; the adapter must still produce ordered bounds.
    resp = predicted_to_response(
        symbol="X", interval="1h", model_name="kronos:test", last_close=100.0,
        times=[1], close=[100.0], high=[99.0], low=[101.0],
    )
    p = resp.points[0]
    assert p.lower <= p.close <= p.upper


def test_predicted_to_response_rejects_empty():
    with pytest.raises(ValueError):
        predicted_to_response(
            symbol="X", interval="5m", model_name="k", last_close=1.0,
            times=[], close=[], high=[], low=[],
        )
