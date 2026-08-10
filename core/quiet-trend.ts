/**
 * Quiet-trend strategy: trend continuation filtered by low volatility.
 *
 * The hypothesis scanner found this survives Šidák correction on 33k H1 bars
 * (p=0.0022, 5/6 walk-forward windows). Backtest with 1.5×ATR stop / 2.5R TP
 * produced +0.92 pts/trade expectancy over 2,277 trades, 5.5 years.
 *
 * TREND READ  — EMA(50) relative to price, with a 0.05% buffer to avoid
 * whipsaws in tight consolidations (your approach from the sketch above).
 *
 * VOLATILITY FILTER — 14-bar mean absolute move vs. the median of the last
 * 100 bars sampled every 5. Only fires when vol ≤ median.
 *
 * HTF REGIME FILTER — before a 5m signal is generated, the caller checks the
 * H1 structural direction via `htfRegime`. If the H1 disagrees, the signal is
 * vetoed. This is the hard veto you described: LONG in a 1H BEARISH regime is
 * blocked; SHORT in a 1H BULLISH regime is blocked. Aligned or NEUTRAL → pass.
 */

import type { AnalysisResult, Candle, Direction } from "./strategy";
import { calcATR, calcEMA, roundTo } from "./strategy";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface QuietTrendConfig {
  /** EMA period for the trend read (on H1; also used for HTF regime). */
  emaPeriod: number;
  /**
   * Price buffer around the EMA as a fraction of price (e.g. 0.0005 = 0.05%).
   * Prevents whipsaws when price is hugging the EMA.
   */
  emaBuffer: number;
  /** Mean absolute move lookback for instantaneous volatility. */
  volPeriod: number;
  /** Percentile cutoff: only enter when vol is ≤ this percentile. */
  volPercentile: number;
  /** Number of bars sampled when computing the percentile. */
  volWindow: number;
  /** ATR period for stop placement. */
  atrPeriod: number;
  /** ATR multiple for the stop loss. */
  atrSlMultiple: number;
  /** R-multiple for the final take-profit (TP2). */
  tpR: number;
  /** R-multiple for TP1 (partial profit). */
  tp1R: number;
}

export const DEFAULT_QUIET_TREND_CONFIG: QuietTrendConfig = {
  emaPeriod: 50,
  emaBuffer: 0.0005, // 0.05% — matches your sketch
  volPeriod: 14,
  volPercentile: 50,
  volWindow: 100,
  atrPeriod: 14,
  atrSlMultiple: 1.5,
  tpR: 2.5,
  tp1R: 1.2,
};

// ─── HTF regime filter ───────────────────────────────────────────────────────

/**
 * Structural direction of the H1 candles via EMA(50) + buffer zone.
 *
 * Returns null ("NEUTRAL") when price is inside the buffer — no opinion
 * strong enough to veto. The engine treats null as "don't filter".
 *
 * LONG  → price > EMA + buffer  (1H structurally bullish → only take LONG on 5m)
 * SHORT → price < EMA − buffer  (1H structurally bearish → only take SHORT on 5m)
 * null  → inside buffer, no veto
 */
export function htfRegime(
  h1Candles: Candle[],
  cfg: Pick<QuietTrendConfig, "emaPeriod" | "emaBuffer"> = DEFAULT_QUIET_TREND_CONFIG,
): Direction | null {
  if (h1Candles.length < cfg.emaPeriod + 1) return null;

  const closes = h1Candles.map(c => c.close);
  const ema = calcEMA(closes, cfg.emaPeriod);
  const currentEma = ema.at(-1);
  if (currentEma === undefined) return null;

  const price = closes.at(-1)!;
  const buffer = price * cfg.emaBuffer;

  if (price > currentEma + buffer) return "LONG";
  if (price < currentEma - buffer) return "SHORT";
  return null; // inside buffer — NEUTRAL, no veto
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function meanAbsMove(candles: Candle[], i: number, n: number): number {
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    sum += Math.abs(candles[k].close - candles[k - 1].close);
  }
  return sum / n;
}

function isQuiet(
  candles: Candle[],
  i: number,
  cfg: QuietTrendConfig,
): boolean {
  if (i < cfg.volPeriod + 1) return false;
  const vol = meanAbsMove(candles, i, cfg.volPeriod);

  const samples: number[] = [];
  const start = Math.max(cfg.volPeriod + 1, i - cfg.volWindow + 1);
  for (let k = start; k <= i; k += 5) {
    samples.push(meanAbsMove(candles, k, cfg.volPeriod));
  }
  samples.sort((a, b) => a - b);
  const cut = samples[Math.floor((samples.length * cfg.volPercentile) / 100)];
  return vol <= cut;
}

// ─── Signal analysis ─────────────────────────────────────────────────────────

/**
 * Analyse the most-recent bar of `candles` for a quiet-trend entry.
 *
 * Returns an AnalysisResult (same shape as `analyzeCandles`) if a valid setup
 * exists, null otherwise. The caller must separately check `htfRegime` and
 * veto the signal when the H1 direction disagrees.
 */
export function analyzeQuietTrend(
  candles: Candle[],
  pricePrecision: number,
  cfg: QuietTrendConfig = DEFAULT_QUIET_TREND_CONFIG,
): AnalysisResult | null {
  const warmup = Math.max(cfg.emaPeriod, cfg.volPeriod + 1, cfg.atrPeriod + 1, 120);
  if (candles.length < warmup + 1) return null;

  const i = candles.length - 1;

  // Volatility filter first — cheapest check
  if (!isQuiet(candles, i, cfg)) return null;

  // EMA trend direction with buffer
  const closes = candles.map(c => c.close);
  const ema = calcEMA(closes, cfg.emaPeriod);
  const currentEma = ema.at(-1);
  if (currentEma === undefined) return null;

  const price = closes[i];
  const buffer = price * cfg.emaBuffer;

  let dir: Direction;
  if (price > currentEma + buffer) {
    dir = "LONG";
  } else if (price < currentEma - buffer) {
    dir = "SHORT";
  } else {
    return null; // inside buffer — no trade
  }

  const r = (n: number) => roundTo(n, pricePrecision);
  const atrSeries = calcATR(candles, cfg.atrPeriod);
  const currentAtr = atrSeries.at(-1) ?? 0;
  if (currentAtr <= 0) return null;

  const entry = r(price);
  const slDist = cfg.atrSlMultiple * currentAtr;
  const stopLoss = r(dir === "LONG" ? entry - slDist : entry + slDist);
  const tp1 = r(dir === "LONG" ? entry + cfg.tp1R * slDist : entry - cfg.tp1R * slDist);
  const tp2 = r(dir === "LONG" ? entry + cfg.tpR * slDist : entry - cfg.tpR * slDist);

  const emaDist = Math.abs(price - currentEma);
  const biasStrength = Math.min(100, (emaDist / currentAtr) * 50);

  return {
    bias: dir === "LONG" ? "BULLISH" : "BEARISH",
    biasStrength,
    confidence: 72,
    direction: dir,
    entryPrice: entry,
    stopLoss,
    tp1,
    tp2,
    reason:
      `Quiet trend ${dir}: price ${dir === "LONG" ? ">" : "<"} EMA(${cfg.emaPeriod}) ` +
      `+ buffer, vol ≤ p${cfg.volPercentile}`,
    grade: "B",
    indicators: {
      ema50: r(currentEma),
      atr: r(currentAtr),
    },
    atr: currentAtr,
  };
}
