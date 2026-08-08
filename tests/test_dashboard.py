"""Tests for teo.dashboard — submit_to_dashboard()."""
from __future__ import annotations

import httpx
import pytest
import respx

from teo.dashboard import get_dashboard_url, submit_decision_to_dashboard, submit_to_dashboard

PROPOSAL = {
    "direction": "LONG",
    "entryPrice": 3450.0,
    "stopLoss": 3420.0,
    "tp1": 3490.0,
    "tp2": 3540.0,
    "confidence": 72.0,
    "reason": "Test proposal",
    "timeframe": "15m",
    "bias": "trend_up",
    "biasStrength": 0.75,
    "spotPrice": 3455.0,
    "asset": "PAXGUSDT",
    "teoScore": 0.72,
    "teoRegime": "trend_up",
}


def test_url_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TEO_DASHBOARD_URL", raising=False)
    assert get_dashboard_url() is None


def test_url_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEO_DASHBOARD_URL", "https://x.convex.site/")
    assert get_dashboard_url() == "https://x.convex.site"


def test_url_strips_whitespace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEO_DASHBOARD_URL", "  https://x.convex.site  ")
    assert get_dashboard_url() == "https://x.convex.site"


@pytest.mark.asyncio
async def test_skip_when_no_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TEO_DASHBOARD_URL", raising=False)
    result = await submit_to_dashboard(PROPOSAL)
    assert result is None


@pytest.mark.asyncio
@respx.mock
async def test_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEO_DASHBOARD_URL", "https://x.convex.site")
    respx.post("https://x.convex.site/teo/propose").mock(
        return_value=httpx.Response(200, json={"ok": True, "id": "abc123"})
    )
    result = await submit_to_dashboard(PROPOSAL)
    assert result == {"ok": True, "id": "abc123"}


@pytest.mark.asyncio
@respx.mock
async def test_none_on_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEO_DASHBOARD_URL", "https://x.convex.site")
    respx.post("https://x.convex.site/teo/propose").mock(
        return_value=httpx.Response(500, json={"error": "Server error"})
    )
    result = await submit_to_dashboard(PROPOSAL)
    assert result is None


@pytest.mark.asyncio
@respx.mock
async def test_decision_journal_submission(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEO_DASHBOARD_URL", "https://x.convex.site")
    decision = {
        "asset": "BTCUSDT",
        "strategyId": "hedge",
        "regime": "trend_up/normal_vol",
        "status": "healthy",
        "action": "hold",
        "reason": "no swap proposed",
        "currentScore": 0.42,
    }
    respx.post("https://x.convex.site/teo/decision").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    result = await submit_decision_to_dashboard(decision)
    assert result == {"ok": True}


@pytest.mark.asyncio
@respx.mock
async def test_none_on_network_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEO_DASHBOARD_URL", "https://x.convex.site")
    respx.post("https://x.convex.site/teo/propose").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )
    result = await submit_to_dashboard(PROPOSAL)
    assert result is None


@respx.mock
@pytest.mark.asyncio
async def test_proposal_sends_shared_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Convex /teo/* routes reject unauthenticated writes, so the secret must be sent."""
    monkeypatch.setenv("TEO_DASHBOARD_URL", "https://x.convex.site")
    monkeypatch.setenv("TEO_SHARED_SECRET", "s3cret")
    route = respx.post("https://x.convex.site/teo/propose").mock(
        return_value=httpx.Response(200, json={"ok": True, "id": "abc"})
    )

    result = await submit_to_dashboard(PROPOSAL)

    assert result == {"ok": True, "id": "abc"}
    assert route.calls.last.request.headers["x-teo-secret"] == "s3cret"


@respx.mock
@pytest.mark.asyncio
async def test_decision_sends_shared_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEO_DASHBOARD_URL", "https://x.convex.site")
    monkeypatch.setenv("TEO_SHARED_SECRET", "s3cret")
    route = respx.post("https://x.convex.site/teo/decision").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    await submit_decision_to_dashboard({"asset": "BTCUSDT", "action": "hold"})

    assert route.calls.last.request.headers["x-teo-secret"] == "s3cret"


@respx.mock
@pytest.mark.asyncio
async def test_no_secret_header_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a configured secret we still post — and let the server 401 it."""
    monkeypatch.setenv("TEO_DASHBOARD_URL", "https://x.convex.site")
    monkeypatch.delenv("TEO_SHARED_SECRET", raising=False)
    route = respx.post("https://x.convex.site/teo/propose").mock(
        return_value=httpx.Response(401, json={"error": "Unauthorized"})
    )

    assert await submit_to_dashboard(PROPOSAL) is None
    assert "x-teo-secret" not in route.calls.last.request.headers
