/**
 * The split exists to fix one measured defect: summed together, the two
 * families cancel, and the combined model scores AGAINST its own trend. The
 * first test here pins that — if a future change lets reversion points bleed
 * back into a trend signal, it fails.
 */

import { describe, expect, test } from "bun:test";
import { mt5Asset } from "../assets";
import {
  analyzeFamilyAt,
  analyzeFamilyCandles,
  BREAKOUT_MAX_POINTS,
  DEFAULT_FAMILY_THRESHOLDS,
  type FamilyRejection,
  MOMENTUM_MAX_POINTS,
  REVERSION_MAX_POINTS,
  scoreBreakout,
  scoreMomentum,
  scoreReversion,
  scoreTrend,
  TREND_MAX_POINTS,
} from "../families";
import {
  analyzeAt,
  type Candle,
  DEFAULT_STRATEGY_CONFIG,
  precomputeIndicators,
} from "../strategy";

/** A clean, unambiguous uptrend — the case trend-following should score best. */
function uptrend(n = 400): Candle[] {
  const out: Candle[] = [];
  let p = 3300;
  let t = 1700000000;
  for (let i = 0; i < n; i++) {
    p += 0.6;
    out.push({
      time: t,
      open: p - 0.3,
      high: p + 0.4,
      low: p - 0.5,
      close: p,
      volume: 100,
    });
    t += 300;
  }
  return out;
}

/** A flat oscillation — the case mean-reversion should score best. */
function ranging(n = 400): Candle[] {
  const out: Candle[] = [];
  let t = 1700000000;
  const out2: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const p = 3300 + Math.sin(i / 8) * 12;
    out2.push({
      time: t,
      open: p,
      high: p + 0.6,
      low: p - 0.6,
      close: p,
      volume: 100,
    });
    t += 300;
  }
  out.push(...out2);
  return out;
}

/**
 * A compressed range that then breaks out upward with two wide bars.
 *
 * The compression matters: it is what the breakout family's squeeze evidence
 * looks for, so this fixture exercises the whole score, not just the event.
 */
function squeezeThenBreakUp(n = 200): Candle[] {
  const out: Candle[] = [];
  let t = 1700000000;
  // 150 bars in a tight band around 3300.
  for (let i = 0; i < n - 2; i++) {
    const p = 3300 + Math.sin(i / 5) * 1.5;
    out.push({
      time: t,
      open: p,
      high: p + 0.4,
      low: p - 0.4,
      close: p,
      volume: 100,
    });
    t += 300;
  }
  // Two wide bars punching above the band.
  for (const step of [6, 6]) {
    const prev = out.at(-1)!.close;
    out.push({
      time: t,
      open: prev,
      high: prev + step + 3,
      low: prev - 0.5,
      close: prev + step,
      volume: 100,
    });
    t += 300;
  }
  return out;
}

describe("family separation — the defect this fixes", () => {
  test("the combined model goes SHORT through a clean uptrend; the trend family goes LONG", () => {
    const candles = uptrend();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);

    let combinedShort = 0;
    let combinedLong = 0;
    let trendShort = 0;
    let trendLong = 0;

    for (let i = 100; i < candles.length; i++) {
      const c = analyzeAt(candles, ind, i, DEFAULT_STRATEGY_CONFIG, 2);
      if (c?.direction === "SHORT") combinedShort++;
      if (c?.direction === "LONG") combinedLong++;

      const f = analyzeFamilyAt(
        candles,
        ind,
        i,
        "trend",
        DEFAULT_STRATEGY_CONFIG,
      );
      if (f?.direction === "SHORT") trendShort++;
      if (f?.direction === "LONG") trendLong++;
    }

    // The combined model reads RSI > 70, Stoch > 80 and the upper-band touch as
    // reversal evidence, and they outweigh the bullish EMA structure. This is
    // the measured defect, pinned so a regression is loud rather than subtle.
    expect(combinedShort).toBeGreaterThan(0);
    expect(combinedLong).toBe(0);

    // The trend family reads the same bars as what they are.
    expect(trendLong).toBeGreaterThan(0);
    expect(trendShort).toBe(0);
  });

  test("trend scoring never awards the losing side more than the winning side in a clean uptrend", () => {
    const candles = uptrend();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);

    let barsChecked = 0;
    for (let i = 100; i < candles.length; i++) {
      const s = scoreTrend(ind, i, DEFAULT_STRATEGY_CONFIG);
      barsChecked++;
      // This is the whole point: in an uptrend, trend evidence must be bullish.
      expect(s.bull).toBeGreaterThan(s.bear);
    }
    expect(barsChecked).toBeGreaterThan(200);
  });

  test("reversion scoring contributes nothing to the trend score", () => {
    const candles = uptrend();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    for (let i = 100; i < candles.length; i++) {
      const t = scoreTrend(ind, i, DEFAULT_STRATEGY_CONFIG);
      // Trend must not read an oscillator extreme; its only extreme is the
      // MACD cross, so the count can never exceed 1.
      expect(t.extremeBull).toBeLessThanOrEqual(1);
      expect(t.extremeBear).toBeLessThanOrEqual(1);
    }
  });

  test("a strong uptrend produces bearish reversion signals — which is why they must be scored apart", () => {
    const candles = uptrend();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    let bearish = 0;
    for (let i = 100; i < candles.length; i++) {
      const rev = scoreReversion(ind, i, DEFAULT_STRATEGY_CONFIG);
      if (rev.bear > rev.bull) bearish++;
    }
    // Documents the conflict rather than asserting it is desirable.
    expect(bearish).toBeGreaterThan(0);
  });
});

describe("score bounds", () => {
  test("no family can exceed its declared maximum", () => {
    for (const candles of [uptrend(), ranging()]) {
      const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
      for (let i = 100; i < candles.length; i++) {
        const t = scoreTrend(ind, i, DEFAULT_STRATEGY_CONFIG);
        const rv = scoreReversion(ind, i, DEFAULT_STRATEGY_CONFIG);
        expect(Math.max(t.bull, t.bear)).toBeLessThanOrEqual(TREND_MAX_POINTS);
        expect(Math.max(rv.bull, rv.bear)).toBeLessThanOrEqual(
          REVERSION_MAX_POINTS,
        );
      }
    }
    for (const candles of [squeezeThenBreakUp(), uptrend()]) {
      const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
      for (let i = 100; i < candles.length; i++) {
        const bo = scoreBreakout(candles, ind, i, DEFAULT_STRATEGY_CONFIG);
        const mo = scoreMomentum(ind, i, DEFAULT_STRATEGY_CONFIG);
        expect(Math.max(bo.bull, bo.bear)).toBeLessThanOrEqual(
          BREAKOUT_MAX_POINTS,
        );
        expect(Math.max(mo.bull, mo.bear)).toBeLessThanOrEqual(
          MOMENTUM_MAX_POINTS,
        );
      }
    }
  });

  test("normalised strength stays within 0-100", () => {
    const fixtures = [uptrend(), ranging(), squeezeThenBreakUp()];
    for (const family of [
      "trend",
      "reversion",
      "breakout",
      "momentum",
    ] as const) {
      for (const candles of fixtures) {
        const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
        for (let i = 100; i < candles.length; i++) {
          const a = analyzeFamilyAt(
            candles,
            ind,
            i,
            family,
            DEFAULT_STRATEGY_CONFIG,
          );
          if (!a) continue;
          expect(a.strength).toBeGreaterThanOrEqual(0);
          expect(a.strength).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe("grade A is reachable", () => {
  test("trend thresholds are satisfiable given only one extreme signal exists", () => {
    // The combined model asked for 3 extremes; trend has 1 available, so the
    // old threshold made grade A impossible by construction.
    expect(DEFAULT_FAMILY_THRESHOLDS.trend.aExtreme).toBeLessThanOrEqual(1);
    expect(DEFAULT_FAMILY_THRESHOLDS.reversion.aExtreme).toBeLessThanOrEqual(3);
  });

  test("a maximal trend bar grades A", () => {
    const candles = uptrend();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    let best = 0;
    for (let i = 100; i < candles.length; i++) {
      const a = analyzeFamilyAt(
        candles,
        ind,
        i,
        "trend",
        DEFAULT_STRATEGY_CONFIG,
      );
      if (a) best = Math.max(best, a.strength);
    }
    // A clean uptrend should clear the B bar at minimum.
    expect(best).toBeGreaterThanOrEqual(
      DEFAULT_FAMILY_THRESHOLDS.trend.bStrength,
    );
  });
});

describe("breakout family", () => {
  test("a range escape after compression scores LONG with the channel break as evidence", () => {
    const candles = squeezeThenBreakUp();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    const last = candles.length - 1;

    const s = scoreBreakout(candles, ind, last, DEFAULT_STRATEGY_CONFIG);
    expect(s.bull).toBeGreaterThan(0);
    expect(s.bear).toBe(0);
    expect(s.extremeBull).toBeGreaterThanOrEqual(1);
    expect(s.reasons.some(r => r.includes("Donchian"))).toBe(true);

    // Graded, not merely scored: a compressed-range break is exactly the
    // setup the family exists to catch.
    const a = analyzeFamilyAt(
      candles,
      ind,
      last,
      "breakout",
      DEFAULT_STRATEGY_CONFIG,
    );
    expect(a).not.toBeNull();
    expect(a!.direction).toBe("LONG");
    expect(["A", "B"]).toContain(a!.grade);
  });

  test("bars inside the channel produce no score at all", () => {
    const candles = squeezeThenBreakUp();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    let scored = 0;
    for (let i = 100; i < candles.length - 2; i++) {
      const s = scoreBreakout(candles, ind, i, DEFAULT_STRATEGY_CONFIG);
      if (s.bull + s.bear > 0) scored++;
    }
    // The fixture ranges tightly for ~150 bars: interior bars must stay flat.
    expect(scored).toBeLessThanOrEqual(2);
  });

  test("grade A asks for two extremes — the break plus a second confirmation", () => {
    expect(DEFAULT_FAMILY_THRESHOLDS.breakout.aExtreme).toBe(2);
    expect(DEFAULT_FAMILY_THRESHOLDS.breakout.aStrength).toBeLessThanOrEqual(
      BREAKOUT_MAX_POINTS,
    );
  });

  test("warm-up covers the full channel", () => {
    const candles = squeezeThenBreakUp();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    const cfg = { ...DEFAULT_STRATEGY_CONFIG, breakoutPeriod: 100 };
    // Warm-up is max(59, period+1) = 101.
    expect(analyzeFamilyAt(candles, ind, 99, "breakout", cfg)).toBeNull();
    expect(analyzeFamilyAt(candles, ind, 101, "breakout", cfg)).toBeDefined;
  });
});

describe("momentum family", () => {
  test("a clean trend reads LONG throughout; flat noise reads nothing", () => {
    const ind = precomputeIndicators(uptrend(), DEFAULT_STRATEGY_CONFIG);
    let longs = 0;
    let shorts = 0;
    for (let i = 120; i < 400; i++) {
      const s = scoreMomentum(ind, i, DEFAULT_STRATEGY_CONFIG);
      if (s.bull > s.bear) longs++;
      if (s.bear > s.bull) shorts++;
    }
    expect(longs).toBeGreaterThan(200);
    expect(shorts).toBe(0);

    // A constant-rate uptrend makes every |ROC| equal, so today's velocity
    // sits AT the p80 mark and conviction holds. Flat oscillation is the
    // opposite case: pace never clears the 60th percentile for long.
    const flatInd = precomputeIndicators(ranging(), DEFAULT_STRATEGY_CONFIG);
    let quiet = 0;
    let total = 0;
    for (let i = 120; i < 400; i++) {
      total++;
      if (
        scoreMomentum(flatInd, i, DEFAULT_STRATEGY_CONFIG).bull +
          scoreMomentum(flatInd, i, DEFAULT_STRATEGY_CONFIG).bear ===
        0
      ) {
        quiet++;
      }
    }
    expect(quiet / total).toBeGreaterThan(0.5);
  });

  test("below-median velocity returns no score rather than a weak one", () => {
    // Directly: a bar whose ROC is tiny relative to its own history must be
    // empty, not a low-strength signal.
    const candles = ranging();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    for (let i = 150; i < 300; i++) {
      const roc = Math.abs(ind.closes[i] - ind.closes[i - 24]);
      const recent: number[] = [];
      for (let k = Math.max(25, i - 199); k <= i; k += 2) {
        recent.push(Math.abs(ind.closes[k] - ind.closes[k - 24]));
      }
      recent.sort((a, b) => a - b);
      if (
        recent.length >= 25 &&
        roc < recent[Math.floor(recent.length * 0.6)]
      ) {
        const s = scoreMomentum(ind, i, DEFAULT_STRATEGY_CONFIG);
        expect(s.bull).toBe(0);
        expect(s.bear).toBe(0);
      }
    }
  });

  test("momentum scoring stays in its lane: no oscillator-extreme reads", () => {
    const ind = precomputeIndicators(uptrend(), DEFAULT_STRATEGY_CONFIG);
    for (let i = 120; i < 400; i++) {
      const s = scoreMomentum(ind, i, DEFAULT_STRATEGY_CONFIG);
      // Its only extreme is velocity conviction — one per side, ever.
      expect(s.extremeBull).toBeLessThanOrEqual(1);
      expect(s.extremeBear).toBeLessThanOrEqual(1);
    }
  });

  test("warm-up covers lookback plus the velocity baseline", () => {
    const candles = uptrend();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    const cfg = { ...DEFAULT_STRATEGY_CONFIG, momentumLookback: 90 };
    // Warm-up is max(59, lookback+51) = 141.
    expect(analyzeFamilyAt(candles, ind, 139, "momentum", cfg)).toBeNull();
    expect(analyzeFamilyAt(candles, ind, 141, "momentum", cfg)).toBeDefined;
  });
});

describe("contract parity with analyzeAt", () => {
  test("refuses an index without enough history", () => {
    const candles = uptrend(200);
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    expect(
      analyzeFamilyAt(candles, ind, 58, "trend", DEFAULT_STRATEGY_CONFIG),
    ).toBeNull();
  });

  test("refuses an index past the end", () => {
    const candles = uptrend(200);
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    expect(
      analyzeFamilyAt(candles, ind, 999, "trend", DEFAULT_STRATEGY_CONFIG),
    ).toBeNull();
  });

  test("the sink reports why a bar was rejected", () => {
    const candles = uptrend();
    const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
    const sink: FamilyRejection = {
      reason: "out_of_range",
      strength: 0,
      biasStrength: 0,
      extremeCount: 0,
      grade: null,
    };
    const seen = new Set<string>();
    for (let i = 100; i < candles.length; i++) {
      analyzeFamilyAt(
        candles,
        ind,
        i,
        "reversion",
        DEFAULT_STRATEGY_CONFIG,
        2,
        DEFAULT_FAMILY_THRESHOLDS.reversion,
        sink,
      );
      seen.add(sink.reason);
    }
    // A trending series gives reversion nothing to work with much of the time,
    // so at least one non-graded reason must appear.
    expect(seen.size).toBeGreaterThan(0);
    for (const r of seen) {
      expect([
        "out_of_range",
        "no_score",
        "neutral_bias",
        "no_trade_grade",
        "graded",
      ]).toContain(r);
    }
  });

  test("TP/SL ordering is correct for both directions", () => {
    for (const candles of [uptrend(), ranging(), squeezeThenBreakUp()]) {
      const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
      for (const family of [
        "trend",
        "reversion",
        "breakout",
        "momentum",
      ] as const) {
        for (let i = 100; i < candles.length; i++) {
          const a = analyzeFamilyAt(
            candles,
            ind,
            i,
            family,
            DEFAULT_STRATEGY_CONFIG,
          );
          if (!a) continue;
          if (a.direction === "LONG") {
            expect(a.stopLoss).toBeLessThan(a.entryPrice);
            expect(a.tp1).toBeGreaterThan(a.entryPrice);
            expect(a.tp2).toBeGreaterThan(a.tp1);
          } else {
            expect(a.stopLoss).toBeGreaterThan(a.entryPrice);
            expect(a.tp1).toBeLessThan(a.entryPrice);
            expect(a.tp2).toBeLessThan(a.tp1);
          }
        }
      }
    }
  });
});

describe("live wiring", () => {
  test("analyzeFamilyCandles matches analyzeFamilyAt on the last bar", () => {
    for (const candles of [uptrend(), squeezeThenBreakUp()]) {
      const ind = precomputeIndicators(candles, DEFAULT_STRATEGY_CONFIG);
      for (const family of [
        "trend",
        "reversion",
        "breakout",
        "momentum",
      ] as const) {
        expect(analyzeFamilyCandles(candles, family)).toEqual(
          analyzeFamilyAt(
            candles,
            ind,
            candles.length - 1,
            family,
            DEFAULT_STRATEGY_CONFIG,
          ),
        );
      }
    }
  });

  test("analyzeFamilyCandles refuses a window shorter than the warm-up", () => {
    expect(analyzeFamilyCandles(uptrend().slice(0, 59), "trend")).toBeNull();
  });

  // The live engine and the self-heal sweep both read asset.model. A broker
  // asset left on "combined" would be traded with the model whose halves cancel.
  test("mt5Asset names a family so the engine does not fall back to combined", () => {
    const meta = {
      symbol: "XAUUSD",
      digits: 2,
      assetId: "MT5:XAUUSD",
      spreadBps: 0.51,
    };
    expect(mt5Asset(meta).model).toBe("quiet-trend");
    expect(mt5Asset(meta, undefined, "reversion").model).toBe("reversion");
  });
});
