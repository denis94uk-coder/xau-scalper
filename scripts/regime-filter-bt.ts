/**
 * Compare quiet-trend backtest with and without the H1 regime filter.
 *
 * Answers the question: does vetoing counter-trend entries on 5m using the
 * H1 structural direction actually improve results, or does it just reduce
 * trade count with no edge improvement?
 *
 * Uses H1 data (the level the strategy trades) with the regime determined
 * from the same H1 candles (in practice the engine would have a separate
 * H1 stream; here we use trailing windows to simulate it).
 */

import type { Candle, Direction } from "../core/strategy";
import { type CostModel, entryCost, exitCost } from "../core/costs";
import { htfRegime, DEFAULT_QUIET_TREND_CONFIG } from "../core/quiet-trend";
import { calcATR, calcEMA } from "../core/strategy";
import { mt5Asset } from "../core/assets";
import { db as openDb } from "../server/db";

interface Trade {
  net: number;
  dir: Direction;
  barsHeld: number;
  exitKind: "TP" | "SL" | "TIME";
  regimeAligned: boolean;
}

function meanAbsMove(candles: Candle[], i: number, n: number): number {
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    sum += Math.abs(candles[k].close - candles[k - 1].close);
  }
  return sum / n;
}

function isQuiet(candles: Candle[], i: number): boolean {
  const cfg = DEFAULT_QUIET_TREND_CONFIG;
  if (i < cfg.volPeriod + 1) return false;
  const vol = meanAbsMove(candles, i, cfg.volPeriod);
  const samples: number[] = [];
  const start = Math.max(cfg.volPeriod + 1, i - cfg.volWindow + 1);
  for (let k = start; k <= i; k += 5)
    samples.push(meanAbsMove(candles, k, cfg.volPeriod));
  samples.sort((a, b) => a - b);
  const cut = samples[Math.floor((samples.length * cfg.volPercentile) / 100)];
  return vol <= cut;
}

function backtest(
  candles: Candle[],
  costs: CostModel,
  useRegimeFilter: boolean,
): Trade[] {
  const cfg = DEFAULT_QUIET_TREND_CONFIG;
  const trades: Trade[] = [];
  const closes = candles.map(c => c.close);
  const ema50 = calcEMA(closes, cfg.emaPeriod);
  let i = 120;

  while (i < candles.length - 1) {
    if (!isQuiet(candles, i)) { i++; continue; }

    // Entry signal: price vs EMA with buffer
    const price = closes[i];
    const ema = ema50[i];
    const buf = price * cfg.emaBuffer;
    let dir: Direction;
    if (price > ema + buf) dir = "LONG";
    else if (price < ema - buf) dir = "SHORT";
    else { i++; continue; }

    // H1 regime: look back 60 bars to simulate reading the current H1 window
    let regimeAligned = true;
    if (useRegimeFilter) {
      const windowStart = Math.max(0, i - 60);
      const h1Window = candles.slice(windowStart, i + 1);
      const regime = htfRegime(h1Window);
      if (regime !== null && regime !== dir) {
        i++;
        continue; // vetoed
      }
      regimeAligned = regime === null || regime === dir;
    }

    const entry = price;
    const atrSeries = calcATR(candles, cfg.atrPeriod);
    const currentAtr = atrSeries[i] ?? 0;
    if (currentAtr <= 0) { i++; continue; }

    const slDist = cfg.atrSlMultiple * currentAtr;
    const tpDist = cfg.tpR * slDist;
    const sl = dir === "LONG" ? entry - slDist : entry + slDist;
    const tp = dir === "LONG" ? entry + tpDist : entry - tpDist;

    let exitPrice = 0;
    let exitKind: Trade["exitKind"] = "TIME";
    let barsHeld = 0;

    for (let j = i + 1; j < Math.min(i + cfg.maxHoldBars + 1, candles.length); j++) {
      barsHeld = j - i;
      const bar = candles[j];
      if (dir === "LONG") {
        if (bar.low <= sl) { exitPrice = sl; exitKind = "SL"; break; }
        if (bar.high >= tp) { exitPrice = tp; exitKind = "TP"; break; }
      } else {
        if (bar.high >= sl) { exitPrice = sl; exitKind = "SL"; break; }
        if (bar.low <= tp) { exitPrice = tp; exitKind = "TP"; break; }
      }
    }
    if (exitKind === "TIME") {
      const last = Math.min(i + cfg.maxHoldBars, candles.length - 1);
      exitPrice = candles[last].close;
      barsHeld = last - i;
    }

    const gross = dir === "LONG" ? exitPrice - entry : entry - exitPrice;
    const net = gross - entryCost(entry, costs) - exitCost(exitPrice, exitKind === "TP" ? "TP" : "TRAIL_SL", costs);
    trades.push({ net, dir, barsHeld, exitKind, regimeAligned });
    i += Math.max(barsHeld, 1);
  }
  return trades;
}

function summarize(trades: Trade[], label: string) {
  if (trades.length === 0) { console.log(`${label}: no trades`); return; }
  const wins = trades.filter(t => t.net > 0);
  const winRate = (wins.length / trades.length) * 100;
  const totalNet = trades.reduce((s, t) => s + t.net, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.net, 0) / wins.length : 0;
  const losses = trades.filter(t => t.net <= 0);
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.net, 0) / losses.length) : 0;
  const exp = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;

  let maxDD = 0, peak = 0, eq = 0;
  for (const t of trades) {
    eq += t.net;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
  }

  const wSize = Math.floor(trades.length / 6);
  let wPos = 0;
  for (let w = 0; w < 6; w++) {
    const s = w * wSize, e = w === 5 ? trades.length : s + wSize;
    if (trades.slice(s, e).reduce((a, t) => a + t.net, 0) > 0) wPos++;
  }

  const byDir = { LONG: trades.filter(t => t.dir === "LONG").length, SHORT: trades.filter(t => t.dir === "SHORT").length };

  console.log(`\n${label}`);
  console.log(`  Trades: ${trades.length} (L=${byDir.LONG} S=${byDir.SHORT})  Win: ${winRate.toFixed(1)}%  Windows: ${wPos}/6`);
  console.log(`  Exp/trade: ${exp >= 0 ? "+" : ""}${exp.toFixed(2)} pts  Total: ${totalNet >= 0 ? "+" : ""}${totalNet.toFixed(0)} pts  MaxDD: ${maxDD.toFixed(0)} pts`);
  console.log(`  Avg win: ${avgWin.toFixed(2)}  Avg loss: ${avgLoss.toFixed(2)}  Payoff: ${(avgWin / (avgLoss || 1)).toFixed(2)}R`);
}

function main() {
  const database = openDb();
  const meta = database.getSetting<{ symbol: string; digits: number; assetId: string; spreadBps: number }>("mt5:XAUUSD");
  if (!meta) { console.error("No MT5 data"); process.exit(1); }
  const asset = mt5Asset(meta);
  const candles = database.getCandles(meta.assetId, "1h", 100_000);
  console.log(`H1 bars: ${candles.length} (${new Date(candles[0].time * 1000).toISOString().slice(0, 10)} → ${new Date(candles.at(-1)!.time * 1000).toISOString().slice(0, 10)})`);

  summarize(backtest(candles, asset.costs, false), "Without H1 regime filter");
  summarize(backtest(candles, asset.costs, true),  "With H1 regime filter (EMA50 + 0.05% buffer)");
}

main();
