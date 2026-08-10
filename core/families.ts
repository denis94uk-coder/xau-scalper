/**
 * Trend and mean-reversion scored as two separate strategies.
 *
 * WHY THIS EXISTS
 * The combined model in strategy.ts scores both families into one bull/bear
 * pair. They fire in opposite conditions, so they cancel: measured over a clean
 * uptrend the mean-reversion half contributes 43 points to BEAR (upper-band
 * touch, RSI > 70, Stoch > 80) while the trend half contributes 40 to BULL. The
 * model leans short in an uptrend, `max(bullScore, bearScore)` never climbs, and
 * grade A — which needs 70 — did not occur once in 4,940 bars of XAUUSD M5.
 *
 * Scoring them apart means each is judged on its own evidence. It also answers a
 * question the combined model cannot: which of the two, if either, actually
 * works on this instrument.
 *
 * WHAT IS NOT DUPLICATED
 * Indicator maths comes from precomputeIndicators — the same IndicatorSeries the
 * combined path uses. Only the attribution of points differs.
 *
 * strategy.ts is untouched. Its behaviour is pinned by a pre-refactor parity
 * fixture and the live engine still runs it.
 */

import {
  type Bias,
  type Candle,
  DEFAULT_STRATEGY_CONFIG,
  type Direction,
  type IndicatorSeries,
  precomputeIndicators,
  roundTo,
  type SignalGrade,
  type StrategyConfig,
} from "./strategy";

export type StrategyFamily = "trend" | "reversion";

/**
 * Grade thresholds for one family.
 *
 * Separate from StrategyConfig's because the two families cannot reach the same
 * numbers. Trend has one extreme signal available (the MACD cross), so the
 * combined model's `gradeAExtreme: 3` is unreachable for it by construction —
 * reusing that threshold would silently forbid a grade A trend signal forever.
 */
export interface FamilyThresholds {
  aStrength: number;
  aExtreme: number;
  bStrength: number;
  bExtreme: number;
  cStrength: number;
}

/**
 * Strength is normalised to 0-100 against each family's own maximum, so a
 * threshold means "this fraction of the strongest signal this family can
 * produce" rather than a raw point total the family may be unable to reach.
 */
export const TREND_MAX_POINTS = 60; // 25 EMA stack + 10 price/EMA21 + 20 MACD cross + 5 RSI tilt
export const REVERSION_MAX_POINTS = 53; // 20 RSI + 15 Stoch + 18 BB touch

export const DEFAULT_FAMILY_THRESHOLDS: Record<
  StrategyFamily,
  FamilyThresholds
> = {
  // Only the MACD cross is an extreme here, so A asks for it and B does not.
  trend: {
    aStrength: 70,
    aExtreme: 1,
    bStrength: 55,
    bExtreme: 0,
    cStrength: 40,
  },
  // RSI, Stochastic and Bollinger can all be extreme at once.
  reversion: {
    aStrength: 70,
    aExtreme: 3,
    bStrength: 55,
    bExtreme: 2,
    cStrength: 40,
  },
};

export interface FamilyScore {
  bull: number;
  bear: number;
  extremeBull: number;
  extremeBear: number;
  reasons: string[];
}

/**
 * Trend-following evidence only.
 *
 * Direction comes from structure — where the EMAs sit relative to each other and
 * to price — plus MACD for momentum. Nothing here reads an oscillator as a
 * reversal signal, which is what let the combined model score against its own
 * trend.
 */
export function scoreTrend(
  ind: IndicatorSeries,
  last: number,
  _config: StrategyConfig,
): FamilyScore {
  const { closes, rsi, histogram, ema9, ema21, ema50 } = ind;
  const price = closes[last];
  const s: FamilyScore = {
    bull: 0,
    bear: 0,
    extremeBull: 0,
    extremeBear: 0,
    reasons: [],
  };

  if (
    ema9[last] !== undefined &&
    ema21[last] !== undefined &&
    ema50[last] !== undefined
  ) {
    if (ema9[last] > ema21[last] && ema21[last] > ema50[last]) {
      s.bull += 25;
      s.reasons.push("EMAs stacked bullish");
    } else if (ema9[last] < ema21[last] && ema21[last] < ema50[last]) {
      s.bear += 25;
      s.reasons.push("EMAs stacked bearish");
    } else if (ema9[last] > ema21[last]) {
      s.bull += 10;
      s.reasons.push("EMA 9>21");
    } else {
      s.bear += 10;
      s.reasons.push("EMA 9<21");
    }
  }

  if (ema21[last] !== undefined) {
    if (price > ema21[last]) s.bull += 10;
    else s.bear += 10;
  }

  if (histogram[last] !== undefined && histogram[last - 1] !== undefined) {
    if (histogram[last] > 0 && histogram[last - 1] <= 0) {
      s.bull += 20;
      s.extremeBull++;
      s.reasons.push("MACD bull cross");
    } else if (histogram[last] < 0 && histogram[last - 1] >= 0) {
      s.bear += 20;
      s.extremeBear++;
      s.reasons.push("MACD bear cross");
    } else if (histogram[last] > 0) {
      s.bull += 8;
    } else {
      s.bear += 8;
    }
  }

  // A mild directional tilt, not a reversal read: RSI above 50 supports a long.
  const lastRSI = rsi[last];
  if (lastRSI !== undefined) {
    if (lastRSI > 50) s.bull += 5;
    else s.bear += 5;
  }

  return s;
}

/**
 * Mean-reversion evidence only.
 *
 * An oscillator extreme is read as a snap-back signal: oversold is bullish,
 * an upper-band touch is bearish. That reading is correct in a range and wrong
 * in a trend, which is precisely why it must not be summed with trend evidence.
 */
export function scoreReversion(
  ind: IndicatorSeries,
  last: number,
  config: StrategyConfig,
): FamilyScore {
  const { closes, rsi, stochK, bbUpper, bbLower } = ind;
  const price = closes[last];
  const s: FamilyScore = {
    bull: 0,
    bear: 0,
    extremeBull: 0,
    extremeBear: 0,
    reasons: [],
  };

  const lastRSI = rsi[last];
  if (lastRSI !== undefined) {
    if (lastRSI < config.rsiOversold) {
      s.bull += 20;
      s.extremeBull++;
      s.reasons.push(`RSI oversold ${lastRSI.toFixed(0)}`);
    } else if (lastRSI > config.rsiOverbought) {
      s.bear += 20;
      s.extremeBear++;
      s.reasons.push(`RSI overbought ${lastRSI.toFixed(0)}`);
    }
  }

  const lastK = stochK[last];
  if (lastK !== undefined) {
    if (lastK < config.stochOversold) {
      s.bull += 15;
      s.extremeBull++;
      s.reasons.push("Stoch oversold");
    } else if (lastK > config.stochOverbought) {
      s.bear += 15;
      s.extremeBear++;
      s.reasons.push("Stoch overbought");
    }
  }

  if (bbUpper[last] !== undefined && bbLower[last] !== undefined) {
    const width = bbUpper[last] - bbLower[last];
    if (width > 0) {
      const pos = (price - bbLower[last]) / width;
      if (pos <= 0.05) {
        s.bull += 18;
        s.extremeBull++;
        s.reasons.push("BB lower band touch");
      } else if (pos >= 0.95) {
        s.bear += 18;
        s.extremeBear++;
        s.reasons.push("BB upper band touch");
      }
    }
  }

  return s;
}

export interface FamilyAnalysis {
  family: StrategyFamily;
  bias: Bias;
  /** 0-100, normalised against this family's maximum. */
  strength: number;
  biasStrength: number;
  confidence: number;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  reason: string;
  grade: SignalGrade;
  extremeCount: number;
  atr: number;
}

function gradeFamily(
  strength: number,
  extremeCount: number,
  t: FamilyThresholds,
): SignalGrade {
  if (strength >= t.aStrength && extremeCount >= t.aExtreme) return "A";
  if (strength >= t.bStrength && extremeCount >= t.bExtreme) return "B";
  if (strength >= t.cStrength) return "C";
  return "NO_TRADE";
}

export interface FamilyRejection {
  reason:
    | "out_of_range"
    | "no_score"
    | "neutral_bias"
    | "no_trade_grade"
    | "graded";
  strength: number;
  biasStrength: number;
  extremeCount: number;
  grade: SignalGrade | null;
}

/**
 * Analyse one bar for one family.
 *
 * Mirrors analyzeAt's contract — null when there is nothing tradable, an
 * optional sink to say why — so callers can swap between them.
 */
export function analyzeFamilyAt(
  candles: Candle[],
  ind: IndicatorSeries,
  last: number,
  family: StrategyFamily,
  config: StrategyConfig,
  pricePrecision = 2,
  thresholds: FamilyThresholds = DEFAULT_FAMILY_THRESHOLDS[family],
  sink?: FamilyRejection,
): FamilyAnalysis | null {
  if (sink) {
    sink.reason = "out_of_range";
    sink.strength = 0;
    sink.biasStrength = 0;
    sink.extremeCount = 0;
    sink.grade = null;
  }
  if (last < 59 || last >= candles.length) return null;

  const r = (n: number) => roundTo(n, pricePrecision);
  const price = ind.closes[last];
  const currentATR = ind.atr[last] ?? price * 0.002;

  const raw =
    family === "trend"
      ? scoreTrend(ind, last, config)
      : scoreReversion(ind, last, config);
  const maxPoints =
    family === "trend" ? TREND_MAX_POINTS : REVERSION_MAX_POINTS;

  const total = raw.bull + raw.bear;
  if (sink) sink.reason = "no_score";
  if (total === 0) return null;

  const biasStrength = Math.round(
    (Math.abs(raw.bull - raw.bear) / total) * 100,
  );
  const bias: Bias =
    biasStrength < config.biasNeutralThreshold
      ? "NEUTRAL"
      : raw.bull > raw.bear
        ? "BULLISH"
        : "BEARISH";

  if (sink) {
    sink.reason = "neutral_bias";
    sink.biasStrength = biasStrength;
  }
  if (bias === "NEUTRAL") return null;

  const direction: Direction = bias === "BULLISH" ? "LONG" : "SHORT";
  const winningPoints = Math.max(raw.bull, raw.bear);
  // Normalised so a threshold means the same thing in both families.
  const strength = Math.round((winningPoints / maxPoints) * 100);
  const extremeCount = direction === "LONG" ? raw.extremeBull : raw.extremeBear;
  const grade = gradeFamily(strength, extremeCount, thresholds);

  if (sink) {
    sink.reason = grade === "NO_TRADE" ? "no_trade_grade" : "graded";
    sink.strength = strength;
    sink.extremeCount = extremeCount;
    sink.grade = grade;
  }
  if (grade === "NO_TRADE") return null;

  const confidence = Math.min(
    config.confidenceCap,
    Math.round(strength * config.confidenceMultiplier),
  );

  let stopLoss: number;
  let tp1: number;
  let tp2: number;
  if (direction === "LONG") {
    stopLoss = r(price - currentATR * config.atrSlMultiplier);
    const risk = price - stopLoss;
    tp1 = r(price + risk * config.tp1R);
    tp2 = r(price + risk * config.tp2R);
  } else {
    stopLoss = r(price + currentATR * config.atrSlMultiplier);
    const risk = stopLoss - price;
    tp1 = r(price - risk * config.tp1R);
    tp2 = r(price - risk * config.tp2R);
  }

  return {
    family,
    bias,
    strength,
    biasStrength,
    confidence,
    direction,
    entryPrice: r(price),
    stopLoss,
    tp1,
    tp2,
    reason: raw.reasons.join(" · "),
    grade,
    extremeCount,
    atr: r(currentATR),
  };
}

/**
 * Analyse the most recent bar for one family.
 *
 * The family counterpart of analyzeCandles — same shape (one window, one
 * answer) so the live engine can swap between them on a per-asset setting.
 */
export function analyzeFamilyCandles(
  candles: Candle[],
  family: StrategyFamily,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  pricePrecision = 2,
): FamilyAnalysis | null {
  if (candles.length < 60) return null;
  return analyzeFamilyAt(
    candles,
    precomputeIndicators(candles, config),
    candles.length - 1,
    family,
    config,
    pricePrecision,
  );
}
