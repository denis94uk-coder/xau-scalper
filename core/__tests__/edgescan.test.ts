/**
 * The scanner's job is to say "nothing here" far more often than "something".
 * The tests that matter most are therefore the negative controls: on a random
 * walk it must survive nothing, and it must not become significant just because
 * it was asked more questions.
 */

import { describe, expect, test } from "bun:test";
import { ZERO_COST_MODEL } from "../costs";
import {
  type Hypothesis,
  MIN_OCCURRENCES,
  normalTwoSided,
  scanEdges,
  survives,
} from "../edgescan";
import { HYPOTHESES } from "../hypotheses";
import type { Candle, Direction } from "../strategy";

/** Deterministic LCG, so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function series(n: number, step: (r: number, i: number) => number, seed = 7) {
  const r = rng(seed);
  const candles: Candle[] = [];
  let price = 2000;
  // 5-minute bars from a fixed UTC midnight, so the session hypotheses see a
  // realistic clock rather than whatever "now" happens to be.
  const start = Date.UTC(2024, 0, 1) / 1000;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += step(r(), i);
    candles.push({
      time: start + i * 300,
      open,
      high: Math.max(open, price) + 0.2,
      low: Math.min(open, price) - 0.2,
      close: price,
      volume: 100,
    });
  }
  return candles;
}

const alwaysLong: Hypothesis = {
  name: "always-long",
  claim: "test fixture",
  signal: () => "LONG",
};

describe("normalTwoSided", () => {
  test("matches known values of the standard normal", () => {
    expect(normalTwoSided(0)).toBeCloseTo(1, 6);
    expect(normalTwoSided(1.959964)).toBeCloseTo(0.05, 4);
    expect(normalTwoSided(2.575829)).toBeCloseTo(0.01, 4);
    // Symmetric: the sign of the effect does not change its p-value.
    expect(normalTwoSided(-1.959964)).toBeCloseTo(normalTwoSided(1.959964), 12);
  });
});

describe("scanEdges", () => {
  test("finds nothing on a random walk — the negative control", () => {
    const candles = series(6000, r => (r - 0.5) * 4);
    const report = scanEdges(candles, HYPOTHESES, ZERO_COST_MODEL, {
      windows: 6,
    });
    const found = report.results.filter(r => survives(r, report));
    expect(found).toEqual([]);
  });

  test("finds a drift that is really there", () => {
    // A persistent upward drift far larger than the noise. If the scanner
    // cannot see this, a negative result on real data means nothing.
    const candles = series(6000, r => (r - 0.5) * 2 + 0.6);
    const report = scanEdges(candles, [alwaysLong], ZERO_COST_MODEL, {
      windows: 6,
    });
    expect(survives(report.results[0], report)).toBe(true);
    expect(report.results[0].meanNet).toBeGreaterThan(0);
  });

  test("costs can turn a real but small drift into no edge", () => {
    const candles = series(6000, r => (r - 0.5) * 2 + 0.02);
    const free = scanEdges(candles, [alwaysLong], ZERO_COST_MODEL);
    const paid = scanEdges(candles, [alwaysLong], {
      halfSpreadBps: 1.5,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 5,
    });
    expect(free.results[0].meanNet).toBeGreaterThan(paid.results[0].meanNet);
    expect(paid.results[0].meanNet).toBeLessThan(0);
  });

  test("the threshold tightens as more hypotheses are tested", () => {
    const candles = series(2000, r => (r - 0.5) * 4);
    const one = scanEdges(candles, [alwaysLong], ZERO_COST_MODEL);
    const many = scanEdges(candles, HYPOTHESES, ZERO_COST_MODEL);
    expect(many.adjustedAlpha).toBeLessThan(one.adjustedAlpha);
    expect(one.adjustedAlpha).toBeCloseTo(0.05, 10);
  });

  test("occurrences do not overlap, so evidence is not double counted", () => {
    const candles = series(1200, r => (r - 0.5) * 4);
    const report = scanEdges(candles, [alwaysLong], ZERO_COST_MODEL, {
      horizonBars: 12,
      warmup: 60,
    });
    // One entry per 12 bars over the usable span, not one per bar.
    expect(report.results[0].n).toBeLessThanOrEqual(
      Math.ceil((1200 - 60) / 12),
    );
    expect(report.results[0].n).toBeGreaterThan(80);
  });

  test("a hypothesis that rarely fires is not reported as measured", () => {
    const candles = series(3000, r => (r - 0.5) * 4);
    const rare: Hypothesis = {
      name: "rare",
      claim: "test fixture",
      signal: (_c, i) => (i % 500 === 0 ? "LONG" : null),
    };
    const report = scanEdges(candles, [rare], ZERO_COST_MODEL);
    expect(report.results[0].n).toBeLessThan(MIN_OCCURRENCES);
    expect(survives(report.results[0], report)).toBe(false);
  });

  test("results are ranked by |t|, not by mean points", () => {
    const candles = series(4000, r => (r - 0.5) * 4);
    const big: Hypothesis = {
      name: "big-and-rare",
      claim: "test fixture",
      signal: (_c, i) => (i === 100 ? "LONG" : null),
    };
    const report = scanEdges(candles, [alwaysLong, big], ZERO_COST_MODEL);
    for (let i = 1; i < report.results.length; i++) {
      expect(Math.abs(report.results[i - 1].tStat)).toBeGreaterThanOrEqual(
        Math.abs(report.results[i].tStat),
      );
    }
  });

  test("a result that only worked in one window does not survive", () => {
    const candles = series(6000, r => (r - 0.5) * 2);
    const report = scanEdges(candles, [alwaysLong], ZERO_COST_MODEL, {
      windows: 6,
    });
    const r = { ...report.results[0], n: 500, pValue: 0, meanNet: 1 };
    expect(
      survives({ ...r, windowsJudged: 6, windowsPositive: 1 }, report),
    ).toBe(false);
    expect(
      survives({ ...r, windowsJudged: 6, windowsPositive: 5 }, report),
    ).toBe(true);
  });
});

describe("hypotheses", () => {
  // Registering a claim and its negation spends two slots of the
  // multiple-testing budget on one question, and prints one fact twice as
  // though the second printing were corroboration.
  test("no two of them are the same claim negated", () => {
    const candles = series(2000, r => (r - 0.5) * 4);
    const flip = (d: Direction | null) =>
      d === null ? null : d === "LONG" ? "SHORT" : "LONG";

    for (let a = 0; a < HYPOTHESES.length; a++) {
      for (let b = a + 1; b < HYPOTHESES.length; b++) {
        let compared = 0;
        let mirrored = 0;
        for (let i = 200; i < 1000; i++) {
          const x = HYPOTHESES[a].signal(candles, i);
          const y = HYPOTHESES[b].signal(candles, i);
          if (x === null && y === null) continue;
          compared++;
          if (y === flip(x)) mirrored++;
        }
        if (compared > 0 && mirrored === compared) {
          throw new Error(
            `${HYPOTHESES[a].name} and ${HYPOTHESES[b].name} are the same test negated`,
          );
        }
      }
    }
  });

  test("every name is distinct, so results cannot be confused", () => {
    const names = HYPOTHESES.map(h => h.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("none of them reads a bar past the one it was given", () => {
    const candles = series(2000, r => (r - 0.5) * 4);
    for (const h of HYPOTHESES) {
      for (let i = 200; i < 400; i++) {
        // Same prefix, different future: a look-ahead would change the answer.
        const truncated = candles.slice(0, i + 1);
        expect(h.signal(truncated, i)).toBe(h.signal(candles, i));
      }
    }
  });
});
