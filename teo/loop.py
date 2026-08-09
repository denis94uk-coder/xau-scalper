"""Self-heal loop orchestration (roadmap 2) — the piece a scheduler/cron drives.

`run_cycle` ties the brain together for one asset: detect regime → sweep for the best config →
assess the current config → persist the outcome to regime-tagged memory → recall what worked in this
regime before. `run_all` fans that over the asset registry. Fetching is injected (a callable) so the
orchestration is unit-tested without network; the CLI and API wire in the real Binance feed.

Run it on a schedule from the dashboard's cron:

    python -m teo.loop --interval 15m --lookback 1000        # all live (tier-1) assets
    python -m teo.loop --symbol BTCUSDT --interval 15m       # one asset
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from teo.assets import live_symbols
from teo.backtest.engine import run_backtest
from teo.backtest.regime import detect_regime
from teo.backtest.sweep import run_sweep, score_metrics
from teo.memory import OutcomeMemory, OutcomeRecord
from teo.models import Candle, StrategyConfig
from teo.selfheal import HealthDecision, HealthThresholds, assess

CandleFetcher = Callable[[str, str, int], Sequence[Candle]]


@dataclass
class CycleResult:
    symbol: str
    strategy_id: str
    interval: str
    regime: str
    decision: HealthDecision
    recalled: OutcomeRecord | None  # best prior outcome for this regime, before this run
    bars: int = 0
    extra: dict = field(default_factory=dict)

    def summary(self) -> str:
        rec = ""
        if self.recalled is not None:
            rec = f" | recall[{self.regime}] best={self.recalled.score:.3f}"
        return (
            f"{self.symbol} {self.strategy_id}/{self.interval} [{self.regime}] "
            f"{self.decision.status}/{self.decision.action}{rec} — {self.decision.reason}"
        )


def run_cycle(
    symbol: str,
    candles: Sequence[Candle],
    *,
    current_config: StrategyConfig | None = None,
    strategy_id: str = "edge",
    memory: OutcomeMemory,
    interval: str = "5m",
    grid: dict[str, list] | None = None,
    thresholds: HealthThresholds | None = None,
) -> CycleResult:
    """Run one self-heal cycle for a single asset and persist the outcome."""
    current_config = current_config or StrategyConfig()
    t = thresholds or HealthThresholds()

    regime = detect_regime(list(candles))
    current_metrics = run_backtest(list(candles), current_config, strategy_id=strategy_id)
    sweep = run_sweep(
        list(candles),
        base=current_config,
        grid=grid,
        min_trades=t.min_trades,
        top_k=1,
        strategy_id=strategy_id,
    )
    best = sweep[0] if sweep else None

    # Recall the best prior outcome for THIS regime *before* we write this run's record.
    recalled = memory.best_for_regime(symbol, regime.label)

    decision = assess(current_metrics, best, regime=regime, thresholds=t)

    # Persist: if we're proposing a swap, remember the proposed config + score; otherwise the
    # current config + its score. Tagged by regime so future cycles can recall it.
    if decision.action == "propose_swap" and decision.proposed_config is not None:
        memory.record(
            symbol=symbol,
            regime=regime.label,
            score=decision.proposed_score or 0.0,
            config=decision.proposed_config,
            action="propose_swap",
        )
    else:
        memory.record(
            symbol=symbol,
            regime=regime.label,
            score=score_metrics(current_metrics, min_trades=t.min_trades),
            config=current_config,
            action="hold",
        )

    return CycleResult(
        symbol=symbol,
        strategy_id=strategy_id,
        interval=interval,
        regime=regime.label,
        decision=decision,
        recalled=recalled,
        bars=len(candles),
    )


def run_all(
    fetch: CandleFetcher,
    *,
    symbols: Sequence[str] | None = None,
    memory: OutcomeMemory,
    strategy_id: str = "edge",
    interval: str = "5m",
    lookback: int = 1000,
    current_config: StrategyConfig | None = None,
    grid: dict[str, list] | None = None,
    thresholds: HealthThresholds | None = None,
) -> list[CycleResult]:
    """Run a self-heal cycle across the given symbols (default: all live tier-1 assets)."""
    syms = list(symbols) if symbols else live_symbols()
    results: list[CycleResult] = []
    for sym in syms:
        try:
            candles = fetch(sym, interval, lookback)
        except Exception as e:  # one bad feed must not sink the whole batch
            results.append(
                CycleResult(
                    symbol=sym,
                    strategy_id=strategy_id,
                    interval=interval,
                    regime="unknown",
                    decision=HealthDecision(
                        status="insufficient_data",
                        action="hold",
                        reason=f"fetch failed: {e}",
                        current_score=0.0,
                        proposed_config=None,
                        proposed_score=None,
                        improvement=None,
                    ),
                    recalled=None,
                )
            )
            continue
        results.append(
            run_cycle(
                sym,
                candles,
                current_config=current_config,
                memory=memory,
                strategy_id=strategy_id,
                interval=interval,
                grid=grid,
                thresholds=thresholds,
            )
        )
    return results


def _main(argv: list[str] | None = None) -> int:
    import argparse
    import asyncio

    from teo.config import settings
    from teo.data.binance import fetch_klines

    p = argparse.ArgumentParser(description="Teo self-heal loop")
    p.add_argument("--symbol", help="single symbol; omit for all live tier-1 assets")
    p.add_argument("--strategy", choices=("edge", "hedge"), default="edge")
    p.add_argument(
        "--submit", action="store_true", help="append decisions to the dashboard journal"
    )
    p.add_argument("--interval", default="15m")
    p.add_argument("--lookback", type=int, default=1000)
    args = p.parse_args(argv)

    memory = OutcomeMemory(settings.memory_path)

    def fetch(sym: str, interval: str, lookback: int) -> list[Candle]:
        return asyncio.run(fetch_klines(sym, interval, limit=lookback))

    symbols = [args.symbol] if args.symbol else None
    results = run_all(
        fetch,
        symbols=symbols,
        memory=memory,
        strategy_id=args.strategy,
        interval=args.interval,
        lookback=args.lookback,
    )
    if args.submit:
        from teo.dashboard import submit_decision_to_dashboard

        for r in results:
            asyncio.run(
                submit_decision_to_dashboard(
                    {
                        "asset": r.symbol,
                        "strategyId": r.strategy_id,
                        "regime": r.regime,
                        "status": r.decision.status,
                        "action": r.decision.action,
                        "reason": r.decision.reason,
                        "currentScore": r.decision.current_score,
                        "proposedScore": r.decision.proposed_score,
                        "improvement": r.decision.improvement,
                        "metadata": {"interval": r.interval, "bars": r.bars},
                    }
                )
            )

    for r in results:
        print(r.summary())
    print(f"\n{len(results)} asset(s) checked · memory now holds {len(memory)} outcome(s)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())
