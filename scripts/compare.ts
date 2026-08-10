/**
 * The combined model against each family, on the same bars and the same costs.
 *
 * The combined model sums trend-following and mean-reversion evidence into one
 * bull/bear pair. They fire in opposite conditions, so they cancel — through a
 * clean synthetic uptrend the combined model signals SHORT on every bar, while
 * trend-only signals LONG on every bar. That is a defect, not a preference.
 *
 * Splitting them raises a question the combined model could not answer: which
 * half, if either, works on this instrument. This runs all three and reports it.
 *
 * Usage:
 *   bun run compare -- --asset MT5:XAUUSD --interval 5m
 */

import { mt5Asset } from "../core/assets";
import {
  type BacktestModel,
  computeMetrics,
  runBacktest,
} from "../core/backtest";
import { assessSignificance } from "../core/significance";
import { db as openDb } from "../server/db";

function parseArgs(argv: string[]) {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        a[k] = v;
        i++;
      } else a[k] = "true";
    }
  }
  return {
    asset: a.asset ?? "MT5:XAUUSD",
    interval: a.interval ?? "5m",
  };
}

function fmt(n: number, d = 2): string {
  if (!Number.isFinite(n)) return "inf";
  return n.toFixed(d);
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const database = openDb();
  const sym = cli.asset.replace(/^MT5:/, "");
  const meta = database.getSetting<{
    symbol: string;
    digits: number;
    assetId: string;
    spreadBps: number;
  }>(`mt5:${sym}`);

  if (!meta) {
    console.error(`No MT5 data for "${sym}". Run 'bun run mt5:sync' first.`);
    process.exit(1);
  }

  const asset = mt5Asset(meta);
  const candles = database.getCandles(meta.assetId, cli.interval, 100_000);
  if (candles.length < 61) {
    console.error(`Only ${candles.length} bars — need > 60.`);
    process.exit(1);
  }

  console.log(
    `\nModel comparison: ${meta.symbol} ${cli.interval} | ${candles.length} bars`,
  );
  console.log(`Spread ${meta.spreadBps.toFixed(2)} bps (measured)\n`);

  const models: BacktestModel[] = ["combined", "trend", "reversion"];

  console.log(
    "model       trades   win%   breakeven%   PF     net pts   expectancy   verdict",
  );
  console.log("─".repeat(84));

  for (const model of models) {
    const trades = runBacktest(
      candles,
      asset.config,
      asset.pricePrecision,
      60,
      asset.costs,
      model,
    );
    const m = computeMetrics(trades);

    if (m.trades === 0) {
      console.log(`${model.padEnd(11)} ${String(0).padStart(6)}   — no trades`);
      continue;
    }

    // Is the win rate distinguishable from chance, against the rate this
    // config must beat to break even after costs? A 58% win rate over 30
    // trades looks convincing and is well inside what a coin flip produces.
    const be = m.breakevenWinRate ?? 50;
    const sig = assessSignificance(m.wins, m.trades, be);

    console.log(
      `${model.padEnd(11)} ` +
        `${String(m.trades).padStart(6)}  ` +
        `${fmt(m.winRate, 1).padStart(5)}  ` +
        `${fmt(be, 1).padStart(10)}  ` +
        `${(m.profitFactor === null ? "inf" : fmt(m.profitFactor)).padStart(5)}  ` +
        `${fmt(m.netPoints).padStart(9)}  ` +
        `${fmt(m.expectancyPerTrade).padStart(10)}   ` +
        `${sig.verdict}`,
    );
  }

  console.log("");
  console.log(
    "breakeven% is the win rate the model must exceed just to cover spread and\n" +
      "slippage on your account. A win rate above it still means nothing unless\n" +
      "the verdict says the sample can tell it apart from chance.",
  );
  console.log("");
  console.log(
    "None of these is a forward test. A model that wins here has only been shown\n" +
      "to fit bars that already happened.",
  );
  console.log("");
}

main();
