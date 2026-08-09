/**
 * Significance tests.
 *
 * These check the statistics against values that can be verified by hand or by
 * simulation, because a subtly wrong p-value is worse than none — it launders a
 * guess into something that looks like evidence.
 */
import { describe, expect, test } from "bun:test";
import {
  assessSignificance,
  binomialPmf,
  binomialTailProbability,
  effectiveSampleSize,
  requiredSampleSize,
  wilsonInterval,
} from "../significance";

describe("binomialPmf", () => {
  test("matches hand-computable cases", () => {
    // C(4,2) · 0.5^4 = 6/16
    expect(binomialPmf(2, 4, 0.5)).toBeCloseTo(0.375, 6);
    // All heads in 3 fair flips = 1/8
    expect(binomialPmf(3, 3, 0.5)).toBeCloseTo(0.125, 6);
    expect(binomialPmf(0, 3, 0.5)).toBeCloseTo(0.125, 6);
  });

  test("sums to one over the whole support", () => {
    for (const n of [5, 20, 100]) {
      let total = 0;
      for (let k = 0; k <= n; k++) total += binomialPmf(k, n, 0.43);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  test("is defined outside the support rather than NaN", () => {
    expect(binomialPmf(-1, 10, 0.5)).toBe(0);
    expect(binomialPmf(11, 10, 0.5)).toBe(0);
  });

  test("survives sample sizes where n! would overflow", () => {
    // 300! is Infinity in floating point; the log-gamma path must not care.
    const p = binomialPmf(150, 300, 0.5);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
  });
});

describe("binomialTailProbability", () => {
  test("a fair coin gives half the mass at or above the midpoint", () => {
    // P(X >= 5 | n=10, p=0.5) = 0.623 (includes the k=5 term).
    expect(binomialTailProbability(5, 10, 0.5)).toBeCloseTo(0.623, 2);
  });

  test("is monotonic in the threshold", () => {
    let prev = 1;
    for (let k = 0; k <= 20; k++) {
      const p = binomialTailProbability(k, 20, 0.5);
      expect(p).toBeLessThanOrEqual(prev + 1e-9);
      prev = p;
    }
  });

  test("an impossible threshold is zero, a trivial one is one", () => {
    expect(binomialTailProbability(21, 20, 0.5)).toBe(0);
    expect(binomialTailProbability(0, 20, 0.5)).toBe(1);
  });
});

describe("wilsonInterval", () => {
  test("stays inside 0-100 at extremes, unlike the normal approximation", () => {
    // 20/20 wins: the textbook interval would exceed 100%.
    const perfect = wilsonInterval(20, 20);
    expect(perfect.high).toBeLessThanOrEqual(100);
    expect(perfect.low).toBeGreaterThan(0);

    const none = wilsonInterval(0, 20);
    expect(none.low).toBeGreaterThanOrEqual(0);
    expect(none.high).toBeLessThan(100);
  });

  test("narrows as the sample grows", () => {
    const small = wilsonInterval(11, 20);
    const large = wilsonInterval(1100, 2000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  test("brackets the observed rate", () => {
    const i = wilsonInterval(55, 100);
    expect(i.low).toBeLessThan(55);
    expect(i.high).toBeGreaterThan(55);
  });

  test("no data means no information, not a point estimate", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 100 });
  });
});

describe("requiredSampleSize", () => {
  test("a smaller edge needs a larger sample", () => {
    const big = requiredSampleSize(60, 48)!;
    const small = requiredSampleSize(50, 48)!;
    expect(small).toBeGreaterThan(big);
  });

  test("no positive edge means no answer rather than a fake one", () => {
    expect(requiredSampleSize(48, 48)).toBeNull();
    expect(requiredSampleSize(40, 48)).toBeNull();
  });

  test("a realistic edge needs a realistic number of trades", () => {
    // 53% against a 48% breakeven — the sort of gap this strategy might have.
    const n = requiredSampleSize(53, 48)!;
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(2000);
  });
});

describe("assessSignificance", () => {
  test("refuses a verdict on a small sample", () => {
    const r = assessSignificance(8, 12, 48);
    expect(r.verdict).toBe("insufficient_data");
    expect(r.summary).toContain("too few");
  });

  test("a good-looking short run is still not evidence", () => {
    // 58% over 40 trades against 48% breakeven feels convincing and is not.
    const r = assessSignificance(23, 40, 48);
    expect(r.verdict).toBe("indistinguishable_from_chance");
    expect(r.tradesNeeded).toBeGreaterThan(40);
  });

  test("a strong result over a large sample is significant", () => {
    const r = assessSignificance(600, 1000, 48);
    expect(r.verdict).toBe("significant");
    expect(r.pValue).toBeLessThan(0.05);
  });

  test("a losing rate is never significant", () => {
    const r = assessSignificance(300, 1000, 48);
    expect(r.verdict).toBe("indistinguishable_from_chance");
    expect(r.tradesNeeded).toBeNull();
  });

  test("the same win rate becomes significant only with enough trades", () => {
    // Identical 56% rate; only the sample size differs.
    expect(assessSignificance(28, 50, 48).verdict).toBe(
      "indistinguishable_from_chance",
    );
    expect(assessSignificance(560, 1000, 48).verdict).toBe("significant");
  });

  test("a higher breakeven makes the same record less impressive", () => {
    const easy = assessSignificance(560, 1000, 48);
    const hard = assessSignificance(560, 1000, 58);
    expect(hard.pValue).toBeGreaterThan(easy.pValue);
  });

  test("the summary is actionable rather than just numeric", () => {
    const r = assessSignificance(23, 40, 48);
    expect(r.summary).toMatch(/would settle it/);
  });
});

describe("effectiveSampleSize", () => {
  test("independent positions are not discounted", () => {
    expect(effectiveSampleSize(100, 1, 0)).toBe(100);
    expect(effectiveSampleSize(100, 5, 0)).toBe(100);
  });

  test("perfectly correlated concurrent positions count as one", () => {
    // Seven simultaneous longs on assets that move together are one bet.
    expect(effectiveSampleSize(700, 7, 1)).toBe(100);
  });

  test("realistic crypto correlation discounts heavily", () => {
    // Six crypto assets at 0.8 pairwise correlation.
    const effective = effectiveSampleSize(600, 6, 0.8);
    expect(effective).toBeLessThan(200);
    expect(effective).toBeGreaterThan(100);
  });

  test("more correlation always means fewer effective trades", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const rho of [0, 0.25, 0.5, 0.75, 1]) {
      const n = effectiveSampleSize(500, 5, rho);
      expect(n).toBeLessThanOrEqual(prev);
      prev = n;
    }
  });

  test("never claims fewer than one trade, or negative", () => {
    expect(effectiveSampleSize(1, 10, 1)).toBe(1);
    expect(effectiveSampleSize(0, 5, 0.5)).toBe(0);
  });
});

describe("the failure this module exists to prevent", () => {
  test("a promising few weeks does not survive scrutiny, and says so", () => {
    // 30 trades, 60% wins, 48% breakeven — the exact shape of a false positive.
    const naive = assessSignificance(18, 30, 48);
    expect(naive.verdict).not.toBe("significant");

    // And correlated positions make the real evidence thinner still.
    const effective = effectiveSampleSize(30, 4, 0.8);
    expect(effective).toBeLessThan(15);
  });
});
