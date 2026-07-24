/**
 * Client-side XAU/USD price & candle data fetching.
 *
 * Uses Convex HTTP actions as server-side proxy to avoid CORS issues.
 * The Convex deployment URL is configured via VITE_CONVEX_URL env var.
 * HTTP endpoints live at the .convex.site domain (not .convex.cloud).
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

function getConvexSiteUrl(): string {
  // VITE_CONVEX_URL = https://xxx.convex.cloud → HTTP endpoint = https://xxx.convex.site
  const convexUrl = import.meta.env.VITE_CONVEX_URL || "";
  return convexUrl.replace(".convex.cloud", ".convex.site");
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

export async function fetchGoldPrice(): Promise<PriceData> {
  const base = getConvexSiteUrl();

  try {
    const res = await fetch(`${base}/api/gold-price`, {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`API returned ${res.status}`);

    const result = await res.json();
    const { source, data } = result;

    if (source === "metals.live") {
      if (Array.isArray(data) && data.length > 0) {
        const price = Number(data[0].price);
        if (price > 0) return makeSnapshot(price, "metals.live");
      }
    } else if (source === "goldprice.org") {
      if (data?.items?.[0]?.xauPrice) {
        const item = data.items[0];
        return makeSnapshot(item.xauPrice, "goldprice.org", {
          change24h: item.chgXau,
          changePct24h: item.pcXau,
        });
      }
    } else if (source === "binance") {
      const price = parseFloat(data.lastPrice);
      if (price > 0) {
        return makeSnapshot(price, "binance/PAXG", {
          change24h: parseFloat(data.priceChange),
          changePct24h: parseFloat(data.priceChangePercent),
          high24h: parseFloat(data.highPrice),
          low24h: parseFloat(data.lowPrice),
        });
      }
    }
  } catch (e: any) {
    console.warn("Convex gold-price proxy failed:", e.message);
  }

  throw new Error("Unable to fetch gold price");
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
  const base = getConvexSiteUrl();

  try {
    const url = `${base}/api/klines?symbol=PAXGUSDT&interval=${binanceInterval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) throw new Error(`API returned ${res.status}`);

    const data = await res.json();

    return data.map((k: any[]) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (e: any) {
    console.error(`Failed to fetch candles (${interval}):`, e.message);
    throw e;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
