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
