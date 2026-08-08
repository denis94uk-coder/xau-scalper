"""Endpoint tests for /assets and the /selfheal memory (persist + recall), feed stubbed."""

import math
import os

from fastapi.testclient import TestClient

import teo.main as main
from teo.main import app
from teo.memory import OutcomeMemory
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


def test_assets_registry():
    r = client.get("/assets")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == len(body["assets"]) > 0
    symbols = {a["symbol"] for a in body["assets"]}
    assert {"PAXGUSDT", "BTCUSDT", "AAPL"} <= symbols


def test_assets_filter_by_tier():
    r = client.get("/assets", params={"tier": 3})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 7
    assert all(a["market_hours"] for a in body["assets"])


def test_selfheal_persist_then_recall(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "fetch_klines", _fake_fetch)
    monkeypatch.setattr(main, "_memory", OutcomeMemory(os.path.join(str(tmp_path), "m.json")))

    body = {"symbol": "BTCUSDT", "interval": "5m", "lookback": 400,
            "min_trades": 0, "persist": True}
    r1 = client.post("/selfheal", json=body).json()
    assert r1["persisted"] is True
    assert r1["recalled"] is None  # nothing recorded before this call

    r2 = client.post("/selfheal", json=body).json()
    assert r2["persisted"] is True
    assert r2["recalled"] is not None  # first call's outcome is now recalled
    assert r2["recalled"]["regime"] == r2["regime"]["label"]


def test_selfheal_no_persist_by_default(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "fetch_klines", _fake_fetch)
    monkeypatch.setattr(main, "_memory", OutcomeMemory(os.path.join(str(tmp_path), "m2.json")))
    r = client.post("/selfheal", json={"symbol": "ETHUSDT", "interval": "5m",
                                       "lookback": 400, "min_trades": 0}).json()
    assert r["persisted"] is False
