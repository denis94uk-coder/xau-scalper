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
  analyzeCandles,
  type Candle,
  DEFAULT_STRATEGY_CONFIG,
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
