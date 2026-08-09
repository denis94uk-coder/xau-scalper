"""Pydantic request/response schemas shared with the dashboard."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

StrategyId = Literal["edge", "hedge"]


class Candle(BaseModel):
    """A single OHLCV bar. `time` is epoch milliseconds (Binance kline open time)."""

    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class ForecastRequest(BaseModel):
    symbol: str = Field(
        "BTCUSDT", description="Binance data-source symbol, e.g. BTCUSDT or PAXGUSDT"
    )
    interval: str = Field("5m", description="Kline interval, e.g. 1m/5m/15m/1h")
    horizon: int = Field(12, ge=1, le=120, description="How many future bars to forecast")
    # If candles are supplied, Teo uses them directly; otherwise it fetches recent history.
    candles: list[Candle] | None = None
    lookback: int = Field(200, ge=20, le=2000, description="Bars to fetch when candles omitted")


class ForecastPoint(BaseModel):
    step: int
    close: float
    lower: float
    upper: float


class ForecastResponse(BaseModel):
    symbol: str
    interval: str
    model: str  # "kronos:<id>" or "baseline"
    horizon: int
    last_close: float
    points: list[ForecastPoint]
    # Compact directional read the dashboard can fold into its TA grade.
    direction: str  # "up" | "down" | "flat"
    expected_return: float  # fractional return over the horizon
    confidence: float  # 0..1
    note: str | None = None


class StrategyConfig(BaseModel):
    """Mirror of the dashboard's StrategyConfig knobs relevant to replay."""

    rsi_oversold: float = 30
    rsi_overbought: float = 70
    atr_sl_mult: float = 1.5
    tp1_r: float = 1.2
    tp2_r: float = 2.5
    ema_fast: int = 9
    ema_slow: int = 21
    ema_trend: int = 50
    atr_trail_mult: float = 2.0
    # Defensive inverse leg for strategy_id="hedge"; edge ignores this value.
    hedge_ratio: float = Field(0.35, ge=0.0, le=0.95)


class BacktestRequest(BaseModel):
    symbol: str = "BTCUSDT"
    strategy_id: StrategyId = "edge"
    interval: str = "5m"
    start: int | None = Field(None, description="epoch ms; omit to use lookback")
    end: int | None = Field(None, description="epoch ms; omit for now")
    lookback: int = Field(1000, ge=60, le=5000)
    config: StrategyConfig = StrategyConfig()


class BacktestMetrics(BaseModel):
    trades: int
    win_rate: float
    net_points: float
    avg_win: float
    avg_loss: float
    max_drawdown: float
    profit_factor: float


class BacktestResponse(BaseModel):
    symbol: str
    strategy_id: StrategyId
    interval: str
    bars: int
    metrics: BacktestMetrics
    note: str | None = None


class RegimeInfo(BaseModel):
    trend: str
    volatility: str
    trend_strength: float
    atr_pct: float
    label: str


class ScoredConfig(BaseModel):
    config: StrategyConfig
    metrics: BacktestMetrics
    score: float


class OptimizeRequest(BaseModel):
    symbol: str = "BTCUSDT"
    strategy_id: StrategyId = "edge"
    interval: str = "5m"
    lookback: int = Field(1000, ge=60, le=5000)
    base: StrategyConfig = StrategyConfig()
    # Optional override grid: {knob: [values]}; omit to use the engine's default grid.
    grid: dict[str, list] | None = None
    top_k: int = Field(5, ge=1, le=25)
    min_trades: int = Field(10, ge=0, le=1000)


class OptimizeResponse(BaseModel):
    symbol: str
    strategy_id: StrategyId
    interval: str
    bars: int
    regime: RegimeInfo
    best: ScoredConfig | None
    ranked: list[ScoredConfig]
    note: str | None = None


class SelfHealRequest(BaseModel):
    symbol: str = "BTCUSDT"
    strategy_id: StrategyId = "edge"
    interval: str = "5m"
    lookback: int = Field(1000, ge=60, le=5000)
    current: StrategyConfig = StrategyConfig()
    grid: dict[str, list] | None = None
    min_profit_factor: float = 1.0
    min_win_rate: float = 0.30
    min_trades: int = Field(10, ge=0, le=1000)
    min_score_improvement: float = 0.15
    # Persist this outcome to regime-tagged memory (roadmap 1) so future cycles can recall it.
    persist: bool = False


class RecalledOutcome(BaseModel):
    regime: str
    score: float
    config: StrategyConfig
    action: str
    ts: float


class SelfHealResponse(BaseModel):
    symbol: str
    strategy_id: StrategyId
    interval: str
    bars: int
    regime: RegimeInfo
    status: str  # healthy | degraded | insufficient_data
    action: str  # hold | propose_swap
    reason: str
    current: ScoredConfig
    proposed: ScoredConfig | None = None
    improvement: float | None = None
    # Best prior outcome recorded for this symbol+regime (roadmap 1 memory), if any.
    recalled: RecalledOutcome | None = None
    persisted: bool = False


class AssetInfo(BaseModel):
    symbol: str
    label: str
    source: str
    kind: str
    tier: int
    market_hours: bool


class AssetsResponse(BaseModel):
    count: int
    assets: list[AssetInfo]
