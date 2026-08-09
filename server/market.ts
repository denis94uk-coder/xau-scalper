/**
 * Market data feed. The one thing that genuinely has to come from outside —
 * you cannot compute a gold signal without a gold price.
 *
 * Keyless and account-free: Binance's public market-data mirror needs no API
 * key, no signup, no dashboard. Nothing here holds a credential.
 *
 * Two efficiency rules the Convex version broke, both of which mattered because
 * they ran every minute:
 *   * Prices for ALL assets come from ONE request. Binance accepts a symbols
 *     array; the old code issued one fetch per asset per tick.
 *   * Candles are fetched incrementally from the newest stored bar, not as a
 *     fresh 200-bar window every cycle.
 */

import type { AssetDefinition } from "../convex/lib/assets";
import type { Candle } from "../convex/lib/strategy";

const BINANCE_API =
  process.env.TEO_BINANCE_BASE_URL ?? "https://data-api.binance.vision/api/v3";

/** Injectable so tests never touch the network. */
export type Fetcher = typeof fetch;

export interface MarketOptions {
  fetcher?: Fetcher;
}

function toCandle(k: unknown[]): Candle {
  return {
    time: Math.floor(Number(k[0]) / 1000),
    open: Number.parseFloat(k[1] as string),
    high: Number.parseFloat(k[2] as string),
    low: Number.parseFloat(k[3] as string),
    close: Number.parseFloat(k[4] as string),
    volume: Number.parseFloat(k[5] as string),
  };
}

/**
 * Latest price for many symbols in a SINGLE request.
 *
 * Returns a map keyed by the venue symbol. A symbol missing from the response
 * is simply absent from the map — callers skip it rather than trading on a
 * fabricated price.
 */
export async function fetchPrices(
  symbols: string[],
  opts: MarketOptions = {},
): Promise<Map<string, number>> {
  const doFetch = opts.fetcher ?? fetch;
  const out = new Map<string, number>();
  if (symbols.length === 0) return out;

  const query = encodeURIComponent(JSON.stringify(symbols));
  const res = await doFetch(`${BINANCE_API}/ticker/price?symbols=${query}`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);

  const rows = (await res.json()) as Array<{ symbol: string; price: string }>;
  for (const row of rows) {
    const price = Number.parseFloat(row.price);
    if (Number.isFinite(price) && price > 0) out.set(row.symbol, price);
  }
  return out;
}

/**
 * Klines for one symbol/interval.
 *
 * `since` (epoch seconds of the newest bar already stored) makes this
 * incremental: only bars at or after that point are requested. The bar itself
 * is re-fetched because the most recent candle is usually still open and its
 * high/low/close are not final.
 */
export async function fetchCandles(
  symbol: string,
  interval: string,
  opts: MarketOptions & { limit?: number; since?: number | null } = {},
): Promise<Candle[]> {
  const doFetch = opts.fetcher ?? fetch;
  const limit = opts.limit ?? 200;

  let url = `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (opts.since != null) {
    url += `&startTime=${opts.since * 1000}`;
  }

  const res = await doFetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status} for ${symbol}`);
  const rows = (await res.json()) as unknown[][];
  return rows.map(toCandle);
}

/** Interval string ("5m", "1h") to milliseconds. */
export function intervalMs(interval: string): number {
  const units: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const unit = interval.at(-1) ?? "";
  const qty = Number.parseInt(interval.slice(0, -1), 10);
  const mult = units[unit];
  if (!mult || !Number.isFinite(qty) || qty <= 0) {
    throw new Error(`unsupported interval: ${interval}`);
  }
  return qty * mult;
}

/** The venue symbols for a set of assets, deduplicated. */
export function venueSymbols(assets: AssetDefinition[]): string[] {
  return [...new Set(assets.map(a => a.dataSourceSymbol))];
}
