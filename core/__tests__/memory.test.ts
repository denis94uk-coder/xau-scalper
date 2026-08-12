/**
 * Outcome memory tests.
 *
 * Recall is the part that compounds: get it wrong and the loop keeps
 * rediscovering the same config, or worse, applies a quiet market's answer to a
 * violent one.
 */
import { describe, expect, test } from "bun:test";
import {
  bestForRegime,
  forRegime,
  type OutcomeRecord,
  recallConfig,
  summariseByRegime,
} from "../memory";
import { DEFAULT_STRATEGY_CONFIG } from "../strategy";
import { isScored, scoreMetrics, UNSCORED } from "../sweep";

const cfg = (over: Partial<typeof DEFAULT_STRATEGY_CONFIG> = {}) => ({
  ...DEFAULT_STRATEGY_CONFIG,
  ...over,
});

function record(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    asset: "BTCUSDT",
    regime: "trend_up/normal_vol",
    score: 1,
    config: cfg(),
    action: "hold",
    at: 1_000,
    ...over,
  };
}

describe("forRegime", () => {
  const rows = [
    record({ regime: "trend_up/normal_vol", score: 1, at: 100 }),
    record({ regime: "chop/high_vol", score: 5, at: 200 }),
    record({
      asset: "ETHUSDT",
      regime: "trend_up/normal_vol",
      score: 9,
      at: 300,
    }),
  ];

  test("filters by both asset and regime", () => {
    const got = forRegime(rows, "BTCUSDT", "trend_up/normal_vol");
    expect(got).toHaveLength(1);
    expect(got[0].score).toBe(1);
  });

  test("a regime with no history is empty, not a fallback to another regime", () => {
    // Returning the chop answer for a trending market would be worse than
    // returning nothing, because the caller cannot tell it was substituted.
    expect(forRegime(rows, "BTCUSDT", "trend_down/low_vol")).toEqual([]);
  });

  test("newest first", () => {
    const many = [
      record({ at: 100, score: 1 }),
      record({ at: 300, score: 2 }),
      record({ at: 200, score: 3 }),
    ];
    expect(
      forRegime(many, "BTCUSDT", "trend_up/normal_vol").map(r => r.at),
    ).toEqual([300, 200, 100]);
  });

  test("stale records can be excluded", () => {
    const rows2 = [record({ at: 1_000 }), record({ at: 900_000 })];
    const got = forRegime(rows2, "BTCUSDT", "trend_up/normal_vol", {
      maxAgeMs: 100_000,
      now: 950_000,
    });
    expect(got).toHaveLength(1);
    expect(got[0].at).toBe(900_000);
  });

  test("low scores can be excluded", () => {
    const rows2 = [record({ score: -3 }), record({ score: 4 })];
    expect(
      forRegime(rows2, "BTCUSDT", "trend_up/normal_vol", { minScore: 0 }),
    ).toHaveLength(1);
  });
});

describe("bestForRegime", () => {
  test("picks the highest score, not the newest", () => {
    const rows = [record({ score: 9, at: 100 }), record({ score: 2, at: 900 })];
    expect(bestForRegime(rows, "BTCUSDT", "trend_up/normal_vol")!.score).toBe(
      9,
    );
  });

  test("a tie breaks toward the more recent record", () => {
    const rows = [
      record({ score: 5, at: 100, config: cfg({ tp2R: 1.5 }) }),
      record({ score: 5, at: 900, config: cfg({ tp2R: 3.5 }) }),
    ];
    expect(
      bestForRegime(rows, "BTCUSDT", "trend_up/normal_vol")!.config.tp2R,
    ).toBe(3.5);
  });

  test("no history means null, not a default config", () => {
    expect(bestForRegime([], "BTCUSDT", "chop/high_vol")).toBeNull();
    expect(recallConfig([], "BTCUSDT", "chop/high_vol")).toBeNull();
  });

  test("recall returns the config attached to the best record", () => {
    const rows = [
      record({ score: 1, config: cfg({ atrSlMultiplier: 1 }) }),
      record({ score: 8, config: cfg({ atrSlMultiplier: 2 }) }),
    ];
    expect(
      recallConfig(rows, "BTCUSDT", "trend_up/normal_vol")!.atrSlMultiplier,
    ).toBe(2);
  });

  test("does not recall across assets", () => {
    const rows = [record({ asset: "ETHUSDT", score: 99 })];
    expect(recallConfig(rows, "BTCUSDT", "trend_up/normal_vol")).toBeNull();
  });
});

describe("summariseByRegime", () => {
  test("groups by regime and reports the spread", () => {
    const rows = [
      record({ regime: "chop/high_vol", score: 1 }),
      record({ regime: "chop/high_vol", score: 3 }),
      record({ regime: "chop/high_vol", score: 5 }),
      record({ regime: "trend_up/low_vol", score: 7 }),
    ];
    const s = summariseByRegime(rows, "BTCUSDT");
    const chop = s.find(r => r.regime === "chop/high_vol")!;
    expect(chop.records).toBe(3);
    expect(chop.bestScore).toBe(5);
    expect(chop.worstScore).toBe(1);
    expect(chop.medianScore).toBe(3);
  });

  test("the median resists a single windfall window", () => {
    const rows = [
      record({ score: 1 }),
      record({ score: 1 }),
      record({ score: 1 }),
      record({ score: 1000 }),
    ];
    const s = summariseByRegime(rows, "BTCUSDT")[0];
    expect(s.medianScore).toBe(1);
    expect(s.bestScore).toBe(1000);
  });

  test("counts proposals separately from holds", () => {
    const rows = [
      record({ action: "hold" }),
      record({ action: "propose_swap" }),
      record({ action: "hold" }),
    ];
    expect(summariseByRegime(rows, "BTCUSDT")[0].proposals).toBe(1);
  });

  test("busiest regime first", () => {
    const rows = [
      record({ regime: "a" }),
      record({ regime: "b" }),
      record({ regime: "b" }),
    ];
    expect(summariseByRegime(rows, "BTCUSDT")[0].regime).toBe("b");
  });

  test("an asset with no history summarises to nothing", () => {
    expect(summariseByRegime([record()], "NOPE")).toEqual([]);
  });
});

describe("the untradeable sentinel", () => {
  // scoreMetrics returns -1e9 + trades for configs below minTrades. That is a
  // ranking device; letting it reach a human as a number reads as a
  // catastrophic result rather than as "nothing here traded enough to judge".
  const unscored = (over: Partial<OutcomeRecord> = {}) =>
    record({ score: UNSCORED + 3, ...over });

  test("a regime where nothing traded reports null, not minus a billion", () => {
    const s = summariseByRegime([unscored(), unscored()], "BTCUSDT")[0];
    expect(s.records).toBe(2);
    expect(s.scored).toBe(0);
    expect(s.bestScore).toBeNull();
    expect(s.worstScore).toBeNull();
    expect(s.medianScore).toBeNull();
  });

  test("statistics ignore the sentinel when real scores exist alongside it", () => {
    const s = summariseByRegime(
      [unscored(), record({ score: 2 }), record({ score: 4 })],
      "BTCUSDT",
    )[0];
    expect(s.records).toBe(3);
    expect(s.scored).toBe(2);
    expect(s.bestScore).toBe(4);
    // Not (−1e9 + 2 + 4) / 3, and not −1e9 as the worst.
    expect(s.worstScore).toBe(2);
    expect(s.medianScore).toBe(3);
  });

  test("an unscored config is never recalled as the best one", () => {
    // It is the config we know least about; ranking it first would be exactly
    // backwards.
    expect(
      bestForRegime([unscored()], "BTCUSDT", "trend_up/normal_vol"),
    ).toBeNull();
    expect(
      recallConfig([unscored()], "BTCUSDT", "trend_up/normal_vol"),
    ).toBeNull();
  });

  test("a real score wins over a sentinel regardless of order", () => {
    const real = record({ score: -5, config: cfg({ tp2R: 3.5 }) });
    expect(
      bestForRegime([unscored(), real], "BTCUSDT", "trend_up/normal_vol")!
        .score,
    ).toBe(-5);
    expect(
      bestForRegime([real, unscored()], "BTCUSDT", "trend_up/normal_vol")!
        .score,
    ).toBe(-5);
  });

  test("isScored draws the line where scoreMetrics puts it", () => {
    expect(isScored(scoreMetrics({ trades: 0 } as never, 10))).toBe(false);
    expect(isScored(-5)).toBe(true);
    expect(isScored(0)).toBe(true);
  });
});
