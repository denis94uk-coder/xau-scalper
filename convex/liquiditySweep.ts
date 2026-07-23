"use node";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// ═══════════════════════════════════════════════════
// LIQUIDITY SWEEP / STOP HUNT DETECTION
// Detects institutional liquidity grabs:
// - Wick beyond key level + fast reversal
// - Volume spike at level + rejection
// ═══════════════════════════════════════════════════

const BINANCE_BASE = "https://data-api.binance.vision/api/v3";
const SYMBOL = "PAXGUSDT";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchCandles(tf: string, limit: number): Promise<Candle[]> {
  const r = await fetch(
    `${BINANCE_BASE}/klines?symbol=${SYMBOL}&interval=${tf}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`Binance klines: ${r.status}`);
  const data = await r.json();
  return data.map((k: any) => ({
    time: k[0] / 1000,
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

function findKeyLevels(candles: Candle[]) {
  const supports: number[] = [];
  const resistances: number[] = [];

  for (let i = 2; i < candles.length - 2; i++) {
    if (
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i - 2].low &&
      candles[i].low < candles[i + 1].low &&
      candles[i].low < candles[i + 2].low
    ) {
      supports.push(candles[i].low);
    }
    if (
      candles[i].high > candles[i - 1].high &&
      candles[i].high > candles[i - 2].high &&
      candles[i].high > candles[i + 1].high &&
      candles[i].high > candles[i + 2].high
    ) {
      resistances.push(candles[i].high);
    }
  }

  const currentPrice = candles[candles.length - 1].close;
  const roundBase = Math.floor(currentPrice / 10) * 10;
  for (let p = roundBase - 30; p <= roundBase + 30; p += 10) {
    if (p < currentPrice) supports.push(p);
    else resistances.push(p);
  }

  const dedup = (levels: number[]): number[] => {
    const sorted = [...new Set(levels)].sort((a, b) => a - b);
    const result: number[] = [];
    for (const lvl of sorted) {
      if (result.length === 0 || Math.abs(lvl - result[result.length - 1]) > 2)
        result.push(lvl);
    }
    return result;
  };

  return {
    supports: dedup(supports).slice(-10),
    resistances: dedup(resistances).slice(-10),
  };
}

function detectSweeps(
  candles: Candle[],
  levels: { supports: number[]; resistances: number[] },
) {
  const sweeps: any[] = [];
  const avgVolume = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const atr = candles.slice(-14).reduce((s, c) => s + (c.high - c.low), 0) / 14;

  for (let i = Math.max(0, candles.length - 5); i < candles.length; i++) {
    const candle = candles[i];
    const range = candle.high - candle.low;
    const volRatio = candle.volume / avgVolume;

    for (const support of levels.supports) {
      const wickBelow = candle.low < support;
      const closedAbove = candle.close > support;
      const openAbove = candle.open > support;
      const wickSize = support - candle.low;
      const isWickDominant = range > 0 && wickSize / range > 0.4;

      if (
        wickBelow &&
        closedAbove &&
        openAbove &&
        isWickDominant &&
        wickSize > atr * 0.3
      ) {
        const confidence = Math.min(
          95,
          Math.round(
            40 +
              (volRatio > 2 ? 20 : volRatio > 1.5 ? 10 : 0) +
              (isWickDominant ? 15 : 0) +
              (wickSize > atr * 0.5 ? 15 : 0) +
              (candle.close > candle.open ? 5 : 0),
          ),
        );

        sweeps.push({
          type: "BULL_SWEEP",
          level: Math.round(support * 100) / 100,
          wickLow: Math.round(candle.low * 100) / 100,
          closeBack: Math.round(candle.close * 100) / 100,
          volumeSpike: Math.round(volRatio * 100) / 100,
          confidence,
          timestamp: candle.time * 1000,
          description: `Swept below $${support.toFixed(0)} support, rejected with ${wickSize.toFixed(1)} wick. Volume ${volRatio.toFixed(1)}× avg.`,
          actionable: confidence >= 60,
          suggestedDirection: "LONG",
          suggestedEntry: Math.round(candle.close * 100) / 100,
          suggestedSL: Math.round((candle.low - atr * 0.3) * 100) / 100,
          suggestedTP:
            Math.round((candle.close + (candle.close - candle.low) * 2) * 100) /
            100,
        });
      }
    }

    for (const resistance of levels.resistances) {
      const wickAbove = candle.high > resistance;
      const closedBelow = candle.close < resistance;
      const openBelow = candle.open < resistance;
      const wickSize = candle.high - resistance;
      const isWickDominant = range > 0 && wickSize / range > 0.4;

      if (
        wickAbove &&
        closedBelow &&
        openBelow &&
        isWickDominant &&
        wickSize > atr * 0.3
      ) {
        const confidence = Math.min(
          95,
          Math.round(
            40 +
              (volRatio > 2 ? 20 : volRatio > 1.5 ? 10 : 0) +
              (isWickDominant ? 15 : 0) +
              (wickSize > atr * 0.5 ? 15 : 0) +
              (candle.close < candle.open ? 5 : 0),
          ),
        );

        sweeps.push({
          type: "BEAR_SWEEP",
          level: Math.round(resistance * 100) / 100,
          wickLow: Math.round(candle.high * 100) / 100,
          closeBack: Math.round(candle.close * 100) / 100,
          volumeSpike: Math.round(volRatio * 100) / 100,
          confidence,
          timestamp: candle.time * 1000,
          description: `Swept above $${resistance.toFixed(0)} resistance, rejected with ${wickSize.toFixed(1)} wick. Volume ${volRatio.toFixed(1)}× avg.`,
          actionable: confidence >= 60,
          suggestedDirection: "SHORT",
          suggestedEntry: Math.round(candle.close * 100) / 100,
          suggestedSL: Math.round((candle.high + atr * 0.3) * 100) / 100,
          suggestedTP:
            Math.round(
              (candle.close - (candle.high - candle.close) * 2) * 100,
            ) / 100,
        });
      }
    }
  }

  return sweeps.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

export const scanLiquiditySweeps = internalAction({
  args: {},
  handler: async ctx => {
    try {
      const candles = await fetchCandles("5m", 200);
      if (candles.length < 30) return;

      const levels = findKeyLevels(candles);
      const sweeps = detectSweeps(candles, levels);

      await ctx.runMutation(internal.sweepQueries.saveSweeps, {
        sweeps: JSON.stringify(sweeps),
        supportLevels: JSON.stringify(
          levels.supports.map(l => Math.round(l * 100) / 100),
        ),
        resistanceLevels: JSON.stringify(
          levels.resistances.map(l => Math.round(l * 100) / 100),
        ),
        totalSweepsDetected: sweeps.length,
        actionableSweeps: sweeps.filter((s: any) => s.actionable).length,
      });

      if (sweeps.length > 0) {
        console.log(
          `[Sweep] ${sweeps.length} sweeps (${sweeps.filter((s: any) => s.actionable).length} actionable)`,
        );
      } else {
        console.log(
          `[Sweep] No sweeps | S: ${levels.supports.length} R: ${levels.resistances.length}`,
        );
      }
    } catch (e: any) {
      console.error("[Sweep] Error:", e.message);
    }
  },
});
