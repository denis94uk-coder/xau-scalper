"""Kronos forecaster — real inference wiring with a clean baseline fallback.

Kronos (https://github.com/shiyu-coder/Kronos) is an open-source foundation model for financial
K-lines. Its `Kronos`, `KronosTokenizer` and `KronosPredictor` classes are published on PyPI as
`kronos-model-arch` (importable as the top-level `model` package; they subclass
`PyTorchModelHubMixin`), so torch + the model code are optional extras
(`pip install -e ".[kronos]"`).

This wrapper:
  * lazily builds the predictor on first use (tokenizer + model from HuggingFace),
  * runs genuine inference via `KronosPredictor.predict(...)`, and
  * on any missing dep / load / inference error raises `KronosUnavailable` so the service falls
    back to the transparent baseline — a forecast request never hard-crashes.

All torch-free shaping (interval math, future timestamps, predicted OHLCV → cone) lives in
`kronos_adapt` and is unit-tested without torch.
"""

from __future__ import annotations

from teo.config import settings
from teo.forecasting import kronos_adapt as ka
from teo.models import Candle, ForecastResponse

# Default tokenizer to pair with a Kronos model when one isn't given explicitly.
_DEFAULT_TOKENIZER = "NeoQuasar/Kronos-Tokenizer-base"


class KronosUnavailable(RuntimeError):
    """Raised when Kronos can't be used; the service falls back to the baseline."""


class KronosForecaster:
    name: str

    def __init__(
        self,
        model_id: str,
        device: str = "cpu",
        tokenizer_id: str | None = None,
        max_context: int = 512,
    ) -> None:
        if not model_id:
            raise KronosUnavailable("TEO_KRONOS_MODEL is not set")
        self.model_id = model_id
        self.tokenizer_id = tokenizer_id or settings.kronos_tokenizer or _DEFAULT_TOKENIZER
        self.device = device
        self.max_context = max_context
        self.name = f"kronos:{model_id}"
        self._predictor = None  # built lazily

    def _ensure_loaded(self) -> None:
        if self._predictor is not None:
            return
        try:
            # `kronos-model-arch` (the `[kronos]` extra) installs these under `model`;
            # a vendored `model/` on PYTHONPATH works identically.
            from model import Kronos, KronosPredictor, KronosTokenizer
        except ImportError as e:
            raise KronosUnavailable(
                "Kronos not installed. Install the extras (`pip install -e \".[kronos]\"`) "
                f"or vendor the Kronos `model` package (see README → Enabling Kronos). "
                f"Import error: {e}"
            ) from e

        try:
            tokenizer = KronosTokenizer.from_pretrained(self.tokenizer_id)
            model = Kronos.from_pretrained(self.model_id)
            self._predictor = KronosPredictor(
                model, tokenizer, device=self.device, max_context=self.max_context
            )
        except Exception as e:  # network / repo / config / device issues
            raise KronosUnavailable(
                f"failed to load Kronos '{self.model_id}' ({self.tokenizer_id}): {e}"
            ) from e

    def forecast(
        self, candles: list[Candle], horizon: int, *, symbol: str, interval: str
    ) -> ForecastResponse:
        self._ensure_loaded()

        # Trim the context to what the model can attend to.
        context = candles[-self.max_context :] if len(candles) > self.max_context else candles

        try:
            import pandas as pd

            interval_ms = ka.interval_to_ms(interval)
            x_df = pd.DataFrame(ka.context_ohlcv(context))
            x_ts = pd.Series(pd.to_datetime(ka.context_timestamps(context), unit="ms"))
            y_ts = pd.Series(
                pd.to_datetime(
                    ka.future_timestamps(context[-1].time, interval_ms, horizon), unit="ms"
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
        except Exception as e:  # any inference-time failure → fall back to baseline
            raise KronosUnavailable(f"Kronos inference failed: {e}") from e

        # Shape predicted OHLCV columns into Teo's response (torch-free, tested).
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
            times=ka.future_timestamps(context[-1].time, ka.interval_to_ms(interval), horizon),
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
        )
    except KronosUnavailable:
        return None
    return _INSTANCE
