/**
 * Tests for the ported regime / sweep / self-heal logic.
 *
 * The behaviours worth protecting are the ones that were wrong in the Python
 * original: the zero-drawdown score blowup, a no-loss config being ranked last,
 * and swaps proposed on nothing but in-sample fit.
 */
import { describe, expect, test } from "bun:test";
import { getAsset } from "../assets";
import type { BacktestMetrics } from "../backtest";
import { DEFAULT_REGIME_THRESHOLDS, detectRegime } from "../regime";
import { assess, DEFAULT_THRESHOLDS } from "../selfheal";
import { type Candle, DEFAULT_STRATEGY_CONFIG } from "../strategy";
import {
  DEFAULT_GRID,
  expandGrid,
  runSweep,
  type SweepResult,
  scoreMetrics,
} from "../sweep";

const ASSET = getAsset("BTCUSDT")!;

function metrics(over: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    trades: 20,
    wins: 11,
    losses: 9,
    winRate: 55,
    netPoints: 100,
    avgWin: 10,
    avgLoss: 5,
    maxDrawdown: 50,
    profitFactor: 1.6,
    grossPoints: 110,
    costPoints: 10,
    expectancyPerTrade: 5,
    breakevenWinRate: 33,
    ...over,
  };
}

function candidate(score: number, oos?: number): SweepResult {
  return {
    config: { ...DEFAULT_STRATEGY_CONFIG, atrSlMultiplier: 2.0 },
    metrics: metrics({ netPoints: 500 }),
    score,
    ...(oos === undefined ? {} : { outOfSampleScore: oos }),
  };
}

/** Deterministic series with a controllable drift. */
function series(n: number, drift: number, vol = 0.004, base = 100): Candle[] {
  let s = 11;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + drift) + next() * base * vol;
    out.push({
      time: i * 300,
      open,
      high: Math.max(open, close) + Math.abs(next()) * base * vol,
      low: Math.min(open, close) - Math.abs(next()) * base * vol,
      close,
      volume: 1,
    });
    price = close;
  }
  return out;
}

describe("detectRegime", () => {
  test("a short window is tagged neutral rather than guessed", () => {
    const r = detectRegime(series(3, 0));
    expect(r.trend).toBe("chop");
    expect(r.volatility).toBe("normal");
    expect(r.label).toBe("chop/normal_vol");
  });

  test("sustained upward drift reads as an uptrend", () => {
    expect(detectRegime(series(300, 0.002)).trend).toBe("up");
  });

  test("sustained downward drift reads as a downtrend", () => {
    expect(detectRegime(series(300, -0.002)).trend).toBe("down");
  });

  test("a flat market is chop", () => {
    expect(detectRegime(series(300, 0, 0.0005)).trend).toBe("chop");
  });

  test("volatility bands separate quiet from wild", () => {
    const quiet = detectRegime(series(300, 0, 0.0002));
    const wild = detectRegime(series(300, 0, 0.02));
    expect(quiet.atrPct).toBeLessThan(wild.atrPct);
    expect(wild.volatility).toBe("high");
  });

  test("the label is a stable memory key", () => {
    const r = detectRegime(series(300, 0.002, 0.02));
    expect(r.label).toBe(`trend_${r.trend}/${r.volatility}_vol`);
  });

  test("thresholds are overridable", () => {
    const c = series(300, 0.002);
    // An absurdly high trend bar reclassifies the same data as chop.
    expect(
      detectRegime(c, { ...DEFAULT_REGIME_THRESHOLDS, trendThreshold: 99 })
        .trend,
    ).toBe("chop");
  });
});

describe("scoreMetrics", () => {
  test("under-traded configs rank below everything, stably", () => {
    const few = scoreMetrics(metrics({ trades: 3 }), 10);
    const fewer = scoreMetrics(metrics({ trades: 1 }), 10);
    expect(few).toBeLessThan(-1e8);
    expect(few).toBeGreaterThan(fewer);
  });

  test("a zero-drawdown run is good, not astronomically good", () => {
    // The Python original divided by (maxDrawdown + 1e-9) and scored ~5e10 here.
    const score = scoreMetrics(
      metrics({
        trades: 12,
        wins: 12,
        losses: 0,
        winRate: 100,
        netPoints: 50,
        avgWin: 4.16,
        avgLoss: 0,
        maxDrawdown: 0,
        profitFactor: null,
      }),
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1000);
  });

  test("a config with no losses is not ranked below a mediocre one", () => {
    const flawless = scoreMetrics(
      metrics({ netPoints: 80, maxDrawdown: 10, profitFactor: null }),
    );
    const mediocre = scoreMetrics(
      metrics({ netPoints: 5, maxDrawdown: 40, profitFactor: 1.05 }),
    );
    expect(flawless).toBeGreaterThan(mediocre);
  });

  test("losing configs score negative", () => {
    expect(
      scoreMetrics(
        metrics({ netPoints: -200, profitFactor: 0.4, winRate: 20 }),
      ),
    ).toBeLessThan(0);
  });
});

describe("expandGrid", () => {
  test("produces the full cartesian product", () => {
    // 3 × 3 × 2 × 2
    expect(expandGrid(DEFAULT_STRATEGY_CONFIG, DEFAULT_GRID)).toHaveLength(36);
  });

  test("keeps base values for knobs not in the grid", () => {
    const [first] = expandGrid(DEFAULT_STRATEGY_CONFIG, {
      atrSlMultiplier: [2.0],
    });
    expect(first.atrSlMultiplier).toBe(2.0);
    expect(first.rsiPeriod).toBe(DEFAULT_STRATEGY_CONFIG.rsiPeriod);
  });

  test("an empty grid yields the base config alone", () => {
    expect(expandGrid(DEFAULT_STRATEGY_CONFIG, {})).toHaveLength(1);
  });
});

describe("runSweep", () => {
  const candles = series(900, 0.0003, 0.006);

  test("returns topK results, best score first", () => {
    const out = runSweep(candles, ASSET, { topK: 5 });
    expect(out).toHaveLength(5);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });

  test("no split means no out-of-sample score", () => {
    expect(
      runSweep(candles, ASSET, { topK: 1 })[0].outOfSampleScore,
    ).toBeUndefined();
  });

  test("a split produces a held-out score", () => {
    const [best] = runSweep(candles, ASSET, { topK: 1, splitRatio: 0.7 });
    expect(best.outOfSample).toBeDefined();
    expect(best.outOfSampleScore).toBeDefined();
  });

  test("too small a window declines to split rather than reporting noise", () => {
    const [best] = runSweep(series(120, 0.0003), ASSET, {
      topK: 1,
      splitRatio: 0.95,
    });
    expect(best.outOfSampleScore).toBeUndefined();
  });

  test("an out-of-range split ratio is rejected", () => {
    expect(() => runSweep(candles, ASSET, { splitRatio: 0 })).toThrow();
    expect(() => runSweep(candles, ASSET, { splitRatio: 1 })).toThrow();
  });

  test("results are net of costs — a costlier asset scores worse", () => {
    const cheap = runSweep(candles, getAsset("BTCUSDT")!, { topK: 1 });
    const dear = runSweep(candles, getAsset("TAOUSDT")!, { topK: 1 });
    expect(dear[0].metrics.netPoints).toBeLessThan(cheap[0].metrics.netPoints);
  });
});

describe("assess", () => {
  const degraded = metrics({ profitFactor: 0.8, winRate: 20, netPoints: -20 });

  test("too few trades is insufficient data, not degradation", () => {
    const d = assess(metrics({ trades: 3 }), null);
    expect(d.status).toBe("insufficient_data");
    expect(d.action).toBe("hold");
  });

  test("a healthy config holds even with a strong candidate available", () => {
    const d = assess(
      metrics({ profitFactor: 1.6, winRate: 55 }),
      candidate(999, 999),
    );
    expect(d.status).toBe("healthy");
    expect(d.proposedConfig).toBeNull();
  });

  test("no losing trades is not degradation", () => {
    // profitFactor null must not read as "below the minimum".
    const d = assess(metrics({ profitFactor: null, winRate: 100 }), null);
    expect(d.status).toBe("healthy");
    expect(d.reason).toContain("no losing trades");
  });

  test("degraded with no candidate holds", () => {
    expect(assess(degraded, null).action).toBe("hold");
  });

  test("no swap without out-of-sample evidence", () => {
    const d = assess(degraded, candidate(50));
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("out of sample");
  });

  test("no swap when the candidate fails out of sample", () => {
    const d = assess(degraded, candidate(50, -20));
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("selection noise");
  });

  test("proposes a swap when the candidate survives out of sample", () => {
    const d = assess(degraded, candidate(50, 5));
    expect(d.action).toBe("propose_swap");
    expect(d.proposedConfig).not.toBeNull();
    expect(d.improvement).toBeGreaterThan(0);
  });

  test("holds when the gain is real but below the bar", () => {
    const currentScore = scoreMetrics(degraded, DEFAULT_THRESHOLDS.minTrades);
    const d = assess(degraded, candidate(currentScore + 0.01, 5));
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("improvement bar");
  });

  test("the out-of-sample gate can be disabled knowingly", () => {
    const d = assess(degraded, candidate(50), {
      thresholds: { ...DEFAULT_THRESHOLDS, requireOutOfSample: false },
    });
    expect(d.action).toBe("propose_swap");
  });

  test("the regime is named in the reason, for the journal", () => {
    const d = assess(degraded, candidate(50, 5), {
      regime: detectRegime(series(300, 0.002)),
    });
    expect(d.reason).toContain("regime:");
  });
});
