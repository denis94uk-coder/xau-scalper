/**
 * Portfolio risk tests.
 *
 * The values here are hand-computable on purpose. A risk cap that is silently
 * wrong is worse than no cap, because it is trusted.
 */
import { describe, expect, test } from "bun:test";
import {
  admit,
  averageConcurrency,
  buildCorrelationMatrix,
  concentration,
  type CorrelationMatrix,
  type Exposure,
  grossRisk,
  pearson,
  portfolioRisk,
  returnSeries,
  summarise,
} from "../portfolio";
import type { Candle } from "../strategy";

/** Candles from a list of closes, one bar per minute from `start`. */
function candles(closes: number[], start = 0, step = 60_000): Candle[] {
  return closes.map((c, i) => ({
    time: start + i * step,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

/** A matrix with a fixed off-diagonal correlation, for arithmetic checks. */
function uniformMatrix(assets: string[], rho: number): CorrelationMatrix {
  return {
    assets,
    get: (a, b) =>
      a === b
        ? { value: 1, samples: Number.POSITIVE_INFINITY, assumed: false }
        : { value: rho, samples: 1000, assumed: false },
    average: () => rho,
    fullyMeasured: () => true,
  };
}

const longs = (ids: string[]): Exposure[] =>
  ids.map(asset => ({ asset, direction: "LONG" as const }));

describe("returnSeries", () => {
  test("keys returns by bar time, not by index", () => {
    const s = returnSeries(candles([100, 110], 5_000));
    // One return, stamped with the time of the bar it closed on.
    expect([...s.keys()]).toEqual([65_000]);
    expect(s.get(65_000)).toBeCloseTo(Math.log(1.1), 10);
  });

  test("skips non-positive prices rather than producing NaN or -Infinity", () => {
    const s = returnSeries(candles([100, 0, 100]));
    expect([...s.values()].every(Number.isFinite)).toBe(true);
  });

  test("a single bar yields no returns", () => {
    expect(returnSeries(candles([100])).size).toBe(0);
  });
});

describe("pearson", () => {
  const drift = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5);

  test("identical series correlate at 1", () => {
    const a = returnSeries(candles(drift));
    const r = pearson(a, returnSeries(candles(drift)));
    expect(r!.value).toBeCloseTo(1, 9);
    expect(r!.samples).toBe(59);
  });

  test("a mirrored series correlates at -1", () => {
    const a = returnSeries(candles(drift));
    // 10000/p, not 200−p: log returns of the reciprocal are exactly negated,
    // whereas an arithmetic mirror is only approximately so.
    const mirrored = drift.map(p => 10_000 / p);
    expect(pearson(a, returnSeries(candles(mirrored)))!.value).toBeCloseTo(
      -1,
      9,
    );
  });

  test("series that share no timestamps are unknown, not uncorrelated", () => {
    // The bug this guards: correlating index-for-index across series that
    // start on different days produces a confident, meaningless number.
    const a = returnSeries(candles(drift, 0));
    const b = returnSeries(candles(drift, 999_000_000));
    expect(pearson(a, b)).toBeNull();
  });

  test("partial overlap uses only the shared bars", () => {
    const a = returnSeries(candles(drift, 0));
    // Same prices, shifted 30 bars forward: 30 bars of overlap.
    const b = returnSeries(candles(drift, 30 * 60_000));
    const r = pearson(a, b, 10);
    expect(r).not.toBeNull();
    expect(r!.samples).toBeLessThan(59);
    expect(r!.samples).toBeGreaterThan(0);
  });

  test("too little overlap is refused rather than extrapolated", () => {
    const a = returnSeries(candles(drift.slice(0, 12)));
    expect(pearson(a, returnSeries(candles(drift.slice(0, 12))))).toBeNull();
  });

  test("a flat series has no correlation to report", () => {
    const flat = returnSeries(candles(new Array(60).fill(100)));
    expect(pearson(flat, returnSeries(candles(drift)))).toBeNull();
  });

  test("stays inside [-1, 1]", () => {
    const a = returnSeries(candles(drift));
    const r = pearson(a, returnSeries(candles(drift)))!;
    expect(r.value).toBeLessThanOrEqual(1);
    expect(r.value).toBeGreaterThanOrEqual(-1);
  });
});

describe("buildCorrelationMatrix", () => {
  const wave = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 4);
  const inverse = wave.map(p => 10_000 / p);

  test("measures what it can", () => {
    const m = buildCorrelationMatrix({
      A: candles(wave),
      B: candles(inverse),
    });
    const e = m.get("A", "B");
    expect(e.assumed).toBe(false);
    expect(e.value).toBeCloseTo(-1, 6);
    expect(m.fullyMeasured()).toBe(true);
  });

  test("an asset is perfectly correlated with itself", () => {
    const m = buildCorrelationMatrix({ A: candles(wave) });
    expect(m.get("A", "A").value).toBe(1);
  });

  test("is symmetric", () => {
    const m = buildCorrelationMatrix({
      A: candles(wave),
      B: candles(inverse),
    });
    expect(m.get("A", "B").value).toBe(m.get("B", "A").value);
  });

  test("falls back to a pessimistic prior, and says it did", () => {
    // Two bars each: nothing to measure.
    const m = buildCorrelationMatrix({
      A: candles([100, 101]),
      B: candles([50, 51]),
    });
    const e = m.get("A", "B");
    expect(e.assumed).toBe(true);
    expect(e.value).toBe(0.8);
    expect(e.samples).toBe(0);
    expect(m.fullyMeasured()).toBe(false);
  });

  test("the fallback is not independence", () => {
    // Assuming 0 would wave through exactly the correlated cluster the cap
    // exists to catch, so the default must never be 0.
    const m = buildCorrelationMatrix({ A: candles([1, 2]), B: candles([3, 4]) });
    expect(m.get("A", "B").value).toBeGreaterThan(0.5);
  });

  test("an unknown asset is treated as unmeasurable, not as an error", () => {
    const m = buildCorrelationMatrix({ A: candles(wave) });
    expect(m.get("A", "NOPE").assumed).toBe(true);
  });

  test("average ignores the diagonal", () => {
    const m = buildCorrelationMatrix({
      A: candles(wave),
      B: candles(inverse),
    });
    // One off-diagonal pair at ~-1; including the 1s would drag it positive.
    expect(m.average()).toBeCloseTo(-1, 6);
  });
});

describe("portfolioRisk", () => {
  test("one position is one unit of risk", () => {
    expect(portfolioRisk(longs(["A"]), uniformMatrix(["A"], 0))).toBeCloseTo(
      1,
      10,
    );
  });

  test("independent positions diversify as sqrt(n)", () => {
    const m = uniformMatrix(["A", "B", "C", "D"], 0);
    expect(portfolioRisk(longs(["A", "B", "C", "D"]), m)).toBeCloseTo(2, 10);
  });

  test("correlated positions barely diversify at all", () => {
    // sqrt(4 + 12·0.85) = sqrt(14.2)
    const m = uniformMatrix(["A", "B", "C", "D"], 0.85);
    expect(portfolioRisk(longs(["A", "B", "C", "D"]), m)).toBeCloseTo(
      Math.sqrt(14.2),
      9,
    );
  });

  test("perfectly correlated positions are one position at n× size", () => {
    const m = uniformMatrix(["A", "B", "C", "D"], 1);
    expect(portfolioRisk(longs(["A", "B", "C", "D"]), m)).toBeCloseTo(4, 9);
  });

  test("opposing positions in correlated assets offset — a real hedge", () => {
    const m = uniformMatrix(["A", "B", "C", "D"], 0.85);
    const book: Exposure[] = [
      { asset: "A", direction: "LONG" },
      { asset: "B", direction: "LONG" },
      { asset: "C", direction: "SHORT" },
      { asset: "D", direction: "SHORT" },
    ];
    // 4 + 2·(0.85 + 0.85 − 4·0.85) = 0.6
    expect(portfolioRisk(book, m)).toBeCloseTo(Math.sqrt(0.6), 9);
    // Far below the same four positions taken in one direction.
    expect(portfolioRisk(book, m)).toBeLessThan(
      portfolioRisk(longs(["A", "B", "C", "D"]), m),
    );
  });

  test("a long and a short in the same asset cancel exactly", () => {
    const m = uniformMatrix(["A"], 0);
    expect(
      portfolioRisk(
        [
          { asset: "A", direction: "LONG" },
          { asset: "A", direction: "SHORT" },
        ],
        m,
      ),
    ).toBeCloseTo(0, 10);
  });

  test("never returns NaN when the estimated matrix is not positive definite", () => {
    // ρ = −1 across three assets is not a valid correlation matrix; the
    // quadratic form goes negative. It must clamp, not produce NaN.
    const m = uniformMatrix(["A", "B", "C"], -1);
    const risk = portfolioRisk(longs(["A", "B", "C"]), m);
    expect(Number.isFinite(risk)).toBe(true);
    expect(risk).toBeGreaterThanOrEqual(0);
  });

  test("an empty book has no risk", () => {
    expect(portfolioRisk([], uniformMatrix([], 0))).toBe(0);
  });

  test("weights scale risk linearly", () => {
    const m = uniformMatrix(["A"], 0);
    expect(portfolioRisk([{ asset: "A", direction: "LONG", weight: 3 }], m)).toBeCloseTo(3, 9);
  });
});

describe("concentration", () => {
  test("correlated positions score near 1 — one bet in several costumes", () => {
    const m = uniformMatrix(["A", "B", "C", "D"], 0.95);
    expect(concentration(longs(["A", "B", "C", "D"]), m)).toBeGreaterThan(0.95);
  });

  test("independent positions score 1/sqrt(n)", () => {
    const m = uniformMatrix(["A", "B", "C", "D"], 0);
    expect(concentration(longs(["A", "B", "C", "D"]), m)).toBeCloseTo(0.5, 9);
  });

  test("an empty book is 0, not NaN", () => {
    expect(concentration([], uniformMatrix([], 0))).toBe(0);
  });

  test("gross risk counts size, blind to how positions interact", () => {
    expect(grossRisk(longs(["A", "B", "C"]))).toBe(3);
  });
});

describe("admit", () => {
  const ids = ["A", "B", "C", "D", "E", "F"];

  test("refuses the position that turns a book into one large bet", () => {
    const m = uniformMatrix(ids, 0.85);
    const open = longs(["A", "B", "C"]);
    const d = admit(open, { asset: "D", direction: "LONG" }, m, { maxRisk: 3 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("over the");
    expect(d.riskAfter).toBeCloseTo(Math.sqrt(14.2), 6);
  });

  test("admits the same position count when the assets are independent", () => {
    // Identical trade, identical cap — only the correlation differs. This is
    // why the limit is expressed as risk rather than as a position count.
    const m = uniformMatrix(ids, 0);
    const d = admit(
      longs(["A", "B", "C"]),
      { asset: "D", direction: "LONG" },
      m,
      { maxRisk: 3 },
    );
    expect(d.allowed).toBe(true);
  });

  test("a hedge is admitted even when the book is already over its cap", () => {
    const m = uniformMatrix(ids, 0.85);
    const open = longs(["A", "B", "C", "D"]); // risk 3.77, over a cap of 3
    const d = admit(open, { asset: "E", direction: "SHORT" }, m, {
      maxRisk: 3,
    });
    expect(d.hedge).toBe(true);
    expect(d.allowed).toBe(true);
    expect(d.marginalRisk).toBeLessThan(0);
    expect(d.riskAfter).toBeLessThan(d.riskBefore);
    expect(d.reason).toContain("Hedge");
  });

  test("the first position is always admitted", () => {
    const m = uniformMatrix(ids, 0.99);
    expect(admit([], { asset: "A", direction: "LONG" }, m).allowed).toBe(true);
  });

  test("reports the closest thing already open, so a refusal is explainable", () => {
    const m: CorrelationMatrix = {
      assets: ids,
      get: (a, b) => {
        if (a === b)
          return { value: 1, samples: Number.POSITIVE_INFINITY, assumed: false };
        const pair = [a, b].sort().join("");
        return {
          value: pair === "BD" ? 0.95 : 0.1,
          samples: 500,
          assumed: false,
        };
      },
      average: () => 0.3,
      fullyMeasured: () => true,
    };
    const d = admit(longs(["A", "B", "C"]), { asset: "D", direction: "LONG" }, m);
    expect(d.closest?.asset).toBe("B");
    expect(d.closest?.correlation).toBeCloseTo(0.95, 6);
    expect(d.reason).toContain("B");
  });

  test("an assumed correlation is disclosed in the reason", () => {
    const m = buildCorrelationMatrix({
      A: candles([100, 101]),
      B: candles([50, 51]),
    });
    const d = admit(longs(["A"]), { asset: "B", direction: "LONG" }, m);
    expect(d.closest?.assumed).toBe(true);
    expect(d.reason).toContain("assumed");
  });
});

describe("summarise", () => {
  const ids = ["A", "B", "C", "D"];

  test("names the failure mode when positions move together", () => {
    const s = summarise(longs(ids), uniformMatrix(ids, 0.97), { maxRisk: 3 });
    expect(s.concentration).toBeGreaterThan(0.85);
    expect(s.summary).toContain("one bet");
    expect(s.headroom).toBe(0);
  });

  test("recognises an offsetting book", () => {
    const s = summarise(
      [
        { asset: "A", direction: "LONG" },
        { asset: "B", direction: "SHORT" },
      ],
      uniformMatrix(ids, 0.9),
    );
    expect(s.concentration).toBeLessThan(0.4);
    expect(s.summary).toContain("offsetting");
    expect(s.netExposure).toBe(0);
  });

  test("net exposure exposes a one-way book that gross size hides", () => {
    const s = summarise(longs(ids), uniformMatrix(ids, 0.5));
    expect(s.grossRisk).toBe(4);
    expect(s.netExposure).toBe(4);
  });

  test("an empty book says so instead of dividing by zero", () => {
    const s = summarise([], uniformMatrix([], 0));
    expect(s.portfolioRisk).toBe(0);
    expect(s.concentration).toBe(0);
    expect(s.summary).toBe("No open positions.");
  });

  test("carries whether the correlations were measured or assumed", () => {
    const assumed = buildCorrelationMatrix({
      A: candles([1, 2]),
      B: candles([3, 4]),
    });
    expect(summarise(longs(["A", "B"]), assumed).correlationsMeasured).toBe(
      false,
    );
  });
});

describe("averageConcurrency", () => {
  test("positions taken one at a time average one", () => {
    expect(
      averageConcurrency([
        { start: 0, end: 10 },
        { start: 20, end: 30 },
        { start: 40, end: 50 },
      ]),
    ).toBeCloseTo(1, 9);
  });

  test("simultaneous positions average their count", () => {
    expect(
      averageConcurrency([
        { start: 0, end: 10 },
        { start: 0, end: 10 },
        { start: 0, end: 10 },
      ]),
    ).toBeCloseTo(3, 9);
  });

  test("a brief overlap does not count as much as a sustained one", () => {
    const brief = averageConcurrency([
      { start: 0, end: 100 },
      { start: 99, end: 199 },
    ]);
    const sustained = averageConcurrency([
      { start: 0, end: 100 },
      { start: 10, end: 110 },
    ]);
    expect(brief).toBeLessThan(sustained);
    expect(brief).toBeGreaterThan(1);
  });

  test("touching intervals are not overlapping", () => {
    expect(
      averageConcurrency([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toBeCloseTo(1, 9);
  });

  test("no positions is zero, not one", () => {
    expect(averageConcurrency([])).toBe(0);
  });

  test("zero-length positions do not divide by zero", () => {
    expect(Number.isFinite(averageConcurrency([{ start: 5, end: 5 }]))).toBe(
      true,
    );
  });
});

describe("the failure this module exists to prevent", () => {
  test("six correlated longs are refused where six independent ones are not", () => {
    const ids = ["A", "B", "C", "D", "E", "F"];
    const crypto = uniformMatrix(ids, 0.85);
    const independent = uniformMatrix(ids, 0);

    // Feed signals in one at a time, exactly as the engine does.
    const take = (m: CorrelationMatrix) => {
      const open: Exposure[] = [];
      for (const asset of ids) {
        const d = admit(open, { asset, direction: "LONG" }, m, { maxRisk: 3 });
        if (d.allowed) open.push({ asset, direction: "LONG" });
      }
      return open.length;
    };

    expect(take(crypto)).toBe(3);
    expect(take(independent)).toBe(6);
  });
});
