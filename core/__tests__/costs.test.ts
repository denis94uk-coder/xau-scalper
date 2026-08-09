/**
 * Cost model tests.
 *
 * The point of these is not arithmetic — it is the asymmetry. Wins fill as
 * resting limit orders and are cheap; losses fill as stops crossing the spread
 * into a fast move and are expensive. A model that misses that flatters every
 * strategy it scores.
 */
import { describe, expect, test } from "bun:test";
import {
  breakevenWinRate,
  DEFAULT_COST_MODEL,
  entryCost,
  exitCost,
  expectancy,
  netPoints,
  roundTripCost,
  ZERO_COST_MODEL,
} from "../costs";

describe("cost components", () => {
  test("entry pays spread and taker fee", () => {
    // 1.5 + 4 = 5.5 bps of 1000 = 0.55
    expect(entryCost(1000, DEFAULT_COST_MODEL)).toBeCloseTo(0.55);
  });

  test("a take-profit exit pays only the maker fee", () => {
    expect(exitCost(1000, "TP", DEFAULT_COST_MODEL)).toBeCloseTo(0.2);
  });

  test("a stop exit costs materially more than a take-profit", () => {
    const tp = exitCost(1000, "SL", DEFAULT_COST_MODEL);
    const target = exitCost(1000, "TP", DEFAULT_COST_MODEL);
    // 1.5 + 4 + 5 = 10.5 bps vs 2 bps
    expect(tp).toBeCloseTo(1.05);
    expect(tp / target).toBeGreaterThan(5);
  });

  test("a trailing stop is priced like any other stop", () => {
    expect(exitCost(1000, "TRAIL_SL", DEFAULT_COST_MODEL)).toBeCloseTo(
      exitCost(1000, "SL", DEFAULT_COST_MODEL),
    );
  });

  test("the zero model is genuinely free", () => {
    expect(roundTripCost(1000, 1010, "SL", ZERO_COST_MODEL)).toBe(0);
  });

  test("costs scale with price, so bps stay comparable across assets", () => {
    const cheap = roundTripCost(15, 15, "SL", DEFAULT_COST_MODEL);
    const dear = roundTripCost(3450, 3450, "SL", DEFAULT_COST_MODEL);
    expect(dear / cheap).toBeCloseTo(3450 / 15);
  });
});

describe("net result", () => {
  test("a winner keeps most of its gross", () => {
    // Long 1000 → 1012, +12 gross, TP fill.
    const net = netPoints(12, 1000, 1012, "TP", DEFAULT_COST_MODEL);
    expect(net).toBeCloseTo(12 - 0.55 - 0.2024, 3);
    expect(net).toBeLessThan(12);
  });

  test("a loser is worse than its gross by more than a winner is", () => {
    const winDrag = 12 - netPoints(12, 1000, 1012, "TP", DEFAULT_COST_MODEL);
    const lossDrag =
      Math.abs(netPoints(-12, 1000, 988, "SL", DEFAULT_COST_MODEL)) - 12;
    expect(lossDrag).toBeGreaterThan(winDrag);
  });

  test("a small gross win can be a net loss", () => {
    // This is the case that matters: the chart shows a winner, the account
    // does not. Nothing in the system could express this before.
    const gross = 0.5;
    expect(
      netPoints(gross, 1000, 1000.5, "TP", DEFAULT_COST_MODEL),
    ).toBeLessThan(0);
  });
});

describe("breakeven win rate", () => {
  test("symmetric win and loss needs better than half", () => {
    expect(breakevenWinRate(10, 10)).toBeCloseTo(50);
  });

  test("a 2:1 payoff can be wrong most of the time and still pay", () => {
    expect(breakevenWinRate(20, 10)).toBeCloseTo(33.33, 1);
  });

  test("a poor payoff demands a high hit rate", () => {
    // Winning 1 and losing 3 needs 75% just to stand still.
    expect(breakevenWinRate(1, 3)).toBeCloseTo(75);
  });

  test("undefined rather than zero when there is nothing to measure", () => {
    expect(breakevenWinRate(0, 0)).toBeNull();
  });
});

describe("expectancy", () => {
  test("is positive only when the payoff clears the breakeven rate", () => {
    const avgWin = 20;
    const avgLoss = 10;
    const be = breakevenWinRate(avgWin, avgLoss)!;
    expect(expectancy(be, avgWin, avgLoss)).toBeCloseTo(0);
    expect(expectancy(be + 5, avgWin, avgLoss)).toBeGreaterThan(0);
    expect(expectancy(be - 5, avgWin, avgLoss)).toBeLessThan(0);
  });

  test("a high win rate with a bad payoff still loses", () => {
    // 70% winners at +1 against 30% losers at -3 is negative.
    expect(expectancy(70, 1, 3)).toBeCloseTo(-0.2);
  });
});
