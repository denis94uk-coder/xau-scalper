import os

from teo.memory import OutcomeMemory
from teo.models import StrategyConfig


def _mem(tmp_path):
    return OutcomeMemory(os.path.join(str(tmp_path), "mem.json"))


def test_record_persists_and_reloads(tmp_path):
    m = _mem(tmp_path)
    m.record(symbol="BTCUSDT", regime="trend_up/high_vol", score=5.0,
             config=StrategyConfig(atr_sl_mult=2.0), action="propose_swap")
    assert len(m) == 1
    # A fresh instance reads the same file back.
    m2 = OutcomeMemory(m.path)
    assert len(m2) == 1
    assert m2.history()[0].regime == "trend_up/high_vol"


def test_best_for_regime_picks_highest_score(tmp_path):
    m = _mem(tmp_path)
    m.record(symbol="BTCUSDT", regime="chop/low_vol", score=1.0,
             config=StrategyConfig(atr_sl_mult=1.0), action="hold")
    m.record(symbol="BTCUSDT", regime="chop/low_vol", score=9.0,
             config=StrategyConfig(atr_sl_mult=3.0), action="propose_swap")
    m.record(symbol="BTCUSDT", regime="trend_up/high_vol", score=99.0,
             config=StrategyConfig(atr_sl_mult=2.0), action="propose_swap")
    best = m.best_for_regime("BTCUSDT", "chop/low_vol")
    assert best is not None and best.score == 9.0
    # Different regime isn't mixed in.
    assert m.best_for_regime("BTCUSDT", "trend_up/high_vol").score == 99.0
    # Unknown symbol/regime → None.
    assert m.best_for_regime("ETHUSDT", "chop/low_vol") is None


def test_recall_config_returns_strategy(tmp_path):
    m = _mem(tmp_path)
    m.record(symbol="ETHUSDT", regime="chop/low_vol", score=4.0,
             config=StrategyConfig(atr_sl_mult=2.5, tp2_r=3.0), action="propose_swap")
    cfg = m.recall_config("ETHUSDT", "chop/low_vol")
    assert isinstance(cfg, StrategyConfig) and cfg.atr_sl_mult == 2.5 and cfg.tp2_r == 3.0
    assert m.recall_config("ETHUSDT", "nope") is None


def test_corrupt_file_starts_fresh(tmp_path):
    path = os.path.join(str(tmp_path), "bad.json")
    with open(path, "w") as f:
        f.write("{not valid json")
    m = OutcomeMemory(path)
    assert len(m) == 0  # didn't crash
    m.record(symbol="BTCUSDT", regime="chop/low_vol", score=1.0,
             config=StrategyConfig(), action="hold")
    assert len(m) == 1
