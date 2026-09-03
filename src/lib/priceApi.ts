/**
 * Price and candle fetching for the chart and ticker.
 *
 * Goes through the local server rather than the venue directly: the browser
 * cannot call the market data host itself (CORS), and routing through the
 * server means one place holds the feed URL.
 */

export interface PriceData {
  price: number;
  bid: number;
  ask: number;
  high24h: number;
  low24h: number;
  change24h: number;
  changePct24h: number;
  timestamp: number;
  source: string;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ──────────────────────────────────────────────
// Convex HTTP endpoint base
// ──────────────────────────────────────────────

function apiBase(): string {
  // Same origin — the server serves this page and the API.
  return "";
}

// ──────────────────────────────────────────────
// Spot Price
// ──────────────────────────────────────────────

function makeSnapshot(
  price: number,
  source: string,
  opts?: {
    change24h?: number;
    changePct24h?: number;
    high24h?: number;
    low24h?: number;
  },
): PriceData {
  const spread = price * 0.0003;
  const r = (n: number) => smartRound(n, price);
  return {
    price: r(price),
    bid: r(price - spread / 2),
    ask: r(price + spread / 2),
    high24h: r(opts?.high24h ?? price * 1.005),
    low24h: r(opts?.low24h ?? price * 0.995),
    change24h: r(opts?.change24h ?? 0),
    changePct24h: Math.round((opts?.changePct24h ?? 0) * 100) / 100,
    timestamp: Date.now(),
    source,
  };
}

/**
 * Decimal places that suit the price's magnitude.
 *
 * Two decimals was a gold assumption. On a sub-cent meme coin it rounds the
 * entire price to zero; on BTC it is right. One rule for every asset in a
 * top-100 registry has to follow magnitude, not a fixed constant.
 */
export function priceDecimals(reference: number): number {
  const abs = Math.abs(reference);
  if (abs >= 100) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 5;
  return 8;
}

function smartRound(n: number, reference: number): number {
  const dp = priceDecimals(reference);
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

/**
 * Format a price-scale number with decimals that suit its magnitude.
 * Gold's fixed two decimals would render a SHIB price as 0.00.
 */
export function fmtPrice(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return n.toFixed(priceDecimals(n));
}

export async function fetchGoldPrice(asset = "BTCUSDT"): Promise<PriceData> {
  const res = await fetch(`${apiBase()}/api/prices?symbols=${asset}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`price API returned ${res.status}`);

  const { tickers } = (await res.json()) as {
    tickers: Array<{
      symbol: string;
      price: number;
      high24h: number;
      low24h: number;
      change24h: number;
      changePct24h: number;
    }>;
  };

  const t = tickers[0];
  // No fallback price. A made-up number rendered as live spot is worse than a
  // visible failure — it would size positions off fiction.
  if (!t) throw new Error(`no price available for ${asset}`);

  return makeSnapshot(t.price, "local/binance", {
    change24h: t.change24h,
    changePct24h: t.changePct24h,
    high24h: t.high24h,
    low24h: t.low24h,
  });
}

// ──────────────────────────────────────────────
// Candle Data (Binance PAXG/USDT via Convex proxy)
// ──────────────────────────────────────────────

const BINANCE_INTERVALS: Record<string, string> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

export async function fetchGoldCandles(
  interval: string,
  limit = 200,
  symbol = "BTCUSDT",
): Promise<Candle[]> {
  const binanceInterval = BINANCE_INTERVALS[interval] || "5m";
  const base = apiBase();

  try {
    const url = `${base}/api/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) throw new Error(`API returned ${res.status}`);

    // The server returns parsed candles; the venue's array format does not
    // leak past it. Guard against upstream returning an error object instead
    // of an array — without this the dashboard's `candles.map` throws
    // `n.map is not a function` and the whole page crashes until the next
    // successful poll.
    const json = await res.json();
    return Array.isArray(json) ? (json as Candle[]) : [];
  } catch (e: any) {
    console.error(
      `Failed to fetch candles for ${symbol} (${interval}):`,
      e.message,
    );
    throw e;
  }
}
