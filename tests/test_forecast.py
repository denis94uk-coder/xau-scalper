from teo.forecasting.base import BaselineForecaster


def test_baseline_forecast_shape(uptrend_candles):
    f = BaselineForecaster()
    resp = f.forecast(uptrend_candles, horizon=12, symbol="BTCUSDT", interval="5m")

    assert resp.model == "baseline"
    assert resp.horizon == 12
    assert len(resp.points) == 12
    assert resp.points[0].step == 1
    assert resp.points[-1].step == 12
    assert resp.last_close == uptrend_candles[-1].close
    assert 0.0 <= resp.confidence <= 1.0
    assert resp.direction in {"up", "down", "flat"}
    # Forecast cone must be ordered and widen with horizon.
    assert resp.points[0].lower <= resp.points[0].close <= resp.points[0].upper
    assert (resp.points[-1].upper - resp.points[-1].lower) >= (
        resp.points[0].upper - resp.points[0].lower
    )


def test_baseline_uptrend_points_up(uptrend_candles):
    resp = BaselineForecaster().forecast(uptrend_candles, 12, symbol="X", interval="5m")
    assert resp.direction == "up"
    assert resp.expected_return > 0
