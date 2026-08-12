/**
 * Why did the strategy fire so rarely?
 *
 * A backtest that returns 7 trades over 5000 bars tells you nothing about the
 * strategy — the sample is too small to separate a bad edge from a coin flip.
 * But it does not say WHERE the bars went, and that is answerable: every bar is
 * either graded too low to trade, blocked because a position was already open,
 * or blocked by the same-direction cooldown.
 *
 * This reports that breakdown so a threshold is changed against evidence rather
 * than changed until trades appear. Lowering gradeCStrength until the count
 * looks healthy is how you manufacture an edge that does not exist.
 *
 * Usage:
 *   bun run diagnose -- --asset MT5:XAUUSD --interval 5m
 *   bun run diagnose -- --source binance --asset PAXGUSDT
 */

import { getAsset, mt5Asset } from "../core/assets";
import {
  analyzeAt,
  type Candle,
  precomputeIndicators,
  type RejectionSink,
  type StrategyConfig,
} from "../core/strategy";
import { db as openDb } from "../server/db";

interface Args {
  asset: string;
  interval: string;
  source: "db" | "binance";
}

function parseArgs(argv: string[]): Args {
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
    source: a.source === "binance" ? "binance" : "db",
  };
}

/**
 * Gaps between consecutive bars, in multiples of the expected bar spacing.
 *
 * A CFD symbol closes at the weekend and rolls over daily, so its series has
 * holes an exchange feed does not. Every indicator here treats consecutive
 * array entries as consecutive in time, so a Friday→Sunday hole is fed to ATR
 * and the EMAs as an ordinary 5-minute step.
 */
function sessionGaps(
  candles: Candle[],
  expectedSecs: number,
): { count: number; largestHours: number; totalMissingBars: number } {
  let count = 0;
  let largest = 0;
  let missing = 0;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta > expectedSecs * 1.5) {
      count++;
      missing += Math.round(delta / expectedSecs) - 1;
      if (delta > largest) largest = delta;
    }
  }
  return {
    count,
    largestHours: largest / 3600,
    totalMissingBars: missing,
  };
}

const INTERVAL_SECS: Record<string, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

function bar(n: number, max: number, width = 40): string {
  if (max === 0) return "";
  return "█".repeat(Math.max(0, Math.round((n / max) * width)));
}

function main() {
  const cli = parseArgs(process.argv.slice(2));

  let candles: Candle[];
  let config: StrategyConfig;
  let pricePrecision: number;
  let label: string;

  if (cli.source === "db") {
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
    candles = database.getCandles(meta.assetId, cli.interval, 100_000);
    config = asset.config;
    pricePrecision = asset.pricePrecision;
    label = `${meta.symbol} (broker data)`;
  } else {
    const asset = getAsset(cli.asset);
    if (!asset) {
      console.error(`Unknown asset "${cli.asset}".`);
      process.exit(1);
    }
    console.error("Binance source not implemented for diagnose yet.");
    process.exit(1);
  }

  if (candles.length < 61) {
    console.error(`Only ${candles.length} bars — need > 60.`);
    process.exit(1);
  }

  console.log(
    `\nDiagnostic: ${label} ${cli.interval} | ${candles.length} bars`,
  );
  const first = new Date(candles[0].time * 1000).toISOString().slice(0, 16);
  const last = new Date(candles.at(-1)!.time * 1000).toISOString().slice(0, 16);
  console.log(`Window: ${first} → ${last} UTC\n`);

  // ─── Session continuity ───
  const expected = INTERVAL_SECS[cli.interval] ?? 300;
  const gaps = sessionGaps(candles, expected);
  console.log("─── Session continuity ───");
  if (gaps.count === 0) {
    console.log("No gaps — continuous series.\n");
  } else {
    console.log(`Gaps:            ${gaps.count}`);
    console.log(`Largest gap:     ${gaps.largestHours.toFixed(1)} hours`);
    console.log(`Bars missing:    ${gaps.totalMissingBars}`);
    console.log(
      "Indicators treat consecutive entries as consecutive in time, so each\n" +
        "gap is fed to ATR and the EMAs as one ordinary bar step.\n",
    );
  }

  // ─── Where every bar ended up ───
  //
  // analyzeAt returns null for several different reasons; the sink reports
  // which, so a bar that never scored is not counted the same as one that
  // scored well and missed the grade bar.
  const ind = precomputeIndicators(candles, config);
  const outcomes: Record<RejectionSink["reason"], number> = {
    out_of_range: 0,
    no_score: 0,
    neutral_bias: 0,
    no_trade_grade: 0,
    graded: 0,
  };
  const grades = { A: 0, B: 0, C: 0 };
  /** Strengths of bars that reached grading — the value thresholds compare to. */
  const gradedStrengths: number[] = [];
  const sink: RejectionSink = {
    reason: "out_of_range",
    strength: 0,
    biasStrength: 0,
    extremeCount: 0,
    grade: null,
  };
  let eligible = 0;

  for (let i = 60; i < candles.length; i++) {
    eligible++;
    const a = analyzeAt(candles, ind, i, config, pricePrecision, sink);
    outcomes[sink.reason]++;
    // Every bar that got as far as a grade, including NO_TRADE ones.
    if (sink.reason === "no_trade_grade" || sink.reason === "graded") {
      gradedStrengths.push(sink.strength);
    }
    if (a) grades[a.grade as "A" | "B" | "C"]++;
  }

  console.log("─── Where every bar ended up ───");
  console.log(`Bars eligible:   ${eligible}  (after 60-bar warm-up)\n`);
  const rows: Array<[string, number]> = [
    ["no directional score", outcomes.no_score],
    ["bias too balanced", outcomes.neutral_bias],
    ["graded NO_TRADE", outcomes.no_trade_grade],
    ["graded A/B/C", outcomes.graded],
  ];
  const maxRow = Math.max(...rows.map(r => r[1]));
  for (const [labelText, n] of rows) {
    const pct = eligible > 0 ? (n / eligible) * 100 : 0;
    console.log(
      `  ${labelText.padEnd(22)} ${String(n).padStart(6)}  ${pct.toFixed(1).padStart(5)}%  ${bar(n, maxRow, 26)}`,
    );
  }

  console.log("\n─── Grades awarded ───");
  for (const [g, n] of Object.entries(grades)) {
    const pct = eligible > 0 ? (n / eligible) * 100 : 0;
    console.log(
      `  ${g.padEnd(9)} ${String(n).padStart(6)}  ${pct.toFixed(2).padStart(5)}% of all bars`,
    );
  }
  const tradable = grades.A + grades.B;
  console.log(
    `\nTradable (A+B):  ${tradable} bars (${((tradable / eligible) * 100).toFixed(2)}% of all bars)`,
  );
  console.log(
    "  Grade C is computed but the backtest does not enter on it\n" +
      "  (core/backtest.ts gates on A or B).\n",
  );

  // ─── Where tradable signals were lost ───
  let occupancyBlocked = 0;
  let cooldownBlocked = 0;
  let entered = 0;
  let open = false;
  let openBarsRemaining = 0;
  const lastEntry: Record<string, number> = {
    LONG: Number.NEGATIVE_INFINITY,
    SHORT: Number.NEGATIVE_INFINITY,
  };

  // Approximate occupancy: a real trade holds for a while. Rather than replay
  // exits, this measures how many A/B bars arrive while ANY prior A/B signal is
  // still notionally open, using the median holding time the backtest produces.
  const HOLD_BARS = 24; // 2 hours on M5 — indicative, not the simulated exit

  for (let i = 60; i < candles.length; i++) {
    if (openBarsRemaining > 0) {
      openBarsRemaining--;
      if (openBarsRemaining === 0) open = false;
    }
    const a = analyzeAt(candles, ind, i, config, pricePrecision);
    if (!a || (a.grade !== "A" && a.grade !== "B")) continue;

    if (open) {
      occupancyBlocked++;
      continue;
    }
    const ms = candles[i].time * 1000;
    if (ms - lastEntry[a.direction] < config.cooldownMs) {
      cooldownBlocked++;
      continue;
    }
    lastEntry[a.direction] = ms;
    entered++;
    open = true;
    openBarsRemaining = HOLD_BARS;
  }

  console.log("─── Where tradable signals went ───");
  console.log(`A/B signals:     ${tradable}`);
  console.log(`  entered:       ${entered}`);
  console.log(
    `  blocked (open position, ~${HOLD_BARS} bars):  ${occupancyBlocked}`,
  );
  console.log(`  blocked (cooldown):                  ${cooldownBlocked}`);
  console.log(
    "\nOccupancy is approximated with a fixed holding time, so `entered` is\n" +
      "indicative — the backtest's real exits decide the true count.\n",
  );

  // ─── How far off are the near-misses? ───
  //
  // This is max(bullScore, bearScore) — the quantity gradeXStrength is compared
  // against. Not biasStrength, which is a normalised imbalance on a different
  // scale and would make the comparison meaningless.
  const sorted = [...gradedStrengths].sort((x, y) => y - x);
  const pct = (p: number) => sorted[Math.floor(sorted.length * p)] ?? 0;
  console.log("─── Signal strength, for bars that reached grading ───");
  console.log(`  sample         ${sorted.length} bars`);
  console.log(`  max            ${sorted[0]?.toFixed(0) ?? "n/a"}`);
  console.log(`  99th pct       ${pct(0.01).toFixed(0)}`);
  console.log(`  95th pct       ${pct(0.05).toFixed(0)}`);
  console.log(`  90th pct       ${pct(0.1).toFixed(0)}`);
  console.log(`  median         ${pct(0.5).toFixed(0)}`);
  console.log("");
  console.log(
    `Thresholds in force: A needs >=${config.gradeAStrength} strength AND ` +
      `>=${config.gradeAExtreme} extreme indicators\n` +
      `                     B needs >=${config.gradeBStrength} AND >=${config.gradeBExtreme}\n` +
      `                     C needs >=${config.gradeCStrength} (not traded)`,
  );
  console.log("");
  console.log(
    "Read it this way. If plenty of bars clear the B strength bar but few are\n" +
      "graded B, the extreme-indicator count is the binding constraint, not\n" +
      "strength. If the 95th percentile sits below it, the model is not finding\n" +
      "this instrument's setups at all — and lowering the bar to force trades\n" +
      "would be selecting noise rather than discovering an edge.",
  );
  console.log("");
}

main();
