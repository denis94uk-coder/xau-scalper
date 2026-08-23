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

export type StrategyFamily = "trend" | "reversion" | "breakout" | "momentum";

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
export const BREAKOUT_MAX_POINTS = 70; // 30 channel break + 15 squeeze + 10 expansion bar + 10 EMA21 follow-through + 5 RSI tilt
export const MOMENTUM_MAX_POINTS = 75; // 25 velocity conviction + 15 persistence + 15 MACD agreement + 10 EMA50 side + 10 RSI conviction

function maxPointsFor(family: StrategyFamily): number {
  switch (family) {
    case "trend":
      return TREND_MAX_POINTS;
    case "reversion":
      return REVERSION_MAX_POINTS;
    case "breakout":
      return BREAKOUT_MAX_POINTS;
    case "momentum":
      return MOMENTUM_MAX_POINTS;
  }
}

/**
 * Bars of history each family needs before it can score at all.
 *
 * trend/reversion keep the historical 59. breakout needs its full channel
 * behind the candidate bar; momentum needs its ROC lookback plus enough
 * sampled history to rank today's velocity against (25 baseline samples).
 */
export function familyWarmup(
  family: StrategyFamily,
  config: StrategyConfig,
): number {
  switch (family) {
    case "breakout":
      return Math.max(59, Math.floor(config.breakoutPeriod) + 1);
    case "momentum":
      return Math.max(59, Math.floor(config.momentumLookback) + 51);
    default:
      return 59;
  }
}

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
  // The channel break is an extreme by construction and every breakout signal
  // has one, so A asks for a second (the expansion bar) rather than for
  // evidence B cannot reach.
  breakout: {
    aStrength: 70,
    aExtreme: 2,
    bStrength: 55,
    bExtreme: 0,
    cStrength: 40,
  },
  // Velocity conviction is the family's one extreme; without it there is no
  // signal at all, so B does not ask for what A already requires.
  momentum: {
    aStrength: 70,
    aExtreme: 1,
    bStrength: 55,
    bExtreme: 0,
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

/**
 * Breakout evidence only: a close outside the channel left by the previous
 * `config.breakoutPeriod` bars, scored on the quality of the release.
 *
 * WHY THIS FAMILY EXISTS
 * trend reads structure (where the EMAs sit) and reversion reads extremes
 * (where the oscillators sit); neither has an opinion about a range EXIT,
 * which is its own event — price leaving a compressed range tends to keep
 * going, because the stops resting beyond the range become the fuel. That is
 * a mechanism, not a parameter tweak, which is the bar a new family has to
 * clear.
 *
 * EVENT-DRIVEN BY CONSTRUCTION
 * Without a fresh channel break the score is zero and the bar returns null.
 * A breakout family that fired between breakouts would be the trend family
 * under another name.
 */
export function scoreBreakout(
  candles: Candle[],
  ind: IndicatorSeries,
  last: number,
  config: StrategyConfig,
): FamilyScore {
  const { closes, rsi, ema21, atr } = ind;
  const price = closes[last];
  const s: FamilyScore = {
    bull: 0,
    bear: 0,
    extremeBull: 0,
    extremeBear: 0,
    reasons: [],
  };

  // The channel spans the bars BEFORE this one — the breakout bar cannot be
  // part of the range it is escaping.
  const n = Math.max(2, Math.floor(config.breakoutPeriod));
  if (last < n) return s;

  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (let k = last - n; k <= last - 1; k++) {
    if (candles[k].high > hi) hi = candles[k].high;
    if (candles[k].low < lo) lo = candles[k].low;
  }

  const brokeUp = price > hi;
  const brokeDown = price < lo;
  // No fresh break, no opinion.
  if (!brokeUp && !brokeDown) return s;

  if (brokeUp) {
    s.bull += 30;
    s.extremeBull++;
    s.reasons.push(`Donchian(${n}) high break`);
  } else {
    s.bear += 30;
    s.extremeBear++;
    s.reasons.push(`Donchian(${n}) low break`);
  }
  const dir = brokeUp ? 1 : -1;

  // Squeeze into the break: the band width across the channel window was
  // materially tighter than the window behind it, so the range being escaped
  // was compressed rather than already wide. Skipped silently when the bands
  // have not enough history — context quality must not gate the event itself.
  let preSum = 0;
  let preCount = 0;
  let baseSum = 0;
  let baseCount = 0;
  const from = Math.max(0, last - 100);
  for (let k = from; k < last; k++) {
    const u = ind.bbUpper[k];
    const l = ind.bbLower[k];
    const c = closes[k];
    if (u === undefined || l === undefined || c <= 0) continue;
    const w = (u - l) / c;
    if (k >= last - n) {
      preSum += w;
      preCount++;
    } else {
      baseSum += w;
      baseCount++;
    }
  }
  if (preCount > 0 && baseCount > 0) {
    const pre = preSum / preCount;
    const base = baseSum / baseCount;
    if (pre > 0 && base > 0 && pre < base * 0.85) {
      if (dir > 0) s.bull += 15;
      else s.bear += 15;
      s.reasons.push("squeeze into break");
    }
  }

  // Expansion bar: the breaking bar's own range against recent volatility.
  const currentATR = atr[last];
  if (currentATR !== undefined && currentATR > 0) {
    const range = candles[last].high - candles[last].low;
    if (range >= currentATR * 1.5) {
      if (dir > 0) {
        s.bull += 10;
        s.extremeBull++;
      } else {
        s.bear += 10;
        s.extremeBear++;
      }
      s.reasons.push("range expansion");
    }
  }

  // Follow-through: close on the breakout side of EMA21.
  if (ema21[last] !== undefined) {
    if (dir > 0 && price > ema21[last]) {
      s.bull += 10;
      s.reasons.push("close above EMA21");
    } else if (dir < 0 && price < ema21[last]) {
      s.bear += 10;
      s.reasons.push("close below EMA21");
    }
  }

  // Directional tilt, same reading as the trend family uses.
  const lastRSI = rsi[last];
  if (lastRSI !== undefined) {
    if (dir > 0 && lastRSI > 50) s.bull += 5;
    else if (dir < 0 && lastRSI < 50) s.bear += 5;
  }

  return s;
}

/**
 * Momentum evidence only: sustained velocity, ranked against the instrument's
 * own recent speed.
 *
 * WHY THIS FAMILY EXISTS
 * Time-series momentum is the oldest documented anomaly and this system never
 * scored it: trend infers direction from EMA structure regardless of how fast
 * price is moving, so a crawl of 0.01%/bar stacks the EMAs exactly like a
 * 2%/bar run does. Here the size of the move decides whether there is a trade
 * at all — below the 60th percentile of recent |ROC| the family stays flat,
 * because slow drift is the trend family's job, not a diluted copy of it.
 */
export function scoreMomentum(
  ind: IndicatorSeries,
  last: number,
  config: StrategyConfig,
): FamilyScore {
  const { closes, rsi, histogram, ema50 } = ind;
  const s: FamilyScore = {
    bull: 0,
    bear: 0,
    extremeBull: 0,
    extremeBear: 0,
    reasons: [],
  };

  const lookback = Math.max(2, Math.floor(config.momentumLookback));
  if (last < lookback + 1) return s;

  const roc = closes[last] - closes[last - lookback];
  if (roc === 0) return s;
  const dir = roc > 0 ? 1 : -1;

  // Velocity conviction: rank |ROC| among the recent distribution of |ROC|s
  // over the same lookback (sampled every other bar). Below the 60th
  // percentile there is no trade — momentum without velocity is not this
  // family's signal.
  const mags: number[] = [];
  const sampleStart = Math.max(lookback + 1, last - 199);
  for (let k = sampleStart; k <= last; k += 2) {
    mags.push(Math.abs(closes[k] - closes[k - lookback]));
  }
  if (mags.length < 25) return s;
  mags.sort((a, b) => a - b);
  const p60 = mags[Math.floor(mags.length * 0.6)];
  const p80 = mags[Math.floor(mags.length * 0.8)];
  const mag = Math.abs(roc);
  if (mag >= p80) {
    if (dir > 0) {
      s.bull += 25;
      s.extremeBull++;
    } else {
      s.bear += 25;
      s.extremeBear++;
    }
    s.reasons.push(`ROC top-20% velocity (${lookback}-bar)`);
  } else if (mag >= p60) {
    if (dir > 0) s.bull += 18;
    else s.bear += 18;
    s.reasons.push(`ROC elevated velocity (${lookback}-bar)`);
  } else {
    return s; // ordinary pace — nothing to trade
  }

  // Persistence: three consecutive closes stepping in the move's direction.
  if (
    closes[last - 2] !== undefined &&
    ((dir > 0 &&
      closes[last] > closes[last - 1] &&
      closes[last - 1] > closes[last - 2]) ||
      (dir < 0 &&
        closes[last] < closes[last - 1] &&
        closes[last - 1] < closes[last - 2]))
  ) {
    if (dir > 0) s.bull += 15;
    else s.bear += 15;
    s.reasons.push("3-bar persistence");
  }

  // MACD agrees with the move's direction.
  const h = histogram[last];
  if (h !== undefined) {
    if (dir > 0 && h > 0) s.bull += 15;
    else if (dir < 0 && h < 0) s.bear += 15;
    s.reasons.push("MACD agrees");
  }

  // Structural side of EMA50.
  if (ema50[last] !== undefined) {
    if (dir > 0 && closes[last] > ema50[last]) s.bull += 10;
    else if (dir < 0 && closes[last] < ema50[last]) s.bear += 10;
  }

  // RSI conviction: past midline in the move's direction, not at an extreme —
  // an extreme belongs to the reversion family.
  const lastRSI = rsi[last];
  if (lastRSI !== undefined) {
    if (dir > 0 && lastRSI >= 55) s.bull += 10;
    else if (dir < 0 && lastRSI <= 45) s.bear += 10;
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
  if (last < familyWarmup(family, config) || last >= candles.length)
    return null;

  const r = (n: number) => roundTo(n, pricePrecision);
  const price = ind.closes[last];
  const currentATR = ind.atr[last] ?? price * 0.002;

  const raw =
    family === "trend"
      ? scoreTrend(ind, last, config)
      : family === "reversion"
        ? scoreReversion(ind, last, config)
        : family === "breakout"
          ? scoreBreakout(candles, ind, last, config)
          : scoreMomentum(ind, last, config);
  const maxPoints = maxPointsFor(family);

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
  if (candles.length < familyWarmup(family, config) + 1) return null;
  return analyzeFamilyAt(
    candles,
    precomputeIndicators(candles, config),
    candles.length - 1,
    family,
    config,
    pricePrecision,
  );
}
