"""Asset registry — parity with the xau-scalper dashboard's multi-asset universe (roadmap 3).

One source of truth for which symbols Teo forecasts / self-heals over, plus the metadata the loop
needs: the data source, whether it trades 24/7 or only in market hours, and a human label. The
self-heal loop iterates this registry so adding an asset is a one-line change here.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Asset:
    symbol: str  # the venue's ticker (what the data feed expects)
    label: str  # human-friendly name
    source: str  # "binance" | "hyperliquid" | "kraken" | "stock"
    kind: str  # "crypto" | "metal" | "stock"
    tier: int  # 1 live/free, 2 queued alt-source, 3 market-hours stocks
    market_hours: bool = False  # True => only trades during exchange hours (stocks)


# Tier 1 — Binance free/keyless, live now (matches the dashboard's live set).
_TIER1 = [
    Asset("PAXGUSDT", "Gold", "binance", "metal", 1),
    Asset("BTCUSDT", "Bitcoin", "binance", "crypto", 1),
    Asset("ETHUSDT", "Ethereum", "binance", "crypto", 1),
    Asset("BNBUSDT", "BNB", "binance", "crypto", 1),
    Asset("LINKUSDT", "Chainlink", "binance", "crypto", 1),
    Asset("AAVEUSDT", "Aave", "binance", "crypto", 1),
    Asset("TAOUSDT", "Bittensor", "binance", "crypto", 1),
]

# Tier 2 — alternative public sources (queued; not Binance-listed).
_TIER2 = [
    Asset("HYPE", "Hyperliquid", "hyperliquid", "crypto", 2),
    Asset("XMRUSD", "Monero", "kraken", "crypto", 2),
]

# Tier 3 — Magnificent 7 equities (market-hours only, 9:30–16:00 ET weekdays).
_TIER3 = [
    Asset(sym, name, "stock", "stock", 3, market_hours=True)
    for sym, name in [
        ("AAPL", "Apple"),
        ("MSFT", "Microsoft"),
        ("NVDA", "Nvidia"),
        ("AMZN", "Amazon"),
        ("GOOGL", "Alphabet"),
        ("META", "Meta"),
        ("TSLA", "Tesla"),
    ]
]

REGISTRY: list[Asset] = [*_TIER1, *_TIER2, *_TIER3]
_BY_SYMBOL = {a.symbol: a for a in REGISTRY}


def get_asset(symbol: str) -> Asset | None:
    return _BY_SYMBOL.get(symbol.upper())


def assets(*, tier: int | None = None, source: str | None = None) -> list[Asset]:
    """Filter the registry by tier and/or source."""
    out = REGISTRY
    if tier is not None:
        out = [a for a in out if a.tier == tier]
    if source is not None:
        out = [a for a in out if a.source == source]
    return list(out)


def live_symbols() -> list[str]:
    """Symbols Teo can forecast today with its free Binance feed (tier 1)."""
    return [a.symbol for a in REGISTRY if a.source == "binance"]
