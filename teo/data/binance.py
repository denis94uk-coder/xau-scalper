"""Free, keyless Binance klines fetch (paginated). Mirrors the dashboard's data source."""

from __future__ import annotations

import httpx

from teo.config import settings
from teo.models import Candle

_MAX_PER_CALL = 1000


def _row_to_candle(row: list) -> Candle:
    # Binance kline row: [openTime, open, high, low, close, volume, closeTime, ...]
    return Candle(
        time=int(row[0]),
        open=float(row[1]),
        high=float(row[2]),
        low=float(row[3]),
        close=float(row[4]),
        volume=float(row[5]),
    )


async def fetch_klines(
    symbol: str,
    interval: str = "5m",
    limit: int = 200,
    start: int | None = None,
    end: int | None = None,
) -> list[Candle]:
    """Fetch up to `limit` candles, paginating in 1000-candle pages when a range is given.

    When `start`/`end` are omitted, returns the most recent `limit` candles.
    """
    limit = min(limit, settings.max_candles)
    url = f"{settings.binance_base_url}/api/v3/klines"

    async with httpx.AsyncClient(timeout=settings.http_timeout_s) as client:
        if start is None and end is None:
            resp = await client.get(
                url,
                params={
                    "symbol": symbol,
                    "interval": interval,
                    "limit": min(limit, _MAX_PER_CALL),
                },
            )
            resp.raise_for_status()
            return [_row_to_candle(r) for r in resp.json()]

        out: list[Candle] = []
        cursor = start
        while len(out) < limit:
            params: dict[str, object] = {
                "symbol": symbol,
                "interval": interval,
                "limit": _MAX_PER_CALL,
            }
            if cursor is not None:
                params["startTime"] = cursor
            if end is not None:
                params["endTime"] = end
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            rows = resp.json()
            if not rows:
                break
            out.extend(_row_to_candle(r) for r in rows)
            last_open = int(rows[-1][0])
            if len(rows) < _MAX_PER_CALL:
                break
            cursor = last_open + 1
        return out[:limit]
