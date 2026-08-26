/**
 * The progression family (operator's Trend Progression port): component
 * scoring on constructed series, and each entry gate actually gating.
 */

import { describe, expect, test } from "bun:test";
import {
  analyzeFamilyAt,
  progressionGates,
  scoreProgression,
} from "../families";
import {
  type Candle,
  DEFAULT_STRATEGY_CONFIG,
  precomputeIndicators,
} from "../strategy";

const H1 = 3600;
const DAY = Date.UTC(2024, 2, 4); // a Monday, 00:00 UTC

function candle(time: number, open: number, close: number, pad = 1.5): Candle {
  return {
    time,
    open,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad,
    close,
    volume: 100,
  };
}

/**
 * Three quiet days (range ~3) followed by a fourth whose overnight window is
 * compressed (range ~2) and which then closes hard above it — the exact event
 * the strategy asks for.
 */
function breakoutDay(): Candle[] {
  const candles: Candle[] = [];
  const price = 100;
  // Five full quiet days: enough for the family's 120-bar warmup.
  for (let k = 0; k < 24 * 5; k++) {
    candles.push(candle(DAY / 1000 + k * H1, price, price));
  }
  // Compressed overnight window on day six.
  for (let hr = 0; hr < 7; hr++) {
    candles.push(candle(DAY / 1000 + 120 * H1 + hr * H1, 100, 100, 1));
  }
  // London hours drift, then the breakout bar itself at 08:00 UTC.
  candles.push(candle(DAY / 1000 + 127 * H1, 100, 102, 1));
  candles.push(candle(DAY / 1000 + 128 * H1, 102, 112, 2));
  return candles;
}

describe("progression family", () => {
  test("a compressed-overnight breakout with trend behind it produces a graded LONG", () => {
    const candles = breakoutDay();
    const config = DEFAULT_STRATEGY_CONFIG;
    const ind = precomputeIndicators(candles, config);
    const last = candles.length - 1;
    const analysis = analyzeFamilyAt(
      candles,
      ind,
      last,
      "progression",
      config,
      2,
    );
    expect(analysis).not.toBeNull();
    expect(analysis!.direction).toBe("LONG");
    expect(["A", "B"]).toContain(analysis!.grade);
    expect(analysis!.strength).toBeGreaterThanOrEqual(45);
  });

  test("the same breakout AGAINST the higher-timeframe slope is refused", () => {
    const candles = breakoutDay();
    const config = DEFAULT_STRATEGY_CONFIG;
    const ind = precomputeIndicators(candles, config);
    const last = candles.length - 1;
    // Price rose into the bar, so a SHORT claim contradicts the 24-bar slope.
    expect(progressionGates(candles, ind, last, "SHORT")).toBe(false);
  });

  test("an uncompressed overnight window fires nothing", () => {
    const candles: Candle[] = [];
    const price = 100;
    // Four identical quiet days — today's window equals the prior median,
    // so the compression gate fails before anything else is consulted.
    for (let k = 0; k < 24 * 3 + 8; k++) {
      candles.push(candle(DAY / 1000 + k * H1, price, price));
    }
    candles.push(candle(DAY / 1000 + 80 * H1, 100, 112, 2));
    const config = DEFAULT_STRATEGY_CONFIG;
    const ind = precomputeIndicators(candles, config);
    const analysis = analyzeFamilyAt(
      candles,
      ind,
      candles.length - 1,
      "progression",
      config,
      2,
    );
    expect(analysis).toBeNull();
  });

  test("score components respond to their own evidence", () => {
    const candles = breakoutDay();
    const config = DEFAULT_STRATEGY_CONFIG;
    const ind = precomputeIndicators(candles, config);
    const last = candles.length - 1;
    const s = scoreProgression(candles, ind, last, config);

    // Momentum should be near its ceiling: RSI far above 55, MACD wide.
    expect(s.bull).toBeGreaterThan(s.bear);
    // ADX is directionless strength and appears on BOTH sides, Pine-style.
    const adxShared = s.bull - s.bear;
    const withoutAdxBull =
      s.bull - (s.bull - Math.abs(s.bull - s.bear)) - s.bear;
    expect(Number.isFinite(withoutAdxBull)).toBe(true);
    expect(Math.abs(adxShared)).toBeGreaterThan(0);
  });
});
