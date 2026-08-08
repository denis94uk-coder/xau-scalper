import os

from teo.loop import run_all, run_cycle
from teo.memory import OutcomeMemory


def _mem(tmp_path):
    return OutcomeMemory(os.path.join(str(tmp_path), "mem.json"))


def test_run_cycle_persists_and_recalls(tmp_path, uptrend_candles):
    m = _mem(tmp_path)
    # First cycle: nothing to recall yet.
    r1 = run_cycle("BTCUSDT", uptrend_candles, memory=m, interval="5m",
                   thresholds=None)
    assert r1.symbol == "BTCUSDT"
    assert r1.bars == len(uptrend_candles)
    assert r1.recalled is None
    assert len(m) == 1
    # Second cycle in the same regime: now it recalls the first outcome.
    r2 = run_cycle("BTCUSDT", uptrend_candles, memory=m, interval="5m")
    assert r2.recalled is not None
    assert r2.recalled.regime == r2.regime
    assert len(m) == 2


def test_run_cycle_summary_is_readable(tmp_path, uptrend_candles):
    m = _mem(tmp_path)
    r = run_cycle("ETHUSDT", uptrend_candles, memory=m, interval="15m")
    s = r.summary()
    assert "ETHUSDT" in s and "15m" in s and r.decision.status in s


def test_run_all_isolates_fetch_failures(tmp_path, uptrend_candles):
    m = _mem(tmp_path)

    def fetch(symbol, interval, lookback):
        if symbol == "BROKEN":
            raise RuntimeError("boom")
        return uptrend_candles

    results = run_all(fetch, symbols=["BTCUSDT", "BROKEN", "ETHUSDT"], memory=m,
                      interval="5m", lookback=len(uptrend_candles))
    assert len(results) == 3
    by = {r.symbol: r for r in results}
    assert by["BROKEN"].decision.status == "insufficient_data"
    assert "fetch failed" in by["BROKEN"].decision.reason
    # The two good symbols still produced (and persisted) outcomes.
    assert by["BTCUSDT"].bars == len(uptrend_candles)
    assert len(m) == 2


def test_run_all_defaults_to_live_registry(tmp_path, uptrend_candles):
    m = _mem(tmp_path)
    calls = []

    def fetch(symbol, interval, lookback):
        calls.append(symbol)
        return uptrend_candles

    run_all(fetch, memory=m, interval="5m", lookback=len(uptrend_candles))
    # Default set is the live tier-1 (Binance) universe — gold + majors, no stocks.
    assert "PAXGUSDT" in calls and "BTCUSDT" in calls
    assert "AAPL" not in calls
