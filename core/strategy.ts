/**
 * Shared, framework-agnostic strategy core for XAU Scalper.
 *
 * This module has NO Convex imports so it can be consumed by BOTH the Convex
 * signal engine (the Convex signal engine) AND standalone Bun/Node scripts (the
 * backtest harness in scripts/). Keeping the indicator math, signal analysis,
 * grading and TP/SL math in one place guarantees the live engine and the
 * backtester can never drift apart.
 *
 * IMPORTANT: With the default StrategyConfig and a pricePrecision of 2, this
 * code reproduces the pre-refactor gold (PAXGUSDT) behaviour byte-for-byte.
 */

// ─── Types ───
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SignalGrade = "A" | "B" | "C" | "NO_TRADE";
export type Direction = "LONG" | "SHORT";
export type Bias = "BULLISH" | "BEARISH" | "NEUTRAL";

/**
 * Every tunable knob of the scalping strategy. The DEFAULT_STRATEGY_CONFIG
 * below keeps the exact hardcoded values the engine used before this refactor,
 * so behaviour is unchanged for existing assets. Per-asset overrides live in
 * the asset registry (core/assets.ts).
 */
export interface StrategyConfig {
  /** EMA lookback periods (was 9 / 21 / 50). */
  emaFast: number;
  emaMid: number;
  emaSlow: number;
  /** RSI period and extreme thresholds (was 14, 30, 70). */
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  /** MACD periods (was 12 / 26 / 9). */
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  /** ATR period (was 14). */
  atrPeriod: number;
  /** ATR multiple used to place the stop loss (was 1.5). */
  atrSlMultiplier: number;
  /** ATR multiple used for the trailing stop after TP1 (was 2). */
  atrTrailMultiplier: number;
  /** Stochastic %K period and extreme thresholds (was 14, 20, 80). */
  stochPeriod: number;
  stochOversold: number;
  stochOverbought: number;
  /** Bollinger band period and standard-deviation multiplier (was 20, 2). */
  bollingerPeriod: number;
  bollingerStdDev: number;
  /** Take-profit R-multiples (was TP1 1.2R, TP2 2.5R). */
  tp1R: number;
  tp2R: number;
  /** Grade thresholds (was A: >=3 extreme & >=70 strength, B: >=2 & >=60, C: >=50). */
  gradeAExtreme: number;
  gradeAStrength: number;
  gradeBExtreme: number;
  gradeBStrength: number;
  gradeCStrength: number;
  /** Confidence scaling (was strength * 1.2, capped at 95). */
  confidenceMultiplier: number;
  confidenceCap: number;
  /** Below this bias strength the setup is treated as NEUTRAL (was 15). */
  biasNeutralThreshold: number;
  /** Minimum spacing between same-direction signals (was 10 min). */
  cooldownMs: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  emaFast: 9,
  emaMid: 21,
  emaSlow: 50,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atrPeriod: 14,
  atrSlMultiplier: 1.5,
  atrTrailMultiplier: 2,
  stochPeriod: 14,
  stochOversold: 20,
  stochOverbought: 80,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  tp1R: 1.2,
  tp2R: 2.5,
  gradeAExtreme: 3,
  gradeAStrength: 70,
  gradeBExtreme: 2,
  gradeBStrength: 60,
  gradeCStrength: 50,
  confidenceMultiplier: 1.2,
  confidenceCap: 95,
  biasNeutralThreshold: 15,
  cooldownMs: 10 * 60 * 1000,
};

// ─── Rounding ───

/**
 * Round to a fixed number of decimal places. With precision = 2 this is
 * identical to the previous hardcoded r2() helper.
 */
export function roundTo(n: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(n * factor) / factor;
}

// ─── Indicator calculations ───

export function calcEMA(data: number[], period: number): number[] {
  const ema: number[] = [];
  const m = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < data.length; i++) sum += data[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    ema[i] = (data[i] - ema[i - 1]) * m + ema[i - 1];
  }
  return ema;
}

export function calcRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  let avgG = 0;
  let avgL = 0;
  for (let i = 1; i <= period; i++) {
    avgG += gains[i] || 0;
    avgL += losses[i] || 0;
  }
  avgG /= period;
  avgL /= period;
  rsi[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    avgG = (avgG * (period - 1) + (gains[i] || 0)) / period;
    avgL = (avgL * (period - 1) + (losses[i] || 0)) / period;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

export function calcMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
) {
  const fast = calcEMA(closes, fastPeriod);
  const slow = calcEMA(closes, slowPeriod);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fast[i] !== undefined && slow[i] !== undefined)
      macdLine[i] = fast[i] - slow[i];
  }
  const vals = macdLine.filter(x => x !== undefined);
  const sig = calcEMA(vals, signalPeriod);
  const signal: number[] = [];
  const histogram: number[] = [];
  let idx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== undefined) {
      if (sig[idx] !== undefined) {
        signal[i] = sig[idx];
        histogram[i] = macdLine[i] - sig[idx];
      }
      idx++;
    }
  }
  return { macd: macdLine, signal, histogram };
}

export function calcATR(candles: Candle[], period = 14): number[] {
  if (candles.length === 0) return [];
  const tr: number[] = [];
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
  }
  const atr: number[] = [];
  let s = 0;
  for (let i = 0; i < period; i++) s += tr[i];
  atr[period - 1] = s / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

export function calcStochastic(candles: Candle[], kPeriod = 14) {
  const k: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const range = hi - lo;
    k[i] = range === 0 ? 50 : ((candles[i].close - lo) / range) * 100;
  }
  return { k };
}

export function calcBollingerBands(
  closes: number[],
  period = 20,
  stdDevMult = 2,
) {
  const upper: number[] = [];
  const lower: number[] = [];
  const middle: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - mean) ** 2;
    const stdDev = Math.sqrt(sqSum / period);
    middle[i] = mean;
    upper[i] = mean + stdDev * stdDevMult;
    lower[i] = mean - stdDev * stdDevMult;
  }
  return { upper, lower, middle };
}

// ─── Signal Grading ───

export function gradeSignal(
  _confidence: number,
  extremeIndicators: number,
  totalStrength: number,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): SignalGrade {
  if (
    extremeIndicators >= config.gradeAExtreme &&
    totalStrength >= config.gradeAStrength
  )
    return "A";
  if (
    extremeIndicators >= config.gradeBExtreme &&
    totalStrength >= config.gradeBStrength
  )
    return "B";
  if (totalStrength >= config.gradeCStrength) return "C";
  return "NO_TRADE";
}

export interface AnalysisResult {
  bias: Bias;
  biasStrength: number;
  confidence: number;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  reason: string;
  grade: SignalGrade;
  indicators: Record<string, number | undefined>;
  atr: number;
}

// ─── Full analysis function ───

/**
 * Every indicator series the analysis reads, computed once over a whole window.
 *
 * All of these are causal — the value at index i depends only on candles up to
 * i — so a series computed over the full window is identical, at every index, to
 * one computed over the prefix ending there. That is what makes it valid to
 * precompute once and index per bar rather than recomputing per bar.
 */
export interface IndicatorSeries {
  closes: number[];
  rsi: number[];
  histogram: number[];
  ema9: number[];
  ema21: number[];
  ema50: number[];
  atr: number[];
  stochK: number[];
  bbUpper: number[];
  bbLower: number[];
}

/** Compute every indicator series once for a window. */
export function precomputeIndicators(
  candles: Candle[],
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): IndicatorSeries {
  const closes = candles.map(c => c.close);
  const { histogram } = calcMACD(
    closes,
    config.macdFast,
    config.macdSlow,
    config.macdSignal,
  );
  const bb = calcBollingerBands(
    closes,
    config.bollingerPeriod,
    config.bollingerStdDev,
  );
  return {
    closes,
    rsi: calcRSI(closes, config.rsiPeriod),
    histogram,
    ema9: calcEMA(closes, config.emaFast),
    ema21: calcEMA(closes, config.emaMid),
    ema50: calcEMA(closes, config.emaSlow),
    atr: calcATR(candles, config.atrPeriod),
    stochK: calcStochastic(candles, config.stochPeriod).k,
    bbUpper: bb.upper,
    bbLower: bb.lower,
  };
}

/**
 * Analyse the bar at `last`, using precomputed series.
 *
 * Equivalent to calling analyzeCandles on `candles.slice(0, last + 1)`, but
 * without recomputing every indicator. Replaying N bars that way is O(N²) and
 * dominated by redundant work: a 36-config sweep over 1,200 bars took 16
 * seconds before this existed.
 */
export function analyzeAt(
  candles: Candle[],
  ind: IndicatorSeries,
  last: number,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  pricePrecision = 2,
): AnalysisResult | null {
  if (last < 59 || last >= candles.length) return null;

  const r = (n: number) => roundTo(n, pricePrecision);

  const { closes, rsi, histogram, ema9, ema21, ema50, atr } = ind;
  const stoch = { k: ind.stochK };
  const bb = { upper: ind.bbUpper, lower: ind.bbLower };
  const price = closes[last];

  const currentATR = atr[last] ?? price * 0.002;

  let bullScore = 0;
  let bearScore = 0;
  let extremeBull = 0;
  let extremeBear = 0;
  const reasons: string[] = [];

  // EMA alignment
  if (
    ema9[last] !== undefined &&
    ema21[last] !== undefined &&
    ema50[last] !== undefined
  ) {
    if (ema9[last] > ema21[last] && ema21[last] > ema50[last]) {
      bullScore += 25;
      reasons.push("EMAs bullish");
    } else if (ema9[last] < ema21[last] && ema21[last] < ema50[last]) {
      bearScore += 25;
      reasons.push("EMAs bearish");
    } else if (ema9[last] > ema21[last]) {
      bullScore += 10;
      reasons.push("EMA 9>21");
    } else {
      bearScore += 10;
      reasons.push("EMA 9<21");
    }
  }

  // Price vs EMA21
  if (ema21[last] !== undefined) {
    if (price > ema21[last]) bullScore += 10;
    else bearScore += 10;
  }

  // RSI
  const lastRSI = rsi[last];
  if (lastRSI !== undefined) {
    if (lastRSI < config.rsiOversold) {
      bullScore += 20;
      extremeBull++;
      reasons.push(`RSI oversold ${lastRSI.toFixed(0)}`);
    } else if (lastRSI > config.rsiOverbought) {
      bearScore += 20;
      extremeBear++;
      reasons.push(`RSI overbought ${lastRSI.toFixed(0)}`);
    } else if (lastRSI > 50) bullScore += 5;
    else bearScore += 5;
  }

  // MACD
  if (histogram[last] !== undefined && histogram[last - 1] !== undefined) {
    if (histogram[last] > 0 && histogram[last - 1] <= 0) {
      bullScore += 20;
      extremeBull++;
      reasons.push("MACD bull cross");
    } else if (histogram[last] < 0 && histogram[last - 1] >= 0) {
      bearScore += 20;
      extremeBear++;
      reasons.push("MACD bear cross");
    } else if (histogram[last] > 0) {
      bullScore += 8;
    } else {
      bearScore += 8;
    }
  }

  // Stochastic
  const lastK = stoch.k[last];
  if (lastK !== undefined) {
    if (lastK < config.stochOversold) {
      bullScore += 15;
      extremeBull++;
      reasons.push("Stoch oversold");
    } else if (lastK > config.stochOverbought) {
      bearScore += 15;
      extremeBear++;
      reasons.push("Stoch overbought");
    }
  }

  // Bollinger Bands
  if (bb.upper[last] !== undefined && bb.lower[last] !== undefined) {
    const bbWidth = bb.upper[last] - bb.lower[last];
    const pricePos = (price - bb.lower[last]) / bbWidth; // 0 = lower band, 1 = upper band
    if (pricePos <= 0.05) {
      bullScore += 18;
      extremeBull++;
      reasons.push("BB lower band touch");
    } else if (pricePos >= 0.95) {
      bearScore += 18;
      extremeBear++;
      reasons.push("BB upper band touch");
    } else if (pricePos < 0.3) {
      bullScore += 8;
      reasons.push("BB lower zone");
    } else if (pricePos > 0.7) {
      bearScore += 8;
      reasons.push("BB upper zone");
    }
  }

  const total = bullScore + bearScore;
  if (total === 0) return null;

  const biasStrength = Math.round(
    (Math.abs(bullScore - bearScore) / total) * 100,
  );
  const bias: Bias =
    biasStrength < config.biasNeutralThreshold
      ? "NEUTRAL"
      : bullScore > bearScore
        ? "BULLISH"
        : "BEARISH";

  if (bias === "NEUTRAL") return null;

  const direction: Direction = bias === "BULLISH" ? "LONG" : "SHORT";
  const confidence = Math.min(
    config.confidenceCap,
    Math.round(Math.max(bullScore, bearScore) * config.confidenceMultiplier),
  );

  // Grade the signal
  const extremeCount = direction === "LONG" ? extremeBull : extremeBear;
  const strength = Math.max(bullScore, bearScore);
  const grade = gradeSignal(confidence, extremeCount, strength, config);

  // Only generate tradeable signals (A or B grade)
  if (grade === "NO_TRADE") return null;

  // TP/SL with partial TP system: TP1 @ tp1R, TP2 @ tp2R
  let sl: number;
  let tp1: number;
  let tp2: number;
  if (direction === "LONG") {
    sl = r(price - currentATR * config.atrSlMultiplier);
    const risk = price - sl;
    tp1 = r(price + risk * config.tp1R); // Partial TP at tp1R
    tp2 = r(price + risk * config.tp2R); // Full TP at tp2R
  } else {
    sl = r(price + currentATR * config.atrSlMultiplier);
    const risk = sl - price;
    tp1 = r(price - risk * config.tp1R); // Partial TP at tp1R
    tp2 = r(price - risk * config.tp2R); // Full TP at tp2R
  }

  return {
    bias,
    biasStrength,
    confidence,
    direction,
    entryPrice: r(price),
    stopLoss: sl,
    tp1,
    tp2,
    reason: reasons.join(" · "),
    grade,
    atr: r(currentATR),
    indicators: {
      rsi: lastRSI ? r(lastRSI) : undefined,
      stochK: lastK ? r(lastK) : undefined,
      macdHist: histogram[last] ? r(histogram[last]) : undefined,
      ema9: ema9[last] ? r(ema9[last]) : undefined,
      ema21: ema21[last] ? r(ema21[last]) : undefined,
      atr: currentATR ? r(currentATR) : undefined,
      bbUpper: bb.upper[last] ? r(bb.upper[last]) : undefined,
      bbLower: bb.lower[last] ? r(bb.lower[last]) : undefined,
    },
  };
}

/**
 * Analyse the most recent bar of a window.
 *
 * Thin wrapper over precomputeIndicators + analyzeAt, kept because it is the
 * shape the live engine wants (one window, one answer) and the shape the
 * pre-refactor parity fixtures assert against.
 */
export function analyzeCandles(
  candles: Candle[],
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  pricePrecision = 2,
): AnalysisResult | null {
  if (candles.length < 60) return null;
  return analyzeAt(
    candles,
    precomputeIndicators(candles, config),
    candles.length - 1,
    config,
    pricePrecision,
  );
}
