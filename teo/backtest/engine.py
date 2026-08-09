"""Candle-replay backtest + metrics.

This is the skeleton the self-healing loop scores configs with. It implements a small, honest
EMA-trend + ATR-stop strategy so the metrics are real numbers rather than mocks. It deliberately
mirrors the *shape* of the dashboard's exit logic (ATR stop-loss, R-multiple take-profit) so the
two stay conceptually aligned; the goal is a scoring harness, not a re-implementation of every
nuance of the live engine.
"""

from __future__ import annotations

from teo.models import BacktestMetrics, Candle, StrategyConfig
from teo.strategies import get_strategy


def _ema_series(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def _atr_series(candles: list[Candle], period: int = 14) -> list[float]:
    if not candles:
        return []
    atr: list[float] = [0.0]
    trs: list[float] = []
    for prev, cur in zip(candles[:-1], candles[1:], strict=False):
        tr = max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close))
        trs.append(tr)
        window = trs[-period:]
        atr.append(sum(window) / len(window))
    return atr


def run_backtest(
    candles: list[Candle], config: StrategyConfig, strategy_id: str = "edge"
) -> BacktestMetrics:
    strategy = get_strategy(strategy_id)
    n = len(candles)
    closes = [c.close for c in candles]
    if n < max(config.ema_trend + 2, 30):
        return BacktestMetrics(
            trades=0, win_rate=0.0, net_points=0.0, avg_win=0.0,
            avg_loss=0.0, max_drawdown=0.0, profit_factor=0.0,
        )

    ema_fast = _ema_series(closes, config.ema_fast)
    ema_slow = _ema_series(closes, config.ema_slow)
    atr = _atr_series(candles)

    wins: list[float] = []
    losses: list[float] = []
    equity = 0.0
    peak = 0.0
    max_dd = 0.0

    in_pos = False
    side = 0  # +1 long, -1 short
    exposure = 1.0
    entry = sl = tp = 0.0

    for i in range(config.ema_trend, n):
        c = candles[i]
        if not in_pos:
            signal = strategy.signal(
                fast_now=ema_fast[i],
                fast_prev=ema_fast[i - 1],
                slow_now=ema_slow[i],
                slow_prev=ema_slow[i - 1],
                config=config,
            )
            a = atr[i] or 0.0
            if signal is None or a <= 0:
                continue
            side, exposure, entry = signal.side, signal.exposure, c.close
            if side == 1:
                sl = entry - a * config.atr_sl_mult
                tp = entry + a * config.atr_sl_mult * config.tp2_r
            else:
                sl = entry + a * config.atr_sl_mult
                tp = entry - a * config.atr_sl_mult * config.tp2_r
            in_pos = True
            continue

        # Manage open position on this bar's range.
        hit_sl = c.low <= sl if side == 1 else c.high >= sl
        hit_tp = c.high >= tp if side == 1 else c.low <= tp
        result: float | None = None
        if hit_sl:
            result = (sl - entry) * side * exposure
        elif hit_tp:
            result = (tp - entry) * side * exposure

        if result is not None:
            equity += result
            peak = max(peak, equity)
            max_dd = max(max_dd, peak - equity)
            (wins if result >= 0 else losses).append(result)
            in_pos = False

    gross_win = sum(wins)
    gross_loss = -sum(losses)
    trades = len(wins) + len(losses)
    return BacktestMetrics(
        trades=trades,
        win_rate=round(len(wins) / trades, 4) if trades else 0.0,
        net_points=round(equity, 4),
        avg_win=round(gross_win / len(wins), 4) if wins else 0.0,
        avg_loss=round(-gross_loss / len(losses), 4) if losses else 0.0,
        max_drawdown=round(max_dd, 4),
        # 999, not 0, when nothing was lost. Zero reads as "worst possible" to
        # every comparison downstream — it would rank a flawless config last and
        # make assess() classify it as degraded.
        profit_factor=(
            round(gross_win / gross_loss, 4) if gross_loss > 0 else 999.0
        ),
    )
