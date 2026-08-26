/**
 * Cross-asset lead-lag: trade one instrument off another's recent move.
 *
 * The claim family, from ROADMAP-CRYPTO.md's step 3: information lands on BTC
 * first — deepest book, fastest participants — and reaches alt books a bar or
 * several later through arb flows. If that delay is real, BTC's last few bars
 * predict the ALT's next few bars better than the alt's own history does,
 * which is something no single-series hypothesis can express. This is the
 * mechanism the injected-series support in core/edgescan.ts was built for.
 *
 * The catalogue is deliberately small: every entry spends a slot of the
 * shared Šidák budget in every future scan, and three windows on one
 * mechanism (short momentum, half-day momentum, single bar) answer "does BTC
 * lead" at the scales worth asking first. Lag variants beyond these are new
 * claims and need a new argument, not a parameter sweep.
 *
 * Every `signal` reads its series only up to index `i` and no further; the
 * look-ahead test in the suite enforces it with truncated pairs.
 */

import type { AlignedSeries, Hypothesis } from "./edgescan";
import type { Candle } from "./strategy";

/** The injected key every claim here reads. One leader per catalogue. */
const LEADER = "btc";

/**
 * The leader's return over `bars` bars ending at bar `i`, or null when the
 * aligned history is missing, stale (no bar shared with this timestamp), or
 * too short. A stale partner bar would quietly turn "BTC led" into "an old
 * BTC bar I am re-using", so absence voids the signal instead.
 */
function leaderReturn(
  candles: Candle[],
  i: number,
  bars: number,
  series: AlignedSeries | undefined,
): number | null {
  if (!series || i < bars) return null;
  const aux = series[LEADER]?.[i];
  if (!aux || aux.time !== candles[i].time) return null;
  const past = series[LEADER][i - bars];
  if (!past) return null;
  const ret = aux.close - past.close;
  return Number.isFinite(ret) ? ret : null;
}

function leadMomentum(bars: number): Hypothesis {
  return {
    name: `lead-btc-mom${bars}`,
    claim: `When BTC moved over the last ${bars} bars, the alt continues that direction next.`,
    signal(candles, i, series) {
      const ret = leaderReturn(candles, i, bars, series);
      if (ret === null || ret === 0) return null;
      return ret > 0 ? "LONG" : "SHORT";
    },
  };
}

/**
 * Single-bar version: the alt follows the leader's LAST CLOSED bar.
 *
 * Kept separate from momentum(1) semantics on purpose — it is registered as
 * its own claim because "arb flows settle within one bar" and "the drift
 * persists for hours" are different stories about the same plumbing, and the
 * budget price of asking both is two slots, not one blurred row.
 */
function leadLastBar(): Hypothesis {
  return {
    name: "lead-btc-bar1",
    claim:
      "The alt's next bars continue the direction of BTC's last closed bar.",
    signal(candles, i, series) {
      if (!series || i < 1) return null;
      const aux = series[LEADER]?.[i];
      const prev = i >= 1 ? series[LEADER][i - 1] : undefined;
      if (!aux || !prev || aux.time !== candles[i].time) return null;
      const move = aux.close - prev.close;
      if (move === 0) return null;
      return move > 0 ? "LONG" : "SHORT";
    },
  };
}

export const LEAD_HYPOTHESES: Hypothesis[] = [
  leadMomentum(3),
  leadMomentum(12),
  leadLastBar(),
];
