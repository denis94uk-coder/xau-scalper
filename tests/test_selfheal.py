from teo.backtest.sweep import SweepResult
from teo.models import BacktestMetrics, StrategyConfig
from teo.selfheal import HealthThresholds, assess


def _m(**kw):
    base = dict(trades=20, win_rate=0.5, net_points=100.0, avg_win=10.0,
                avg_loss=-5.0, max_drawdown=50.0, profit_factor=1.5)
    base.update(kw)
    return BacktestMetrics(**base)


def _candidate(score):
    return SweepResult(
        config=StrategyConfig(atr_sl_mult=2.0), metrics=_m(net_points=500.0), score=score
    )


def test_insufficient_data():
    d = assess(_m(trades=3), None)
    assert d.status == "insufficient_data"
    assert d.action == "hold"


def test_healthy_holds():
    d = assess(_m(profit_factor=1.6, win_rate=0.55), _candidate(999.0))
    assert d.status == "healthy"
    assert d.action == "hold"
    assert d.proposed_config is None


def test_degraded_proposes_swap_when_candidate_better():
    current = _m(profit_factor=0.8, win_rate=0.2, net_points=-20.0)
    d = assess(current, _candidate(50.0),
               thresholds=HealthThresholds(min_score_improvement=0.15))
    assert d.status == "degraded"
    assert d.action == "propose_swap"
    assert d.proposed_config is not None
    assert d.improvement is not None and d.improvement > 0


def test_degraded_holds_when_no_better_candidate():
    current = _m(profit_factor=0.8, win_rate=0.2, net_points=-20.0)
    # Candidate barely differs → below the improvement bar.
    from teo.backtest.sweep import score_metrics
    cur_score = score_metrics(current)
    d = assess(current, _candidate(cur_score + 0.01),
               thresholds=HealthThresholds(min_score_improvement=0.5))
    assert d.status == "degraded"
    assert d.action == "hold"
    assert d.proposed_config is None


def test_degraded_but_no_candidate():
    current = _m(profit_factor=0.8, win_rate=0.2)
    d = assess(current, None)
    assert d.status == "degraded"
    assert d.action == "hold"
