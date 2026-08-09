"""Bridge to the TypeScript strategy.

The dashboard's strategy lives in `core/strategy.ts`. Teo used to score configs
with `teo/backtest/engine.py`, a two-EMA crossover that is NOT that strategy —
so every config it proposed described a different system than the one running.
The gap was not subtle: on a random walk the real strategy produces ~0 trades
where the Python proxy fired 34, because it only takes A/B grades.

This module closes it by shelling out to `scripts/score.ts`, which replays the
real `analyzeCandles` over a candle window and reports metrics net of the real
per-asset trading costs. One subprocess scores every config in a sweep — a
default grid is 36 configs, and a process per config would be untenable.

Falls back to nothing: if the bridge cannot run, callers get an explicit
BridgeUnavailable rather than silently reverting to the proxy and reporting
numbers for the wrong strategy.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from teo.models import BacktestMetrics, Candle, StrategyConfig

# Repo root: teo/backtest/ts_bridge.py → ../../
REPO_ROOT = Path(__file__).resolve().parents[2]
SCORER = REPO_ROOT / "scripts" / "score.ts"

# Python knob name → TypeScript StrategyConfig field.
#
# Only knobs the TS strategy actually reads appear here. The Python model also
# carries rsi_oversold/rsi_overbought/tp1_r/atr_trail_mult, which the old proxy
# ignored entirely — mapping them means sweeping them now does something.
CONFIG_MAP: dict[str, str] = {
    "rsi_oversold": "rsiOversold",
    "rsi_overbought": "rsiOverbought",
    "atr_sl_mult": "atrSlMultiplier",
    "tp1_r": "tp1R",
    "tp2_r": "tp2R",
    "ema_fast": "emaFast",
    "ema_slow": "emaMid",
    "ema_trend": "emaSlow",
    "atr_trail_mult": "atrTrailMultiplier",
}

# Knobs that must stay whole numbers on the TS side.
_INT_FIELDS = {"emaFast", "emaMid", "emaSlow"}


class BridgeUnavailable(RuntimeError):
    """The TypeScript scorer could not be run."""


@dataclass(frozen=True)
class ScoredWindow:
    """Metrics for one config, in-sample and (when split) out-of-sample."""

    config: StrategyConfig
    metrics: BacktestMetrics
    out_of_sample: BacktestMetrics | None


def to_ts_config(config: StrategyConfig) -> dict[str, float]:
    """Translate a Python config into TS StrategyConfig overrides."""
    raw = config.model_dump()
    out: dict[str, float] = {}
    for py_key, ts_key in CONFIG_MAP.items():
        if py_key not in raw:
            continue
        value = raw[py_key]
        out[ts_key] = int(value) if ts_key in _INT_FIELDS else float(value)
    return out


def _to_metrics(m: dict) -> BacktestMetrics:
    """TS metrics → Teo's schema.

    `profitFactor` arrives as null when there were no losing trades. Zero would
    read as "worst possible" to every comparison downstream, so it is mapped to
    a large finite value that sorts as the win it is.
    """
    pf = m.get("profitFactor")
    return BacktestMetrics(
        trades=int(m["trades"]),
        win_rate=round(float(m["winRate"]) / 100, 4),
        net_points=round(float(m["netPoints"]), 4),
        avg_win=round(float(m["avgWin"]), 4),
        avg_loss=round(-abs(float(m["avgLoss"])), 4),
        max_drawdown=round(float(m["maxDrawdown"]), 4),
        profit_factor=999.0 if pf is None else round(float(pf), 4),
    )


def score_configs(
    configs: list[StrategyConfig],
    *,
    symbol: str,
    interval: str = "5m",
    candles: list[Candle] | None = None,
    lookback: int = 1000,
    split_ratio: float | None = None,
    timeout_s: float = 300.0,
) -> list[ScoredWindow]:
    """Score every config against the real strategy in one subprocess.

    Supplying `candles` avoids a second fetch of a window the caller already
    holds, and keeps this testable without network.
    """
    if not configs:
        return []
    if not SCORER.exists():
        raise BridgeUnavailable(f"scorer not found at {SCORER}")

    runtime = shutil.which("bun")
    if runtime is None:
        raise BridgeUnavailable(
            "bun is not on PATH; it runs the TypeScript strategy scorer"
        )

    job: dict = {
        "symbol": symbol,
        "interval": interval,
        "configs": [to_ts_config(c) for c in configs],
    }
    if candles is not None:
        job["candles"] = [c.model_dump() for c in candles]
    else:
        job["lookback"] = lookback
    if split_ratio is not None:
        job["splitRatio"] = split_ratio

    try:
        proc = subprocess.run(
            [runtime, "run", str(SCORER)],
            input=json.dumps(job),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=str(REPO_ROOT),
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise BridgeUnavailable(f"scorer timed out after {timeout_s}s") from e
    except OSError as e:
        raise BridgeUnavailable(f"could not start the scorer: {e}") from e

    if not proc.stdout.strip():
        raise BridgeUnavailable(
            f"scorer produced no output (exit {proc.returncode}): "
            f"{proc.stderr.strip()[:300]}"
        )

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise BridgeUnavailable(f"scorer emitted invalid JSON: {e}") from e

    if "error" in payload:
        raise BridgeUnavailable(f"scorer failed: {payload['error']}")

    results = payload.get("results", [])
    if len(results) != len(configs):
        raise BridgeUnavailable(
            f"scorer returned {len(results)} results for {len(configs)} configs"
        )

    return [
        ScoredWindow(
            config=cfg,
            metrics=_to_metrics(r["metrics"]),
            out_of_sample=(
                _to_metrics(r["outOfSample"]) if r.get("outOfSample") else None
            ),
        )
        for cfg, r in zip(configs, results, strict=True)
    ]


def bridge_available() -> bool:
    """Whether the TypeScript scorer can be invoked."""
    return SCORER.exists() and shutil.which("bun") is not None
