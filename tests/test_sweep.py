from teo.backtest.sweep import DEFAULT_GRID, run_sweep, score_metrics
from teo.models import BacktestMetrics, StrategyConfig


def _m(**kw):
    base = dict(trades=20, win_rate=0.5, net_points=100.0, avg_win=10.0,
                avg_loss=-5.0, max_drawdown=50.0, profit_factor=1.5)
    base.update(kw)
    return BacktestMetrics(**base)


def test_score_penalizes_under_traded():
    good = _m(trades=20)
    thin = _m(trades=3)
    assert score_metrics(good) > score_metrics(thin)
    assert score_metrics(thin, min_trades=10) < -1e8


def test_score_rewards_return_and_penalizes_drawdown():
    low_dd = _m(max_drawdown=10.0)
    high_dd = _m(max_drawdown=200.0)
    assert score_metrics(low_dd) > score_metrics(high_dd)

    more_ret = _m(net_points=300.0)
    less_ret = _m(net_points=50.0)
    assert score_metrics(more_ret) > score_metrics(less_ret)


def test_run_sweep_ranks_and_caps(uptrend_candles):
    results = run_sweep(uptrend_candles, min_trades=0, top_k=3)
    assert len(results) <= 3
    # Sorted descending by score.
    scores = [r.score for r in results]
    assert scores == sorted(scores, reverse=True)
    # Each result carries a config drawn from the grid.
    for r in results:
        assert isinstance(r.config, StrategyConfig)
        assert r.config.atr_sl_mult in DEFAULT_GRID["atr_sl_mult"]


def test_run_sweep_custom_grid(uptrend_candles):
    grid = {"atr_sl_mult": [1.0, 2.0], "tp2_r": [2.0]}
    results = run_sweep(uptrend_candles, grid=grid, min_trades=0, top_k=10)
    # 2 x 1 = 2 combinations.
    assert len(results) == 2


def test_zero_drawdown_does_not_produce_an_astronomical_score():
    """A lucky streak should be good, not infinitely good.

    The previous denominator was `max_drawdown + 1e-9`, so a run that happened
    never to draw down scored around 5e10 and dominated every ranking on what is
    usually a small-sample accident.
    """
    from teo.backtest.sweep import score_metrics
    from teo.models import BacktestMetrics

    flawless = BacktestMetrics(
        trades=12, win_rate=1.0, net_points=50.0, avg_win=4.16,
        avg_loss=0.0, max_drawdown=0.0, profit_factor=999.0,
    )
    score = score_metrics(flawless)
    assert score < 1000, f"zero-drawdown score blew up: {score}"
    assert score > 0


def test_no_loss_config_is_not_ranked_last():
    """profit_factor must not be 0 when there were no losses."""
    from teo.backtest.engine import run_backtest
    from teo.models import Candle, StrategyConfig

    # A monotonic ramp: any position that opens runs to target, never stops out.
    candles = [
        Candle(time=i * 300_000, open=100 + i, high=101 + i, low=99 + i,
               close=100 + i, volume=1.0)
        for i in range(200)
    ]
    m = run_backtest(candles, StrategyConfig())
    if m.trades > 0 and m.avg_loss == 0.0:
        assert m.profit_factor > 1.0, "a config with no losses was scored as 0"
