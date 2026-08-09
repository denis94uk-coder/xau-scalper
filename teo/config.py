"""Environment-driven settings. No secrets — Teo only uses free, keyless data."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    # Free, keyless Binance market-data mirror.
    binance_base_url: str = _env("TEO_BINANCE_BASE_URL", "https://data-api.binance.vision")
    http_timeout_s: float = float(_env("TEO_HTTP_TIMEOUT_S", "15"))

    # Kronos: HF repo id for the pretrained weights. Empty => baseline forecaster only.
    kronos_model: str = _env("TEO_KRONOS_MODEL", "")
    kronos_tokenizer: str = _env("TEO_KRONOS_TOKENIZER", "")  # empty => sensible default
    kronos_device: str = _env("TEO_KRONOS_DEVICE", "cpu")
    kronos_max_context: int = int(_env("TEO_KRONOS_MAX_CONTEXT", "512"))

    # Regime-tagged outcome memory (roadmap 1). JSON file; the self-heal loop appends to it.
    memory_path: str = _env("TEO_MEMORY_PATH", ".teo_memory.json")

    # Guardrails.
    max_candles: int = int(_env("TEO_MAX_CANDLES", "2000"))
    max_horizon: int = int(_env("TEO_MAX_HORIZON", "120"))


settings = Settings()
