"""Tests for running Kronos locally.

Split into two groups:

  * Wiring — configuration, source resolution and the fallback contract. These
    run everywhere, with or without torch installed, because the whole point of
    the design is that a missing model degrades to the baseline rather than
    breaking the service.

  * Architecture — builds the VENDORED model with random weights and runs a real
    forward pass. Skipped when torch is absent. This proves the vendored source
    is complete and executable without downloading any weights, which is the
    part that cannot be checked from an environment with no Hub access.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from teo.forecasting.kronos import (
    KronosForecaster,
    KronosUnavailable,
    _default_tokenizer_for,
    get_kronos,
    local_weights_present,
    reset_kronos,
)

HAS_TORCH = importlib.util.find_spec("torch") is not None
requires_torch = pytest.mark.skipif(not HAS_TORCH, reason="torch not installed")


@pytest.fixture(autouse=True)
def _clear_cache():
    reset_kronos()
    yield
    reset_kronos()


# ─── Wiring ───

def test_mini_gets_the_2k_tokenizer():
    # Kronos-mini has a 2048 context and its own tokenizer; pairing it with the
    # base tokenizer would silently mismatch.
    assert _default_tokenizer_for("NeoQuasar/Kronos-mini").endswith("Tokenizer-2k")


def test_small_and_base_get_the_base_tokenizer():
    for mid in ("NeoQuasar/Kronos-small", "NeoQuasar/Kronos-base"):
        assert _default_tokenizer_for(mid).endswith("Tokenizer-base")


def test_unconfigured_forecaster_is_unavailable_not_fatal():
    with pytest.raises(KronosUnavailable):
        KronosForecaster(model_id="", local_dir="")


def test_get_kronos_returns_none_when_unconfigured(monkeypatch: pytest.MonkeyPatch):
    # The service must keep serving forecasts from the baseline.
    # Settings is a frozen dataclass, so swap the whole object rather than a field.
    import dataclasses

    from teo.config import settings as real

    monkeypatch.setattr(
        "teo.forecasting.kronos.settings",
        dataclasses.replace(real, kronos_model="", kronos_local_dir=""),
    )
    assert get_kronos() is None


def test_local_dir_alone_is_enough_configuration(tmp_path: Path):
    (tmp_path / "model").mkdir()
    (tmp_path / "tokenizer").mkdir()
    f = KronosForecaster(model_id="", local_dir=str(tmp_path))
    assert f._resolve_sources() == (
        str(tmp_path / "model"),
        str(tmp_path / "tokenizer"),
    )


def test_local_weights_take_precedence_over_a_hub_id(tmp_path: Path):
    # Once weights are on disk, nothing should reach for the network.
    (tmp_path / "model").mkdir()
    (tmp_path / "tokenizer").mkdir()
    f = KronosForecaster(model_id="NeoQuasar/Kronos-mini", local_dir=str(tmp_path))
    model_src, tok_src = f._resolve_sources()
    assert model_src.startswith(str(tmp_path))
    assert tok_src.startswith(str(tmp_path))


def test_incomplete_local_dir_falls_back_to_the_hub_id(tmp_path: Path):
    (tmp_path / "model").mkdir()  # tokenizer/ missing
    f = KronosForecaster(model_id="NeoQuasar/Kronos-mini", local_dir=str(tmp_path))
    assert f._resolve_sources() == ("NeoQuasar/Kronos-mini", "NeoQuasar/Kronos-Tokenizer-2k")


def test_incomplete_local_dir_with_no_hub_id_is_a_clear_error(tmp_path: Path):
    (tmp_path / "model").mkdir()
    f = KronosForecaster(model_id="", local_dir=str(tmp_path))
    with pytest.raises(KronosUnavailable, match="fetch_weights"):
        f._resolve_sources()


def test_local_weights_present_detects_both_halves(tmp_path: Path):
    assert not local_weights_present(str(tmp_path))
    (tmp_path / "model").mkdir()
    assert not local_weights_present(str(tmp_path))
    (tmp_path / "tokenizer").mkdir()
    assert local_weights_present(str(tmp_path))


def test_local_weights_present_is_false_for_empty_config():
    assert not local_weights_present("")


# ─── Fetcher ───

def test_fetch_rejects_an_unknown_variant(tmp_path: Path):
    from teo.forecasting.fetch_weights import fetch

    assert fetch("enormous", tmp_path) == 1


def test_every_variant_names_a_model_and_tokenizer_repo():
    from teo.forecasting.fetch_weights import VARIANTS

    assert set(VARIANTS) == {"mini", "small", "base"}
    for model_repo, tok_repo, size in VARIANTS.values():
        assert model_repo.startswith("NeoQuasar/")
        assert "Tokenizer" in tok_repo
        assert size


def test_mini_variant_pairs_with_the_2k_tokenizer():
    from teo.forecasting.fetch_weights import VARIANTS

    assert VARIANTS["mini"][1].endswith("Tokenizer-2k")


# ─── Vendored architecture ───

@requires_torch
def test_vendored_package_exposes_the_three_classes():
    from teo.vendor.kronos import Kronos, KronosPredictor, KronosTokenizer

    for cls in (Kronos, KronosTokenizer, KronosPredictor):
        assert cls is not None


@requires_torch
def test_vendored_model_builds_and_runs_a_forward_pass():
    """The vendored source is complete and executable without any weights.

    Random initialisation, so the OUTPUT is meaningless — what this establishes
    is that the architecture imports, constructs and computes, which is the part
    that would otherwise only be discovered on a machine that can reach the Hub.
    """
    import torch

    from teo.vendor.kronos import Kronos

    torch.manual_seed(0)
    model = Kronos(
        s1_bits=6,
        s2_bits=6,
        n_layers=2,
        d_model=32,
        n_heads=2,
        ff_dim=64,
        ffn_dropout_p=0.0,
        attn_dropout_p=0.0,
        resid_dropout_p=0.0,
        token_dropout_p=0.0,
        learn_te=True,
    )
    model.eval()

    batch, seq = 1, 16
    s1 = torch.randint(0, 2**6, (batch, seq))
    s2 = torch.randint(0, 2**6, (batch, seq))
    stamp = torch.zeros(batch, seq, 4)

    with torch.no_grad():
        out = model(s1, s2, stamp)

    # Two-head output (pre/post token logits).
    assert isinstance(out, tuple)
    assert out[0].shape[0] == batch
    assert torch.isfinite(out[0]).all()


@requires_torch
def test_vendored_tokenizer_builds():
    from teo.vendor.kronos import KronosTokenizer

    tok = KronosTokenizer(
        d_in=7,
        d_model=32,
        n_heads=2,
        ff_dim=64,
        n_enc_layers=1,
        n_dec_layers=1,
        ffn_dropout_p=0.0,
        attn_dropout_p=0.0,
        resid_dropout_p=0.0,
        s1_bits=6,
        s2_bits=6,
        beta=1.0,
        gamma0=1.0,
        gamma=1.0,
        zeta=1.0,
        group_size=1,
    )
    assert sum(p.numel() for p in tok.parameters()) > 0
