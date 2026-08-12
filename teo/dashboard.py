"""
Dashboard bridge — submits trade proposals to the local Bun server's /teo/propose endpoint.

Usage:
    from teo.dashboard import submit_to_dashboard

    await submit_to_dashboard({
        "direction": "LONG",
        "entryPrice": 3450.0,
        "stopLoss": 3420.0,
        "tp1": 3490.0,
        "tp2": 3540.0,
        "confidence": 72.0,
        "reason": "Bull sweep below support, regime: trend_up",
        "timeframe": "15m",
        "bias": "trend_up",
        "biasStrength": 0.75,
        "spotPrice": 3455.0,
        "asset": "PAXGUSDT",
        "teoScore": 0.72,
        "teoRegime": "trend_up",
    })
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

log = logging.getLogger(__name__)


def get_dashboard_url() -> str | None:
    """Return the Convex HTTP URL from TEO_DASHBOARD_URL env var, or None if not set."""
    url = os.environ.get("TEO_DASHBOARD_URL", "").strip().rstrip("/")
    return url or None


def _auth_headers() -> dict[str, str]:
    """Shared secret the Convex /teo/* routes require.

    The dashboard rejects unauthenticated writes, so a missing secret means the
    post will 401 — we send whatever is configured and let the server decide,
    rather than silently skipping the call.
    """
    secret = os.environ.get("TEO_SHARED_SECRET", "").strip()
    return {"x-teo-secret": secret} if secret else {}


async def submit_to_dashboard(proposal: dict[str, Any]) -> dict[str, Any] | None:
    """
    POST a trade proposal to the Convex /teo/propose endpoint.

    Returns the response JSON dict on success, None on failure (error is logged).
    Silently skips (returns None) if TEO_DASHBOARD_URL is not configured.
    """
    url = get_dashboard_url()
    if not url:
        log.debug("TEO_DASHBOARD_URL not set — proposal not submitted to dashboard")
        log.info("Unsubmitted proposal: %s", proposal)
        return None

    endpoint = f"{url}/teo/propose"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(endpoint, json=proposal, headers=_auth_headers())
            resp.raise_for_status()
            result: dict[str, Any] = resp.json()
            log.info("Proposal submitted to dashboard: ideaId=%s", result.get("id"))
            return result
    except httpx.HTTPStatusError as exc:
        log.warning(
            "Dashboard submission HTTP error: %s %s — %s",
            exc.response.status_code,
            endpoint,
            exc.response.text[:200],
        )
    except httpx.RequestError as exc:
        log.warning("Dashboard submission request error: %s", exc)
    return None


async def submit_decision_to_dashboard(decision: dict[str, Any]) -> dict[str, Any] | None:
    """Record a Teo hold/proposal decision in the dashboard journal.

    This endpoint is append-only: it records the decision and never applies a proposed
    configuration. If the dashboard URL is absent, the decision remains in local logs.
    """
    url = get_dashboard_url()
    if not url:
        log.debug("TEO_DASHBOARD_URL not set — decision not submitted to dashboard")
        log.info("Unsubmitted Teo decision: %s", decision)
        return None

    endpoint = f"{url}/teo/decision"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(endpoint, json=decision, headers=_auth_headers())
            resp.raise_for_status()
            result: dict[str, Any] = resp.json()
            log.info(
                "Teo decision submitted: asset=%s action=%s",
                decision.get("asset"),
                decision.get("action"),
            )
            return result
    except httpx.HTTPStatusError as exc:
        log.warning(
            "Decision journal HTTP error: %s %s — %s",
            exc.response.status_code,
            endpoint,
            exc.response.text[:200],
        )
    except httpx.RequestError as exc:
        log.warning("Decision journal request error: %s", exc)
    return None
