/**
 * Trading cost model.
 *
 * Nothing in this system modelled costs before: every P&L number — backtest,
 * live journal, Teo's sweep — was gross. For a scalper that is not a rounding
 * error. With a 1.5×ATR stop and TP1 at 1.2R, the whole theoretical edge per
 * trade is a bit over one ATR; round-trip costs on a 5m bar are a meaningful
 * fraction of that, and they are paid on EVERY trade while the edge is only
 * collected on the winners.
 *
 * The asymmetry is the part that actually decides profitability:
 *
 *   * Take-profits are resting LIMIT orders. They fill at your price. You pay a
 *     fee, and on most venues a lower (maker) one. No slippage.
 *   * Stops are MARKET orders triggered into a move that is going against you,
 *     usually the fastest part of it. You pay the spread, taker fees, AND
 *     slippage past the trigger — precisely when liquidity is thinnest.
 *
 * A model that applies one symmetric cost to both sides understates losses and
 * flatters the strategy. This one does not.
 *
 * All rates are in basis points (1 bp = 0.01%) of notional, which keeps them
 * comparable across a $3,400 gold contract and a $15 LINK.
 */

export interface CostModel {
  /** Half the quoted bid/ask, paid on any market order. */
  halfSpreadBps: number;
  /** Fee paid when crossing the book (market orders, stop fills). */
  takerFeeBps: number;
  /** Fee paid when a resting order is filled (take-profits). */
  makerFeeBps: number;
  /**
   * Adverse fill past the trigger price on a stop.
   *
   * This is where most unmodelled loss hides. A stop is triggered by the move
   * that is hurting you; the fill lands behind the trigger, and the faster the
   * move the further behind.
   */
  stopSlippageBps: number;
}

/**
 * Conservative defaults for a retail account on a liquid venue.
 *
 * Deliberately pessimistic rather than optimistic: a strategy that survives
 * costs that are too high is a real finding, while one that only works because
 * costs were too low is the expensive kind of mistake.
 */
export const DEFAULT_COST_MODEL: CostModel = {
  halfSpreadBps: 1.5,
  takerFeeBps: 4,
  makerFeeBps: 2,
  stopSlippageBps: 5,
};

/** Costs are zero — for isolating strategy behaviour in tests, never for results. */
export const ZERO_COST_MODEL: CostModel = {
  halfSpreadBps: 0,
  takerFeeBps: 0,
  makerFeeBps: 0,
  stopSlippageBps: 0,
};

const BPS = 1 / 10_000;

export type ExitKind = "TP" | "SL" | "TRAIL_SL";

/**
 * Cost of ENTERING a position, in price points.
 *
 * Entries are market orders in this strategy — the signal fires on a closing
 * bar and the engine takes the price it can get.
 */
export function entryCost(price: number, model: CostModel): number {
  return price * (model.halfSpreadBps + model.takerFeeBps) * BPS;
}

/**
 * Cost of EXITING a position, in price points.
 *
 * `kind` decides the treatment: a take-profit rests and fills at its price; a
 * stop crosses the spread and slips.
 */
export function exitCost(
  price: number,
  kind: ExitKind,
  model: CostModel,
): number {
  if (kind === "TP") {
    return price * model.makerFeeBps * BPS;
  }
  return (
    price *
    (model.halfSpreadBps + model.takerFeeBps + model.stopSlippageBps) *
    BPS
  );
}

/**
 * Convert a gross points result into a net one.
 *
 * `grossPoints` is the raw level difference the strategy aimed at; the return
 * value is what would actually have landed in the account, in the same units.
 */
export function netPoints(
  grossPoints: number,
  entryPrice: number,
  exitPrice: number,
  kind: ExitKind,
  model: CostModel,
): number {
  return (
    grossPoints -
    entryCost(entryPrice, model) -
    exitCost(exitPrice, kind, model)
  );
}

/** Total round-trip cost in points, for reporting and for sizing decisions. */
export function roundTripCost(
  entryPrice: number,
  exitPrice: number,
  kind: ExitKind,
  model: CostModel,
): number {
  return entryCost(entryPrice, model) + exitCost(exitPrice, kind, model);
}

/**
 * The win rate a strategy must EXCEED just to break even after costs.
 *
 * This is the number that decides whether a setup is worth taking, and the
 * system had no notion of it. Given an average win and average loss in points
 * (already net of costs), a strategy breaks even when
 *
 *     p · avgWin = (1 − p) · avgLoss
 *
 * so p = avgLoss / (avgWin + avgLoss). Comparing observed win rate against this
 * — rather than against 50% — is what tells you whether an edge exists.
 *
 * Returns null when the inputs cannot describe a tradeable system (no wins and
 * no losses), rather than a misleading 0.
 */
export function breakevenWinRate(
  avgWin: number,
  avgLoss: number,
): number | null {
  const w = Math.abs(avgWin);
  const l = Math.abs(avgLoss);
  if (w + l === 0) return null;
  return (l / (w + l)) * 100;
}

/**
 * Expectancy per trade in points: what one trade is worth on average.
 *
 * Positive expectancy after costs is the only definition of edge that matters.
 * winRate is a percentage (0-100); avgWin and avgLoss are net points, avgLoss
 * given as a positive magnitude.
 */
export function expectancy(
  winRate: number,
  avgWin: number,
  avgLoss: number,
): number {
  const p = winRate / 100;
  return p * Math.abs(avgWin) - (1 - p) * Math.abs(avgLoss);
}
