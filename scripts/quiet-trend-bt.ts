/**
 * Backtest the quiet-trend hypothesis with real exits.
 *
 * The edge scanner found that trend continuation (9/21 MA direction) works
 * on H1 gold when volatility is in the calmer half of recent history.
 * That was a fixed-bar hold with no stop. This gives it a stop and a target
 * and checks whether the edge survives the exit geometry.
 *
 * Usage:
 *   bun run scripts/quiet-trend-bt.ts [--interval 1h] [--atr-sl 1.5] [--tp-r 2.0]
 */

import { mt5Asset } from "../core/assets";
import { type CostModel, entryCost, exitCost } from "../core/costs";
import type { Candle, Direction } from "../core/strategy";
import { db as openDb } from "../server/db";

interface Trade {
  entryBar: number;
  dir: Direction;
  entry: number;
  exit: number;
  exitKind: "TP" | "SL" | "TRAIL_SL" | "TIME";
  net: number;
  barsHeld: number;
}

function meanAbsMove(candles: Candle[], i: number, n: number): number {
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    sum += Math.abs(candles[k].close - candles[k - 1].close);
  }
  return sum / n;
}

function atr(candles: Candle[], i: number, period: number): number {
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const tr = Math.max(
      candles[k].high - candles[k].low,
      Math.abs(candles[k].high - candles[k - 1].close),
      Math.abs(candles[k].low - candles[k - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

function signal(candles: Candle[], i: number): Direction | null {
  if (i < 120) return null;

  const vol = meanAbsMove(candles, i, 14);
  const recent: number[] = [];
  for (let k = i - 99; k <= i; k += 5) recent.push(meanAbsMove(candles, k, 14));
  recent.sort((a, b) => a - b);
  const cut = recent[Math.floor((recent.length * 50) / 100)];
  if (vol > cut) return null;

  const fast = candles.slice(i - 8, i + 1).reduce((s, c) => s + c.close, 0) / 9;
  const slow =
    candles.slice(i - 20, i + 1).reduce((s, c) => s + c.close, 0) / 21;
  if (fast === slow) return null;
  return fast > slow ? "LONG" : "SHORT";
}

function backtest(
  candles: Candle[],
  costs: CostModel,
  opts: { atrSl: number; tpR: number; maxBars: number; trailAfterR?: number },
): Trade[] {
  const trades: Trade[] = [];
  let i = 120;

  while (i < candles.length - 1) {
    const dir = signal(candles, i);
    if (dir === null) {
      i++;
      continue;
    }

    const entryPrice = candles[i].close;
    const currentAtr = atr(candles, i, 14);
    const slDist = opts.atrSl * currentAtr;
    const tpDist = opts.tpR * slDist;

    const slPrice = dir === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    const tpPrice = dir === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;

    let exitPrice = 0;
    let exitKind: Trade["exitKind"] = "TIME";
    let barsHeld = 0;
    let trailStop = slPrice;
    let bestPrice = entryPrice;

    for (
      let j = i + 1;
      j < Math.min(i + opts.maxBars + 1, candles.length);
      j++
    ) {
      barsHeld = j - i;
      const bar = candles[j];

      if (dir === "LONG") {
        if (bar.low <= trailStop) {
          exitPrice = trailStop;
          exitKind = trailStop === slPrice ? "SL" : "TRAIL_SL";
          break;
        }
        if (bar.high >= tpPrice) {
          exitPrice = tpPrice;
          exitKind = "TP";
          break;
        }
        if (opts.trailAfterR && bar.high > bestPrice) {
          bestPrice = bar.high;
          const trailDist = opts.atrSl * currentAtr;
          const newTrail = bestPrice - trailDist;
          if (newTrail > trailStop) trailStop = newTrail;
        }
      } else {
        if (bar.high >= trailStop) {
          exitPrice = trailStop;
          exitKind = trailStop === slPrice ? "SL" : "TRAIL_SL";
          break;
        }
        if (bar.low <= tpPrice) {
          exitPrice = tpPrice;
          exitKind = "TP";
          break;
        }
        if (opts.trailAfterR && bar.low < bestPrice) {
          bestPrice = bar.low;
          const trailDist = opts.atrSl * currentAtr;
          const newTrail = bestPrice + trailDist;
          if (newTrail < trailStop) trailStop = newTrail;
        }
      }
    }

    if (exitKind === "TIME") {
      const lastBar = Math.min(i + opts.maxBars, candles.length - 1);
      exitPrice = candles[lastBar].close;
      barsHeld = lastBar - i;
    }

    const gross =
      dir === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice;
    const eCost = entryCost(entryPrice, costs);
    const xKind = exitKind === "TP" ? "TP" : "SL";
    const xCost = exitCost(
      exitPrice,
      xKind === "TP" ? "TP" : "TRAIL_SL",
      costs,
    );
    const net = gross - eCost - xCost;

    trades.push({
      entryBar: i,
      dir,
      entry: entryPrice,
      exit: exitPrice,
      exitKind,
      net,
      barsHeld,
    });

    i += Math.max(barsHeld, 1);
  }

  return trades;
}

function summarize(trades: Trade[], label: string) {
  if (trades.length === 0) {
    console.log(`${label}: no trades`);
    return;
  }

  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const totalNet = trades.reduce((s, t) => s + t.net, 0);
  const avgWin =
    wins.length > 0 ? wins.reduce((s, t) => s + t.net, 0) / wins.length : 0;
  const avgLoss =
    losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + t.net, 0) / losses.length)
      : 0;
  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
  const sorted = [...trades.map(t => t.net)].sort((a, b) => a - b);
  const worstDecile = sorted.slice(
    0,
    Math.max(1, Math.floor(sorted.length / 10)),
  );
  const worstAvg = worstDecile.reduce((a, b) => a + b, 0) / worstDecile.length;

  const byExit = { TP: 0, SL: 0, TRAIL_SL: 0, TIME: 0 };
  for (const t of trades) byExit[t.exitKind]++;

  let maxDD = 0;
  let peak = 0;
  let equity = 0;
  for (const t of trades) {
    equity += t.net;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDD) maxDD = peak - equity;
  }

  // Walk-forward: split into 6 windows
  const windowSize = Math.floor(trades.length / 6);
  let windowsPositive = 0;
  for (let w = 0; w < 6; w++) {
    const start = w * windowSize;
    const end = w === 5 ? trades.length : start + windowSize;
    const windowNet = trades.slice(start, end).reduce((s, t) => s + t.net, 0);
    if (windowNet > 0) windowsPositive++;
  }

  console.log(`\n${label}`);
  console.log(
    `  Trades: ${trades.length}   Win rate: ${winRate.toFixed(1)}%   Windows +ve: ${windowsPositive}/6`,
  );
  console.log(
    `  Total P&L: ${totalNet.toFixed(1)} pts   Expectancy: ${expectancy.toFixed(2)} pts/trade`,
  );
  console.log(
    `  Avg win: ${avgWin.toFixed(2)}   Avg loss: ${avgLoss.toFixed(2)}   Payoff: ${(avgWin / (avgLoss || 1)).toFixed(2)}R`,
  );
  console.log(
    `  Worst decile: ${worstAvg.toFixed(2)}   Max drawdown: ${maxDD.toFixed(1)} pts`,
  );
  console.log(
    `  Exits: TP=${byExit.TP} SL=${byExit.SL} Trail=${byExit.TRAIL_SL} Time=${byExit.TIME}`,
  );
}

function main() {
  const database = openDb();
  const meta = database.getSetting<{
    symbol: string;
    digits: number;
    assetId: string;
    spreadBps: number;
  }>("mt5:XAUUSD");

  if (!meta) {
    console.error("No MT5 data. Run import-csv first.");
    process.exit(1);
  }

  const asset = mt5Asset(meta);
  const candles = database.getCandles(meta.assetId, "1h", 100_000);
  console.log(`Loaded ${candles.length} H1 bars`);
  console.log(
    `${new Date(candles[0].time * 1000).toISOString().slice(0, 10)} to ` +
      `${new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)}`,
  );

  const configs = [
    {
      atrSl: 1.0,
      tpR: 1.5,
      maxBars: 24,
      label: "1.0× ATR SL / 1.5R TP / 24h max",
    },
    {
      atrSl: 1.0,
      tpR: 2.0,
      maxBars: 24,
      label: "1.0× ATR SL / 2.0R TP / 24h max",
    },
    {
      atrSl: 1.5,
      tpR: 1.5,
      maxBars: 24,
      label: "1.5× ATR SL / 1.5R TP / 24h max",
    },
    {
      atrSl: 1.5,
      tpR: 2.0,
      maxBars: 24,
      label: "1.5× ATR SL / 2.0R TP / 24h max",
    },
    {
      atrSl: 1.5,
      tpR: 2.5,
      maxBars: 24,
      label: "1.5× ATR SL / 2.5R TP / 24h max",
    },
    {
      atrSl: 2.0,
      tpR: 1.5,
      maxBars: 24,
      label: "2.0× ATR SL / 1.5R TP / 24h max",
    },
    {
      atrSl: 2.0,
      tpR: 2.0,
      maxBars: 24,
      label: "2.0× ATR SL / 2.0R TP / 24h max",
    },
    {
      atrSl: 1.5,
      tpR: 2.0,
      maxBars: 48,
      label: "1.5× ATR SL / 2.0R TP / 48h max",
    },
    {
      atrSl: 1.5,
      tpR: 2.0,
      maxBars: 24,
      trailAfterR: 1.0,
      label: "1.5× ATR SL / 2.0R TP / trail / 24h",
    },
  ];

  for (const cfg of configs) {
    const trades = backtest(candles, asset.costs, cfg);
    summarize(trades, cfg.label);
  }
}

main();
