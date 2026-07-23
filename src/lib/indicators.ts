// Technical indicator calculations for scalping

// ────────────────────────────
// Session helpers
// ────────────────────────────
export type SessionName = "ASIAN" | "LONDON" | "NEW_YORK" | "OFF_HOURS";

export interface SessionInfo {
  name: SessionName;
  label: string;
  isKillZone: boolean;
  /** Kill-zone description (empty outside kill zones) */
  kzLabel: string;
  /** 0-1 progress through current session */
  progress: number;
  /** UTC hour */
  utcHour: number;
}

/** Detect which session a UTC timestamp falls into + whether it's a kill zone */
export function getSession(timestampMs: number): SessionInfo {
  const d = new Date(timestampMs);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const hm = h + m / 60;

  // Asian: 00:00–08:00 UTC
  if (hm >= 0 && hm < 8) {
    return {
      name: "ASIAN",
      label: "Asian",
      isKillZone: false,
      kzLabel: "",
      progress: hm / 8,
      utcHour: h,
    };
  }
  // London: 08:00–13:30 UTC  |  Kill zone 08:00–09:30
  if (hm >= 8 && hm < 13.5) {
    const isKZ = hm >= 8 && hm < 9.5;
    return {
      name: "LONDON",
      label: "London",
      isKillZone: isKZ,
      kzLabel: isKZ ? "London Open KZ" : "",
      progress: (hm - 8) / 5.5,
      utcHour: h,
    };
  }
  // NY: 13:30–21:00 UTC  |  Kill zone 13:30–15:00
  if (hm >= 13.5 && hm < 21) {
    const isKZ = hm >= 13.5 && hm < 15;
    return {
      name: "NEW_YORK",
      label: "New York",
      isKillZone: isKZ,
      kzLabel: isKZ ? "NY Open KZ" : "",
      progress: (hm - 13.5) / 7.5,
      utcHour: h,
    };
  }
  // Off-hours 21:00–00:00
  return {
    name: "OFF_HOURS",
    label: "Off-Hours",
    isKillZone: false,
    kzLabel: "",
    progress: (hm - 21) / 3,
    utcHour: h,
  };
}

// ────────────────────────────
// Core types
// ────────────────────────────
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Exponential Moving Average
export function calcEMA(data: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);

  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period && i < data.length; i++) {
    sum += data[i];
  }
  ema[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    ema[i] = (data[i] - ema[i - 1]) * multiplier + ema[i - 1];
  }

  return ema;
}

// Simple Moving Average
export function calcSMA(data: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j];
    }
    sma[i] = sum / period;
  }
  return sma;
}

// RSI (Relative Strength Index)
export function calcRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = diff > 0 ? diff : 0;
    losses[i] = diff < 0 ? -diff : 0;
  }

  // First average
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i] || 0;
    avgLoss += losses[i] || 0;
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + (gains[i] || 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (losses[i] || 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

// MACD
export function calcMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fastEma = calcEMA(closes, fastPeriod);
  const slowEma = calcEMA(closes, slowPeriod);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEma[i] !== undefined && slowEma[i] !== undefined) {
      macdLine[i] = fastEma[i] - slowEma[i];
    }
  }

  // Signal line is EMA of MACD
  const macdValues = macdLine.filter(v => v !== undefined);
  const signalEma = calcEMA(macdValues, signalPeriod);

  const signal: number[] = [];
  const histogram: number[] = [];
  let macdIdx = 0;

  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== undefined) {
      if (signalEma[macdIdx] !== undefined) {
        signal[i] = signalEma[macdIdx];
        histogram[i] = macdLine[i] - signalEma[macdIdx];
      }
      macdIdx++;
    }
  }

  return { macd: macdLine, signal, histogram };
}

// Bollinger Bands
export function calcBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2,
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = calcSMA(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = period - 1; i < closes.length; i++) {
    let sumSquares = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSquares += (closes[j] - middle[i]) ** 2;
    }
    const stdDev = Math.sqrt(sumSquares / period);
    upper[i] = middle[i] + stdDevMultiplier * stdDev;
    lower[i] = middle[i] - stdDevMultiplier * stdDev;
  }

  return { upper, middle, lower };
}

// ATR (Average True Range)
export function calcATR(candles: Candle[], period = 14): number[] {
  if (candles.length === 0) return [];
  const tr: number[] = [];
  tr[0] = candles[0].high - candles[0].low;

  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  const atr: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += tr[i];
  }
  atr[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  return atr;
}

// VWAP (Volume Weighted Average Price) - session based
export function calcVWAP(candles: Candle[]): number[] {
  const vwap: number[] = [];
  let cumVol = 0;
  let cumTP = 0;

  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumVol += candles[i].volume;
    cumTP += tp * candles[i].volume;
    vwap[i] = cumVol > 0 ? cumTP / cumVol : tp;
  }

  return vwap;
}

// Stochastic Oscillator
export function calcStochastic(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3,
): { k: number[]; d: number[] } {
  if (candles.length < kPeriod) return { k: [], d: [] };
  const k: number[] = [];

  for (let i = kPeriod - 1; i < candles.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }
    const range = highest - lowest;
    k[i] = range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100;
  }

  const d = calcSMA(
    k.filter(v => v !== undefined),
    dPeriod,
  );

  return { k, d };
}

// ────────────────────────────
// Support / Resistance via swing highs & lows
// ────────────────────────────
export function findSwingLevels(
  candles: Candle[],
  lookback = 5,
): { supports: number[]; resistances: number[] } {
  const supports: number[] = [];
  const resistances: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (
        candles[i].high <= candles[i - j].high ||
        candles[i].high <= candles[i + j].high
      ) {
        isSwingHigh = false;
      }
      if (
        candles[i].low >= candles[i - j].low ||
        candles[i].low >= candles[i + j].low
      ) {
        isSwingLow = false;
      }
    }
    if (isSwingHigh) resistances.push(candles[i].high);
    if (isSwingLow) supports.push(candles[i].low);
  }

  return { supports, resistances };
}

// Cluster nearby levels (within tolerance %) and return the strongest
export function clusterLevels(
  levels: number[],
  tolerancePct = 0.0015,
): number[] {
  if (levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters: { sum: number; count: number }[] = [];

  let cluster = { sum: sorted[0], count: 1 };
  for (let i = 1; i < sorted.length; i++) {
    const avg = cluster.sum / cluster.count;
    if ((sorted[i] - avg) / avg < tolerancePct) {
      cluster.sum += sorted[i];
      cluster.count++;
    } else {
      clusters.push(cluster);
      cluster = { sum: sorted[i], count: 1 };
    }
  }
  clusters.push(cluster);

  // Sort by touch count (strongest first), return top 3
  return clusters
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(c => Math.round((c.sum / c.count) * 100) / 100);
}

// Pivot Points (Classic)
export function calcPivotPoints(candles: Candle[]): {
  pivot: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
} {
  // Use the last completed period (second to last candle's session)
  const len = candles.length;
  const high = Math.max(
    ...candles.slice(Math.max(0, len - 50)).map(c => c.high),
  );
  const low = Math.min(...candles.slice(Math.max(0, len - 50)).map(c => c.low));
  const close = candles[len - 1].close;

  const pivot = (high + low + close) / 3;
  return {
    pivot: r2(pivot),
    r1: r2(2 * pivot - low),
    r2: r2(pivot + (high - low)),
    r3: r2(high + 2 * (pivot - low)),
    s1: r2(2 * pivot - high),
    s2: r2(pivot - (high - low)),
    s3: r2(low - 2 * (high - pivot)),
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ────────────────────────────
// Full Scalp Analysis
// ────────────────────────────
export interface ScalpEntry {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  riskReward: number;
  confidence: number; // 0-100
  reason: string;
}

export interface ScalpAnalysis {
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  biasStrength: number; // 0-100
  biasReasons: string[];
  entries: ScalpEntry[];
  keySupports: number[];
  keyResistances: number[];
  pivotPoints: ReturnType<typeof calcPivotPoints>;
  indicators: {
    rsi: number | undefined;
    stochK: number | undefined;
    macdHistogram: number | undefined;
    ema9: number | undefined;
    ema21: number | undefined;
    ema50: number | undefined;
    atr: number | undefined;
    bbUpper: number | undefined;
    bbLower: number | undefined;
    bbMiddle: number | undefined;
  };
}

export function analyzeForScalping(candles: Candle[]): ScalpAnalysis | null {
  if (candles.length < 50) return null;

  const closes = candles.map(c => c.close);
  const last = candles.length - 1;
  const price = closes[last];

  // Calculate all indicators
  const rsi = calcRSI(closes, 14);
  const { histogram } = calcMACD(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const bb = calcBollingerBands(closes, 20);
  const stoch = calcStochastic(candles);
  const atr = calcATR(candles, 14);
  const pivots = calcPivotPoints(candles);

  // Support / Resistance
  const { supports, resistances } = findSwingLevels(candles, 4);
  const keySupports = clusterLevels(supports);
  const keyResistances = clusterLevels(resistances);

  const currentATR = atr[last] ?? price * 0.002;

  // ─── Bias calculation ───
  const biasReasons: string[] = [];
  let bullScore = 0;
  let bearScore = 0;

  // EMA alignment
  if (
    ema9[last] !== undefined &&
    ema21[last] !== undefined &&
    ema50[last] !== undefined
  ) {
    if (ema9[last] > ema21[last] && ema21[last] > ema50[last]) {
      bullScore += 25;
      biasReasons.push("EMAs aligned bullish (9 > 21 > 50)");
    } else if (ema9[last] < ema21[last] && ema21[last] < ema50[last]) {
      bearScore += 25;
      biasReasons.push("EMAs aligned bearish (9 < 21 < 50)");
    } else if (ema9[last] > ema21[last]) {
      bullScore += 10;
      biasReasons.push("EMA 9 above EMA 21 (short-term bullish)");
    } else {
      bearScore += 10;
      biasReasons.push("EMA 9 below EMA 21 (short-term bearish)");
    }
  }

  // Price vs EMAs
  if (ema21[last] !== undefined) {
    if (price > ema21[last]) {
      bullScore += 10;
      biasReasons.push("Price above EMA 21");
    } else {
      bearScore += 10;
      biasReasons.push("Price below EMA 21");
    }
  }

  // RSI
  const lastRSI = rsi[last];
  if (lastRSI !== undefined) {
    if (lastRSI < 30) {
      bullScore += 20;
      biasReasons.push(`RSI oversold (${lastRSI.toFixed(1)})`);
    } else if (lastRSI > 70) {
      bearScore += 20;
      biasReasons.push(`RSI overbought (${lastRSI.toFixed(1)})`);
    } else if (lastRSI > 50) {
      bullScore += 5;
    } else {
      bearScore += 5;
    }
  }

  // MACD
  if (histogram[last] !== undefined) {
    if (
      histogram[last] > 0 &&
      histogram[last - 1] !== undefined &&
      histogram[last - 1] <= 0
    ) {
      bullScore += 20;
      biasReasons.push("MACD bullish crossover");
    } else if (
      histogram[last] < 0 &&
      histogram[last - 1] !== undefined &&
      histogram[last - 1] >= 0
    ) {
      bearScore += 20;
      biasReasons.push("MACD bearish crossover");
    } else if (histogram[last] > 0) {
      bullScore += 8;
      biasReasons.push("MACD histogram positive");
    } else {
      bearScore += 8;
      biasReasons.push("MACD histogram negative");
    }
  }

  // Bollinger Bands
  if (bb.lower[last] !== undefined && bb.upper[last] !== undefined) {
    if (price <= bb.lower[last]) {
      bullScore += 15;
      biasReasons.push("Price at lower BB (potential bounce)");
    } else if (price >= bb.upper[last]) {
      bearScore += 15;
      biasReasons.push("Price at upper BB (potential rejection)");
    }
  }

  // Stochastic
  const lastK = stoch.k[last];
  if (lastK !== undefined) {
    if (lastK < 20) {
      bullScore += 12;
      biasReasons.push(`Stochastic oversold (${lastK.toFixed(0)})`);
    } else if (lastK > 80) {
      bearScore += 12;
      biasReasons.push(`Stochastic overbought (${lastK.toFixed(0)})`);
    }
  }

  const total = bullScore + bearScore;
  const biasStrength =
    total === 0
      ? 0
      : Math.round((Math.abs(bullScore - bearScore) / total) * 100);
  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    biasStrength < 15
      ? "NEUTRAL"
      : bullScore > bearScore
        ? "BULLISH"
        : "BEARISH";

  // ─── Generate entry ideas ───
  const entries: ScalpEntry[] = [];

  // Long entry: EMA bounce + RSI support
  if (bias === "BULLISH" || bias === "NEUTRAL") {
    const nearestSupport =
      keySupports.find(s => s < price && (price - s) / price < 0.005) ??
      ema21[last] ??
      price - currentATR;
    const sl = r2(nearestSupport - currentATR * 0.5);
    const risk = price - sl;
    if (risk > 0) {
      entries.push({
        direction: "LONG",
        entryPrice: r2(price),
        stopLoss: sl,
        tp1: r2(price + risk * 1.5),
        tp2: r2(price + risk * 2.5),
        riskReward: Math.round(((risk * 2) / risk) * 10) / 10,
        confidence: Math.min(90, Math.round(bullScore * 1.2)),
        reason: buildEntryReason(
          "LONG",
          lastRSI,
          ema9[last],
          ema21[last],
          bb,
          last,
          price,
        ),
      });
    }
  }

  // Short entry: rejection + RSI resistance
  if (bias === "BEARISH" || bias === "NEUTRAL") {
    const nearestResistance =
      keyResistances.find(r => r > price && (r - price) / price < 0.005) ??
      ema21[last] ??
      price + currentATR;
    const sl = r2(nearestResistance + currentATR * 0.5);
    const risk = sl - price;
    if (risk > 0) {
      entries.push({
        direction: "SHORT",
        entryPrice: r2(price),
        stopLoss: sl,
        tp1: r2(price - risk * 1.5),
        tp2: r2(price - risk * 2.5),
        riskReward: Math.round(((risk * 2) / risk) * 10) / 10,
        confidence: Math.min(90, Math.round(bearScore * 1.2)),
        reason: buildEntryReason(
          "SHORT",
          lastRSI,
          ema9[last],
          ema21[last],
          bb,
          last,
          price,
        ),
      });
    }
  }

  // Sort entries: show the one matching bias first
  entries.sort((a, b) => b.confidence - a.confidence);

  return {
    bias,
    biasStrength,
    biasReasons,
    entries,
    keySupports,
    keyResistances,
    pivotPoints: pivots,
    indicators: {
      rsi: rsi[last],
      stochK: stoch.k[last],
      macdHistogram: histogram[last],
      ema9: ema9[last],
      ema21: ema21[last],
      ema50: ema50[last],
      atr: atr[last],
      bbUpper: bb.upper[last],
      bbLower: bb.lower[last],
      bbMiddle: bb.middle[last],
    },
  };
}

function buildEntryReason(
  dir: "LONG" | "SHORT",
  rsi: number | undefined,
  ema9: number | undefined,
  ema21: number | undefined,
  bb: { upper: number[]; lower: number[]; middle: number[] },
  last: number,
  price: number,
): string {
  const parts: string[] = [];
  if (dir === "LONG") {
    if (ema9 !== undefined && ema21 !== undefined && ema9 > ema21)
      parts.push("EMA 9/21 bullish");
    if (rsi !== undefined && rsi < 40)
      parts.push(`RSI low (${rsi.toFixed(0)})`);
    if (bb.lower[last] !== undefined && price < bb.middle[last])
      parts.push("Below BB midline");
  } else {
    if (ema9 !== undefined && ema21 !== undefined && ema9 < ema21)
      parts.push("EMA 9/21 bearish");
    if (rsi !== undefined && rsi > 60)
      parts.push(`RSI high (${rsi.toFixed(0)})`);
    if (bb.upper[last] !== undefined && price > bb.middle[last])
      parts.push("Above BB midline");
  }
  return parts.length > 0
    ? parts.join(" · ")
    : dir === "LONG"
      ? "Bullish momentum"
      : "Bearish momentum";
}

// Generate scalping signals based on indicators
export interface ScalpSignal {
  type: "BUY" | "SELL" | "NEUTRAL";
  strength: number; // 0-100
  reasons: string[];
}

export function generateSignal(candles: Candle[]): ScalpSignal {
  if (candles.length < 50) {
    return { type: "NEUTRAL", strength: 0, reasons: ["Insufficient data"] };
  }

  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes, 14);
  const { histogram } = calcMACD(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const bb = calcBollingerBands(closes, 20);
  const stoch = calcStochastic(candles);

  const last = candles.length - 1;
  const reasons: string[] = [];
  let bullScore = 0;
  let bearScore = 0;

  // RSI
  const lastRSI = rsi[last];
  if (lastRSI !== undefined) {
    if (lastRSI < 30) {
      bullScore += 20;
      reasons.push(`RSI oversold (${lastRSI.toFixed(1)})`);
    } else if (lastRSI > 70) {
      bearScore += 20;
      reasons.push(`RSI overbought (${lastRSI.toFixed(1)})`);
    } else if (lastRSI < 45) {
      bullScore += 5;
    } else if (lastRSI > 55) {
      bearScore += 5;
    }
  }

  // MACD
  if (histogram[last] !== undefined && histogram[last - 1] !== undefined) {
    if (histogram[last] > 0 && histogram[last - 1] <= 0) {
      bullScore += 25;
      reasons.push("MACD bullish crossover");
    } else if (histogram[last] < 0 && histogram[last - 1] >= 0) {
      bearScore += 25;
      reasons.push("MACD bearish crossover");
    } else if (histogram[last] > histogram[last - 1]) {
      bullScore += 10;
      reasons.push("MACD momentum rising");
    } else {
      bearScore += 10;
      reasons.push("MACD momentum falling");
    }
  }

  // EMA crossover
  if (ema9[last] !== undefined && ema21[last] !== undefined) {
    if (ema9[last] > ema21[last] && ema9[last - 1] <= ema21[last - 1]) {
      bullScore += 25;
      reasons.push("EMA 9/21 bullish cross");
    } else if (ema9[last] < ema21[last] && ema9[last - 1] >= ema21[last - 1]) {
      bearScore += 25;
      reasons.push("EMA 9/21 bearish cross");
    } else if (ema9[last] > ema21[last]) {
      bullScore += 10;
      reasons.push("Price above EMA 21");
    } else {
      bearScore += 10;
      reasons.push("Price below EMA 21");
    }
  }

  // Bollinger Bands
  if (bb.lower[last] !== undefined && bb.upper[last] !== undefined) {
    if (closes[last] <= bb.lower[last]) {
      bullScore += 20;
      reasons.push("Price at lower Bollinger Band");
    } else if (closes[last] >= bb.upper[last]) {
      bearScore += 20;
      reasons.push("Price at upper Bollinger Band");
    }
  }

  // Stochastic
  const lastK = stoch.k[last];
  if (lastK !== undefined) {
    if (lastK < 20) {
      bullScore += 15;
      reasons.push(`Stoch oversold (${lastK.toFixed(1)})`);
    } else if (lastK > 80) {
      bearScore += 15;
      reasons.push(`Stoch overbought (${lastK.toFixed(1)})`);
    }
  }

  const totalScore = bullScore + bearScore;
  if (totalScore === 0)
    return { type: "NEUTRAL", strength: 0, reasons: ["No clear signal"] };

  if (bullScore > bearScore) {
    return {
      type: "BUY",
      strength: Math.min(100, Math.round((bullScore / totalScore) * 100)),
      reasons,
    };
  }
  if (bearScore > bullScore) {
    return {
      type: "SELL",
      strength: Math.min(100, Math.round((bearScore / totalScore) * 100)),
      reasons,
    };
  }

  return { type: "NEUTRAL", strength: 50, reasons };
}
