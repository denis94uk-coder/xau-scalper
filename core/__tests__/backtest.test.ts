/**
 * Tests for the shared replay engine.
 *
 * Focus on the contracts the Teo scoring bridge depends on: metric aggregation
 * (especially the undefined-profit-factor case that used to be reported as 0
 * and read as "worst possible"), and the startIndex window used by the
 * out-of-sample split.
 */
import { describe, expect, test } from "bun:test";
import { type ClosedTrade, computeMetrics, runBacktest } from "../backtest";
import { type Candle, DEFAULT_STRATEGY_CONFIG } from "../strategy";

function trade(pnlPoints: number): ClosedTrade {
  return {
    direction: "LONG",
    entryPrice: 100,
    exitPrice: 100 + pnlPoints,
    grossPoints: pnlPoints,
    pnlPoints,
    outcome: pnlPoints > 0 ? "TP1_TP2" : "SL",
  };
}

/**
 * Deterministic oscillating series — sine swings plus seeded noise, no
 * Math.random, so tests are stable.
 *
 * A plain random walk is not usable here: the real strategy only trades A/B
 * grades and produces ~0 signals on one (it needs RSI/Stochastic/Bollinger
 * extremes to line up). That selectivity is a property of the strategy worth
 * preserving, so the fixture oscillates enough to actually trip those bands.
 */
function osc(n: number, seed = 7, amp = 6, period = 90): Candle[] {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + Math.sin((i / period) * Math.PI * 2) * amp + (i / n) * 4;
    const open = base + next() * 0.5;
    const close = base + next() * 0.5;
    out.push({
      time: i * 300,
      open,
      high: Math.max(open, close) + Math.abs(next()) * 0.6,
      low: Math.min(open, close) - Math.abs(next()) * 0.6,
      close,
      volume: 1,
    });
  }
  return out;
}

describe("computeMetrics", () => {
  test("aggregates wins, losses and net points", () => {
    const m = computeMetrics([trade(10), trade(-4), trade(6), trade(-2)]);
    expect(m.trades).toBe(4);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(2);
    expect(m.netPoints).toBeCloseTo(10);
    expect(m.winRate).toBeCloseTo(50);
    expect(m.avgWin).toBeCloseTo(8);
    expect(m.avgLoss).toBeCloseTo(3);
    expect(m.profitFactor).toBeCloseTo(16 / 6);
  });

  test("profit factor is null — not 0 — when nothing lost", () => {
    // 0 would rank a flawless config as the worst possible one, and in the
    // self-heal path would classify it as degraded.
    const m = computeMetrics([trade(5), trade(7)]);
    expect(m.profitFactor).toBeNull();
    expect(m.losses).toBe(0);
  });

  test("empty trade list is inert rather than NaN", () => {
    const m = computeMetrics([]);
    expect(m.trades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.netPoints).toBe(0);
    expect(m.profitFactor).toBeNull();
  });

  test("max drawdown tracks the worst peak-to-trough on the equity curve", () => {
    // equity: 10, 4, 14, 2 → peak 14, trough 2 → drawdown 12
    const m = computeMetrics([trade(10), trade(-6), trade(10), trade(-12)]);
    expect(m.maxDrawdown).toBeCloseTo(12);
  });
});

describe("runBacktest", () => {
  test("returns no trades when there is not enough history", () => {
    expect(runBacktest(osc(40), DEFAULT_STRATEGY_CONFIG, 2)).toEqual([]);
  });

  test("is deterministic for a given series and config", () => {
    const candles = osc(600);
    const a = runBacktest(candles, DEFAULT_STRATEGY_CONFIG, 2);
    const b = runBacktest(candles, DEFAULT_STRATEGY_CONFIG, 2);
    expect(a).toEqual(b);
  });

  test("startIndex scores only the tail, so a held-out slice trades less", () => {
    const candles = osc(600);
    const full = runBacktest(candles, DEFAULT_STRATEGY_CONFIG, 2, 60);
    const tail = runBacktest(candles, DEFAULT_STRATEGY_CONFIG, 2, 420);
    expect(tail.length).toBeLessThan(full.length);
  });

  test("a wider stop changes the outcome — config is actually applied", () => {
    const candles = osc(600);
    const tight = runBacktest(
      candles,
      { ...DEFAULT_STRATEGY_CONFIG, atrSlMultiplier: 0.5 },
      2,
    );
    const wide = runBacktest(
      candles,
      { ...DEFAULT_STRATEGY_CONFIG, atrSlMultiplier: 3.0 },
      2,
    );
    expect(computeMetrics(tight).netPoints).not.toBeCloseTo(
      computeMetrics(wide).netPoints,
    );
  });

  test("every closed trade has a coherent direction and P&L sign", () => {
    for (const t of runBacktest(osc(600), DEFAULT_STRATEGY_CONFIG, 2)) {
      const move =
        t.direction === "LONG"
          ? t.exitPrice - t.entryPrice
          : t.entryPrice - t.exitPrice;
      expect(Math.sign(t.pnlPoints)).toBe(Math.sign(Number(move.toFixed(2))));
    }
  });
});
