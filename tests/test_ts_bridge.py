"""Tests for the TypeScript strategy bridge.

The last group actually shells out to `bun run scripts/score.ts` with inline
candles, so it exercises the real strategy end to end without network. Skipped
when bun is absent.
"""

from __future__ import annotations

import math

import pytest

from teo.backtest.ts_bridge import (
    CONFIG_MAP,
    BridgeUnavailable,
    ScoredWindow,
    _to_metrics,
    bridge_available,
    score_configs,
    to_ts_config,
)
from teo.models import Candle, StrategyConfig

requires_bun = pytest.mark.skipif(
    not bridge_available(), reason="bun not available"
)


def osc(n: int, base: float = 100.0, seed: int = 7) -> list[Candle]:
    """Oscillating series — the real strategy needs indicator extremes to fire."""
    s = seed

    def nxt() -> float:
        nonlocal s
        s = (s * 1103515245 + 12345) & 0x7FFFFFFF
        return s / 0x7FFFFFFF - 0.5

    out: list[Candle] = []
    for i in range(n):
        b = base + math.sin((i / 90) * math.pi * 2) * base * 0.06 + (i / n) * base * 0.04
        o = b + nxt() * base * 0.005
        c = b + nxt() * base * 0.005
        out.append(
            Candle(
                time=i * 300_000,
                open=o,
                high=max(o, c) + abs(nxt()) * base * 0.006,
                low=min(o, c) - abs(nxt()) * base * 0.006,
                close=c,
                volume=1.0,
            )
        )
    return out


# ─── Config translation ───

def test_every_python_knob_maps_to_a_ts_field():
    raw = StrategyConfig().model_dump()
    mapped = set(CONFIG_MAP)
    unmapped = set(raw) - mapped - {"hedge_ratio"}
    assert not unmapped, f"knobs with no TS equivalent: {unmapped}"


def test_translation_produces_ts_field_names():
    ts = to_ts_config(StrategyConfig(atr_sl_mult=2.0, tp2_r=3.5))
    assert ts["atrSlMultiplier"] == 2.0
    assert ts["tp2R"] == 3.5
    assert "atr_sl_mult" not in ts


def test_ema_periods_stay_integers():
    # A fractional lookback would be meaningless to the indicator maths.
    ts = to_ts_config(StrategyConfig())
    for key in ("emaFast", "emaMid", "emaSlow"):
        assert isinstance(ts[key], int)


def test_rsi_knobs_are_mapped():
    # The Python proxy ignored these entirely, so sweeping them did nothing.
    ts = to_ts_config(StrategyConfig(rsi_oversold=25, rsi_overbought=75))
    assert ts["rsiOversold"] == 25
    assert ts["rsiOverbought"] == 75


# ─── Metric translation ───

def test_null_profit_factor_becomes_a_win_not_a_zero():
    m = _to_metrics(
        {
            "trades": 5, "winRate": 100.0, "netPoints": 50.0, "avgWin": 10.0,
            "avgLoss": 0.0, "maxDrawdown": 0.0, "profitFactor": None,
        }
    )
    assert m.profit_factor > 1.0


def test_win_rate_is_converted_from_percent_to_fraction():
    m = _to_metrics(
        {
            "trades": 10, "winRate": 60.0, "netPoints": 5.0, "avgWin": 2.0,
            "avgLoss": 1.0, "maxDrawdown": 3.0, "profitFactor": 1.5,
        }
    )
    assert m.win_rate == pytest.approx(0.6)


def test_avg_loss_is_negative_in_teo_schema():
    m = _to_metrics(
        {
            "trades": 10, "winRate": 50.0, "netPoints": 0.0, "avgWin": 2.0,
            "avgLoss": 2.0, "maxDrawdown": 4.0, "profitFactor": 1.0,
        }
    )
    assert m.avg_loss < 0


# ─── Failure behaviour ───

def test_empty_config_list_is_not_an_error():
    assert score_configs([], symbol="BTCUSDT") == []


@requires_bun
def test_unknown_asset_raises_rather_than_returning_junk():
    with pytest.raises(BridgeUnavailable, match="unknown asset"):
        score_configs(
            [StrategyConfig()], symbol="NOT_A_REAL_ASSET", candles=osc(200)
        )


# ─── Real end-to-end scoring ───

@requires_bun
def test_scores_against_the_real_strategy():
    configs = [StrategyConfig(), StrategyConfig(atr_sl_mult=2.0, tp2_r=3.5)]
    results = score_configs(configs, symbol="BTCUSDT", candles=osc(700))

    assert len(results) == 2
    assert all(isinstance(r, ScoredWindow) for r in results)
    # Different configs must produce different results, or nothing is applied.
    assert results[0].metrics.net_points != results[1].metrics.net_points


@requires_bun
def test_split_ratio_returns_out_of_sample_metrics():
    results = score_configs(
        [StrategyConfig()], symbol="BTCUSDT", candles=osc(700), split_ratio=0.7
    )
    oos = results[0].out_of_sample
    assert oos is not None
    # The held-out slice is smaller, so it can only contain fewer trades.
    assert oos.trades <= results[0].metrics.trades


@requires_bun
def test_without_a_split_there_is_no_out_of_sample():
    results = score_configs([StrategyConfig()], symbol="BTCUSDT", candles=osc(700))
    assert results[0].out_of_sample is None


@requires_bun
def test_results_are_net_of_trading_costs():
    """The TS scorer applies real per-asset costs; the Python proxy applied none.

    TAO quotes far wider than BTC, so identical price action must score worse on
    it — if the two agree, costs are not being applied.
    """
    candles = osc(700)
    btc = score_configs([StrategyConfig()], symbol="BTCUSDT", candles=candles)
    tao = score_configs([StrategyConfig()], symbol="TAOUSDT", candles=candles)
    assert tao[0].metrics.net_points < btc[0].metrics.net_points
