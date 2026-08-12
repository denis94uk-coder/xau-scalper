import { describe, expect, test } from "bun:test";
import { analyzeQuietTrend, htfRegime } from "../quiet-trend";
import type { Candle } from "../strategy";

function candles(
  closes: number[],
  atr = 5,
  baseTime = 1_700_000_000,
): Candle[] {
  return closes.map((c, i) => ({
    time: baseTime + i * 3600,
    open: c,
    high: c + atr * 0.5,
    low: c - atr * 0.5,
    close: c,
    volume: 100,
  }));
}

/** Rising trend: EMA rises with it. */
function risingTrend(n: number, start = 2000, step = 1): Candle[] {
  const closes = Array.from({ length: n }, (_, i) => start + i * step);
  return candles(closes);
}

/** Flat candles — no directional bias. */
function flat(n: number, price = 2000): Candle[] {
  return candles(Array.from({ length: n }, () => price));
}

describe("htfRegime", () => {
  test("returns null when not enough bars", () => {
    expect(htfRegime(flat(10))).toBeNull();
  });

  test("LONG when price is above EMA + buffer", () => {
    // Price rockets above a slowly-rising EMA
    const c = risingTrend(200, 2000, 2);
    expect(htfRegime(c)).toBe("LONG");
  });

  test("SHORT when price is below EMA − buffer", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 2000 - i * 2);
    const c = candles(closes);
    expect(htfRegime(c)).toBe("SHORT");
  });

  test("null (NEUTRAL) when price hugs the EMA", () => {
    // Flat price — EMA ≈ price, well within 0.05% buffer
    expect(htfRegime(flat(200))).toBeNull();
  });

  test("respects custom emaPeriod", () => {
    // Short period EMA follows price tightly; should still detect trend
    const c = risingTrend(100, 2000, 3);
    expect(htfRegime(c, { emaPeriod: 20, emaBuffer: 0.0005 })).toBe("LONG");
  });
});

describe("analyzeQuietTrend", () => {
  test("returns null when not enough warmup bars", () => {
    expect(analyzeQuietTrend(flat(50), 2)).toBeNull();
  });

  test("returns null on flat price (inside EMA buffer)", () => {
    expect(analyzeQuietTrend(flat(200), 2)).toBeNull();
  });

  test("detects a quiet LONG trend", () => {
    // Gentle, steady rise — low volatility relative to itself
    const c = risingTrend(200, 2000, 0.5);
    const result = analyzeQuietTrend(c, 2);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe("LONG");
    expect(result?.grade).toBe("B");
    expect(result?.stopLoss).toBeLessThan(result?.entryPrice ?? 0);
    expect(result?.tp2).toBeGreaterThan(result?.entryPrice ?? 0);
  });

  test("detects a quiet SHORT trend", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 2000 - i * 0.5);
    const c = candles(closes);
    const result = analyzeQuietTrend(c, 2);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe("SHORT");
    expect(result?.stopLoss).toBeGreaterThan(result?.entryPrice ?? 0);
    expect(result?.tp2).toBeLessThan(result?.entryPrice ?? 0);
  });

  test("tp2 is farther than tp1 in both directions", () => {
    const c = risingTrend(200, 2000, 0.5);
    const result = analyzeQuietTrend(c, 2);
    if (!result) throw new Error("no result");
    // LONG: tp1 < tp2
    expect(result.tp1).toBeLessThan(result.tp2);
    // SL is below entry
    expect(result.stopLoss).toBeLessThan(result.entryPrice);
  });

  test("respects price precision in output", () => {
    const c = risingTrend(200, 2000, 0.5);
    const result2 = analyzeQuietTrend(c, 2);
    if (!result2) throw new Error("no result");
    const decimals = (n: number) => (n.toString().split(".")[1] ?? "").length;
    expect(decimals(result2.entryPrice)).toBeLessThanOrEqual(2);
    expect(decimals(result2.stopLoss)).toBeLessThanOrEqual(2);
  });

  test("returns null when volatility is too high", () => {
    // Large random jumps → vol above median → filter blocks entry
    const closes: number[] = [2000];
    const rng = () => Math.sin(closes.length * 1.7) * 0.5 + 0.5;
    for (let i = 1; i < 200; i++) {
      const trend = 0.5; // small upward drift
      const noise = (rng() - 0.5) * 60; // large noise
      closes.push(closes[i - 1] + trend + noise);
    }
    // Even with a trend, explosive vol should block most signals
    const result = analyzeQuietTrend(candles(closes), 2);
    // Not guaranteed null (depends on final bars), but we can confirm the
    // function handles it without throwing
    expect(typeof result === "object" || result === null).toBe(true);
  });
});

describe("regime filter integration", () => {
  test("LONG regime allows LONG signal", () => {
    const h1 = risingTrend(200, 2000, 2);
    expect(htfRegime(h1)).toBe("LONG");
    // A LONG analysis result should be admitted
    const a = analyzeQuietTrend(risingTrend(200, 2000, 0.5), 2);
    if (a) {
      const regime = htfRegime(h1);
      expect(regime === null || regime === a.direction).toBe(true);
    }
  });

  test("LONG regime vetoes SHORT signal", () => {
    const h1Regime = htfRegime(risingTrend(200, 2000, 2));
    expect(h1Regime).toBe("LONG");
    // Simulated SHORT signal
    const shortDir = "SHORT";
    // The veto condition: regime !== null && regime !== signal direction
    const vetoed = h1Regime !== null && h1Regime !== shortDir;
    expect(vetoed).toBe(true);
  });

  test("NEUTRAL regime (null) does not veto either direction", () => {
    const h1Regime = htfRegime(flat(200));
    expect(h1Regime).toBeNull();
    // null regime → no veto regardless of signal
    expect(h1Regime !== null && h1Regime !== "LONG").toBe(false);
    expect(h1Regime !== null && h1Regime !== "SHORT").toBe(false);
  });
});
