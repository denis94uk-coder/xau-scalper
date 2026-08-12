import type { Db } from "../db";
import type { Fetcher } from "../market";

const KEY = "marketRegime";

// ═══════════════════════════════════════════════════
// MARKET REGIME DETECTION ENGINE
// Classifies market as: TRENDING_UP, TRENDING_DOWN, RANGING, VOLATILE
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

async function fetchCandles(
  doFetch: Fetcher,
  tf: string,
  limit: number,
): Promise<Candle[]> {
  const r = await doFetch(
    `${BINANCE_BASE}/klines?symbol=${SYMBOL}&interval=${tf}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`Binance klines: ${r.status}`);
  const data = (await r.json()) as any;
  return data.map((k: any) => ({
    time: k[0] / 1000,
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

function emaCalc(data: number[], period: number): number[] {
  const result: number[] = [];
  const mult = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, data.length); i++) sum += data[i];
  result[Math.min(period, data.length) - 1] =
    sum / Math.min(period, data.length);
  for (let i = period; i < data.length; i++) {
    result[i] =
      (data[i] - (result[i - 1] ?? data[i])) * mult +
      (result[i - 1] ?? data[i]);
  }
  return result;
}

function detectRegime(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const last = closes.length - 1;
  const price = closes[last];

  // ATR
  const atrPeriod = 14;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }
  const recentATR =
    trs.slice(-atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
  const longATR =
    trs.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, trs.length);
  const atrRatio = longATR > 0 ? recentATR / longATR : 1;

  // EMAs
  const ema20 = emaCalc(closes, 20);
  const ema50 = emaCalc(closes, 50);
  const ema200Vals = emaCalc(closes, Math.min(200, closes.length - 1));
  const priceVsEma50 = ema50[last]
    ? ((price - ema50[last]) / ema50[last]) * 100
    : 0;
  const priceVsEma200 = ema200Vals[last]
    ? ((price - ema200Vals[last]) / ema200Vals[last]) * 100
    : 0;

  // ADX proxy
  const lookback = Math.min(20, candles.length - 1);
  let plusDM = 0,
    minusDM = 0,
    trSum = 0;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    if (i <= 0) continue;
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM += upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM += downMove > upMove && downMove > 0 ? downMove : 0;
    trSum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
  }
  const diPlus = trSum > 0 ? (plusDM / trSum) * 100 : 0;
  const diMinus = trSum > 0 ? (minusDM / trSum) * 100 : 0;
  const diSum = diPlus + diMinus;
  const adxProxy = diSum > 0 ? (Math.abs(diPlus - diMinus) / diSum) * 100 : 0;

  // Trend strength
  const ema20Recent = ema20.slice(-10).filter(v => v !== undefined);
  const trendSlope =
    ema20Recent.length >= 2
      ? ((ema20Recent[ema20Recent.length - 1] - ema20Recent[0]) /
          ema20Recent[0]) *
        100
      : 0;
  const trendStrength = Math.max(-100, Math.min(100, trendSlope * 50));

  // BB width
  const bbPeriod = 20;
  const recentCloses = closes.slice(-bbPeriod);
  const sma = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
  const std = Math.sqrt(
    recentCloses.reduce((s, c) => s + (c - sma) ** 2, 0) / recentCloses.length,
  );
  const bbWidth = sma > 0 ? ((std * 4) / sma) * 100 : 0;

  // Range
  const recent20 = candles.slice(-20);
  const rangeHigh = Math.max(...recent20.map(c => c.high));
  const rangeLow = Math.min(...recent20.map(c => c.low));
  const rangeHighLow = price > 0 ? ((rangeHigh - rangeLow) / price) * 100 : 0;

  // CLASSIFY
  let regime: string;
  let confidence: number;
  let recommendedStrategy: string;
  let description: string;

  if (atrRatio > 1.5 && bbWidth > 2.5) {
    regime = "VOLATILE";
    confidence = Math.min(95, Math.round(50 + atrRatio * 20));
    recommendedStrategy =
      "Widen SL by 1.5×, reduce position size 50%, skip C-grade signals";
    description = `High volatility detected (ATR ${(atrRatio * 100 - 100).toFixed(0)}% above average). Market is erratic — wider stops, smaller size.`;
  } else if (adxProxy > 30 && Math.abs(trendStrength) > 20) {
    regime = trendStrength > 0 ? "TRENDING_UP" : "TRENDING_DOWN";
    confidence = Math.min(
      95,
      Math.round(40 + adxProxy + Math.abs(trendStrength) * 0.3),
    );
    const dir = regime === "TRENDING_UP" ? "bullish" : "bearish";
    recommendedStrategy = `Favor ${regime === "TRENDING_UP" ? "LONG" : "SHORT"} trades, use trailing stops, extend TP2 by 1.5×`;
    description = `Strong ${dir} trend (ADX ${adxProxy.toFixed(0)}, EMA slope ${trendStrength > 0 ? "+" : ""}${trendStrength.toFixed(1)}). Ride the momentum.`;
  } else if (adxProxy < 20 && bbWidth < 1.5 && rangeHighLow < 1.5) {
    regime = "RANGING";
    confidence = Math.min(90, Math.round(50 + (20 - adxProxy) * 2));
    recommendedStrategy =
      "Mean-reversion setups preferred, tighter TP, avoid breakout trades";
    description = `Low volatility range-bound (BB squeeze ${bbWidth.toFixed(1)}%, range ${rangeHighLow.toFixed(2)}%). Fade the extremes, tight TP.`;
  } else if (Math.abs(trendStrength) > 15 && adxProxy > 20) {
    regime = trendStrength > 0 ? "TRENDING_UP" : "TRENDING_DOWN";
    confidence = Math.min(
      80,
      Math.round(30 + adxProxy + Math.abs(trendStrength) * 0.2),
    );
    const dir = regime === "TRENDING_UP" ? "bullish" : "bearish";
    recommendedStrategy = `Mild ${dir} trend — standard settings with slight ${regime === "TRENDING_UP" ? "LONG" : "SHORT"} bias`;
    description = `Moderate ${dir} trend. Standard approach with directional bias.`;
  } else {
    regime = "RANGING";
    // ponytail: random seed removed so the same data reproduces the same
    // confidence — a diagnostics readout must be deterministic.
    confidence = 45;
    recommendedStrategy =
      "Mixed signals — use tight stops, wait for clearer setup";
    description = "No clear trend or volatility regime. Exercise patience.";
  }

  // Adaptive multipliers
  let slMult = 1,
    tpMult = 1,
    sizeMult = 1,
    minGrade = "B",
    favorDir = "BOTH";
  if (regime === "VOLATILE") {
    slMult = 1.5;
    tpMult = 1.3;
    sizeMult = 0.5;
    minGrade = "A";
  } else if (regime === "TRENDING_UP") {
    tpMult = 1.5;
    favorDir = "LONG";
  } else if (regime === "TRENDING_DOWN") {
    tpMult = 1.5;
    favorDir = "SHORT";
  } else if (regime === "RANGING") {
    slMult = 0.8;
    tpMult = 0.7;
    sizeMult = 0.8;
  }

  return {
    regime,
    confidence,
    atrRatio,
    adxProxy,
    trendStrength,
    priceVsEma50,
    priceVsEma200,
    bbWidth,
    rangeHighLow,
    recommendedStrategy,
    description,
    slMultiplier: slMult,
    tpMultiplier: tpMult,
    positionSizeMultiplier: sizeMult,
    minGrade,
    favorDirection: favorDir,
  };
}

export async function detectMarketRegime(
  db: Db,
  fetcher?: Fetcher,
): Promise<void> {
  const doFetch = fetcher ?? fetch;
  try {
    const candles = await fetchCandles(doFetch, "15m", 250);
    if (candles.length < 50) {
      console.log("[Regime] Not enough candles");
      return;
    }

    const r = detectRegime(candles);

    db.setSetting(KEY, {
      timestamp: Date.now(),
      regime: r.regime,
      confidence: r.confidence,
      atrRatio: r.atrRatio,
      adxProxy: r.adxProxy,
      trendStrength: r.trendStrength,
      priceVsEma50: r.priceVsEma50,
      priceVsEma200: r.priceVsEma200,
      bbWidth: r.bbWidth,
      rangeHighLow: r.rangeHighLow,
      recommendedStrategy: r.recommendedStrategy,
      description: r.description,
      slMultiplier: r.slMultiplier,
      tpMultiplier: r.tpMultiplier,
      positionSizeMultiplier: r.positionSizeMultiplier,
      minGrade: r.minGrade,
      favorDirection: r.favorDirection,
    });

    console.log(
      `[Regime] ${r.regime} (${r.confidence}%) | ATR: ${r.atrRatio.toFixed(2)} | ADX: ${r.adxProxy.toFixed(0)}`,
    );
  } catch (e: any) {
    console.error("[Regime] Error:", e.message);
  }
}
