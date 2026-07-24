/**
 * Experimental Indicators — Proven profitable tools for XAU/USD scalping
 *
 * 1. Supertrend — ATR-based trend following (most popular gold scalping indicator)
 * 2. Heikin Ashi — Smoothed candles for trend clarity
 * 3. TTM Squeeze — Bollinger/Keltner compression → breakout detector
 * 4. EMA Ribbon — 8/13/21/34/55 dynamic support/resistance
 * 5. RSI Divergence — Auto-detect bullish/bearish divergences
 * 6. Order Blocks — Institutional buy/sell zones
 * 7. Fair Value Gaps — Price imbalance zones
 * 8. VWAP Bands — Session VWAP ± standard deviations
 */

import type { Candle, ScalpEntry } from "./indicators";
import {
  calcATR,
  calcBollingerBands,
  calcEMA,
  calcRSI,
  calcSMA,
} from "./indicators";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. SUPERTREND
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface SupertrendResult {
  trend: ("UP" | "DOWN")[]; // trend direction per candle
  line: number[]; // supertrend line values
  signal: ("BUY" | "SELL" | null)[]; // signal on direction change
}

export function calcSupertrend(
  candles: Candle[],
  atrPeriod = 10,
  multiplier = 3,
): SupertrendResult {
  const atr = calcATR(candles, atrPeriod);
  const trend: ("UP" | "DOWN")[] = [];
  const line: number[] = [];
  const signal: ("BUY" | "SELL" | null)[] = [];

  const upperBand: number[] = [];
  const lowerBand: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const atrVal = atr[i] ?? 0;

    upperBand[i] = hl2 + multiplier * atrVal;
    lowerBand[i] = hl2 - multiplier * atrVal;

    // Adjust bands based on previous values
    if (i > 0) {
      if (
        lowerBand[i] < lowerBand[i - 1] &&
        candles[i - 1].close > lowerBand[i - 1]
      ) {
        lowerBand[i] = lowerBand[i - 1];
      }
      if (
        upperBand[i] > upperBand[i - 1] &&
        candles[i - 1].close < upperBand[i - 1]
      ) {
        upperBand[i] = upperBand[i - 1];
      }
    }

    // Determine trend
    if (i === 0) {
      trend[i] = candles[i].close > upperBand[i] ? "UP" : "DOWN";
    } else {
      if (trend[i - 1] === "UP") {
        trend[i] = candles[i].close < lowerBand[i] ? "DOWN" : "UP";
      } else {
        trend[i] = candles[i].close > upperBand[i] ? "UP" : "DOWN";
      }
    }

    line[i] = trend[i] === "UP" ? lowerBand[i] : upperBand[i];

    // Signal on change
    if (i > 0 && trend[i] !== trend[i - 1]) {
      signal[i] = trend[i] === "UP" ? "BUY" : "SELL";
    } else {
      signal[i] = null;
    }
  }

  return { trend, line, signal };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. HEIKIN ASHI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface HACandle extends Candle {
  haOpen: number;
  haClose: number;
  haHigh: number;
  haLow: number;
  isBullish: boolean;
}

export function calcHeikinAshi(candles: Candle[]): HACandle[] {
  const ha: HACandle[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen =
      i === 0
        ? (c.open + c.close) / 2
        : (ha[i - 1].haOpen + ha[i - 1].haClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);

    ha.push({
      ...c,
      haOpen,
      haClose,
      haHigh,
      haLow,
      isBullish: haClose > haOpen,
    });
  }

  return ha;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. TTM SQUEEZE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface SqueezeResult {
  isSqueezing: boolean[]; // true = BB inside KC (compression)
  momentum: number[]; // linear regression of (close - midline)
  squeezeFired: boolean[]; // squeeze just released
}

export function calcTTMSqueeze(
  candles: Candle[],
  bbPeriod = 20,
  bbMult = 2,
  kcPeriod = 20,
  kcMult = 1.5,
): SqueezeResult {
  const closes = candles.map(c => c.close);
  const bb = calcBollingerBands(closes, bbPeriod, bbMult);
  const atr = calcATR(candles, kcPeriod);
  const kcMiddle = calcSMA(closes, kcPeriod);

  const isSqueezing: boolean[] = [];
  const momentum: number[] = [];
  const squeezeFired: boolean[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (
      bb.upper[i] !== undefined &&
      bb.lower[i] !== undefined &&
      kcMiddle[i] !== undefined &&
      atr[i] !== undefined
    ) {
      const kcUpper = kcMiddle[i] + kcMult * atr[i];
      const kcLower = kcMiddle[i] - kcMult * atr[i];
      isSqueezing[i] = bb.lower[i] > kcLower && bb.upper[i] < kcUpper;

      // Momentum: simple approach — close minus midline of Donchian-like channel
      const lookback = Math.min(i + 1, kcPeriod);
      const slice = candles.slice(i - lookback + 1, i + 1);
      const highest = Math.max(...slice.map(c => c.high));
      const lowest = Math.min(...slice.map(c => c.low));
      const midline = (highest + lowest) / 2 + kcMiddle[i];
      momentum[i] = closes[i] - midline / 2;

      squeezeFired[i] = i > 0 && isSqueezing[i - 1] === true && !isSqueezing[i];
    } else {
      isSqueezing[i] = false;
      momentum[i] = 0;
      squeezeFired[i] = false;
    }
  }

  return { isSqueezing, momentum, squeezeFired };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. EMA RIBBON (8/13/21/34/55)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface EMARibbonResult {
  ema8: number[];
  ema13: number[];
  ema21: number[];
  ema34: number[];
  ema55: number[];
  trendStrength: number; // 0-100: how aligned (stacked) they are
  ribbonBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  expanding: boolean; // ribbon widening = strong trend
}

export function calcEMARibbon(closes: number[]): EMARibbonResult {
  const ema8 = calcEMA(closes, 8);
  const ema13 = calcEMA(closes, 13);
  const ema21 = calcEMA(closes, 21);
  const ema34 = calcEMA(closes, 34);
  const ema55 = calcEMA(closes, 55);

  const last = closes.length - 1;
  const vals = [ema8[last], ema13[last], ema21[last], ema34[last], ema55[last]];

  if (vals.some(v => v === undefined)) {
    return {
      ema8,
      ema13,
      ema21,
      ema34,
      ema55,
      trendStrength: 0,
      ribbonBias: "NEUTRAL",
      expanding: false,
    };
  }

  // Check alignment (perfect stack)
  let bullOrder = 0;
  let bearOrder = 0;
  for (let i = 0; i < vals.length - 1; i++) {
    if (vals[i] > vals[i + 1]) bullOrder++;
    else bearOrder++;
  }

  const trendStrength = Math.round((Math.max(bullOrder, bearOrder) / 4) * 100);
  const ribbonBias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    bullOrder === 4
      ? "BULLISH"
      : bearOrder === 4
        ? "BEARISH"
        : trendStrength >= 75
          ? bullOrder > bearOrder
            ? "BULLISH"
            : "BEARISH"
          : "NEUTRAL";

  // Check if expanding (top EMA - bottom EMA widening)
  const spread = Math.abs(vals[0] - vals[4]);
  let prevSpread = 0;
  if (last > 5) {
    const prevVals = [
      ema8[last - 5],
      ema13[last - 5],
      ema21[last - 5],
      ema34[last - 5],
      ema55[last - 5],
    ];
    if (prevVals.every(v => v !== undefined)) {
      prevSpread = Math.abs(prevVals[0]! - prevVals[4]!);
    }
  }

  return {
    ema8,
    ema13,
    ema21,
    ema34,
    ema55,
    trendStrength,
    ribbonBias,
    expanding: spread > prevSpread,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. RSI DIVERGENCE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface Divergence {
  type:
    | "BULLISH_REGULAR"
    | "BEARISH_REGULAR"
    | "BULLISH_HIDDEN"
    | "BEARISH_HIDDEN";
  priceIndex1: number;
  priceIndex2: number;
  description: string;
}

export function detectRSIDivergence(
  candles: Candle[],
  rsiPeriod = 14,
  lookback = 30,
): Divergence[] {
  if (candles.length < rsiPeriod + lookback) return [];

  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes, rsiPeriod);
  const divergences: Divergence[] = [];
  const last = candles.length - 1;
  const start = Math.max(rsiPeriod, last - lookback);

  // Find swing lows and highs in recent candles
  const swingLows: number[] = [];
  const swingHighs: number[] = [];

  for (let i = start + 2; i <= last - 2; i++) {
    if (
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i - 2].low &&
      candles[i].low < candles[i + 1].low &&
      candles[i].low < candles[i + 2].low
    ) {
      swingLows.push(i);
    }
    if (
      candles[i].high > candles[i - 1].high &&
      candles[i].high > candles[i - 2].high &&
      candles[i].high > candles[i + 1].high &&
      candles[i].high > candles[i + 2].high
    ) {
      swingHighs.push(i);
    }
  }

  // Check last 2 swing lows for bullish divergence
  if (swingLows.length >= 2) {
    const a = swingLows[swingLows.length - 2];
    const b = swingLows[swingLows.length - 1];
    if (rsi[a] !== undefined && rsi[b] !== undefined) {
      // Regular bullish: price lower low, RSI higher low
      if (candles[b].low < candles[a].low && rsi[b] > rsi[a]) {
        divergences.push({
          type: "BULLISH_REGULAR",
          priceIndex1: a,
          priceIndex2: b,
          description: `Regular bullish div: price LL at ${candles[b].low.toFixed(2)} but RSI HL (${rsi[a]!.toFixed(0)} → ${rsi[b]!.toFixed(0)})`,
        });
      }
      // Hidden bullish: price higher low, RSI lower low
      if (candles[b].low > candles[a].low && rsi[b] < rsi[a]) {
        divergences.push({
          type: "BULLISH_HIDDEN",
          priceIndex1: a,
          priceIndex2: b,
          description: `Hidden bullish div: price HL but RSI LL (${rsi[a]!.toFixed(0)} → ${rsi[b]!.toFixed(0)})`,
        });
      }
    }
  }

  // Check last 2 swing highs for bearish divergence
  if (swingHighs.length >= 2) {
    const a = swingHighs[swingHighs.length - 2];
    const b = swingHighs[swingHighs.length - 1];
    if (rsi[a] !== undefined && rsi[b] !== undefined) {
      // Regular bearish: price higher high, RSI lower high
      if (candles[b].high > candles[a].high && rsi[b] < rsi[a]) {
        divergences.push({
          type: "BEARISH_REGULAR",
          priceIndex1: a,
          priceIndex2: b,
          description: `Regular bearish div: price HH at ${candles[b].high.toFixed(2)} but RSI LH (${rsi[a]!.toFixed(0)} → ${rsi[b]!.toFixed(0)})`,
        });
      }
      // Hidden bearish: price lower high, RSI higher high
      if (candles[b].high < candles[a].high && rsi[b] > rsi[a]) {
        divergences.push({
          type: "BEARISH_HIDDEN",
          priceIndex1: a,
          priceIndex2: b,
          description: `Hidden bearish div: price LH but RSI HH (${rsi[a]!.toFixed(0)} → ${rsi[b]!.toFixed(0)})`,
        });
      }
    }
  }

  return divergences;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. ORDER BLOCKS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface OrderBlock {
  type: "BULLISH_OB" | "BEARISH_OB";
  high: number;
  low: number;
  midpoint: number;
  index: number;
  strength: number; // 1-3 based on rejection strength
}

export function detectOrderBlocks(
  candles: Candle[],
  lookback = 50,
): OrderBlock[] {
  if (candles.length < lookback) return [];

  const blocks: OrderBlock[] = [];
  const start = Math.max(0, candles.length - lookback);

  for (let i = start + 1; i < candles.length - 1; i++) {
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish OB: bearish candle before strong bullish move
    // Last down candle before a big push up
    if (
      curr.close < curr.open && // current is bearish
      next.close > next.open && // next is bullish
      next.close > curr.high && // next breaks above
      next.close - next.open > (curr.open - curr.close) * 1.5 // strong move
    ) {
      const strength =
        next.close - next.open > (curr.open - curr.close) * 2.5
          ? 3
          : next.close - next.open > (curr.open - curr.close) * 2
            ? 2
            : 1;
      blocks.push({
        type: "BULLISH_OB",
        high: curr.open,
        low: curr.low,
        midpoint: (curr.open + curr.low) / 2,
        index: i,
        strength,
      });
    }

    // Bearish OB: bullish candle before strong bearish move
    if (
      curr.close > curr.open && // current is bullish
      next.close < next.open && // next is bearish
      next.close < curr.low && // next breaks below
      next.open - next.close > (curr.close - curr.open) * 1.5
    ) {
      const strength =
        next.open - next.close > (curr.close - curr.open) * 2.5
          ? 3
          : next.open - next.close > (curr.close - curr.open) * 2
            ? 2
            : 1;
      blocks.push({
        type: "BEARISH_OB",
        high: curr.high,
        low: curr.open,
        midpoint: (curr.high + curr.open) / 2,
        index: i,
        strength,
      });
    }
  }

  // Return most recent ones
  return blocks.slice(-6);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. FAIR VALUE GAPS (FVG)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface FairValueGap {
  type: "BULLISH_FVG" | "BEARISH_FVG";
  high: number;
  low: number;
  size: number;
  index: number;
  filled: boolean;
}

export function detectFVG(candles: Candle[], lookback = 40): FairValueGap[] {
  if (candles.length < 3) return [];

  const gaps: FairValueGap[] = [];
  const start = Math.max(0, candles.length - lookback);
  const price = candles[candles.length - 1].close;

  for (let i = start + 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c3 = candles[i];

    // Bullish FVG: gap between c1.high and c3.low (c3 low > c1 high)
    if (c3.low > c1.high) {
      const size = c3.low - c1.high;
      const minSize = price * 0.0003; // Min 0.03% of price
      if (size > minSize) {
        gaps.push({
          type: "BULLISH_FVG",
          high: c3.low,
          low: c1.high,
          size,
          index: i - 1,
          filled: price < c1.high, // filled if price came back through
        });
      }
    }

    // Bearish FVG: gap between c3.high and c1.low
    if (c1.low > c3.high) {
      const size = c1.low - c3.high;
      const minSize = price * 0.0003;
      if (size > minSize) {
        gaps.push({
          type: "BEARISH_FVG",
          high: c1.low,
          low: c3.high,
          size,
          index: i - 1,
          filled: price > c1.low,
        });
      }
    }
  }

  // Return unfilled gaps, most recent first
  return gaps.filter(g => !g.filled).slice(-4);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. VWAP BANDS (± std devs)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface VWAPBands {
  vwap: number[];
  upper1: number[];
  lower1: number[];
  upper2: number[];
  lower2: number[];
}

export function calcVWAPBands(candles: Candle[]): VWAPBands {
  const vwap: number[] = [];
  const upper1: number[] = [];
  const lower1: number[] = [];
  const upper2: number[] = [];
  const lower2: number[] = [];

  let cumVol = 0;
  let cumTPVol = 0;
  let cumTP2Vol = 0;

  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const vol = candles[i].volume || 1;
    cumVol += vol;
    cumTPVol += tp * vol;
    cumTP2Vol += tp * tp * vol;

    const v = cumTPVol / cumVol;
    vwap[i] = v;

    const variance = cumTP2Vol / cumVol - v * v;
    const stdDev = Math.sqrt(Math.max(0, variance));

    upper1[i] = v + stdDev;
    lower1[i] = v - stdDev;
    upper2[i] = v + 2 * stdDev;
    lower2[i] = v - 2 * stdDev;
  }

  return { vwap, upper1, lower1, upper2, lower2 };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COMBINED EXPERIMENTAL ANALYSIS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export interface ExperimentalSignal {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number; // 0-100
  tools: ToolSignal[];
  combinedScore: number;
}

export interface ToolSignal {
  name: string;
  signal: "BUY" | "SELL" | "NEUTRAL" | "SQUEEZE";
  weight: number;
  detail: string;
}

export interface ExperimentalAnalysis {
  // Core analysis (same structure as ScalpAnalysis for compatibility)
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  biasStrength: number;
  entries: ScalpEntry[];

  // Experimental tools
  supertrend: SupertrendResult;
  heikinAshi: HACandle[];
  squeeze: SqueezeResult;
  emaRibbon: EMARibbonResult;
  divergences: Divergence[];
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  vwapBands: VWAPBands;

  // Combined signal
  experimentalSignal: ExperimentalSignal;
}

export function analyzeExperimental(
  candles: Candle[],
): ExperimentalAnalysis | null {
  if (candles.length < 60) return null;

  const closes = candles.map(c => c.close);
  const last = candles.length - 1;
  const price = closes[last];
  const atr = calcATR(candles, 14);
  const currentATR = atr[last] ?? price * 0.002;

  // Run all experimental tools
  const supertrend = calcSupertrend(candles, 10, 3);
  const heikinAshi = calcHeikinAshi(candles);
  const squeeze = calcTTMSqueeze(candles);
  const emaRibbon = calcEMARibbon(closes);
  const divergences = detectRSIDivergence(candles);
  const orderBlocks = detectOrderBlocks(candles);
  const fvgs = detectFVG(candles);
  const vwapBands = calcVWAPBands(candles);

  // Standard indicators available for future use

  // ─── Score each tool ───
  const tools: ToolSignal[] = [];
  let bullScore = 0;
  let bearScore = 0;

  // 1. Supertrend (weight: 20)
  const stTrend = supertrend.trend[last];
  const stSignal = supertrend.signal[last];
  if (stTrend === "UP") {
    bullScore += stSignal === "BUY" ? 20 : 15;
    tools.push({
      name: "Supertrend",
      signal: stSignal === "BUY" ? "BUY" : "BUY",
      weight: 20,
      detail:
        stSignal === "BUY"
          ? `Fresh BUY signal! Line at ${supertrend.line[last]?.toFixed(2)}`
          : `Uptrend — support at ${supertrend.line[last]?.toFixed(2)}`,
    });
  } else {
    bearScore += stSignal === "SELL" ? 20 : 15;
    tools.push({
      name: "Supertrend",
      signal: stSignal === "SELL" ? "SELL" : "SELL",
      weight: 20,
      detail:
        stSignal === "SELL"
          ? `Fresh SELL signal! Line at ${supertrend.line[last]?.toFixed(2)}`
          : `Downtrend — resistance at ${supertrend.line[last]?.toFixed(2)}`,
    });
  }

  // 2. Heikin Ashi (weight: 15)
  const haLast = heikinAshi[last];
  const haPrev = last > 0 ? heikinAshi[last - 1] : null;
  if (haLast) {
    const haNoLowerWick = haLast.haLow === haLast.haOpen; // Strong bull
    const haNoUpperWick = haLast.haHigh === haLast.haOpen; // Strong bear
    const haFlipped = haPrev && haLast.isBullish !== haPrev.isBullish;

    if (haLast.isBullish) {
      bullScore += haNoLowerWick ? 15 : haFlipped ? 12 : 8;
      tools.push({
        name: "Heikin Ashi",
        signal: "BUY",
        weight: 15,
        detail: haNoLowerWick
          ? "Strong bullish — no lower wick"
          : haFlipped
            ? "Bullish reversal candle"
            : "Bullish candle",
      });
    } else {
      bearScore += haNoUpperWick ? 15 : haFlipped ? 12 : 8;
      tools.push({
        name: "Heikin Ashi",
        signal: "SELL",
        weight: 15,
        detail: haNoUpperWick
          ? "Strong bearish — no upper wick"
          : haFlipped
            ? "Bearish reversal candle"
            : "Bearish candle",
      });
    }
  }

  // 3. TTM Squeeze (weight: 18)
  const isSqueeze = squeeze.isSqueezing[last];
  const sqFired = squeeze.squeezeFired[last];
  const sqMomentum = squeeze.momentum[last] ?? 0;

  if (sqFired) {
    if (sqMomentum > 0) {
      bullScore += 18;
      tools.push({
        name: "TTM Squeeze",
        signal: "BUY",
        weight: 18,
        detail: "Squeeze FIRED — bullish momentum breakout!",
      });
    } else {
      bearScore += 18;
      tools.push({
        name: "TTM Squeeze",
        signal: "SELL",
        weight: 18,
        detail: "Squeeze FIRED — bearish momentum breakout!",
      });
    }
  } else if (isSqueeze) {
    tools.push({
      name: "TTM Squeeze",
      signal: "SQUEEZE",
      weight: 18,
      detail: `Compression active — breakout imminent (mom: ${sqMomentum > 0 ? "+" : ""}${sqMomentum.toFixed(2)})`,
    });
  } else {
    if (sqMomentum > 0) {
      bullScore += 8;
      tools.push({
        name: "TTM Squeeze",
        signal: "BUY",
        weight: 18,
        detail: `Positive momentum (${sqMomentum.toFixed(2)})`,
      });
    } else {
      bearScore += 8;
      tools.push({
        name: "TTM Squeeze",
        signal: "SELL",
        weight: 18,
        detail: `Negative momentum (${sqMomentum.toFixed(2)})`,
      });
    }
  }

  // 4. EMA Ribbon (weight: 15)
  if (emaRibbon.ribbonBias === "BULLISH") {
    bullScore += emaRibbon.expanding ? 15 : 10;
    tools.push({
      name: "EMA Ribbon",
      signal: "BUY",
      weight: 15,
      detail: `Bullish stack (${emaRibbon.trendStrength}% aligned)${emaRibbon.expanding ? " — expanding" : ""}`,
    });
  } else if (emaRibbon.ribbonBias === "BEARISH") {
    bearScore += emaRibbon.expanding ? 15 : 10;
    tools.push({
      name: "EMA Ribbon",
      signal: "SELL",
      weight: 15,
      detail: `Bearish stack (${emaRibbon.trendStrength}% aligned)${emaRibbon.expanding ? " — expanding" : ""}`,
    });
  } else {
    tools.push({
      name: "EMA Ribbon",
      signal: "NEUTRAL",
      weight: 15,
      detail: "No clear ribbon alignment — choppy market",
    });
  }

  // 5. RSI Divergence (weight: 16)
  if (divergences.length > 0) {
    const recent = divergences[divergences.length - 1];
    const isBull = recent.type.startsWith("BULLISH");
    if (isBull) bullScore += recent.type.includes("REGULAR") ? 16 : 10;
    else bearScore += recent.type.includes("REGULAR") ? 16 : 10;

    tools.push({
      name: "RSI Divergence",
      signal: isBull ? "BUY" : "SELL",
      weight: 16,
      detail: recent.description,
    });
  } else {
    tools.push({
      name: "RSI Divergence",
      signal: "NEUTRAL",
      weight: 16,
      detail: "No divergence detected",
    });
  }

  // 6. Order Blocks (weight: 12)
  const nearOBs = orderBlocks.filter(
    ob => Math.abs(price - ob.midpoint) / price < 0.003,
  );
  if (nearOBs.length > 0) {
    const ob = nearOBs[nearOBs.length - 1];
    const isBull = ob.type === "BULLISH_OB";
    if (isBull) bullScore += 12;
    else bearScore += 12;
    tools.push({
      name: "Order Blocks",
      signal: isBull ? "BUY" : "SELL",
      weight: 12,
      detail: `${isBull ? "Bullish" : "Bearish"} OB zone ${ob.low.toFixed(2)}-${ob.high.toFixed(2)} (str: ${ob.strength}/3)`,
    });
  } else if (orderBlocks.length > 0) {
    const nearest = orderBlocks.reduce((prev, curr) =>
      Math.abs(price - curr.midpoint) < Math.abs(price - prev.midpoint)
        ? curr
        : prev,
    );
    tools.push({
      name: "Order Blocks",
      signal: "NEUTRAL",
      weight: 12,
      detail: `Nearest ${nearest.type === "BULLISH_OB" ? "bull" : "bear"} OB at ${nearest.midpoint.toFixed(2)}`,
    });
  } else {
    tools.push({
      name: "Order Blocks",
      signal: "NEUTRAL",
      weight: 12,
      detail: "No order blocks nearby",
    });
  }

  // 7. FVG (weight: 8)
  const nearFVGs = fvgs.filter(
    g =>
      price >= g.low - currentATR * 0.5 && price <= g.high + currentATR * 0.5,
  );
  if (nearFVGs.length > 0) {
    const fvg = nearFVGs[nearFVGs.length - 1];
    const isBull = fvg.type === "BULLISH_FVG";
    if (isBull) bullScore += 8;
    else bearScore += 8;
    tools.push({
      name: "Fair Value Gap",
      signal: isBull ? "BUY" : "SELL",
      weight: 8,
      detail: `${isBull ? "Bullish" : "Bearish"} FVG ${fvg.low.toFixed(2)}-${fvg.high.toFixed(2)} (${fvg.size.toFixed(2)} pts)`,
    });
  } else {
    tools.push({
      name: "Fair Value Gap",
      signal: "NEUTRAL",
      weight: 8,
      detail: "No active FVGs nearby",
    });
  }

  // 8. VWAP position (weight: 10)
  const vwapVal = vwapBands.vwap[last];
  if (vwapVal !== undefined) {
    const aboveVwap = price > vwapVal;
    const distPct = (Math.abs(price - vwapVal) / vwapVal) * 100;

    if (price <= vwapBands.lower2[last]) {
      bullScore += 10;
      tools.push({
        name: "VWAP Bands",
        signal: "BUY",
        weight: 10,
        detail: `Price at -2σ (${distPct.toFixed(2)}% below VWAP) — mean reversion buy`,
      });
    } else if (price >= vwapBands.upper2[last]) {
      bearScore += 10;
      tools.push({
        name: "VWAP Bands",
        signal: "SELL",
        weight: 10,
        detail: `Price at +2σ (${distPct.toFixed(2)}% above VWAP) — mean reversion sell`,
      });
    } else if (price <= vwapBands.lower1[last]) {
      bullScore += 6;
      tools.push({
        name: "VWAP Bands",
        signal: "BUY",
        weight: 10,
        detail: `Below -1σ VWAP band — bullish zone`,
      });
    } else if (price >= vwapBands.upper1[last]) {
      bearScore += 6;
      tools.push({
        name: "VWAP Bands",
        signal: "SELL",
        weight: 10,
        detail: `Above +1σ VWAP band — bearish zone`,
      });
    } else {
      if (aboveVwap) bullScore += 3;
      else bearScore += 3;
      tools.push({
        name: "VWAP Bands",
        signal: aboveVwap ? "BUY" : "SELL",
        weight: 10,
        detail: `Price ${aboveVwap ? "above" : "below"} VWAP (${distPct.toFixed(2)}%)`,
      });
    }
  }

  // ─── Combined signal ───
  const totalScore = bullScore + bearScore;
  const combinedScore =
    totalScore > 0
      ? Math.round((Math.abs(bullScore - bearScore) / totalScore) * 100)
      : 0;
  const direction: "LONG" | "SHORT" | "NEUTRAL" =
    combinedScore < 15 ? "NEUTRAL" : bullScore > bearScore ? "LONG" : "SHORT";

  const toolsBullish = tools.filter(t => t.signal === "BUY").length;
  const toolsBearish = tools.filter(t => t.signal === "SELL").length;
  const confidence = Math.min(
    95,
    Math.round(
      (Math.max(toolsBullish, toolsBearish) / tools.length) * 100 * 1.1,
    ),
  );

  const experimentalSignal: ExperimentalSignal = {
    direction,
    confidence,
    tools,
    combinedScore,
  };

  // ─── Bias (for compatibility)
  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    direction === "LONG"
      ? "BULLISH"
      : direction === "SHORT"
        ? "BEARISH"
        : "NEUTRAL";

  // ─── Generate entries ───
  const entries: ScalpEntry[] = [];

  if (direction !== "NEUTRAL") {
    // Build reasons from the strongest tools
    const activeTools = tools.filter(t =>
      direction === "LONG" ? t.signal === "BUY" : t.signal === "SELL",
    );
    const reason = activeTools
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map(t => `${t.name}: ${t.detail}`)
      .join(" | ");

    if (direction === "LONG") {
      const sl =
        supertrend.trend[last] === "UP"
          ? Math.min(
              supertrend.line[last] ?? price - currentATR,
              price - currentATR * 0.8,
            )
          : price - currentATR * 1.2;
      const risk = price - sl;
      if (risk > 0) {
        entries.push({
          direction: "LONG",
          entryPrice: r2(price),
          stopLoss: r2(sl),
          tp1: r2(price + risk * 1.5),
          tp2: r2(price + risk * 2.5),
          riskReward: 2,
          confidence,
          reason,
        });
      }
    } else {
      const sl =
        supertrend.trend[last] === "DOWN"
          ? Math.max(
              supertrend.line[last] ?? price + currentATR,
              price + currentATR * 0.8,
            )
          : price + currentATR * 1.2;
      const risk = sl - price;
      if (risk > 0) {
        entries.push({
          direction: "SHORT",
          entryPrice: r2(price),
          stopLoss: r2(sl),
          tp1: r2(price - risk * 1.5),
          tp2: r2(price - risk * 2.5),
          riskReward: 2,
          confidence,
          reason,
        });
      }
    }
  }

  return {
    bias,
    biasStrength: combinedScore,
    entries,
    supertrend,
    heikinAshi,
    squeeze,
    emaRibbon,
    divergences,
    orderBlocks,
    fvgs,
    vwapBands,
    experimentalSignal,
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
