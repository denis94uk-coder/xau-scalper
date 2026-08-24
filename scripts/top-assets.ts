/**
 * Expand asset coverage to the live top-N Binance USDT pairs.
 *
 *   bun run --bun scripts/top-assets.ts                 # top 100, merged into config
 *   bun run --bun scripts/top-assets.ts -- --top 50
 *   bun run --bun scripts/top-assets.ts -- --dry-run    # print, do not save
 *
 * WHY A SCRIPT RATHER THAN A BIGGER HAND-WRITTEN REGISTRY
 * Volume ranking drifts weekly; a table in core/assets.ts would be stale the
 * month after it is written. The ranking is also a data question — "which
 * books are deep enough to scalp" is answered by the venue's own 24h quote
 * volume far better than by anyone's memory.
 *
 * Everything merges into the stored AppConfig as enabled binance assets, so
 * the engine, monitor and research pick them up on the next cycle. Existing
 * assets are never touched: what you have tuned stays tuned.
 *
 * Costs are tiered estimates from volume rank (the same bands core/assets.ts
 * uses), deliberately pessimistic — being wrong in the expensive direction is
 * the cheap mistake.
 */

import { DEFAULT_STRATEGY_CONFIG } from "../core/strategy";
import { ConfigStore } from "../server/config";
import { Db } from "../server/db";

const BINANCE_API =
  process.env.TEO_BINANCE_BASE_URL ?? "https://data-api.binance.vision/api/v3";

/** Quote assets that are money, not instruments. */
const STABLES = new Set([
  "USDC",
  "FDUSD",
  "TUSD",
  "BUSD",
  "DAI",
  "USDP",
  "USD1",
  "USDE",
  "USDS",
  "PYUSD",
  "EUR",
  "AEUR",
  "GBP",
  "TRY",
  "BRL",
  "ARS",
  "JPY",
  "RUB",
  "ZAR",
  "USDT",
]);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

/** Leveraged and synthetic tokens are not scalping instruments. */
function tradable(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  if (symbol.includes("_")) return false;
  const base = symbol.slice(0, -4);
  if (STABLES.has(base)) return false;
  if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
  return true;
}

/** Decimal places implied by a tick size like "0.00100000". */
function precisionFromTick(tick: string): number {
  const m = tick.match(/\.(\d*?[1-9])?0*$/);
  if (!m || m[1] === undefined) return 0;
  return m[1].length;
}

interface Ticker24 {
  symbol: string;
  quoteVolume: string;
  lastPrice: string;
}

interface ExchangeFilter {
  filterType: string;
  tickSize?: string;
}

interface ExchangeSymbolInfo {
  symbol: string;
  status: string;
  filters: ExchangeFilter[];
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  const top = Number(flag("top") ?? 100);
  const dry = Boolean(flag("dry-run"));

  console.log(`Fetching Binance rankings…`);
  const [tickers, info] = await Promise.all([
    json<Ticker24[]>(`${BINANCE_API}/ticker/24hr`),
    json<{ symbols: ExchangeSymbolInfo[] }>(`${BINANCE_API}/exchangeInfo`),
  ]);

  const ticks = new Map<string, number>();
  for (const s of info.symbols) {
    if (s.status !== "TRADING") continue;
    const f = s.filters.find(f => f.filterType === "PRICE_FILTER");
    if (f?.tickSize) ticks.set(s.symbol, precisionFromTick(f.tickSize));
  }

  const ranked = tickers
    .filter(t => tradable(t.symbol))
    .map(t => ({
      symbol: t.symbol,
      quoteVolume: Number(t.quoteVolume),
      price: Number(t.lastPrice),
      precision: ticks.get(t.symbol) ?? 2,
    }))
    .filter(t => t.quoteVolume > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, top);

  if (ranked.length === 0) throw new Error("no tradable USDT pairs returned");

  // Cost bands by rank, matching the registry's pessimism: the deeper the
  // book, the tighter the assumed spread and stop slippage.
  const costsFor = (rank: number) => {
    if (rank < 20)
      return {
        halfSpreadBps: 1,
        takerFeeBps: 4,
        makerFeeBps: 2,
        stopSlippageBps: 3,
      };
    if (rank < 60)
      return {
        halfSpreadBps: 2.5,
        takerFeeBps: 4,
        makerFeeBps: 2,
        stopSlippageBps: 8,
      };
    return {
      halfSpreadBps: 5,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 15,
    };
  };

  const db = new Db();
  const store = new ConfigStore(db);
  const cfg = store.get();
  const known = new Set(cfg.assets.map(a => a.id));

  const additions = ranked
    .filter(r => !known.has(r.symbol))
    .map(r => ({
      id: r.symbol,
      displaySymbol: `${r.symbol.slice(0, -4)}/USD`,
      dataSourceSymbol: r.symbol,
      dataSource: "binance" as const,
      pricePrecision: r.precision,
      enabled: true,
      config: { ...DEFAULT_STRATEGY_CONFIG },
      costs: costsFor(ranked.indexOf(r)),
      useMt5Costs: true,
    }));

  console.log(
    `Top ${ranked.length} by 24h quote volume — ` +
      `${additions.length} new, ${ranked.length - additions.length} already configured.`,
  );
  for (const r of ranked.slice(0, 10)) {
    console.log(
      `  ${(ranked.indexOf(r) + 1).toString().padStart(3)} ${r.symbol.padEnd(12)} ` +
        `vol ${Math.round(r.quoteVolume / 1e6).toLocaleString()}M`,
    );
  }
  if (additions.length > 10) {
    console.log(`  … and ${additions.length - 10} more`);
  }

  if (dry) {
    console.log("Dry run — nothing saved.");
    db.close();
    return;
  }

  store.save({ ...cfg, assets: [...cfg.assets, ...additions] });
  db.close();
  console.log(
    `Saved. The engine picks up ${additions.length} new assets on its next cycle.`,
  );
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
