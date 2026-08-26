/**
 * Order-flow hypotheses from taker-side volume.
 *
 * Binance klines publish, per bar, how much base volume crossed BY aggressive
 * market BUY orders (field 9); the rest of the bar's volume is aggressive
 * selling. That is a positioning/pressure measurement sitting inside data we
 * have fetched since the beginning and never once kept — the flow family has
 * therefore never been tested here, while every price-only family has been
 * measured to exhaustion (rounds 1–8).
 *
 * The share is `takerBuyBase / volume`, scale-free across assets. Bars
 * lacking the field — MT5 syncs, older rows — void the signal: unknown flow
 * is not zero flow.
 *
 * Registered 2026-08-26 BEFORE any scan, permanent whatever they score:
 *   flow-thrust        extreme one-bar buy OR sell imbalance on loud volume
 *                      continues (initiative flow keeps pushing)
 *   flow-absorption    price makes an N-bar extreme while aggressive flow
 *                      leans the OTHER way — passive size is absorbing, revert
 *   flow-divergence    multi-bar flow share disagrees with multi-bar price
 *                      direction; trade toward the flow
 */

import type { Hypothesis } from "./edgescan";
import type { Candle } from "./strategy";

/**
 * Taker-buy share of bar `i`, or null when the bar carries no flow data or
 * zero volume. Every claim in this file goes through this gate.
 */
function buyShare(candles: Candle[], i: number): number | null {
  const c = candles[i];
  if (c.takerBuyBase === undefined || !Number.isFinite(c.takerBuyBase)) {
    return null;
  }
  if (!(c.volume > 0)) return null;
  return c.takerBuyBase / c.volume;
}

/** Median bar volume over the previous `n` bars. */
function medianVolume(candles: Candle[], i: number, n: number): number | null {
  const v: number[] = [];
  for (let k = i - n; k < i; k++) {
    if (candles[k].volume > 0) v.push(candles[k].volume);
  }
  if (v.length < Math.floor(n / 2)) return null;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function flowThrust(multiple: number): Hypothesis {
  return {
    name: `flow-thrust-${multiple}x`,
    claim: `A bar on ${multiple}× median volume where over 70% of flow was aggressive buying continues up; under 30% continues down.`,
    signal(candles, i) {
      if (i < 50) return null;
      const med = medianVolume(candles, i, 50);
      if (med === null || candles[i].volume < multiple * med) return null;
      const s = buyShare(candles, i);
      if (s === null) return null;
      if (s > 0.7) return "LONG";
      if (s < 0.3) return "SHORT";
      return null;
    },
  };
}

function flowAbsorption(lookback: number): Hypothesis {
  return {
    name: `flow-absorption-${lookback}`,
    claim: `Price making a ${lookback}-bar low while aggressive flow still leans to buys reverts up; mirror at highs.`,
    signal(candles, i) {
      if (i < lookback + 1) return null;
      const s = buyShare(candles, i);
      if (s === null) return null;

      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - lookback; k < i; k++) {
        if (candles[k].high > hi) hi = candles[k].high;
        if (candles[k].low < lo) lo = candles[k].low;
      }
      // New low but buyers dominated the crossing: passive bids absorbed the
      // aggression, so the residual demand is on the long side.
      if (candles[i].low < lo && s > 0.55) return "LONG";
      if (candles[i].high > hi && s < 0.45) return "SHORT";
      return null;
    },
  };
}

function flowDivergence(): Hypothesis {
  return {
    name: "flow-divergence-12",
    claim:
      "Over 12 bars, cumulative taker-buy share above 55% while price fell continues by reverting up; mirror for sells.",
    signal(candles, i) {
      if (i < 11) return null;
      let flows = 0;
      let sum = 0;
      for (let k = i - 11; k <= i; k++) {
        const s = buyShare(candles, k);
        if (s !== null) {
          sum += s;
          flows++;
        }
      }
      // At least half the window must carry flow data, or the average
      // describes a cherry-picked subset rather than the period.
      if (flows < 6) return null;
      const avg = sum / flows;

      const px = candles[i].close - candles[i - 12].close;
      if (px === 0) return null;
      // Price down while persistent aggressive buying: the pressure the tape
      // records contradicts the price path — fade the price.
      if (px < 0 && avg > 0.55) return "LONG";
      if (px > 0 && avg < 0.45) return "SHORT";
      return null;
    },
  };
}

export const FLOW_HYPOTHESES: Hypothesis[] = [
  flowThrust(3),
  flowThrust(5),
  flowAbsorption(24),
  flowDivergence(),
];
