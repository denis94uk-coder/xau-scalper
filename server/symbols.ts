/**
 * The universe of instruments a research run can target.
 *
 * Three layers, most specific first:
 *   1. Configured assets — whatever the operator trades, any source.
 *   2. The curated registry and then the exchange's full USDT book, so every
 *      liquid crypto pair is one click away without anyone maintaining a list.
 *   3. A handful of broker spellings (indices, forex) whose history can only
 *      come from a MetaTrader terminal.
 *
 * The exchange list is fetched from the keyless public mirror and cached in
 * memory for a day: it is a few hundred kilobytes, changes only when Binance
 * lists or delists something, and would otherwise be re-downloaded on every
 * page open. If the fetch fails the local layers still answer — an offline
 * mode must degrade to the curated list, not to an error page.
 */

import type { ASSETS } from "../core/assets";
import type { Fetcher } from "./market";

export interface ResearchableAsset {
  /** Symbol sent as `symbol` on the run request. */
  symbol: string;
  /** Preferred asset id (`assetId` on the run request). */
  assetId: string;
  display: string;
  source: "binance" | "mt5";
  /** Already in the live configuration. */
  configured: boolean;
}

/** Broker spellings offered even though no feed covers them locally. */
const BROKER_SYMBOLS = [
  "XAUUSD",
  "NAS100",
  "US30",
  "SPX500",
  "DE40",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
] as const;

/** Leveraged tokens track their underlying with decay — useless for this. */
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

let pairsCache: { at: number; symbols: string[] } | null = null;
const PAIRS_TTL_MS = 24 * 60 * 60 * 1000;

/** Spot USDT quote pairs currently trading, sorted. Cached for a day. */
export async function fetchUsdtPairs(
  fetcher: Fetcher = fetch,
): Promise<string[]> {
  if (pairsCache && Date.now() - pairsCache.at < PAIRS_TTL_MS) {
    return pairsCache.symbols;
  }

  const base =
    process.env.TEO_BINANCE_BASE_URL ??
    "https://data-api.binance.vision/api/v3";
  const res = await fetcher(`${base}/exchangeInfo?permissions=SPOT`);
  if (!res.ok) throw new Error(`Binance exchangeInfo ${res.status}`);
  const info = (await res.json()) as {
    symbols: Array<{
      symbol: string;
      status: string;
      quoteAsset: string;
      isSpotTradingAllowed: boolean;
    }>;
  };

  const symbols = info.symbols
    .filter(
      s =>
        s.status === "TRADING" &&
        s.isSpotTradingAllowed &&
        s.quoteAsset === "USDT" &&
        !LEVERAGED.test(s.symbol),
    )
    .map(s => s.symbol)
    .sort();

  if (symbols.length > 0) pairsCache = { at: Date.now(), symbols };
  return symbols;
}

/**
 * Assemble the full picker universe. `configuredIds` are the live config's
 * asset ids; `pairs` may be empty when the exchange is unreachable.
 */
export function buildSymbolUniverse(
  configuredAssets: Array<{
    id: string;
    displaySymbol: string;
    dataSourceSymbol: string;
    dataSource: string;
  }>,
  registry: Array<(typeof ASSETS)[number]>,
  pairs: string[],
): ResearchableAsset[] {
  const out: ResearchableAsset[] = [];
  const seen = new Set<string>();

  for (const a of configuredAssets) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({
      symbol: a.dataSourceSymbol,
      assetId: a.id,
      display: a.displaySymbol,
      source: a.dataSource === "binance" ? "binance" : "mt5",
      configured: true,
    });
  }

  const byId = new Set(configuredAssets.map(a => a.id));
  for (const a of registry) {
    if (byId.has(a.id) || seen.has(a.dataSourceSymbol) || seen.has(a.id)) {
      continue;
    }
    seen.add(a.id);
    out.push({
      symbol: a.dataSourceSymbol,
      assetId: a.id,
      display: a.displaySymbol,
      source: "binance",
      configured: false,
    });
  }

  for (const p of pairs) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({
      symbol: p,
      assetId: p,
      display: p,
      source: "binance",
      configured: false,
    });
  }

  for (const s of BROKER_SYMBOLS) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({
      symbol: s,
      assetId: `MT5:${s}`,
      display: s,
      source: "mt5",
      configured: false,
    });
  }

  return out;
}
