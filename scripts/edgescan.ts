/**
 * Scan the hypothesis catalogue against your broker's bars.
 *
 * Every model in this system so far has been an exit strategy wrapped around an
 * entry nobody had shown predicts anything. This asks the prior question: hold
 * a fixed number of bars, pay a round trip, and see whether any of the claims
 * in core/hypotheses.ts moves the mean away from zero by more than the number
 * of claims tested can explain.
 *
 * Usage:
 *   bun run edgescan -- --asset MT5:XAUUSD --interval 5m --horizon 12
 */

import { mt5Asset } from "../core/assets";
import { scanEdges, survives } from "../core/edgescan";
import { HYPOTHESES } from "../core/hypotheses";
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
    horizon: a.horizon ? Number(a.horizon) : 12,
    windows: a.windows ? Number(a.windows) : 6,
  };
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
  if (candles.length < 500) {
    console.error(
      `Only ${candles.length} bars — a scan below ~500 measures noise.`,
    );
    process.exit(1);
  }

  const report = scanEdges(candles, HYPOTHESES, asset.costs, {
    horizonBars: cli.horizon,
    windows: cli.windows,
  });

  console.log(
    `\nEdge scan: ${meta.symbol} ${cli.interval} | ${candles.length} bars | ` +
      `hold ${cli.horizon} bars`,
  );
  console.log(
    `Spread ${meta.spreadBps.toFixed(2)} bps (measured) · ` +
      `${report.hypothesesTested} hypotheses · ` +
      `each must beat p < ${report.adjustedAlpha.toFixed(5)} ` +
      `for the set to hold at ${report.familyAlpha}\n`,
  );

  console.log(
    "hypothesis              n      mean net   hit%       t       p        windows",
  );
  console.log("─".repeat(82));

  for (const r of report.results) {
    const flag = survives(r, report) ? "  ← survives" : "";
    console.log(
      `${r.name.padEnd(22)} ` +
        `${String(r.n).padStart(5)}  ` +
        `${r.meanNet.toFixed(3).padStart(10)}  ` +
        `${r.hitRate.toFixed(1).padStart(5)}  ` +
        `${r.tStat.toFixed(2).padStart(6)}  ` +
        `${r.pValue.toFixed(4).padStart(7)}  ` +
        `${`${r.windowsPositive}/${r.windowsJudged}`.padStart(7)}` +
        flag,
    );
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
