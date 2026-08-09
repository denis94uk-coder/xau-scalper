/**
 * Market regime tagging — trend direction and volatility band.
 *
 * Ported from teo/backtest/regime.py. Pure arithmetic, no ML, no I/O.
 *
 * This is the *tagging* regime used to label outcomes so the self-heal loop can
 * ask "what worked in this kind of market before?". It is deliberately coarse
 * and separate from server/intel/regime.ts, which is the richer dashboard
 * indicator (ADX proxy, Bollinger width, recommended strategy text). Conflating
 * them would tie a memory key to a display concern — a change to what the
 * dashboard shows would silently invalidate every stored outcome.
 */

import type { Candle } from "./strategy";

export type Trend = "up" | "down" | "chop";
export type Volatility = "low" | "normal" | "high";

export interface Regime {
  trend: Trend;
  volatility: Volatility;
  /** Fast/slow EMA gap as a fraction of price. Signed. */
  trendStrength: number;
  /** ATR as a fraction of price. */
  atrPct: number;
  /** Stable key, e.g. "trend_up/high_vol". This is what memory is keyed on. */
  label: string;
}

export interface RegimeThresholds {
  /** EMA gap magnitude below which the market is called chop. */
  trendThreshold: number;
  volLow: number;
  volHigh: number;
}

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  trendThreshold: 0.004,
  volLow: 0.004,
  volHigh: 0.012,
};

/**
 * Full-series EMA collapsed to its final value.
 *
 * Seeded with the first observation rather than an SMA of the first `period`.
 * That differs from calcEMA in strategy.ts, and deliberately so: this is a
 * coarse regime label, and matching the Python original keeps previously
 * recorded outcomes comparable with newly recorded ones.
 */
function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) {
    out = values[i] * k + out * (1 - k);
  }
  return out;
}

/** ATR over the last `period` bars, as a fraction of the latest close. */
function atrPct(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    trs.push(
      Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      ),
    );
  }
  const window = trs.length >= period ? trs.slice(-period) : trs;
  if (window.length === 0) return 0;
  const atr = window.reduce((a, b) => a + b, 0) / window.length;
  const last = candles[candles.length - 1].close;
  return last ? atr / last : 0;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function labelFor(trend: Trend, volatility: Volatility): string {
  const base = trend === "chop" ? "chop" : `trend_${trend}`;
  return `${base}/${volatility}_vol`;
}

/**
 * Classify the trend and volatility of a window.
 *
 * Too short a window returns a neutral tag rather than guessing — a confident
 * label from four bars would poison the memory it feeds.
 */
export function detectRegime(
  candles: Candle[],
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS,
): Regime {
  if (candles.length < 5) {
    return {
      trend: "chop",
      volatility: "normal",
      trendStrength: 0,
      atrPct: 0,
      label: labelFor("chop", "normal"),
    };
  }

  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1] || 1;
  const strength = (ema(closes, 9) - ema(closes, 21)) / price;

  const trend: Trend =
    strength > thresholds.trendThreshold
      ? "up"
      : strength < -thresholds.trendThreshold
        ? "down"
        : "chop";

  const pct = atrPct(candles);
  const volatility: Volatility =
    pct < thresholds.volLow
      ? "low"
      : pct > thresholds.volHigh
        ? "high"
        : "normal";

  return {
    trend,
    volatility,
    trendStrength: round6(strength),
    atrPct: round6(pct),
    label: labelFor(trend, volatility),
  };
}
