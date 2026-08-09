from teo.backtest.engine import run_backtest
from teo.models import StrategyConfig
from teo.strategies import get_strategy


def test_backtest_runs_and_scores(uptrend_candles):
    m = run_backtest(uptrend_candles, StrategyConfig())
    assert m.trades >= 0
    assert 0.0 <= m.win_rate <= 1.0
    assert m.max_drawdown >= 0.0
    # Profit factor is non-negative and only positive when there are losing trades to divide by.
    assert m.profit_factor >= 0.0


def test_edge_and_hedge_strategies_are_explicit(uptrend_candles):
    edge = get_strategy("edge")
    hedge = get_strategy("hedge")
    assert edge.id == "edge"
    assert hedge.id == "hedge"
    edge_metrics = run_backtest(uptrend_candles, StrategyConfig(), strategy_id="edge")
    hedge_metrics = run_backtest(uptrend_candles, StrategyConfig(), strategy_id="hedge")
    assert edge_metrics.trades >= 0
    assert hedge_metrics.trades >= 0


def test_unknown_strategy_is_rejected(uptrend_candles):
    try:
        run_backtest(uptrend_candles, StrategyConfig(), strategy_id="unknown")
    except ValueError as exc:
        assert "strategy_id" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("unknown strategy should be rejected")


def test_backtest_insufficient_data_is_safe():
    m = run_backtest([], StrategyConfig())
    assert m.trades == 0
    assert m.net_points == 0.0
