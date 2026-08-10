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
import { assessSignificance, requiredSampleSize } from "../core/significance";
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
    /** 0 disables. Otherwise the number of consecutive windows to split into. */
    walkForward: a["walk-forward"] ? Number(a["walk-forward"]) : 0,
    model: a.model,
  };
}

function fmt(n: number, d = 2): string {
  if (!Number.isFinite(n)) return "inf";
  return n.toFixed(d);
}

/**
 * The same model over consecutive slices of the history.
 *
 * A single backtest over one window cannot tell a persistent edge from one
 * profitable stretch surrounded by noise — and after testing several models on
 * several timeframes, the best-looking combination is the one most likely to be
 * that stretch. An edge that is real shows up in most windows. One that was
 * selected shows up in one and vanishes either side of it.
 *
 * Windows are consecutive and non-overlapping, each replayed with the full
 * preceding history so its indicators match what the live engine would have
 * computed at that moment. A warm-up gap would make every window after the
 * first artificially poor.
 */
function walkForward(
  candles: Parameters<typeof runBacktest>[0],
  asset: ReturnType<typeof mt5Asset>,
  model: BacktestModel,
  windows: number,
): void {
  const usable = candles.length - 60;
  const per = Math.floor(usable / windows);

  if (per < 200) {
    console.log(
      `\n${windows} windows over ${usable} bars leaves ${per} bars each — too few to judge.\n` +
        "Use fewer windows, or sync more history.\n",
    );
    return;
  }

  console.log(`\n─── Walk-forward: ${model}, ${windows} windows ───\n`);
  console.log(
    "window        bars   trades   win%   breakeven%   edge     net pts   PF",
  );
  console.log("─".repeat(76));

  let positive = 0;
  let judged = 0;
  let totalWins = 0;
  let totalTrades = 0;
  let weightedBe = 0;

  for (let w = 0; w < windows; w++) {
    const start = 60 + w * per;
    const end = w === windows - 1 ? candles.length : 60 + (w + 1) * per;
    // Full history up to `end`, but only entries from `start` onward, so the
    // indicators are warm and the window still measures only its own bars.
    const slice = candles.slice(0, end);
    const trades = runBacktest(
      slice,
      asset.config,
      asset.pricePrecision,
      start,
      asset.costs,
      model,
    );
    const m = computeMetrics(trades);

    if (m.trades === 0) {
      console.log(
        `  ${String(w + 1).padStart(2)}      ${String(end - start).padStart(6)}        0   — no trades`,
      );
      continue;
    }

    const be = m.breakevenWinRate ?? 50;
    const edge = m.winRate - be;
    judged++;
    if (edge > 0) positive++;
    totalWins += m.wins;
    totalTrades += m.trades;
    weightedBe += be * m.trades;

    console.log(
      `  ${String(w + 1).padStart(2)}      ` +
        `${String(end - start).padStart(6)}   ` +
        `${String(m.trades).padStart(6)}  ` +
        `${fmt(m.winRate, 1).padStart(5)}  ` +
        `${fmt(be, 1).padStart(10)}  ` +
        `${(edge >= 0 ? "+" : "") + fmt(edge, 1).padStart(5)}  ` +
        `${fmt(m.netPoints).padStart(10)}  ` +
        `${(m.profitFactor === null ? "inf" : fmt(m.profitFactor)).padStart(5)}`,
    );
  }

  if (judged === 0) {
    console.log("\nNo window produced a trade.\n");
    return;
  }

  const meanBe = weightedBe / totalTrades;
  const aggWin = (totalWins / totalTrades) * 100;
  const aggEdge = aggWin - meanBe;
  // Exact binomial, the same test the dashboard reports everywhere else — not a
  // normal approximation, which is unreliable at the low win rates this exit
  // geometry produces.
  const sig = assessSignificance(totalWins, totalTrades, meanBe);
  const needed = requiredSampleSize(aggWin, meanBe);

  console.log("");
  console.log(
    `Windows with a positive edge: ${positive} of ${judged}` +
      (judged > 0 ? `  (${((positive / judged) * 100).toFixed(0)}%)` : ""),
  );
  console.log(
    `Pooled: ${totalWins}W / ${totalTrades} trades = ${aggWin.toFixed(1)}%  ` +
      `vs breakeven ${meanBe.toFixed(1)}%  edge ${aggEdge >= 0 ? "+" : ""}${aggEdge.toFixed(2)} pts`,
  );
  console.log(`        p = ${sig.pValue.toFixed(4)}   ${sig.verdict}`);
  if (needed !== null) {
    console.log(
      `        confirming an edge this size needs ~${needed} trades ` +
        `(you have ${totalTrades})`,
    );
  }
  console.log("");
  console.log(
    "An edge that is real appears in most windows. One that came from a single\n" +
      "profitable stretch appears in one and disappears either side of it — and\n" +
      "the pooled p-value will not save it, because pooling is the same single\n" +
      "look that produced the stretch.",
  );
  console.log("");
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

  // Walk-forward answers a different question from the summary table, so it
  // replaces it rather than being appended: "does this hold up across time",
  // not "which model looks best overall".
  if (cli.walkForward > 0) {
    const model: BacktestModel =
      cli.model === "trend" || cli.model === "reversion"
        ? cli.model
        : cli.model === "combined"
          ? "combined"
          : "trend";
    walkForward(candles, asset, model, cli.walkForward);
    return;
  }

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
