/**
 * Regression tests for the shared strategy core.
 *
 * The fixture in analyzeCandles.fixture.json was captured from the ORIGINAL
 * (pre-refactor) signalEngine.ts implementation. These tests prove the
 * extracted, parameterised strategy produces byte-for-byte identical output
 * for gold (pricePrecision 2, DEFAULT_STRATEGY_CONFIG) so live behaviour is
 * unchanged.
 *
 * Run with: bun run test:unit
 */
import { describe, expect, test } from "bun:test";
import {
  analyzeAt,
  analyzeCandles,
  type Candle,
  DEFAULT_STRATEGY_CONFIG,
  precomputeIndicators,
  roundTo,
} from "../strategy";
import fixture from "./analyzeCandles.fixture.json";

interface FixtureCase {
  candles: Candle[];
  expected: ReturnType<typeof analyzeCandles>;
}

const cases = fixture as unknown as {
  long: FixtureCase;
  short: FixtureCase;
};

describe("analyzeCandles — pre-refactor parity", () => {
  test("LONG fixture matches original output byte-for-byte", () => {
    const result = analyzeCandles(cases.long.candles);
    expect(result).toEqual(cases.long.expected);
  });

  test("SHORT fixture matches original output byte-for-byte", () => {
    const result = analyzeCandles(cases.short.candles);
    expect(result).toEqual(cases.short.expected);
  });

  test("explicit default config + precision 2 matches implicit defaults", () => {
    const explicit = analyzeCandles(
      cases.long.candles,
      DEFAULT_STRATEGY_CONFIG,
      2,
    );
    expect(explicit).toEqual(cases.long.expected);
  });

  test("returns a graded LONG signal with correct TP/SL ordering", () => {
    const r = cases.long.expected;
    if (!r) throw new Error("fixture expected a signal");
    expect(r.direction).toBe("LONG");
    expect(r.grade).toBe("B");
    expect(r.stopLoss).toBeLessThan(r.entryPrice);
    expect(r.tp1).toBeGreaterThan(r.entryPrice);
    expect(r.tp2).toBeGreaterThan(r.tp1);
  });

  test("returns a graded SHORT signal with correct TP/SL ordering", () => {
    const r = cases.short.expected;
    if (!r) throw new Error("fixture expected a signal");
    expect(r.direction).toBe("SHORT");
    expect(r.stopLoss).toBeGreaterThan(r.entryPrice);
    expect(r.tp1).toBeLessThan(r.entryPrice);
    expect(r.tp2).toBeLessThan(r.tp1);
  });

  test("fewer than 60 candles yields no signal", () => {
    expect(analyzeCandles(cases.long.candles.slice(0, 59))).toBeNull();
  });
});

describe("roundTo", () => {
  test("precision 2 matches legacy r2 behaviour", () => {
    expect(roundTo(2139.399, 2)).toBe(2139.4);
    expect(roundTo(1.005, 2)).toBe(1);
  });

  test("higher precision keeps more decimals", () => {
    expect(roundTo(12.34567, 3)).toBe(12.346);
  });
});

describe("precomputed analysis", () => {
  /** Deterministic oscillator with a drift, so signals actually fire. */
  function series(n: number, seed: number): Candle[] {
    let s = seed;
    const next = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff - 0.5;
    };
    const out: Candle[] = [];
    for (let i = 0; i < n; i++) {
      const b = 100 + Math.sin(i / 40) * 8 + (i / n) * 5;
      const o = b + next() * 0.6;
      const c = b + next() * 0.6;
      out.push({
        time: i * 300,
        open: o,
        high: Math.max(o, c) + Math.abs(next()) * 0.7,
        low: Math.min(o, c) - Math.abs(next()) * 0.7,
        close: c,
        volume: 1,
      });
    }
    return out;
  }

  test("analyzeAt matches analyzeCandles at every bar", () => {
    // Every indicator is causal, so a series computed over the whole window must
    // equal one computed over each prefix. This is the property that makes the
    // replay linear instead of quadratic — if it ever breaks, backtest results
    // silently stop matching what the live engine would have seen.
    for (const seed of [1, 7, 42]) {
      const candles = series(400, seed);
      const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
      for (let i = 60; i < candles.length; i++) {
        expect(analyzeAt(candles, ind, i, DEFAULT_STRATEGY_CONFIG, 2)).toEqual(
          analyzeCandles(candles.slice(0, i + 1), DEFAULT_STRATEGY_CONFIG, 2),
        );
      }
    }
  });

  test("analyzeAt refuses an index without enough history", () => {
    const candles = series(200, 3);
    const ind = precomputeIndicators(candles);
    expect(analyzeAt(candles, ind, 58, DEFAULT_STRATEGY_CONFIG, 2)).toBeNull();
  });

  test("analyzeAt refuses an index past the end", () => {
    const candles = series(200, 3);
    const ind = precomputeIndicators(candles);
    expect(analyzeAt(candles, ind, 999, DEFAULT_STRATEGY_CONFIG, 2)).toBeNull();
  });
});
