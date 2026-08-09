/**
 * Edge audit — the cost-adjusted breakeven win rate, per asset.
 *
 * This answers the only question that decides whether a strategy is worth
 * running: given its own geometry (ATR stop, R-multiple targets) and what it
 * actually costs to trade the instrument, how often must it be RIGHT just to
 * stand still?
 *
 * It needs no backtest and no fixture, so it cannot be flattered by a kind
 * sample. It is arithmetic on the strategy's own parameters.
 *
 * The asymmetry does the damage. A target is a resting limit order that fills
 * at your price; a stop crosses the spread into the move that is hurting you
 * and slips. So costs shrink every win and ENLARGE every loss, which pushes the
 * breakeven win rate up twice over.
 *
 * Usage:
 *   bun run edge-audit                 # all enabled assets, default 0.10% ATR
 *   bun run edge-audit -- --atr 0.15   # assume a livelier 5m bar
 */

import { getEnabledAssets } from "../core/assets";
import { breakevenWinRate, entryCost, exitCost } from "../core/costs";
import { DEFAULT_STRATEGY_CONFIG } from "../core/strategy";

/**
 * 5-minute ATR as a percentage of price.
 *
 * An assumption, not a measurement — override it with --atr. Lower ATR means
 * tighter stops and targets in absolute terms, which makes fixed costs a LARGER
 * share of each trade, so a quiet market is the hostile case.
 */
const DEFAULT_ATR_PCT = 0.1;

function parseAtr(argv: string[]): number {
  const i = argv.indexOf("--atr");
  if (i === -1) return DEFAULT_ATR_PCT;
  const v = Number.parseFloat(argv[i + 1] ?? "");
  if (!Number.isFinite(v) || v <= 0) {
    console.error("--atr must be a positive percentage, e.g. --atr 0.15");
    process.exit(1);
  }
  return v;
}

/** Representative price per asset, only to turn bps into points. */
const REFERENCE_PRICE: Record<string, number> = {
  PAXGUSDT: 3450,
  BTCUSDT: 95_000,
  ETHUSDT: 3200,
  BNBUSDT: 620,
  LINKUSDT: 15,
  AAVEUSDT: 260,
  TAOUSDT: 380,
};

const pct = (n: number) => `${n.toFixed(1)}%`;

function main() {
  const atrPct = parseAtr(process.argv.slice(2));
  const cfg = DEFAULT_STRATEGY_CONFIG;

  console.log(`
Edge audit — what win rate does this strategy NEED after costs?

  Stop      ${cfg.atrSlMultiplier}× ATR
  TP1       ${cfg.tp1R}R      TP2  ${cfg.tp2R}R
  ATR       ${atrPct}% of price (assumption — override with --atr)
`);

  console.log(
    "asset       risk    TP1 net   TP2 net   loss net   BE(TP1)  BE(TP2)  gross BE",
  );
  console.log("─".repeat(80));

  for (const asset of getEnabledAssets()) {
    const price = REFERENCE_PRICE[asset.id] ?? 100;
    const atr = price * (atrPct / 100);

    // Strategy geometry, in points.
    const risk = atr * cfg.atrSlMultiplier;
    const tp1Gross = risk * cfg.tp1R;
    const tp2Gross = risk * cfg.tp2R;

    // Costs. Entry is always a market order; the exit depends on which side won.
    const entry = entryCost(price, asset.costs);
    const tpExit = exitCost(price, "TP", asset.costs);
    const slExit = exitCost(price, "SL", asset.costs);

    const tp1Net = tp1Gross - entry - tpExit;
    const tp2Net = tp2Gross - entry - tpExit;
    // A loss is the stop distance PLUS both costs — it gets bigger, not smaller.
    const lossNet = risk + entry + slExit;

    const beTp1 = breakevenWinRate(tp1Net, lossNet);
    const beTp2 = breakevenWinRate(tp2Net, lossNet);
    const beGross = breakevenWinRate(tp1Gross, risk);

    const flag =
      beTp1 === null || beTp1 > 75
        ? "  ← implausible"
        : beTp1 > 60
          ? "  ← hard"
          : "";

    console.log(
      `${asset.id.padEnd(11)}` +
        `${risk.toFixed(2).padStart(7)} ` +
        `${tp1Net.toFixed(2).padStart(9)} ` +
        `${tp2Net.toFixed(2).padStart(9)} ` +
        `${(-lossNet).toFixed(2).padStart(10)} ` +
        `${(beTp1 === null ? "n/a" : pct(beTp1)).padStart(8)} ` +
        `${(beTp2 === null ? "n/a" : pct(beTp2)).padStart(8)} ` +
        `${(beGross === null ? "n/a" : pct(beGross)).padStart(9)}` +
        flag,
    );
  }

  console.log(`
Reading this:

  BE(TP1)   win rate needed if trades exit at TP1. This is the honest number
            for a scalper, because the partial-TP design books most trades there.
  BE(TP2)   win rate needed if trades run to TP2 — the optimistic case.
  gross BE  what the breakeven would be with NO costs. The gap between that
            column and BE(TP1) is what the system was ignoring.

A breakeven above ~60% is a demanding bar for a 5-minute mean-reversion signal;
above ~75% is not realistically achievable and means the setup is unprofitable
at that target no matter how good the entries are.

Two levers actually move these numbers: hold for larger targets (raise tp1R and
tp2R so the fixed cost is a smaller share), or trade instruments whose spread is
small relative to their volatility. Tightening the stop makes it WORSE — it
shrinks the win while the cost stays put.
`);
}

main();
