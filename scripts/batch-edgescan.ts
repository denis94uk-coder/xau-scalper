/**
 * Run the edge scanner across the liquid crypto universe as a matrix.
 *
 *   bun run edgescan:batch                                   # top 5 × five timeframes
 *   bun run edgescan:batch -- --top 10 --intervals 1h,4h
 *   bun run edgescan:batch -- --out tmp/batch-report.json
 *
 * WHY A MATRIX RATHER THAN ONE SCAN PER PICKED ASSET
 * An edge worth trading has to survive somewhere specific and refuse to
 * appear everywhere else — scanning the whole grid is what turns "BTC on
 * Tuesday" into a finding rather than an anecdote. The price of asking is the
 * correction: every cell here spends one slot of a SHARED testing budget,
 * because twenty-five per-scan corrections would let a fluke clear the bar in
 * roughly one scan of twenty and then be reported as discovered.
 *
 * Costs are the registry's where the asset is configured, otherwise the same
 * pessimistic rank bands top-assets uses. Nothing here writes config: this is
 * a measurement tool, and adoption stays a human decision.
 */

import { getAsset, unconfiguredExchangeAsset } from "../core/assets";
import type { CostModel } from "../core/costs";
import { type EdgeResult, MIN_OCCURRENCES, scanEdges } from "../core/edgescan";
import { HYPOTHESES } from "../core/hypotheses";
import { CRYPTO_HYPOTHESES } from "../core/hypotheses-crypto";
import type { Candle } from "../core/strategy";
import { fetchCandleRange } from "../server/market";

const BINANCE_API =
  process.env.TEO_BINANCE_BASE_URL ?? "https://data-api.binance.vision/api/v3";

const ALL_HYPOTHESES = [...HYPOTHESES, ...CRYPTO_HYPOTHESES];

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

function tradable(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  if (symbol.includes("_")) return false;
  const base = symbol.slice(0, -4);
  if (STABLES.has(base)) return false;
  if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
  return true;
}

/** Cost bands by volume rank — the same pessimism as scripts/top-assets.ts. */
function costsForRank(rank: number): CostModel {
  if (rank < 20) {
    return {
      halfSpreadBps: 1,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 3,
    };
  }
  if (rank < 60) {
    return {
      halfSpreadBps: 2.5,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 8,
    };
  }
  return {
    halfSpreadBps: 5,
    takerFeeBps: 4,
    makerFeeBps: 2,
    stopSlippageBps: 15,
  };
}

interface Ticker24 {
  symbol: string;
  quoteVolume: string;
}

interface CellKey {
  symbol: string;
  interval: string;
}

interface CellResult extends CellKey {
  bars: number;
  roundTripBps: number;
  results: EdgeResult[];
}

interface SurvivorRow extends CellKey {
  name: string;
  claim: string;
  n: number;
  meanNet: number;
  worstDecile: number;
  hitRate: number;
  pValue: number;
  windowsPositive: number;
  windowsJudged: number;
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  const top = Number(flag("top") ?? 5);
  const intervals = (flag("intervals") ?? "5m,15m,30m,1h,4h")
    .split(",")
    .map(s => s.trim());
  const maxBars = Number(flag("max-bars") ?? 30_000);
  const horizon = Number(flag("horizon") ?? 12);
  const windows = Number(flag("windows") ?? 6);
  const pageDelayMs = Number(flag("page-delay-ms") ?? 450);
  const out = flag("out");

  console.log("Ranking the venue by 24h quote volume…");
  const tickers = await json<Ticker24[]>(`${BINANCE_API}/ticker/24hr`);
  const ranked = tickers
    .filter(t => tradable(t.symbol))
    .map(t => ({ symbol: t.symbol, quoteVolume: Number(t.quoteVolume) }))
    .filter(t => t.quoteVolume > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, top);

  if (ranked.length === 0) throw new Error("no tradable USDT pairs returned");
  console.log(
    `Scanning ${ranked.map(r => r.symbol).join(", ")} · ` +
      `${intervals.join("/")} · hold ${horizon} bars · ≤${maxBars} bars each\n`,
  );

  const intervalMsOf = (iv: string): number => {
    const qty = Number.parseInt(iv.slice(0, -1), 10);
    const unit = iv.at(-1);
    const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return qty * mult;
  };

  const cells: CellResult[] = [];
  const skipped: string[] = [];

  for (const [ai, asset] of ranked.entries()) {
    const venue = getAsset(asset.symbol)
      ? asset.symbol
      : unconfiguredExchangeAsset(asset.symbol).dataSourceSymbol;
    const costs = getAsset(venue)?.costs ?? costsForRank(ai);
    const roundTripBps =
      2 * costs.halfSpreadBps +
      costs.takerFeeBps +
      costs.makerFeeBps +
      costs.stopSlippageBps;

    for (const interval of intervals) {
      const label = `${venue.padEnd(10)} ${interval.padEnd(4)}`;
      const to = Math.floor(Date.now() / 1000);
      // Cap the span, not the array: fewer pages for coarse bars, and the
      // venue simply returns less than asked when its history is younger
      // than the window.
      const from = to - (maxBars * intervalMsOf(interval)) / 1000;

      let candles: Candle[];
      try {
        candles = await fetchCandleRange(venue, interval, from, to, {
          pageDelayMs,
        });
      } catch (e) {
        console.log(
          `${label} fetch failed: ${e instanceof Error ? e.message : e}`,
        );
        skipped.push(`${venue} ${interval}: fetch failed`);
        continue;
      }

      if (candles.length < 800) {
        console.log(
          `${label} ${candles.length} bars — too little history, skipped`,
        );
        skipped.push(`${venue} ${interval}: ${candles.length} bars`);
        continue;
      }

      const report = scanEdges(candles, ALL_HYPOTHESES, costs, {
        horizonBars: horizon,
        windows,
      });
      cells.push({
        symbol: venue,
        interval,
        bars: candles.length,
        roundTripBps,
        results: report.results,
      });
      const best = report.results.find(r => r.measured && r.meanNet > 0);
      console.log(
        `${label} ${String(candles.length).padStart(6)} bars · ` +
          `${report.results.filter(r => r.measured).length}/${ALL_HYPOTHESES.length} measured` +
          (best ? ` · best ${best.name} t=${best.tStat.toFixed(2)}` : ""),
      );
    }
  }

  // ─── The shared budget ───
  // Every p-value the matrix produced spent one slot of ONE family error rate.
  const totalTests = cells.length * ALL_HYPOTHESES.length;
  const familyAlpha = 0.05;
  const globalAlpha = 1 - (1 - familyAlpha) ** (1 / Math.max(totalTests, 1));

  const survivors: SurvivorRow[] = [];
  for (const cell of cells) {
    for (const r of cell.results) {
      if (!r.measured) continue;
      if (r.pValue >= globalAlpha) continue;
      if (r.windowsJudged >= 3 && r.windowsPositive * 2 <= r.windowsJudged) {
        continue;
      }
      if (r.meanNet <= 0) continue;
      survivors.push({
        symbol: cell.symbol,
        interval: cell.interval,
        name: r.name,
        claim: r.claim,
        n: r.n,
        meanNet: r.meanNet,
        worstDecile: r.worstDecile,
        hitRate: r.hitRate,
        pValue: r.pValue,
        windowsPositive: r.windowsPositive,
        windowsJudged: r.windowsJudged,
      });
    }
  }
  survivors.sort((a, b) => a.pValue - b.pValue);

  console.log("");
  console.log(
    `═══ Matrix verdict ═══\n` +
      `${cells.length} scans × ${ALL_HYPOTHESES.length} hypotheses = ${totalTests} tests\n` +
      `one shared bar at α=${familyAlpha}: each p must beat ${globalAlpha.toExponential(3)}\n`,
  );

  const measuredRows = cells
    .flatMap(c => c.results.map(r => ({ cell: c, r })))
    .filter(x => x.r.measured);
  console.log(
    `${measuredRows.length} of ${totalTests} hypothesis×scan pairs fired enough ` +
      `times (≥${MIN_OCCURRENCES}) to be judged at all.`,
  );
  if (skipped.length > 0) {
    console.log(`Skipped cells (${skipped.length}):`);
    for (const s of skipped) console.log(`  · ${s}`);
  }

  if (survivors.length === 0) {
    console.log(
      "\nNothing survived the shared budget. Across the whole matrix these\n" +
        "claims carry no directional information beyond what " +
        `${totalTests} tries explain.\nThat is the expected outcome and a usable result:\n` +
        "the catalogue does not owe an edge, and the null protects the\n" +
        "operator from paying costs to test someone's folklore with money.",
    );
  } else {
    console.log(
      `\nSurvivors (${survivors.length}) — entries with information after costs,\n` +
        "consistent across windows. NOT yet strategies (no stop, fixed-bar exit):\n",
    );
    console.log(
      "asset       tf    hypothesis              n      mean net   hit%       p        windows",
    );
    console.log("─".repeat(96));
    for (const s of survivors) {
      console.log(
        `${s.symbol.padEnd(11)} ${s.interval.padEnd(5)} ` +
          `${s.name.padEnd(22)} ${String(s.n).padStart(5)}  ` +
          `${s.meanNet.toFixed(3).padStart(10)}  ` +
          `${s.hitRate.toFixed(1).padStart(5)}  ` +
          `${s.pValue.toExponential(2).padStart(9)}  ` +
          `${`${s.windowsPositive}/${s.windowsJudged}`.padStart(7)}`,
      );
    }
  }

  if (out) {
    const payload = {
      generatedAt: new Date().toISOString(),
      params: { top, intervals, maxBars, horizon, windows },
      totalTests,
      familyAlpha,
      globalAlpha,
      cells: cells.map(c => ({
        ...c,
        results: c.results.map(r => ({
          name: r.name,
          n: r.n,
          meanNet: r.meanNet,
          stdev: r.stdev,
          tStat: r.tStat,
          pValue: r.pValue,
          hitRate: r.hitRate,
          worstDecile: r.worstDecile,
          windowsPositive: r.windowsPositive,
          windowsJudged: r.windowsJudged,
          measured: r.measured,
        })),
      })),
      survivors,
    };
    await Bun.write(out, JSON.stringify(payload, null, 2));
    console.log(`\nFull report written to ${out}`);
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
