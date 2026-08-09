"""Kronos forecaster — local inference, with a transparent baseline fallback.

Kronos (https://github.com/shiyu-coder/Kronos, MIT) is a foundation model for
financial K-lines. The architecture is VENDORED at `teo/vendor/kronos` rather
than installed from PyPI, because the published `kronos-model-arch` distribution
hard-pins a plotting stack the model code never imports. See that package's
docstring for the detail.

Running it entirely locally
---------------------------
Weights are the only thing that starts life elsewhere, and they are a one-time
anonymous download — no account, no key, no signup:

    bun run kronos:fetch          # or: python -m teo.forecasting.fetch_weights

That writes them under `models/kronos/`. Point TEO_KRONOS_LOCAL_DIR at it and
inference never contacts the network again; the process runs offline forever
after. If the directory is absent the adapter falls back to a Hub id, and if
that fails too it raises KronosUnavailable so /forecast degrades to the baseline
rather than erroring.

Model sizes are small enough that CPU is a reasonable default:
Kronos-mini is 4.1M parameters, Kronos-small 24.7M.

All torch-free shaping lives in `kronos_adapt` and is tested without torch.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from teo.config import settings
from teo.forecasting import kronos_adapt as ka
from teo.models import Candle, ForecastResponse

# Tokenizer paired with a model when none is given. Kronos-mini uses the 2k
# tokenizer; the small/base models use the base one.
_DEFAULT_TOKENIZER = "NeoQuasar/Kronos-Tokenizer-base"
_MINI_TOKENIZER = "NeoQuasar/Kronos-Tokenizer-2k"


class KronosUnavailable(RuntimeError):
    """Raised when Kronos can't be used; the service falls back to the baseline."""


def _default_tokenizer_for(model_id: str) -> str:
    return _MINI_TOKENIZER if "mini" in model_id.lower() else _DEFAULT_TOKENIZER


def _import_kronos() -> tuple[Any, Any, Any]:
    """Load the architecture classes.

    An externally installed `model` package wins if present, so anyone who does
    install upstream keeps their copy. Otherwise the vendored source is used.
    """
    try:
        from model import Kronos, KronosPredictor, KronosTokenizer  # type: ignore

        return Kronos, KronosTokenizer, KronosPredictor
    except ImportError:
        pass

    try:
        from teo.vendor.kronos import Kronos, KronosPredictor, KronosTokenizer

        return Kronos, KronosTokenizer, KronosPredictor
    except ImportError as e:
        # The vendored source is always present, so this means torch (or one of
        # its siblings) is missing rather than the model code.
        raise KronosUnavailable(
            "Kronos needs torch. Install the extra: pip install -e '.[kronos]'. "
            f"Import error: {e}"
        ) from e


class KronosForecaster:
    name: str

    def __init__(
        self,
        model_id: str,
        device: str = "cpu",
        tokenizer_id: str | None = None,
        max_context: int = 512,
        local_dir: str | None = None,
    ) -> None:
        self.local_dir = local_dir or settings.kronos_local_dir or ""
        # A local weights directory is sufficient on its own — a Hub id is only
        # needed when there is nothing on disk to load.
        if not model_id and not self.local_dir:
            raise KronosUnavailable(
                "set TEO_KRONOS_LOCAL_DIR (after `python -m teo.forecasting.fetch_weights`) "
                "or TEO_KRONOS_MODEL"
            )
        self.model_id = model_id
        self.tokenizer_id = (
            tokenizer_id
            or settings.kronos_tokenizer
            or _default_tokenizer_for(model_id)
        )
        self.device = device
        self.max_context = max_context
        self.name = f"kronos:{Path(self.local_dir).name or model_id}"
        self._predictor: Any = None

    def _resolve_sources(self) -> tuple[str, str]:
        """Where to load the model and tokenizer from.

        Prefers local paths so a configured install never reaches the network.
        """
        if self.local_dir:
            base = Path(self.local_dir)
            model_path = base / "model"
            tok_path = base / "tokenizer"
            if model_path.is_dir() and tok_path.is_dir():
                return str(model_path), str(tok_path)
            if not self.model_id:
                raise KronosUnavailable(
                    f"local weights not found under {base} "
                    "(expected model/ and tokenizer/ subdirectories); "
                    "run `python -m teo.forecasting.fetch_weights`"
                )
        return self.model_id, self.tokenizer_id

    def _ensure_loaded(self) -> None:
        if self._predictor is not None:
            return

        Kronos, KronosTokenizer, KronosPredictor = _import_kronos()
        model_src, tok_src = self._resolve_sources()

        try:
            tokenizer = KronosTokenizer.from_pretrained(tok_src)
            model = Kronos.from_pretrained(model_src)
            self._predictor = KronosPredictor(
                model, tokenizer, device=self.device, max_context=self.max_context
            )
        except Exception as e:  # network / repo / config / device
            raise KronosUnavailable(
                f"failed to load Kronos from '{model_src}' ({tok_src}): {e}"
            ) from e

    def forecast(
        self, candles: list[Candle], horizon: int, *, symbol: str, interval: str
    ) -> ForecastResponse:
        self._ensure_loaded()

        context = (
            candles[-self.max_context :]
            if len(candles) > self.max_context
            else candles
        )

        try:
            import pandas as pd

            interval_ms = ka.interval_to_ms(interval)
            x_df = pd.DataFrame(ka.context_ohlcv(context))
            x_ts = pd.Series(pd.to_datetime(ka.context_timestamps(context), unit="ms"))
            y_ts = pd.Series(
                pd.to_datetime(
                    ka.future_timestamps(context[-1].time, interval_ms, horizon),
                    unit="ms",
                )
            )

            pred = self._predictor.predict(
                df=x_df,
                x_timestamp=x_ts,
                y_timestamp=y_ts,
                pred_len=horizon,
                T=1.0,
                top_p=0.9,
                sample_count=1,
            )
        except KronosUnavailable:
            raise
        except Exception as e:
            raise KronosUnavailable(f"Kronos inference failed: {e}") from e

        try:
            close = [float(v) for v in pred["close"].tolist()]
            high = [float(v) for v in pred["high"].tolist()]
            low = [float(v) for v in pred["low"].tolist()]
        except Exception as e:
            raise KronosUnavailable(f"unexpected Kronos output shape: {e}") from e

        return ka.predicted_to_response(
            symbol=symbol,
            interval=interval,
            model_name=self.name,
            last_close=context[-1].close,
            times=ka.future_timestamps(
                context[-1].time, ka.interval_to_ms(interval), horizon
            ),
            close=close,
            high=high,
            low=low,
        )


_INSTANCE: KronosForecaster | None = None


def get_kronos() -> KronosForecaster | None:
    """Return a cached Kronos forecaster, or None if it can't be constructed."""
    global _INSTANCE
    if _INSTANCE is not None:
        return _INSTANCE
    try:
        _INSTANCE = KronosForecaster(
            settings.kronos_model,
            settings.kronos_device,
            max_context=settings.kronos_max_context,
            local_dir=settings.kronos_local_dir,
        )
    except KronosUnavailable:
        return None
    return _INSTANCE


def reset_kronos() -> None:
    """Drop the cached instance. Used by tests and after changing configuration."""
    global _INSTANCE
    _INSTANCE = None


def local_weights_present(local_dir: str | None = None) -> bool:
    """True when a usable local weights directory exists."""
    base = Path(local_dir or settings.kronos_local_dir or "")
    if not base.name:
        return False
    return (base / "model").is_dir() and (base / "tokenizer").is_dir()


def default_weights_dir() -> Path:
    return Path(os.environ.get("TEO_KRONOS_LOCAL_DIR") or "models/kronos")
