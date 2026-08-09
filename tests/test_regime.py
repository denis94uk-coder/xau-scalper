from teo.backtest.regime import detect_regime
from teo.models import Candle


def _series(closes, atr=0.5):
    out = []
    t = 1_700_000_000_000
    for i, c in enumerate(closes):
        out.append(
            Candle(time=t + i * 300_000, open=c, high=c + atr, low=c - atr, close=c, volume=10)
        )
    return out


def test_detect_uptrend():
    r = detect_regime(_series([100 + i * 0.5 for i in range(60)]))
    assert r.trend == "up"
    assert r.trend_strength > 0
    assert r.label.startswith("trend_up")


def test_detect_downtrend():
    r = detect_regime(_series([100 - i * 0.5 for i in range(60)]))
    assert r.trend == "down"
    assert r.trend_strength < 0


def test_detect_chop():
    closes = [100 + (1 if i % 2 else -1) * 0.05 for i in range(60)]
    r = detect_regime(_series(closes, atr=0.05))
    assert r.trend == "chop"


def test_volatility_bands():
    lo = detect_regime(_series([100 + i * 0.5 for i in range(60)], atr=0.05))
    hi = detect_regime(_series([100 + i * 0.5 for i in range(60)], atr=3.0))
    assert lo.volatility in {"low", "normal"}
    assert hi.volatility == "high"


def test_short_window_is_safe():
    r = detect_regime(_series([100, 101]))
    assert r.trend == "chop"
