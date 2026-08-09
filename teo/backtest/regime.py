"""Market-regime detection — the 'memory' half of the brain.

Tags a window of candles with a regime (trend up / trend down / chop) and a volatility band
(low / normal / high). The self-healing loop stores the regime alongside each outcome so it can,
over time, recall which strategy config worked best in *this kind* of market rather than blindly
optimizing on the last N bars. Pure arithmetic, no ML — fully unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass

from teo.models import Candle


@dataclass(frozen=True)
class Regime:
    trend: str  # "up" | "down" | "chop"
    volatility: str  # "low" | "normal" | "high"
    trend_strength: float  # normalized EMA gap (fraction of price)
    atr_pct: float  # ATR as a fraction of price

    @property
    def label(self) -> str:
        base = f"trend_{self.trend}" if self.trend != "chop" else "chop"
        return f"{base}/{self.volatility}_vol"


def _ema(values: list[float], period: int) -> float:
    if not values:
        return 0.0
    k = 2 / (period + 1)
    ema = values[0]
    for v in values[1:]:
        ema = v * k + ema * (1 - k)
    return ema


def _atr_pct(candles: list[Candle], period: int = 14) -> float:
    if len(candles) < 2:
        return 0.0
    trs: list[float] = []
    for prev, cur in zip(candles[:-1], candles[1:], strict=False):
        tr = max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close))
        trs.append(tr)
    window = trs[-period:] if len(trs) >= period else trs
    atr = sum(window) / len(window) if window else 0.0
    last = candles[-1].close
    return atr / last if last else 0.0


def detect_regime(
    candles: list[Candle],
    *,
    trend_threshold: float = 0.004,
    vol_low: float = 0.004,
    vol_high: float = 0.012,
) -> Regime:
    """Classify the trend + volatility of the most recent window.

    trend: sign of the fast/slow EMA gap when its magnitude clears `trend_threshold`, else 'chop'.
    volatility: ATR% bucketed by `vol_low` / `vol_high`.
    """
    closes = [c.close for c in candles]
    if len(closes) < 5:
        return Regime(trend="chop", volatility="normal", trend_strength=0.0, atr_pct=0.0)

    fast = _ema(closes, 9)
    slow = _ema(closes, 21)
    price = closes[-1] or 1.0
    strength = (fast - slow) / price

    if strength > trend_threshold:
        trend = "up"
    elif strength < -trend_threshold:
        trend = "down"
    else:
        trend = "chop"

    atr_pct = _atr_pct(candles)
    if atr_pct < vol_low:
        vol = "low"
    elif atr_pct > vol_high:
        vol = "high"
    else:
        vol = "normal"

    return Regime(
        trend=trend, volatility=vol, trend_strength=round(strength, 6), atr_pct=round(atr_pct, 6)
    )
