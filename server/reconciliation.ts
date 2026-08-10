/**
 * State reconciliation — the "ghost trade" preventer.
 *
 * On startup the engine already calls recoverGap(), which replays stored candles
 * bar-by-bar to resolve exits that happened while the process was down. That
 * covers the normal sleep/restart case, but candle history is bounded: if the
 * bot was offline long enough that the gap spans more than what fetchCandles
 * returns, stale positions survive recovery and block new signals.
 *
 * reconcileState() is the safety net for that edge case. It fetches the current
 * live price for every open idea and asks a single, unambiguous question:
 *
 *   • Is the current price definitively on the wrong side of the stop loss?
 *     → The SL was hit at some point. Force-close as STOPPED at SL price.
 *
 *   • Is the current price definitively beyond TP2?
 *     → TP2 was reached. Force-close as TP2_HIT at TP2 price.
 *
 * Both checks work off the current price, so they can only catch the clear-cut
 * cases: a trade sitting comfortably inside its range is left alone for the
 * normal monitor cycle. That is intentional — this function is not a substitute
 * for gap recovery, it is a backstop for positions that gap recovery could not
 * resolve because the candle window did not reach back far enough.
 *
 * Call after recoverGap() and before the first monitorIdeas() tick.
 */

import { getEnabledAssets } from "../core/assets";
import { roundTo } from "../core/strategy";
import type { EngineDeps } from "./engine";
import { publish } from "./events";
import { fetchPrices, venueSymbols } from "./market";

/**
 * Compare every open idea against the current live price and force-close any
 * that are definitively outside their range.
 *
 * Returns the count of ideas resolved.
 */
export async function reconcileState(deps: EngineDeps): Promise<number> {
  const { db } = deps;
  const assets = deps.assets ?? getEnabledAssets();

  console.log("[reconcile] Starting state reconciliation...");

  const open = db.openIdeas();
  if (open.length === 0) {
    console.log("[reconcile] No open ideas. Nothing to reconcile.");
    return 0;
  }

  const active = assets.filter(a => open.some(i => i.asset === a.id));
  if (active.length === 0) return 0;

  let prices: Map<string, number>;
  try {
    prices = await fetchPrices(venueSymbols(active), { fetcher: deps.fetcher });
  } catch (e) {
    console.error(
      "[reconcile] Could not fetch prices — skipping reconciliation:",
      e instanceof Error ? e.message : String(e),
    );
    return 0;
  }

  let resolved = 0;
  const now = deps.now?.() ?? Date.now();

  for (const asset of active) {
    const price = prices.get(asset.dataSourceSymbol);
    if (price === undefined) continue;

    const r = (n: number) => roundTo(n, asset.pricePrecision);

    for (const idea of open.filter(i => i.asset === asset.id)) {
      const isLong = idea.direction === "LONG";
      // After TP1, the SL moves to breakeven (entry_price) then trails upward.
      const effectiveSL = idea.trailing_sl ?? idea.stop_loss;

      // ── Ghost trade: current price is definitively past the stop loss ────────
      // For a LONG, price being below SL right now means it had to pass through
      // SL at some point. Same logic mirrored for SHORT.
      const slBreached = isLong ? price < effectiveSL : price > effectiveSL;
      if (slBreached) {
        const pnl = r(
          isLong
            ? effectiveSL - idea.entry_price
            : idea.entry_price - effectiveSL,
        );
        db.updateIdea(idea.id, {
          status: "STOPPED",
          pnl_points: pnl,
          resolved_at: now,
        });
        db.addIdeaEvent(idea.id, "SL_HIT", effectiveSL, now);
        db.logJournal({
          eventType: "SL_HIT",
          asset: asset.id,
          ideaId: idea.id,
          direction: idea.direction,
          price: effectiveSL,
          details:
            `[RECONCILE] Ghost trade: ${idea.direction} SL @ ${effectiveSL} | ` +
            `entry ${idea.entry_price} | live ${price} | ` +
            `${pnl >= 0 ? "+" : ""}${pnl} pts`,
          metadata: { reconciliation: true, currentPrice: price },
        });
        console.warn(
          `[reconcile] Ghost trade closed: ${idea.asset} ${idea.direction} #${idea.id} ` +
            `(live=${price}, SL=${effectiveSL})`,
        );
        resolved++;
        continue;
      }

      // ── TP2 cleared: current price is definitively beyond the second target ──
      // If price is currently past TP2, TP2 must have been touched at some
      // point, so we book the full target regardless of current status.
      const tp2Cleared = isLong ? price > idea.tp2 : price < idea.tp2;
      if (tp2Cleared) {
        const pnl = r(
          isLong ? idea.tp2 - idea.entry_price : idea.entry_price - idea.tp2,
        );
        db.updateIdea(idea.id, {
          status: "TP2_HIT",
          pnl_points: pnl,
          resolved_at: now,
        });
        db.addIdeaEvent(idea.id, "TP2_HIT", idea.tp2, now);
        db.logJournal({
          eventType: "TP2_HIT",
          asset: asset.id,
          ideaId: idea.id,
          direction: idea.direction,
          price: idea.tp2,
          details:
            `[RECONCILE] Ghost trade: ${idea.direction} TP2 @ ${idea.tp2} | ` +
            `entry ${idea.entry_price} | live ${price} | +${pnl} pts`,
          metadata: { reconciliation: true, currentPrice: price },
        });
        console.warn(
          `[reconcile] Ghost trade closed at TP2: ${idea.asset} ${idea.direction} #${idea.id} ` +
            `(live=${price}, TP2=${idea.tp2})`,
        );
        resolved++;
      }
    }
  }

  if (resolved > 0) {
    publish("ideas");
    publish("journal");
  }

  console.log(`[reconcile] Complete. Resolved ${resolved} ghost trade(s).`);
  return resolved;
}
