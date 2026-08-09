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
  return {
    price: round2(price),
    bid: round2(price - spread / 2),
    ask: round2(price + spread / 2),
    high24h: round2(opts?.high24h ?? price * 1.005),
    low24h: round2(opts?.low24h ?? price * 0.995),
    change24h: round2(opts?.change24h ?? 0),
    changePct24h: round2(opts?.changePct24h ?? 0),
    timestamp: Date.now(),
    source,
  };
}

export async function fetchGoldPrice(asset = "PAXGUSDT"): Promise<PriceData> {
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
};

export async function fetchGoldCandles(
  interval: string,
  limit = 200,
): Promise<Candle[]> {
  const binanceInterval = BINANCE_INTERVALS[interval] || "5m";
  const base = apiBase();

  try {
    const url = `${base}/api/klines?symbol=PAXGUSDT&interval=${binanceInterval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) throw new Error(`API returned ${res.status}`);

    // The server returns parsed candles; the venue's array format does not
    // leak past it.
    return (await res.json()) as Candle[];
  } catch (e: any) {
    console.error(`Failed to fetch candles (${interval}):`, e.message);
    throw e;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
