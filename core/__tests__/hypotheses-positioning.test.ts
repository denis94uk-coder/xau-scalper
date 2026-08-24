/**
 * Positioning hypotheses must behave like any other hypothesis: honest about
 * missing data, blind to anything newer than the entry bar, and pinned to
 * their claimed mechanism on constructed series.
 *
 * Timeline convention in these fixtures: aux observations are spaced at the
 * SAME 300s cadence as the bars but LEAD them by 100 steps, so a bar near the
 * end of a short fixture can see a long positioning history behind it — which
 * is exactly the situation the real runner produces.
 */

import { describe, expect, test } from "bun:test";
import type {
  FundingEvent,
  OpenInterestPoint,
} from "../../server/market-futures";
import type { Candle } from "../../strategy";
import {
  fundingExtreme,
  oiConfirmedBreakout,
  oiWashout,
  stepAt,
  stepIndex,
} from "../hypotheses-positioning";

const START = Date.UTC(2024, 0, 1) / 1000;
const STEP = 300;

function candles(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 30000;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += i % 7 === 0 ? 10 : -10;
    out.push({
      time: START + i * STEP,
      open,
      high: Math.max(open, price) + 2,
      low: Math.min(open, price) - 2,
      close: price,
      volume: 100,
    });
  }
  return out;
}

/** Funding settlements leading the bars by 100 steps, one per STEP. */
function fundingSeries(rates: number[]): FundingEvent[] {
  return rates.map((rate, k) => ({
    time: START + (k - 100) * STEP,
    rate,
  }));
}

/** Open-interest observations on the same leading timeline. */
function oiSeries(contracts: number[]): OpenInterestPoint[] {
  return contracts.map((c, k) => ({
    time: START + (k - 100) * STEP,
    contracts: c,
    notional: c * 30000,
  }));
}

describe("stepIndex / stepAt", () => {
  const series = [{ time: 100 }, { time: 200 }, { time: 300 }];

  test("empty series has no opinion", () => {
    expect(stepIndex([], 500)).toBe(-1);
    expect(stepAt([], 500)).toBeNull();
  });

  test("before the first observation there is nothing to see", () => {
    expect(stepIndex(series, 50)).toBe(-1);
  });

  test("returns the latest observation at or before t", () => {
    expect(stepAt(series, 250)?.time).toBe(200);
    expect(stepAt(series, 300)?.time).toBe(300);
    expect(stepAt(series, 99_999)?.time).toBe(300);
  });
});

describe("fundingExtreme", () => {
  // 240 ordinary settlements alternating 1bp/3bp, so each trailing decile cut
  // lands on 3bp above and 1bp below. One extra settlement carries the value
  // under test and is the visible print for the final bars.
  const calm: number[] = [];
  for (let k = 0; k < 120; k++) calm.push(0.0001, 0.0003);

  test("an extreme positive settlement fades short", () => {
    const h = fundingExtreme(fundingSeries([...calm, 0.01]));
    const cs = candles(160); // opens past the final settlement
    expect(h.signal(cs, cs.length - 1)).toBe("SHORT");
  });

  test("an extreme negative settlement buys long", () => {
    const h = fundingExtreme(fundingSeries([...calm, -0.008]));
    const cs = candles(160);
    expect(h.signal(cs, cs.length - 1)).toBe("LONG");
  });

  test("ordinary funding has no opinion", () => {
    const h = fundingExtreme(fundingSeries([...calm, 0.0002]));
    const cs = candles(160);
    expect(h.signal(cs, cs.length - 1)).toBeNull();
  });

  test("too little history is an abstention, not a direction", () => {
    const h = fundingExtreme(fundingSeries([0.0001, 0.02, 0.0001]));
    const cs = candles(160);
    expect(h.signal(cs, cs.length - 1)).toBeNull();
  });

  test("never reads an observation newer than the entry bar", () => {
    const h = fundingExtreme(fundingSeries([...calm, 0.01]));
    const full = candles(160);
    const truncated = full.slice(0, 100);
    // Bar 99 sits BEFORE the extreme print (which leads by construction):
    // truncating everything after it must not change the answer.
    expect(h.signal(truncated, 99)).toBe(h.signal(full, 99));
  });
});

describe("oiConfirmedBreakout", () => {
  /** Genuine sideways market: closes wiggle ±1 around 30000, ranges stay tight. */
  function sidewaysCandles(): Candle[] {
    return Array.from({ length: 140 }, (_, k) => ({
      time: START + k * STEP,
      open: k % 2 === 0 ? 30000 : 30001,
      high: 30003,
      low: 29998,
      close: k % 2 === 0 ? 30001 : 30000,
      volume: 100,
    }));
  }

  function breakoutCandles(breakUp: boolean): Candle[] {
    const cs = sidewaysCandles();
    const last = cs[cs.length - 1];
    const target = breakUp ? 30100 : 29900;
    return [
      ...cs.slice(0, cs.length - 1),
      {
        ...last,
        close: target,
        high: Math.max(target, last.high),
        low: Math.min(target, last.low),
      },
    ];
  }

  test("range break with OI above its median goes long", () => {
    const h = oiConfirmedBreakout(
      oiSeries([...Array(130).fill(1000), ...Array(10).fill(1800)]),
      24,
    );
    expect(h.signal(breakoutCandles(true), 139)).toBe("LONG");
  });

  test("the mirrored break goes short", () => {
    const h = oiConfirmedBreakout(
      oiSeries([...Array(130).fill(1000), ...Array(10).fill(1800)]),
      24,
    );
    expect(h.signal(breakoutCandles(false), 139)).toBe("SHORT");
  });

  test("break without OI confirmation abstains", () => {
    const h = oiConfirmedBreakout(oiSeries(Array(140).fill(1000)), 24);
    expect(h.signal(breakoutCandles(true), 139)).toBeNull();
  });

  test("a close inside the range never fires", () => {
    const h = oiConfirmedBreakout(
      oiSeries([...Array(130).fill(1000), ...Array(10).fill(1800)]),
      24,
    );
    expect(h.signal(sidewaysCandles(), 139)).toBeNull();
  });
});

describe("oiWashout", () => {
  /** Last 12 bars drop 6% from the earlier closes. */
  function crashCandles(): Candle[] {
    const cs = candles(140);
    return cs.map((c, k) =>
      k >= cs.length - 12
        ? {
            ...c,
            open: c.open * 0.94,
            high: c.high * 0.94,
            low: c.low * 0.94,
            close: c.close * 0.94,
          }
        : c,
    );
  }

  test("price crash plus collapsing OI buys the washout", () => {
    const h = oiWashout(
      oiSeries([...Array(128).fill(1000), ...Array(12).fill(900)]),
      3,
      4,
      12,
    );
    expect(h.signal(crashCandles(), 139)).toBe("LONG");
  });

  test("crash without an OI collapse abstains", () => {
    const h = oiWashout(oiSeries(Array(140).fill(1000)), 3, 4, 12);
    expect(h.signal(crashCandles(), 139)).toBeNull();
  });

  test("OI collapse without a price crash abstains", () => {
    const h = oiWashout(
      oiSeries([...Array(128).fill(1000), ...Array(12).fill(900)]),
      3,
      4,
      12,
    );
    expect(h.signal(candles(140), 139)).toBeNull();
  });
});
