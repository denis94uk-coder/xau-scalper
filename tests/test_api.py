from fastapi.testclient import TestClient

from teo.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    # No ML weights in CI => baseline is the active forecaster.
    assert body["forecaster"] == "baseline"


def test_forecast_with_supplied_candles():
    candles = [
        {"time": 1_700_000_000_000 + i * 300_000, "open": 100 + i, "high": 101 + i,
         "low": 99 + i, "close": 100.5 + i, "volume": 10}
        for i in range(60)
    ]
    r = client.post("/forecast", json={"symbol": "BTCUSDT", "interval": "5m",
                                       "horizon": 6, "candles": candles})
    assert r.status_code == 200
    body = r.json()
    assert body["model"] == "baseline"
    assert len(body["points"]) == 6


def test_forecast_rejects_too_few_candles():
    candles = [
        {"time": i, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 0}
        for i in range(5)
    ]
    r = client.post("/forecast", json={"candles": candles, "horizon": 3})
    assert r.status_code == 422
