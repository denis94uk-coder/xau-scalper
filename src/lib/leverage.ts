/**
 * Leverage / liquidation math shared by the simulator and live idea views.
 *
 * One formula everywhere: liquidation hits at roughly 100 ÷ leverage %
 * against the entry, minus a 0.5% maintenance-margin buffer. A stop-loss
 * wider than that distance cannot protect the position — the venue kills it
 * first.
 */

export function liquidationPct(leverage: number): number {
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  return 100 / lev - 0.5;
}

/** Stop distance as % of entry. null when uncomputable. */
export function stopPctOf(entryPrice: number, stopLoss: number): number | null {
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopLoss) ||
    entryPrice === 0
  )
    return null;
  return (Math.abs(entryPrice - stopLoss) / Math.abs(entryPrice)) * 100;
}

export interface LiqAssessment {
  liqPrice: number;
  stopPct: number;
  liqPct: number;
  /** True when the stop triggers before liquidation at this leverage. */
  survives: boolean;
}

/** Liquidation price and stop-vs-liquidation verdict for a live idea. */
export function assessLiquidation(
  entryPrice: number,
  stopLoss: number,
  direction: "LONG" | "SHORT",
  leverage: number,
): LiqAssessment | null {
  const stopPct = stopPctOf(entryPrice, stopLoss);
  if (stopPct === null) return null;
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  const liqPct = liquidationPct(lev);
  const drift = (entryPrice * liqPct) / 100;
  const liqPrice =
    direction === "LONG" ? entryPrice - drift : entryPrice + drift;
  return { liqPrice, stopPct, liqPct, survives: stopPct <= liqPct };
}
