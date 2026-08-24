/**
 * Cost-sensitivity pass: how much of the catalogue's apparent death is the
 * exit's price tag rather than absent information?
 *
 *   bun run cost-sensitivity -- --asset BTCUSDT --interval 1h --days 400
 *
 * Every hypothesis runs THREE times over identical bars — the tests are the
 * same tests, so no extra budget is spent; each scan corrects for its own set.
 *
 *   zero    gross information. Is there ANY signal?
 *   maker   entry crosses (spread+taker), exit fills as a resting limit
 *           (maker fee only). The best case a limit-take-profit strategy
 *           could achieve. The live engine's TP1 is exactly such an order.
 *   full    the scanner's standing pessimism: both legs cross, stop slippage
 *           paid. What a strategy whose exits always turn out to be stops
 *           would pay.
 *
 * The interesting rows are the ones BETWEEN lenses: gross > 0 but dead at
 * full costs are entries worth giving a real exit to before condemning;
 * dead even at zero were never signals. This is not rehabilitation for its
 * own sake — a candidate must still clear significance and window consistency
 * under whichever lens claims it.
 */

import { getAsset, unconfiguredExchangeAsset } from "../core/assets";
import { type CostModel, ZERO_COST_MODEL } from "../core/costs";
import { type EdgeResult, scanEdges, survives } from "../core/edgescan";
import { HYPOTHESES } from "../core/hypotheses";
import { CRYPTO_HYPOTHESES } from "../core/hypotheses-crypto";
import { exchangeSymbolFor, fetchCandleRange } from "../server/market";

const ALL_HYPOTHESES = [...HYPOTHESES, ...CRYPTO_HYPOTHESES];

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
    asset: a.asset ?? "BTCUSDT",
    interval: a.interval ?? "1h",
    horizon: a.horizon ? Number(a.horizon) : 12,
    windows: a.windows ? Number(a.windows) : 6,
    days: a.days ? Number(a.days) : 400,
    pageDelayMs: Number(a["page-delay-ms"] ?? 450),
  };
}

function roundTripBps(model: CostModel): number {
  return 2 * model.halfSpreadBps + model.takerFeeBps + model.stopSlippageBps;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  const venue = exchangeSymbolFor(cli.asset.toUpperCase());
  if (!venue) {
    console.error(`"${cli.asset}" does not map to a Binance feed symbol.`);
    process.exit(1);
  }
  const configured = getAsset(venue);
  const asset = configured ?? unconfiguredExchangeAsset(venue);

  const to = Math.floor(Date.now() / 1000);
  const from = to - cli.days * 86_400;
  console.log(`Fetching ${venue} ${cli.interval} (${cli.days}d)…`);
  const candles = await fetchCandleRange(venue, cli.interval, from, to, {
    pageDelayMs: cli.pageDelayMs,
  });
  if (candles.length < 500) {
    console.error(`Only ${candles.length} bars — not enough to measure.`);
    process.exit(1);
  }

  const tier = asset.costs;
  const lenses: Array<{
    label: string;
    model: CostModel;
    exitKind: "TP" | "TRAIL_SL";
    bps: string;
  }> = [
    { label: "zero", model: ZERO_COST_MODEL, exitKind: "TRAIL_SL", bps: "0" },
    {
      label: "maker-exit",
      model: tier,
      exitKind: "TP",
      // Entry hs+taker, exit maker fee only.
      bps: `${(tier.halfSpreadBps + tier.takerFeeBps + tier.makerFeeBps).toFixed(1)}`,
    },
    {
      label: "full",
      model: tier,
      exitKind: "TRAIL_SL",
      bps: `${roundTripBps(tier).toFixed(1)}`,
    },
  ];

  const reports = lenses.map(l =>
    scanEdges(candles, ALL_HYPOTHESES, l.model, {
      horizonBars: cli.horizon,
      windows: cli.windows,
      exitKind: l.exitKind,
    }),
  );

  console.log(
    `\nCost sensitivity: ${venue} ${cli.interval} | ${candles.length} bars | hold ${cli.horizon}`,
  );
  console.log(
    lenses
      .map(
        (l, i) =>
          `${l.label}: ≈${l.bps} bps RT (${reports[i].results.filter(r => survives(r, reports[i])).length} survive)`,
      )
      .join(" · "),
  );
  console.log(
    `\n${ALL_HYPOTHESES.length} hypotheses per lens · Šidák bar per lens p < ` +
      `${reports[0].adjustedAlpha.toExponential(3)}\n`,
  );

  const byName = new Map<string, EdgeResult[]>();
  for (const rep of reports) {
    for (const r of rep.results)
      byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  }

  console.log(
    "hypothesis              n     gross/hold  maker/hold   full/hold   hit@maker",
  );
  console.log("─".repeat(80));

  const rows = [...byName.entries()].map(([name, rs]) => ({ name, rs }));
  rows.sort(
    (a, b) => (b.rs[2]?.meanNet ?? -Infinity) - (a.rs[2]?.meanNet ?? -Infinity),
  );
  for (const { name, rs } of rows) {
    const [zero, maker, full] = rs;
    const stats = maker?.measured
      ? `${maker.hitRate.toFixed(1).padStart(5)}%`
      : "   — ";
    console.log(
      `${name.padEnd(22)} ${String(maker?.n ?? 0).padStart(5)} ` +
        `${(zero?.meanNet ?? 0).toFixed(2).padStart(11)} ` +
        `${(maker?.meanNet ?? 0).toFixed(2).padStart(11)} ` +
        `${(full?.meanNet ?? 0).toFixed(2).padStart(11)}  ${stats}`,
    );
  }

  const judged = rows.filter(({ rs }) => rs[1]?.measured);
  const aliveAtMaker = judged.filter(({ rs }) => (rs[1]?.meanNet ?? 0) > 0);
  const informativeOnly = judged.filter(
    ({ rs }) => (rs[0]?.meanNet ?? 0) > 0 && (rs[1]?.meanNet ?? 0) <= 0,
  );
  const empty = judged.filter(({ rs }) => (rs[0]?.meanNet ?? 0) <= 0);

  console.log("");
  console.log(
    `${judged.length} of ${rows.length} fired enough to judge. Of those:\n` +
      `  · ${aliveAtMaker.length} stay positive after a maker exit\n` +
      `  · ${informativeOnly.length} carry gross signal but die even at maker costs\n` +
      `  · ${empty.length} carry nothing at all (dead at zero cost)`,
  );

  if (aliveAtMaker.length > 0) {
    console.log("\nPositive after a maker exit — candidates for real exits:");
    for (const { name, rs } of aliveAtMaker) {
      console.log(
        `  ${name.padEnd(22)} maker ${(rs[1]?.meanNet ?? 0).toFixed(3)}/hold over ${rs[1]?.n}` +
          `, windows ${rs[1]?.windowsPositive}/${rs[1]?.windowsJudged}`,
      );
    }
    console.log(
      "\nPositive here is NOT tradeable-yet: these rows still need the full\n" +
        "gauntlet (significance under their lens, then runBacktest with real\n" +
        "stops) before anything is believed.",
    );
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
