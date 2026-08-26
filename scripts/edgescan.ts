/**
 * Scan the hypothesis catalogue against real bars.
 *
 * Every model in this system so far has been an exit strategy wrapped around an
 * entry nobody had shown predicts anything. This asks the prior question: hold
 * a fixed number of bars, pay a round trip, and see whether any of the claims
 * in core/hypotheses.ts and core/hypotheses-crypto.ts moves the mean away from
 * zero by more than the number of claims tested can explain.
 *
 * Two data paths:
 *   MT5:<SYMBOL>  broker bars already synced by 'mt5:sync', measured spread.
 *   <VENUE>       any Binance USDT pair (BTCUSDT, ETHUSDT, …), fetched live
 *                 from the free feed, tier-estimated costs.
 *
 * Usage:
 *   bun run edgescan -- --asset MT5:XAUUSD --interval 5m
 *   bun run edgescan -- --asset BTCUSDT --interval 1h --days 180
 */

import { getAsset, mt5Asset, unconfiguredExchangeAsset } from "../core/assets";
import type { CostModel } from "../core/costs";
import { MIN_OCCURRENCES, scanEdges, survives } from "../core/edgescan";
import { HYPOTHESES } from "../core/hypotheses";
import { CRYPTO_HYPOTHESES } from "../core/hypotheses-crypto";
import { FLOW_HYPOTHESES } from "../core/hypotheses-flow";
import { LEAD_HYPOTHESES } from "../core/hypotheses-leads";
import type { Candle } from "../core/strategy";
import { db as openDb } from "../server/db";
import { exchangeSymbolFor, fetchCandleRange } from "../server/market";

const ALL_HYPOTHESES = [...HYPOTHESES, ...CRYPTO_HYPOTHESES];
// Lead-lag claims need an injected partner series; they join the set only
// when one is actually provided, so the Šidák count matches what was asked.
const LEADER = "BTCUSDT";

/** True when the series carries venue flow data anywhere near its middle. */
function hasFlowData(candles: Candle[]): boolean {
  for (let k = Math.floor(candles.length / 2); k < candles.length; k++) {
    if (candles[k].takerBuyBase !== undefined) return true;
  }
  return false;
}

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
    horizon: a.horizon ? Number(a.horizon) : 12,
    windows: a.windows ? Number(a.windows) : 6,
    days: a.days ? Number(a.days) : 120,
  };
}

interface PreparedScan {
  label: string;
  costNote: string;
  candles: Candle[];
  costs: CostModel;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const database = openDb();

  let prepared: PreparedScan;
  // Filled only on the exchange path when the target is not the leader
  // itself — scanning BTC "led by BTC" would re-measure plain momentum under
  // a second name and spend two budget slots on one question.
  let injected: Record<string, Candle[]> | undefined;

  if (/^MT5:/i.test(cli.asset)) {
    // ─── Broker bars: unchanged legacy path ───
    const sym = cli.asset.replace(/^MT5:/i, "");
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
    if (candles.length < 500) {
      console.error(
        `Only ${candles.length} bars — a scan below ~500 measures noise.`,
      );
      process.exit(1);
    }
    prepared = {
      label: `${meta.symbol} ${cli.interval} | ${candles.length} bars`,
      costNote: `Spread ${meta.spreadBps.toFixed(2)} bps (measured)`,
      candles,
      costs: asset.costs,
    };
  } else {
    // ─── Exchange feed: any venue USDT pair ───
    const venue = exchangeSymbolFor(cli.asset.toUpperCase());
    if (!venue) {
      console.error(
        `"${cli.asset}" does not map to a Binance feed symbol. Use a ` +
          `USDT pair (BTCUSDT) or an MT5 symbol (MT5:XAUUSD).`,
      );
      process.exit(1);
    }
    const asset = getAsset(venue) ?? unconfiguredExchangeAsset(venue);

    const to = Math.floor(Date.now() / 1000);
    const from = to - cli.days * 86_400;
    console.log(`Fetching ${venue} ${cli.interval} for ${cli.days} days…`);
    const candles = await fetchCandleRange(venue, cli.interval, from, to);

    if (candles.length < 500) {
      console.error(
        `Only ${candles.length} bars from the exchange feed — a scan below ~500 measures noise.`,
      );
      process.exit(1);
    }
    const c = asset.costs;
    const roundTrip = (
      2 * c.halfSpreadBps +
      c.takerFeeBps +
      c.makerFeeBps +
      c.stopSlippageBps
    ).toFixed(1);

    if (venue !== LEADER) {
      console.log(`Fetching ${LEADER} ${cli.interval} as the lead series…`);
      injected = {
        btc: await fetchCandleRange(LEADER, cli.interval, from, to),
      };
    }

    prepared = {
      label: `${venue} ${cli.interval} | ${candles.length} bars | last ${cli.days}d`,
      costNote:
        `Tier costs ≈${roundTrip} bps round trip` +
        (getAsset(venue) ? "" : " (pessimistic: asset not configured)"),
      candles,
      costs: asset.costs,
    };
  }

  const flow = hasFlowData(prepared.candles);
  const hypotheses = [
    ...ALL_HYPOTHESES,
    ...(flow ? FLOW_HYPOTHESES : []),
    ...(injected ? LEAD_HYPOTHESES : []),
  ];
  const report = scanEdges(prepared.candles, hypotheses, prepared.costs, {
    horizonBars: cli.horizon,
    windows: cli.windows,
    series: injected,
  });

  console.log(`\nEdge scan: ${prepared.label} | hold ${cli.horizon} bars`);
  console.log(
    `${prepared.costNote} · ` +
      `${report.hypothesesTested} hypotheses` +
      (injected ? " (incl. 3 BTC-lead claims)" : "") +
      (flow ? " (incl. 4 taker-flow claims)" : "") +
      ` · ` +
      `each must beat p < ${report.adjustedAlpha.toFixed(5)} ` +
      `for the set to hold at ${report.familyAlpha}\n`,
  );

  console.log(
    "hypothesis              n      mean net   worst10%   hit%       t       p        windows",
  );
  console.log("─".repeat(92));

  for (const r of report.results) {
    const flag = survives(r, report) ? "  ← survives" : "";
    // A t and a p computed from four occurrences are arithmetic, not a
    // measurement, and printing them in the same columns as the rest is how a
    // reader ends up trading the noisiest row on the screen.
    const stats = r.measured
      ? `${r.tStat.toFixed(2).padStart(6)}  ${r.pValue.toFixed(4).padStart(7)}`
      : `${"—".padStart(6)}  ${"too few".padStart(7)}`;
    console.log(
      `${r.name.padEnd(22)} ` +
        `${String(r.n).padStart(5)}  ` +
        `${r.meanNet.toFixed(3).padStart(10)}  ` +
        `${r.worstDecile.toFixed(2).padStart(8)}  ` +
        `${r.hitRate.toFixed(1).padStart(5)}  ` +
        `${stats}  ` +
        `${`${r.windowsPositive}/${r.windowsJudged}`.padStart(7)}` +
        flag,
    );
  }

  const unmeasured = report.results.filter(r => !r.measured);
  if (unmeasured.length > 0) {
    console.log("");
    console.log(
      `${unmeasured.length} of ${report.results.length} hypotheses fired fewer than ` +
        `${MIN_OCCURRENCES} times and are not judged either way. That is a\n` +
        "statement about how much history you synced, not about the market.",
    );
  }

  // The higher-timeframe folklore gets an explicit verdict rather than two rows
  // to eyeball, because "with the trend beats against it" is a comparison and
  // reading it off a table sorted by |t| is how it never gets checked.
  for (const htf of ["h4", "d1"]) {
    const withT = report.results.find(r => r.name === `mom3-with-${htf}`);
    const against = report.results.find(r => r.name === `mom3-against-${htf}`);
    if (!withT || !against) continue;
    console.log("");
    console.log(
      `─── Scalping with vs against the ${htf.toUpperCase()} trend ───`,
    );
    if (!withT.measured || !against.measured) {
      console.log("  Not enough occurrences on this history to compare.");
      continue;
    }
    console.log(
      `  with:    ${withT.meanNet.toFixed(3).padStart(8)} pts/hold   ` +
        `worst decile ${withT.worstDecile.toFixed(2).padStart(8)}   n=${withT.n}`,
    );
    console.log(
      `  against: ${against.meanNet.toFixed(3).padStart(8)} pts/hold   ` +
        `worst decile ${against.worstDecile.toFixed(2).padStart(8)}   n=${against.n}`,
    );
    const meanGap = withT.meanNet - against.meanNet;
    const tailGap = withT.worstDecile - against.worstDecile;
    console.log(
      `  Trading with the trend is worth ${meanGap >= 0 ? "+" : ""}${meanGap.toFixed(3)} pts per hold ` +
        `and a ${tailGap >= 0 ? "shallower" : "deeper"} bad tail ` +
        `by ${Math.abs(tailGap).toFixed(2)} pts.`,
    );
    console.log(
      "  The 'against' row is also the pullback strategy with its sign flipped:\n" +
        "  buying the dip in an uptrend and scalping against the trend fire on the\n" +
        "  same bars, opposite ways.",
    );
    if (Math.abs(meanGap) < 0.5 && Math.abs(tailGap) < 2) {
      console.log(
        "  Neither gap is large. On this history the higher timeframe does not\n" +
          "  separate a good scalp from a bad one — but a fixed-bar hold has no\n" +
          "  stop, and the usual version of this claim is about the stop being run\n" +
          "  over. That part is only visible in a backtest with a real exit.",
      );
    }
  }

  const found = report.results.filter(r => survives(r, report));
  console.log("");
  if (found.length === 0) {
    console.log(
      "Nothing survived. That is a result, not a failure: it says these claims\n" +
        "carry no directional information about this instrument at this horizon\n" +
        "and these costs. Try a different horizon before a different hypothesis —\n" +
        "an edge at 48 bars is invisible to a 12-bar hold.",
    );
  } else {
    for (const r of found) {
      console.log(`${r.name}: ${r.claim}`);
      console.log(
        `  ${r.meanNet.toFixed(3)} pts per occurrence over ${r.n} of them, ` +
          `positive in ${r.windowsPositive} of ${r.windowsJudged} windows.`,
      );
    }
    console.log("");
    console.log(
      "Surviving here means the ENTRY carries information. It is not yet a\n" +
        "strategy: it has no stop, and a fixed-bar exit is not one you would\n" +
        "trade. The next step is to give it an exit and check the edge is still\n" +
        "there afterwards — not to size up on this number.",
    );
  }
  console.log("");
}

main();
