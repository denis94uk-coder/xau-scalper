"""Teo FastAPI service: /health, /forecast, /backtest, /optimize, /selfheal."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from teo import __version__
from teo.assets import REGISTRY
from teo.assets import assets as list_assets
from teo.backtest.engine import run_backtest
from teo.backtest.regime import Regime, detect_regime
from teo.backtest.sweep import run_sweep, score_metrics
from teo.config import settings
from teo.data.binance import fetch_klines
from teo.forecasting.base import BaselineForecaster
from teo.forecasting.kronos import KronosUnavailable, get_kronos
from teo.memory import OutcomeMemory
from teo.models import (
    AssetInfo,
    AssetsResponse,
    BacktestRequest,
    BacktestResponse,
    ForecastRequest,
    ForecastResponse,
    OptimizeRequest,
    OptimizeResponse,
    RecalledOutcome,
    RegimeInfo,
    ScoredConfig,
    SelfHealRequest,
    SelfHealResponse,
    StrategyConfig,
)
from teo.selfheal import HealthThresholds, assess

app = FastAPI(title="Teo", version=__version__)

_baseline = BaselineForecaster()


def _active_forecaster_name() -> str:
    k = get_kronos()
    return k.name if k is not None else _baseline.name


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "forecaster": _active_forecaster_name(),
        "data_source": settings.binance_base_url,
    }


@app.post("/forecast", response_model=ForecastResponse)
async def forecast(req: ForecastRequest) -> ForecastResponse:
    if req.horizon > settings.max_horizon:
        raise HTTPException(400, f"horizon exceeds max {settings.max_horizon}")

    candles = req.candles
    if not candles:
        try:
            candles = await fetch_klines(req.symbol, req.interval, limit=req.lookback)
        except Exception as e:  # upstream data error
            raise HTTPException(502, f"failed to fetch candles: {e}") from e
    if len(candles) < 20:
        raise HTTPException(422, "need at least 20 candles to forecast")

    # Prefer Kronos when available; fall back to baseline transparently.
    kronos = get_kronos()
    if kronos is not None:
        try:
            return kronos.forecast(
                candles, req.horizon, symbol=req.symbol, interval=req.interval
            )
        except KronosUnavailable:
            pass  # fall through to baseline

    return _baseline.forecast(candles, req.horizon, symbol=req.symbol, interval=req.interval)


@app.post("/backtest", response_model=BacktestResponse)
async def backtest(req: BacktestRequest) -> BacktestResponse:
    try:
        candles = await fetch_klines(
            req.symbol, req.interval, limit=req.lookback, start=req.start, end=req.end
        )
    except Exception as e:
        raise HTTPException(502, f"failed to fetch candles: {e}") from e

    metrics = run_backtest(candles, req.config, strategy_id=req.strategy_id)
    return BacktestResponse(
        symbol=req.symbol,
        strategy_id=req.strategy_id,
        interval=req.interval,
        bars=len(candles),
        metrics=metrics,
        note=None if metrics.trades else "no trades generated over this window",
    )


_memory = OutcomeMemory(settings.memory_path)


@app.get("/assets", response_model=AssetsResponse)
async def get_assets(tier: int | None = None, source: str | None = None) -> AssetsResponse:
    """The multi-asset registry Teo forecasts / self-heals over (roadmap 3)."""
    rows = list_assets(tier=tier, source=source) if (tier or source) else REGISTRY
    return AssetsResponse(
        count=len(rows),
        assets=[
            AssetInfo(
                symbol=a.symbol,
                label=a.label,
                source=a.source,
                kind=a.kind,
                tier=a.tier,
                market_hours=a.market_hours,
            )
            for a in rows
        ],
    )


def _regime_info(regime: Regime) -> RegimeInfo:
    return RegimeInfo(
        trend=regime.trend,
        volatility=regime.volatility,
        trend_strength=regime.trend_strength,
        atr_pct=regime.atr_pct,
        label=regime.label,
    )


@app.post("/optimize", response_model=OptimizeResponse)
async def optimize(req: OptimizeRequest) -> OptimizeResponse:
    """Run a parameter sweep over recent candles and return the ranked configs."""
    try:
        candles = await fetch_klines(req.symbol, req.interval, limit=req.lookback)
    except Exception as e:
        raise HTTPException(502, f"failed to fetch candles: {e}") from e

    results = run_sweep(
        candles,
        base=req.base,
        grid=req.grid,
        min_trades=req.min_trades,
        top_k=req.top_k,
        strategy_id=req.strategy_id,
    )
    ranked = [
        ScoredConfig(config=r.config, metrics=r.metrics, score=r.score) for r in results
    ]
    return OptimizeResponse(
        symbol=req.symbol,
        strategy_id=req.strategy_id,
        interval=req.interval,
        bars=len(candles),
        regime=_regime_info(detect_regime(candles)),
        best=ranked[0] if ranked else None,
        ranked=ranked,
        note=None if ranked and ranked[0].metrics.trades else "no config traded over this window",
    )


@app.post("/selfheal", response_model=SelfHealResponse)
async def selfheal(req: SelfHealRequest) -> SelfHealResponse:
    """Detect live degradation of the current config and propose a swap when warranted."""
    try:
        candles = await fetch_klines(req.symbol, req.interval, limit=req.lookback)
    except Exception as e:
        raise HTTPException(502, f"failed to fetch candles: {e}") from e

    current_metrics = run_backtest(candles, req.current, strategy_id=req.strategy_id)
    regime = detect_regime(candles)
    sweep = run_sweep(
        candles,
        base=req.current,
        grid=req.grid,
        min_trades=req.min_trades,
        top_k=1,
        strategy_id=req.strategy_id,
    )
    best = sweep[0] if sweep else None

    decision = assess(
        current_metrics,
        best,
        regime=regime,
        thresholds=HealthThresholds(
            min_profit_factor=req.min_profit_factor,
            min_win_rate=req.min_win_rate,
            min_trades=req.min_trades,
            min_score_improvement=req.min_score_improvement,
        ),
    )

    proposed = None
    if decision.proposed_config is not None and best is not None:
        proposed = ScoredConfig(
            config=decision.proposed_config, metrics=best.metrics, score=best.score
        )

    # Roadmap 1 — recall the best prior outcome for this symbol+regime, and optionally persist this.
    recalled = None
    prior = _memory.best_for_regime(req.symbol, regime.label)
    if prior is not None:
        recalled = RecalledOutcome(
            regime=prior.regime,
            score=prior.score,
            config=StrategyConfig(**prior.config),
            action=prior.action,
            ts=prior.ts,
        )

    persisted = False
    if req.persist:
        if decision.action == "propose_swap" and decision.proposed_config is not None:
            _memory.record(
                symbol=req.symbol,
                regime=regime.label,
                score=decision.proposed_score or 0.0,
                config=decision.proposed_config,
                action="propose_swap",
            )
        else:
            _memory.record(
                symbol=req.symbol,
                regime=regime.label,
                score=score_metrics(current_metrics, min_trades=req.min_trades),
                config=req.current,
                action="hold",
            )
        persisted = True

    return SelfHealResponse(
        symbol=req.symbol,
        strategy_id=req.strategy_id,
        interval=req.interval,
        bars=len(candles),
        regime=_regime_info(regime),
        status=decision.status,
        action=decision.action,
        reason=decision.reason,
        current=ScoredConfig(
            config=req.current,
            metrics=current_metrics,
            score=score_metrics(current_metrics, min_trades=req.min_trades),
        ),
        proposed=proposed,
        improvement=decision.improvement,
        recalled=recalled,
        persisted=persisted,
    )
