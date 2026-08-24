/**
 * The momentum-48 exit test: does the one surviving scan pattern survive
 * contact with a real trade shape?
 *
 *   bun run momentum48-test                       # BTC + ETH, H1, 400d
 *   bun run momentum48-test -- --interval 4h
 *
 * WHAT WAS LEARNED BEFORE THIS TEST (and why the guards exist anyway)
 * Round 1/4 scans found 48-bar momentum continuation positive-gross on both
 * BTC and ETH H1, positive after a maker exit, majority-positive windows.
 * Lookback 48 was therefore chosen by LOOKING AT THE DATA, which is exactly
 * how tuning masquerades as discovery. The guards below are what separates
 * this from that:
 *
 *   · THREE chronological windows — select nothing, validate once, report
 *     the untouched window as-is;
 *   · TWO assets must agree — a real mechanism is not a property of one
 *     order book;
 *   · the pooled result must clear binomial significance against its own
 *     breakeven win rate at α = 0.025 (two assets = two tests);
 *   · lookback 24, the family's default, runs as CONTROL: if 24 performs
 *     the same, "48" is not the finding, momentum-with-real-exits is;
 *   · exits are the live engine's actual geometry — ATR stop, TP1 limit at
 *     1.2R with breakeven move, ATR trail, TP2 — not a fixed-bar hold.
 */

import { getAsset, unconfiguredExchangeAsset } from "../core/assets";
import {
  type BacktestMetrics,
  computeMetrics,
  runBacktest,
} from "../core/backtest";
import { assessSignificance } from "../core/significance";
import { DEFAULT_STRATEGY_CONFIG } from "../core/strategy";
import { exchangeSymbolFor, fetchCandleRange } from "../server/market";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

function fmt(n: number | null): string {
  return n === null || !Number.isFinite(n) ? "∞" : n.toFixed(2);
}

interface WindowResult {
  label: string;
  metrics: BacktestMetrics;
}

function backtestWindow(
  candles: Candle[],
  from: number,
  to: number,
  lookback: number,
  costs: import("../core/costs").CostModel,
  precision: number,
): WindowResult {
  const config = {
    ...DEFAULT_STRATEGY_CONFIG,
    momentumLookback: lookback,
  };
  const trades = runBacktest(
    candles.slice(from, to),
    config,
    precision,
    60,
    costs,
    "momentum",
  );
  return { label: "", metrics: computeMetrics(trades) };
}

type Candle = Awaited<ReturnType<typeof fetchCandleRange>>[number];

async function main() {
  const assets = (flag("assets") ?? "BTCUSDT,ETHUSDT")
    .split(",")
    .map(s => s.trim().toUpperCase());
  const interval = flag("interval") ?? "1h";
  const days = Number(flag("days") ?? 400);
  const lookback = Number(flag("lookback") ?? 48);

  console.log(
    `Momentum-${lookback} exit test · ${interval} · last ${days}d · ` +
      `live-exit geometry (ATR stop / TP1 limit / trail)\n`,
  );

  const results = new Map<
    string,
    {
      windows: Array<{ name: string; lb: number; m: BacktestMetrics }>;
      pooled: Record<
        number,
        { sig: ReturnType<typeof assessSignificance>; net: number }
      >;
    }
  >();

  for (const symbol of assets) {
    const venue = exchangeSymbolFor(symbol);
    if (!venue) {
      console.error(`${symbol}: not a Binance feed symbol, skipped`);
      continue;
    }
    const configured = getAsset(venue);
    const asset = configured ?? unconfiguredExchangeAsset(venue);

    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86_400;
    const candles = await fetchCandleRange(venue, interval, from, to, {
      pageDelayMs: 450,
    });
    if (candles.length < 800) {
      console.error(`${venue}: only ${candles.length} bars, skipped`);
      continue;
    }

    // Chronological three-way split, same proportions discovery uses.
    const trainEnd = Math.floor(candles.length * 0.5);
    const valEnd = Math.floor(candles.length * 0.75);
    const spans: Array<[string, number, number]> = [
      ["train", 60, trainEnd],
      ["validation", trainEnd, valEnd],
      ["test", valEnd, candles.length],
    ];

    const entry = { windows: [], pooled: {} } as {
      windows: Array<{ name: string; lb: number; m: BacktestMetrics }>;
      pooled: Record<
        number,
        { sig: ReturnType<typeof assessSignificance>; net: number }
      >;
    };

    for (const lb of [lookback, 24]) {
      let allTrades: BacktestMetrics | null = null;
      for (const [name, s, e] of spans) {
        const r = backtestWindow(
          candles,
          s,
          e,
          lb,
          asset.costs,
          asset.pricePrecision,
        );
        r.label = name;
        entry.windows.push({ name: `${name}(lb${lb})`, lb, m: r.metrics });
        if (!allTrades) allTrades = r.metrics;
      }
      // Pool the whole history for one significance verdict per lookback:
      // breakeven comes from the pooled trade shape itself.
      const full = backtestWindow(
        candles,
        60,
        candles.length,
        lb,
        asset.costs,
        asset.pricePrecision,
      );
      const be = full.metrics.breakevenWinRate ?? 50;
      entry.pooled[lb] = {
        sig: assessSignificance(full.metrics.wins, full.metrics.trades, be),
        net: full.metrics.netPoints,
      };
    }

    results.set(venue, entry);

    console.log(`\n─── ${venue} ${interval} · ${candles.length} bars ───`);
    console.log(
      `${"window".padEnd(14)} ${"lb".padStart(3)} ${"trades".padStart(7)} ` +
        `${"WR%".padStart(6)} ${"beWR%".padStart(6)} ${"net".padStart(9)} ` +
        `${"exp/trade".padStart(10)} ${"PF".padStart(6)} ${"maxDD".padStart(8)}`,
    );
    for (const w of entry.windows) {
      console.log(
        `${w.name.padEnd(14)} ${String(w.lb).padStart(3)} ` +
          `${String(w.m.trades).padStart(7)} ` +
          `${fmt(w.m.winRate).padStart(6)} ` +
          `${fmt(w.m.breakevenWinRate).padStart(6)} ` +
          `${fmt(w.m.netPoints).padStart(9)} ` +
          `${fmt(w.m.expectancyPerTrade).padStart(10)} ` +
          `${fmt(w.m.profitFactor).padStart(6)} ` +
          `${fmt(w.m.maxDrawdown).padStart(8)}`,
      );
    }
    for (const [lb, p] of Object.entries(entry.pooled)) {
      console.log(
        `pooled(lb${lb}): ${p.sig.summary}  [net ${fmt(p.net)}, p=${p.sig.pValue.toFixed(4)}]`,
      );
    }
  }

  // ─── Verdict, mechanical and stated before anyone sees the numbers' shape ───
  console.log("\n═══ Verdict ═══");
  const entries = [...results.entries()];
  if (entries.length === 0) {
    console.log("No asset produced enough data to judge.");
    return;
  }

  const alphaPerAsset = 0.05 / entries.length;
  const checks = entries.map(([venue, e]) => {
    const testRow = e.windows.find(w => w.name.startsWith("test"));
    const valRow = e.windows.find(w => w.name.startsWith("validation"));
    const pooled = e.pooled[lookback];
    return {
      venue,
      testPositive: (testRow?.m.netPoints ?? -Infinity) > 0,
      valPositive: (valRow?.m.netPoints ?? -Infinity) > 0,
      significant: pooled?.sig.pValue < alphaPerAsset,
      trades: testRow?.m.trades ?? 0,
    };
  });

  for (const c of checks) {
    console.log(
      `${c.venue}: test-window net>0? ${c.testPositive ? "yes" : "NO"} · ` +
        `validation net>0? ${c.valPositive ? "yes" : "NO"} · ` +
        `pooled p<${alphaPerAsset.toFixed(3)}? ${c.significant ? "yes" : "NO"} ` +
        `(test trades ${c.trades})`,
    );
  }

  const survivedAll =
    checks.length === entries.length &&
    checks.every(c => c.testPositive && c.valPositive && c.significant);

  if (survivedAll) {
    console.log(
      "\nmomentum-" +
        lookback +
        " SURVIVED every stated guard on every asset.\n" +
        "Next: registration as a scoring-model default for these assets goes\n" +
        "through the quiet-trend path — and through forward trading on demo\n" +
        "before any size.",
    );
  } else {
    console.log(
      `\nmomentum-${lookback} did NOT clear all guards. That is the expected\n` +
        "outcome and closes the line honestly: a scan pattern that cannot\n" +
        "survive its own exit test was never an edge, and saying so is how\n" +
        "this catalogue stays trustworthy.",
    );
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
