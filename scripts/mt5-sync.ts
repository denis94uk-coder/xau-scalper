/**
 * Pull data from a running MetaTrader 5 terminal.
 *
 *   bun run mt5:sync              # find the terminal, ingest, report
 *   bun run mt5:sync -- --watch   # keep pulling every 30s
 *   bun run mt5:sync -- --dir /path/to/MQL5/Files/teo
 *
 * Requires mt5/TeoExporter.mq5 to be running on a chart. See the README.
 *
 * The headline output is not the bar count — it is the COST comparison. The
 * dashboard's per-asset spreads are estimates, and the edge audit showed this
 * strategy needs a 69-87% win rate to break even at TP1 under those estimates.
 * Your broker's real spread moves that number, in whichever direction, and this
 * is what tells you by how much.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAsset } from "../core/assets";
import { breakevenWinRate, entryCost, exitCost } from "../core/costs";
import { DEFAULT_STRATEGY_CONFIG } from "../core/strategy";
import { Db } from "../server/db";
import {
  costModelFrom,
  findExportDir,
  ingestDir,
  parseExport,
} from "../server/mt5";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

/**
 * What the strategy needs to break even on this symbol, at these costs.
 *
 * Mirrors scripts/edge-audit.ts, but driven by the broker's measured spread
 * rather than the registry's estimate.
 */
function breakeven(
  price: number,
  atrPct: number,
  costs: ReturnType<typeof costModelFrom>,
) {
  const cfg = DEFAULT_STRATEGY_CONFIG;
  const risk = price * (atrPct / 100) * cfg.atrSlMultiplier;
  const entry = entryCost(price, costs);
  const tp1Net = risk * cfg.tp1R - entry - exitCost(price, "TP", costs);
  const tp2Net = risk * cfg.tp2R - entry - exitCost(price, "TP", costs);
  const lossNet = risk + entry + exitCost(price, "SL", costs);
  return {
    tp1: breakevenWinRate(tp1Net, lossNet),
    tp2: breakevenWinRate(tp2Net, lossNet),
  };
}

function report(db: Db, dir: string) {
  const { ingested, errors } = ingestDir(db, dir);

  if (ingested.length === 0 && errors.length === 0) {
    console.log(
      `  No .json exports in ${dir}.\n` +
        "  Is TeoExporter running on a chart, and are Expert Advisors allowed?",
    );
    return;
  }

  for (const r of ingested) {
    const stale = r.ageSeconds > 300;
    console.log(
      `  ${r.symbol.padEnd(10)} ${r.interval.padEnd(4)} ` +
        `${String(r.bars).padStart(5)} bars  spread ${r.spreadBps.toFixed(2)} bps` +
        (r.ageSeconds < 0
          ? ""
          : `  exported ${r.ageSeconds}s ago${stale ? "  ← STALE, is the terminal still running?" : ""}`),
    );
  }

  for (const e of errors) {
    console.log(`  ${e.file}: ${e.error}`);
  }

  // ─── The comparison that actually matters ───
  const specs = readdirSync(dir).filter(f => f.endsWith(".json"));
  const seen = new Set<string>();
  let printedHeader = false;

  for (const file of specs) {
    let exp: ReturnType<typeof parseExport>;
    try {
      exp = parseExport(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (seen.has(exp.symbol)) continue;
    seen.add(exp.symbol);

    let costs: ReturnType<typeof costModelFrom>;
    try {
      costs = costModelFrom(exp);
    } catch {
      continue;
    }

    const price = exp.bid > 0 ? exp.bid : (exp.bars.at(-1)?.[4] ?? 0);
    if (price <= 0) continue;

    if (!printedHeader) {
      console.log(
        "\n  Breakeven win rate on YOUR broker's spread (0.10% ATR assumed):",
      );
      console.log("  symbol      spread     TP1      TP2");
      printedHeader = true;
    }

    const be = breakeven(price, 0.1, costs);
    console.log(
      `  ${exp.symbol.padEnd(10)} ` +
        `${`${(costs.halfSpreadBps * 2).toFixed(2)}bps`.padStart(9)} ` +
        `${(be.tp1 === null ? "n/a" : `${be.tp1.toFixed(1)}%`).padStart(7)} ` +
        `${(be.tp2 === null ? "n/a" : `${be.tp2.toFixed(1)}%`).padStart(7)}`,
    );

    // Compare against the registry estimate for gold, the one asset both cover.
    const estimate = getAsset("PAXGUSDT");
    if (estimate && /XAU|GOLD/i.test(exp.symbol)) {
      const est = breakeven(price, 0.1, estimate.costs);
      console.log(
        `  ${"(estimate)".padEnd(10)} ` +
          `${`${(estimate.costs.halfSpreadBps * 2).toFixed(2)}bps`.padStart(9)} ` +
          `${(est.tp1 === null ? "n/a" : `${est.tp1.toFixed(1)}%`).padStart(7)} ` +
          `${(est.tp2 === null ? "n/a" : `${est.tp2.toFixed(1)}%`).padStart(7)}` +
          "   ← what the app assumed before this sync",
      );
    }
  }

  if (printedHeader) {
    console.log(
      "\n  Fees and stop slippage are still assumptions — a quote cannot show\n" +
        "  them. Only the spread above is measured.\n",
    );
  }
}

function main() {
  const dir = flag("dir") ?? findExportDir();
  if (!dir) {
    console.error(`
Could not find the MT5 export directory.

  1. Copy mt5/TeoExporter.mq5 into MT5 → File → Open Data Folder → MQL5/Experts
  2. Compile it (F7 in MetaEditor) and drag it onto a chart
  3. Tools → Options → Expert Advisors → allow automated trading

Then re-run, or point at it directly:

  bun run mt5:sync -- --dir "/path/to/MQL5/Files/teo"
`);
    process.exit(1);
  }

  console.log(`\nReading ${dir}\n`);
  const db = new Db();

  report(db, dir);

  if (flag("watch")) {
    const every = Number(flag("interval") ?? 30) * 1000;
    console.log(`  Watching, every ${every / 1000}s. Ctrl-C to stop.\n`);
    setInterval(() => {
      console.log(`— ${new Date().toLocaleTimeString()} —`);
      report(db, dir);
    }, every);
  } else {
    db.close();
  }
}

main();
