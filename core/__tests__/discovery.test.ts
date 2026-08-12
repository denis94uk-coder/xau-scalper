/**
 * Strategy discovery tests.
 *
 * The property that matters here is not "the search finds a strategy" — on
 * random data it must NOT — but that the search cannot fool itself. So the
 * tests are mostly about the guards: a random walk must produce no qualified
 * candidate, the correction must scale with the number of attempts, and the
 * sampler must never emit a configuration the strategy would misread.
 */

import { describe, expect, test } from "bun:test";
import type { AssetDefinition } from "../assets";
import {
  adjustPValue,
  DEFAULT_SEARCH_SPACE,
  discover,
  rng,
  sampleConfig,
} from "../discovery";
import { type Candle, DEFAULT_STRATEGY_CONFIG } from "../strategy";

const asset: AssetDefinition = {
  id: "TEST",
  displaySymbol: "TEST",
  dataSourceSymbol: "TEST",
  dataSource: "mt5",
  pricePrecision: 2,
  sessionType: "24_7",
  enabled: true,
  config: DEFAULT_STRATEGY_CONFIG,
  costs: {
    halfSpreadBps: 4,
    takerFeeBps: 4,
    makerFeeBps: 2,
    stopSlippageBps: 8,
  },
};

/** A driftless random walk: there is no edge here to find, by construction. */
function randomWalk(n: number, seed = 7): Candle[] {
  const rand = rng(seed);
  const out: Candle[] = [];
  let price = 1000;
  for (let i = 0; i < n; i++) {
    const move = (rand() - 0.5) * 4;
    const open = price;
    const close = price + move;
    const high = Math.max(open, close) + rand() * 2;
    const low = Math.min(open, close) - rand() * 2;
    out.push({
      time: 1_700_000_000 + i * 900,
      open,
      high,
      low,
      close,
      volume: 100,
    });
    price = close;
  }
  return out;
}

/** A staircase: strong persistent trend, which a trend system should catch. */
function trending(n: number, seed = 3): Candle[] {
  const rand = rng(seed);
  const out: Candle[] = [];
  let price = 1000;
  for (let i = 0; i < n; i++) {
    const move = 1.2 + (rand() - 0.5) * 1.5;
    const open = price;
    const close = price + move;
    out.push({
      time: 1_700_000_000 + i * 900,
      open,
      high: Math.max(open, close) + rand(),
      low: Math.min(open, close) - rand(),
      close,
      volume: 100,
    });
    price = close;
  }
  return out;
}

describe("seeded randomness", () => {
  test("the same seed reproduces the same sequence", () => {
    const a = rng(42);
    const b = rng(42);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });

  test("different seeds diverge", () => {
    expect(rng(1)()).not.toBe(rng(2)());
  });

  test("stays inside [0, 1)", () => {
    const r = rng(9);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("sampling", () => {
  test("every draw respects the strategy's ordering rules", () => {
    const rand = rng(11);
    for (let i = 0; i < 500; i++) {
      const c = sampleConfig(
        DEFAULT_STRATEGY_CONFIG,
        DEFAULT_SEARCH_SPACE,
        rand,
      );

      // Distinct and ordered: equal EMAs make "aligned" vacuously true.
      expect(c.emaFast).toBeLessThan(c.emaMid);
      expect(c.emaMid).toBeLessThan(c.emaSlow);

      expect(c.macdFast).toBeLessThan(c.macdSlow);
      expect(c.tp1R).toBeLessThan(c.tp2R);
      expect(c.rsiOversold).toBeLessThan(c.rsiOverbought);
      expect(c.stochOversold).toBeLessThan(c.stochOverbought);
      expect(c.gradeBStrength).toBeLessThanOrEqual(c.gradeAStrength);
      expect(c.gradeCStrength).toBeLessThanOrEqual(c.gradeBStrength);
    }
  });

  test("period knobs stay integers", () => {
    const rand = rng(5);
    for (let i = 0; i < 100; i++) {
      const c = sampleConfig(
        DEFAULT_STRATEGY_CONFIG,
        DEFAULT_SEARCH_SPACE,
        rand,
      );
      for (const k of [
        "emaFast",
        "emaMid",
        "emaSlow",
        "rsiPeriod",
        "atrPeriod",
        "macdFast",
        "macdSlow",
      ] as const) {
        expect(Number.isInteger(c[k])).toBe(true);
      }
    }
  });

  test("knobs outside the space are carried over untouched", () => {
    const c = sampleConfig(
      { ...DEFAULT_STRATEGY_CONFIG, cooldownMs: 123_456 },
      { emaFast: { min: 5, max: 10, integer: true } },
      rng(1),
    );
    expect(c.cooldownMs).toBe(123_456);
  });
});

describe("multiple-comparisons correction", () => {
  test("a single attempt is not penalised", () => {
    expect(adjustPValue(0.03, 1)).toBe(0.03);
  });

  test("more attempts make the same p-value less impressive", () => {
    const one = adjustPValue(0.01, 1);
    const hundred = adjustPValue(0.01, 100);
    expect(hundred).toBeGreaterThan(one);
    // 1 - 0.99^100 is roughly 0.63: a 1-in-100 result is expected once in 100 tries.
    expect(hundred).toBeCloseTo(0.634, 2);
  });

  test("never exceeds certainty", () => {
    expect(adjustPValue(0.5, 10_000)).toBeLessThanOrEqual(1);
  });
});

describe("discovery", () => {
  test("refuses to report on a window too short to split three ways", () => {
    const report = discover(randomWalk(300), asset, { iterations: 5 });
    expect(report.best).toBeNull();
    expect(report.candidates).toHaveLength(0);
    expect(report.conclusion).toContain("Not enough history");
  });

  test("finds nothing tradeable in a driftless random walk", () => {
    // The headline guarantee. If this ever passes a candidate, the validation
    // is broken rather than the market being generous.
    const report = discover(randomWalk(3000), asset, {
      iterations: 60,
      seed: 4,
    });
    expect(report.best).toBeNull();
    expect(report.conclusion).toContain("None of");
  });

  test("reports every candidate it rejected, with a reason", () => {
    const report = discover(randomWalk(3000), asset, {
      iterations: 30,
      seed: 8,
    });
    expect(report.candidates.length).toBeGreaterThan(0);
    for (const c of report.candidates) {
      expect(c.verdict).not.toBe("qualified");
      expect(c.summary.length).toBeGreaterThan(10);
    }
  });

  test("splits the history into three disjoint windows covering it all", () => {
    const candles = randomWalk(4000);
    const report = discover(candles, asset, { iterations: 5 });
    const { train, validation, test: testWindow } = report.split;
    expect(train + validation + testWindow).toBe(candles.length);
    expect(train).toBeGreaterThan(validation);
    expect(testWindow).toBeGreaterThan(0);
  });

  test("is reproducible from its seed", () => {
    const candles = trending(3000);
    const a = discover(candles, asset, { iterations: 20, seed: 99 });
    const b = discover(candles, asset, { iterations: 20, seed: 99 });
    expect(JSON.stringify(a.candidates)).toBe(JSON.stringify(b.candidates));
  });

  test("a different seed explores different configurations", () => {
    const candles = trending(3000);
    const a = discover(candles, asset, { iterations: 20, seed: 1 });
    const b = discover(candles, asset, { iterations: 20, seed: 2 });
    expect(JSON.stringify(a.candidates)).not.toBe(JSON.stringify(b.candidates));
  });

  test("stops early when asked", () => {
    let calls = 0;
    const report = discover(randomWalk(3000), asset, {
      iterations: 500,
      shouldStop: () => ++calls > 5,
    });
    expect(report.evaluated).toBeLessThan(20);
  });

  test("a candidate that qualifies beat all three windows and the correction", () => {
    // Whether a trend series produces a qualified candidate depends on the
    // seed, so this asserts the INVARIANT rather than the outcome: anything
    // labelled qualified must satisfy every condition the label claims.
    const report = discover(trending(4000), asset, {
      iterations: 80,
      seed: 21,
    });
    for (const c of report.candidates.filter(c => c.verdict === "qualified")) {
      expect(c.train.netPoints).toBeGreaterThan(0);
      expect(c.validation.netPoints).toBeGreaterThan(0);
      expect(c.test.netPoints).toBeGreaterThan(0);
      expect(c.adjustedPValue).toBeLessThanOrEqual(0.05);
      expect(c.overall.winRate).toBeGreaterThan(
        c.overall.breakevenWinRate ?? 50,
      );
    }
  });

  test("qualified candidates rank above rejected ones", () => {
    const report = discover(trending(4000), asset, {
      iterations: 60,
      seed: 33,
    });
    const verdicts = report.candidates.map(c => c.verdict === "qualified");
    const firstReject = verdicts.indexOf(false);
    if (firstReject > 0) {
      expect(verdicts.slice(firstReject).every(v => !v)).toBe(true);
    }
  });

  test("costs are applied — a zero-cost run keeps more than a costed one", () => {
    const candles = trending(3000);
    const expensive = discover(candles, asset, { iterations: 15, seed: 6 });
    const free = discover(
      candles,
      {
        ...asset,
        costs: {
          halfSpreadBps: 0,
          takerFeeBps: 0,
          makerFeeBps: 0,
          stopSlippageBps: 0,
        },
      },
      { iterations: 15, seed: 6 },
    );
    const cost = (r: typeof expensive) =>
      r.candidates.reduce((s, c) => s + c.train.costPoints, 0);
    expect(cost(expensive)).toBeGreaterThan(cost(free));
  });
});
