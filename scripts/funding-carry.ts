/**
 * Funding-CARRY measurement — not a directional claim.
 *
 * Round 3 asked "does price revert after extreme funding" (answered NO).
 * This asks the harvest question instead: while funding sits above a
 * threshold, a short-perp/long-spot book COLLECTS the payments regardless of
 * direction. The measurable quantity is the expected sum of settlements
 * collected during an episode, against the fixed cost of putting the two
 * legs on and taking them off.
 *
 * Costs (spot CFD/exchange taker both legs + perp taker both legs):
 *   entry: spot buy taker + perp short taker
 *   exit:  spot sell taker + perp buy taker
 *   ≈ 4 × taker fee ≈ 4 × 5 bps = 20 bps round trip for everything.
 * Basis drift is NOT modelled here — that honesty comes after the raw rent
 * is measured; if the gross carry cannot clear 20 bps, nothing else matters.
 */
import { fetchFundingRates } from "../server/market-futures";

const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const to = Math.floor(Date.now() / 1000);
const from = to - 1095 * 86400; // three years
const COST_BPS = 20;

for (const symbol of SYMBOLS) {
  const events = await fetchFundingRates(symbol, from, to);
  if (events.length < 100) {
    console.log(`${symbol}: only ${events.length} settlements, skipping`);
    continue;
  }
  const rates = events.map(e => e.rate);
  const sorted = [...rates].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.floor((sorted.length - 1) * p)] * 10000; // → bps

  console.log(`\n=== ${symbol} | ${events.length} settlements over 3y ===`);
  console.log(
    `rate percentiles (bps/settlement): p10 ${pct(0.1).toFixed(2)} · ` +
      `p50 ${pct(0.5).toFixed(2)} · p90 ${pct(0.9).toFixed(2)} · ` +
      `p95 ${pct(0.95).toFixed(2)} · p99 ${pct(0.99).toFixed(2)}`,
  );

  // Episode analysis: enter the harvest when the rate crosses ABOVE a
  // threshold, exit when it falls back below half the threshold. Sum what
  // the book collects in between (short perp receives positive funding).
  for (const thresholdBps of [3, 5, 8, 12]) {
    const thr = thresholdBps / 10000;
    const exitThr = thr / 2;
    let episodes = 0;
    let collecting = false;
    let sum = 0;
    const sums: Array<{ sum: number; bars: number }> = [];
    let bars = 0;
    for (const e of events) {
      if (!collecting && e.rate >= thr) {
        collecting = true;
        sum = 0;
        bars = 0;
      }
      if (collecting) {
        sum += e.rate * 10000; // bps collected this settlement
        bars++;
        if (e.rate < exitThr) {
          sums.push({ sum, bars });
          collecting = false;
          episodes++;
        }
      }
    }
    if (collecting) sums.push({ sum, bars });
    episodes = sums.length;
    if (episodes === 0) {
      console.log(
        `thr ${thresholdBps}bps: no episode crossed and held — nothing to harvest`,
      );
      continue;
    }
    const total = sums.reduce((s, x) => s + x.sum, 0);
    const avg = total / episodes;
    const avgBars = sums.reduce((s, x) => s + x.bars, 0) / episodes;
    const posEpisodes = sums.filter(x => x.sum > COST_BPS).length;
    const netAnnualized = sums.reduce((s, x) => s + (x.sum - COST_BPS), 0) / 3;
    console.log(
      `thr ${String(thresholdBps).padStart(2)}bps: ${String(episodes).padStart(3)} episodes · ` +
        `avg collect ${avg.toFixed(1)} bps over ${avgBars.toFixed(1)} settlements · ` +
        `net of ${COST_BPS}bps RT: ${(total - episodes * COST_BPS).toFixed(0)} bps total, ` +
        `${posEpisodes}/${episodes} episodes profitable · ` +
        `~${(netAnnualized).toFixed(1)} bps/yr`,
    );
  }
}
