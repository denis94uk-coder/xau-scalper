/**
 * Tests for the COT crowd gauge: percentile ranking, crowded-side extremes,
 * and the not-enough-history guard.
 */
import { describe, expect, test } from "bun:test";
import { type CotReport, cotState } from "../intel/cotPositioning";

function report(
  date: string,
  noncommLong: number,
  noncommShort: number,
): CotReport {
  return {
    date,
    openInterest: 400_000,
    noncommLong,
    noncommShort,
    pctNoncommLong: 50,
    pctNoncommShort: 10,
    changeOpenInterest: 0,
    changeNoncommLong: 0,
    changeNoncommShort: 0,
  };
}

/** 60 weeks of history oscillating around a neutral net position. */
function neutralHistory(): CotReport[] {
  const rows: CotReport[] = [];
  for (let w = 0; w < 60; w++) {
    const net = Math.round(1000 * Math.sin(w / 5));
    const date = new Date(Date.UTC(2026, 0, 1 + w * 7))
      .toISOString()
      .slice(0, 10);
    rows.push(report(date, 200_000 + net, 100_000));
  }
  return rows;
}

describe("cotState", () => {
  test("returns null under 52 reports — a short window fakes extremes", () => {
    expect(cotState(neutralHistory().slice(0, 40))).toBeNull();
  });

  test("ranks net non-commercial positioning as a percentile of the window", () => {
    const state = cotState(neutralHistory());
    expect(state).not.toBeNull();
    expect(state!.percentile).toBeGreaterThanOrEqual(0);
    expect(state!.percentile).toBeLessThanOrEqual(100);
    expect(state!.windowSize).toBe(60);
  });

  test("flags crowded LONG at an extreme bullish percentile", () => {
    const rows = neutralHistory();
    // Latest report: massive net long, above everything in the window.
    rows.unshift(report("2027-12-31", 400_000, 10_000));
    const state = cotState(rows);
    expect(state!.netNoncomm).toBe(390_000);
    expect(state!.percentile).toBe(100);
    expect(state!.crowded).toBe("LONG");
  });

  test("flags crowded SHORT at an extreme bearish percentile", () => {
    const rows = neutralHistory();
    rows.unshift(report("2027-12-31", 10_000, 400_000));
    const state = cotState(rows);
    expect(state!.percentile).toBeLessThanOrEqual(10);
    expect(state!.crowded).toBe("SHORT");
  });

  test("mid-range positioning is not crowded", () => {
    const rows = neutralHistory();
    // Net 100_500 — inside the oscillation band, neither extreme.
    rows.unshift(report("2027-12-31", 200_500, 100_000));
    const state = cotState(rows);
    expect(state!.crowded).toBeNull();
  });

  test("orders by date regardless of input order", () => {
    const rows = neutralHistory();
    rows.reverse();
    const latest = rows.reduce((a, b) => (a.date > b.date ? a : b));
    const state = cotState(rows);
    expect(state!.reportDate).toBe(latest.date);
    expect(state!.netNoncomm).toBe(latest.noncommLong - latest.noncommShort);
  });
});
