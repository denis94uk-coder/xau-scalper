"""Regime-tagged outcome memory (roadmap 1) — the 'memory' the self-heal loop learns from.

Every self-heal cycle appends an outcome record: which symbol, which market regime, the config that
was in force (or proposed), its score, and when. Over time this lets the loop *recall* the config
that historically scored best in *this* regime — so adaptation compounds instead of re-deriving from
scratch on every run.

Storage is a plain JSON file (append-on-write, atomic replace). No DB, no secrets — deliberately
simple and inspectable. Pure I/O with a small in-file index; fully unit-tested with a tmp path.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from dataclasses import asdict, dataclass, field

from teo.models import StrategyConfig


@dataclass
class OutcomeRecord:
    symbol: str
    regime: str  # regime label, e.g. "trend_up/high_vol"
    score: float
    config: dict  # StrategyConfig as a plain dict
    action: str  # "hold" | "propose_swap" | "applied"
    ts: float = field(default_factory=lambda: time.time())


class OutcomeMemory:
    """A JSON-file store of regime-tagged self-heal outcomes."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._records: list[OutcomeRecord] = self._load()

    def _load(self) -> list[OutcomeRecord]:
        if not os.path.exists(self.path):
            return []
        try:
            with open(self.path, encoding="utf-8") as f:
                raw = json.load(f)
            return [OutcomeRecord(**r) for r in raw]
        except (json.JSONDecodeError, TypeError, OSError):
            # A corrupt/partial file must never crash the loop; start fresh.
            return []

    def _flush(self) -> None:
        tmp_fd, tmp_path = tempfile.mkstemp(
            dir=os.path.dirname(self.path) or ".", suffix=".tmp"
        )
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump([asdict(r) for r in self._records], f, indent=2)
            os.replace(tmp_path, self.path)  # atomic
        except OSError:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise

    def record(
        self,
        *,
        symbol: str,
        regime: str,
        score: float,
        config: StrategyConfig,
        action: str,
    ) -> OutcomeRecord:
        rec = OutcomeRecord(
            symbol=symbol,
            regime=regime,
            score=round(float(score), 6),
            config=config.model_dump(),
            action=action,
        )
        self._records.append(rec)
        self._flush()
        return rec

    def best_for_regime(
        self, symbol: str, regime: str, *, min_score: float | None = None
    ) -> OutcomeRecord | None:
        """Highest-scoring recorded outcome for this symbol + regime, if any."""
        cands = [
            r for r in self._records if r.symbol == symbol and r.regime == regime
        ]
        if min_score is not None:
            cands = [r for r in cands if r.score >= min_score]
        if not cands:
            return None
        return max(cands, key=lambda r: r.score)

    def recall_config(self, symbol: str, regime: str) -> StrategyConfig | None:
        """The best-known config for this symbol + regime, ready to reuse."""
        rec = self.best_for_regime(symbol, regime)
        return StrategyConfig(**rec.config) if rec else None

    def history(self, symbol: str | None = None, *, limit: int = 50) -> list[OutcomeRecord]:
        rows = self._records if symbol is None else [r for r in self._records if r.symbol == symbol]
        return rows[-limit:]

    def __len__(self) -> int:
        return len(self._records)
