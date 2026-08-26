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

import type { AssetDefinition } from "../core/assets";
import type { Candle } from "../core/strategy";

const BINANCE_API =
  process.env.TEO_BINANCE_BASE_URL ?? "https://data-api.binance.vision/api/v3";

/** Injectable so tests never touch the network. */
export type Fetcher = typeof fetch;

export interface MarketOptions {
  fetcher?: Fetcher;
}

function toCandle(k: unknown[]): Candle {
  const candle: Candle = {
    time: Math.floor(Number(k[0]) / 1000),
    open: Number.parseFloat(k[1] as string),
    high: Number.parseFloat(k[2] as string),
    low: Number.parseFloat(k[3] as string),
    close: Number.parseFloat(k[4] as string),
    volume: Number.parseFloat(k[5] as string),
  };
  // Kline field 9 is taker-buy base volume. Present on the exchange feed,
  // absent from MT5 rows; kept optional rather than zeroed so "no data"
  // never masquerades as "no aggressive buying".
  if (k.length > 9 && k[9] !== undefined && k[9] !== null) {
    const takerBuy = Number.parseFloat(k[9] as string);
    if (Number.isFinite(takerBuy)) candle.takerBuyBase = takerBuy;
  }
  return candle;
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

export interface Ticker {
  symbol: string;
  price: number;
  high24h: number;
  low24h: number;
  change24h: number;
  changePct24h: number;
}

/**
 * 24-hour stats for many symbols in a SINGLE request.
 *
 * Feeds the dashboard ticker. Symbols absent from the response are omitted
 * rather than defaulted, so the UI shows a gap instead of a fabricated price.
 */
export async function fetchTickers(
  symbols: string[],
  opts: MarketOptions = {},
): Promise<Ticker[]> {
  const doFetch = opts.fetcher ?? fetch;
  if (symbols.length === 0) return [];

  const query = encodeURIComponent(JSON.stringify(symbols));
  const res = await doFetch(`${BINANCE_API}/ticker/24hr?symbols=${query}`);
  if (!res.ok) throw new Error(`Binance ticker24 ${res.status}`);

  const rows = (await res.json()) as Array<Record<string, string>>;
  const out: Ticker[] = [];
  for (const r of rows) {
    const price = Number.parseFloat(r.lastPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({
      symbol: r.symbol,
      price,
      high24h: Number.parseFloat(r.highPrice),
      low24h: Number.parseFloat(r.lowPrice),
      change24h: Number.parseFloat(r.priceChange),
      changePct24h: Number.parseFloat(r.priceChangePercent),
    });
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

/**
 * Broker symbols the free exchange feed can stand in for.
 *
 * Researching gold should not require a running Windows terminal: PAXG is
 * tokenized physical gold and tracks XAUUSD closely enough for strategy
 * discovery, and the crypto pairs are exact. Normalised so broker spellings
 * like "XAUUSD.x" or "GOLDmicro" still map.
 */
const EXCHANGE_ALIASES: Array<[RegExp, string]> = [
  // No silver spot on Binance, so XAGUSD is deliberately unmapped.
  [/^(XAUUSD|GOLD)/i, "PAXGUSDT"],
  [/^BTCUSD/i, "BTCUSDT"],
  [/^ETHUSD/i, "ETHUSDT"],
];

export function exchangeSymbolFor(brokerSymbol: string): string | null {
  const norm = brokerSymbol.replace(/[.\-_ ].*$/, "").toUpperCase();
  // A venue-native symbol ("SOLUSDT", "PEPEUSDT") is its own alias: the free
  // feed quotes every USDT pair, so the whole research picker must resolve
  // here instead of falling through to a terminal that may not exist.
  if (/^[A-Z0-9]{2,15}USDT$/.test(norm)) return norm;
  for (const [pattern, venue] of EXCHANGE_ALIASES) {
    if (!venue) continue;
    if (pattern.test(norm)) return venue;
  }
  return null;
}

/**
 * Paginated kline history between two epoch-second bounds.
 *
 * The venue returns at most 1000 bars per call, so a two-year window pages
 * forward with startTime until it is covered. Gaps (weekends on crypto aside)
 * are simply absent from the result, matching what the venue has.
 *
 * `pageDelayMs` spaces the pages out: a batch job sweeping many symbols would
 * otherwise spend the feed's rate budget in one burst and get 429s halfway
 * through. Interactive callers leave it unset; long sweeps set it.
 */
export async function fetchCandleRange(
  symbol: string,
  interval: string,
  from: number,
  to: number,
  opts: MarketOptions & { pageDelayMs?: number } = {},
): Promise<Candle[]> {
  const doFetch = opts.fetcher ?? fetch;
  const out: Candle[] = [];
  let cursor = from * 1000;
  const endMs = to * 1000;

  while (cursor < endMs) {
    if (out.length > 0 && opts.pageDelayMs && opts.pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
    const url =
      `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`Binance klines ${res.status} for ${symbol}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) out.push(toCandle(r));
    const lastOpen = Number(rows[rows.length - 1][0]);
    cursor = lastOpen + 1;
    if (rows.length < 1000) break;
  }

  return out;
}

/** The venue symbols for a set of assets, deduplicated. */
export function venueSymbols(assets: AssetDefinition[]): string[] {
  return [...new Set(assets.map(a => a.dataSourceSymbol))];
}
