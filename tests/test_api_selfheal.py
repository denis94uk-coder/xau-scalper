"""Endpoint tests for /optimize and /selfheal with the data feed stubbed (no network)."""

import math

from fastapi.testclient import TestClient

import teo.main as main
from teo.main import app
from teo.models import Candle

client = TestClient(app)


def _candles(n=400):
    out = []
    t = 1_700_000_000_000
    price = 100.0
    for i in range(n):
        price += 0.08 + 0.4 * math.sin(i / 5)
        out.append(Candle(time=t + i * 300_000, open=price - 0.08, high=price + 0.6,
                          low=price - 0.6, close=price, volume=1000 + i))
    return out


async def _fake_fetch(symbol, interval="5m", limit=200, start=None, end=None):
    return _candles(limit)


def test_optimize(monkeypatch):
    monkeypatch.setattr(main, "fetch_klines", _fake_fetch)
    r = client.post("/optimize", json={"symbol": "BTCUSDT", "interval": "5m",
                                       "lookback": 400, "min_trades": 0, "top_k": 4})
    assert r.status_code == 200
    body = r.json()
    assert body["bars"] == 400
    assert "regime" in body and "label" in body["regime"]
    assert len(body["ranked"]) <= 4
    if body["best"]:
        assert body["best"]["score"] == body["ranked"][0]["score"]


def test_selfheal(monkeypatch):
    monkeypatch.setattr(main, "fetch_klines", _fake_fetch)
    r = client.post("/selfheal", json={"symbol": "BTCUSDT", "interval": "5m",
                                       "lookback": 400, "min_trades": 0})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] in {"healthy", "degraded", "insufficient_data"}
    assert body["action"] in {"hold", "propose_swap"}
    assert "current" in body and "score" in body["current"]
    assert "regime" in body
    if body["action"] == "propose_swap":
        assert body["proposed"] is not None
        assert body["improvement"] is not None
