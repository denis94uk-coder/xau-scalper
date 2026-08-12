/**
 * Placing accepted signals in MetaTrader 5.
 *
 * The engine's job ends at "this is a trade worth taking". This module is the
 * only place that turns that judgement into an order, and it exists separately
 * from the engine for one reason: everything upstream is reversible analysis
 * and everything here spends money. A reader auditing "can this thing trade my
 * account?" should have exactly one file to read.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS A NORMAL STATE
 * Nothing here throws. Execution being off, the terminal being closed, the
 * position cap being reached and an unmapped symbol are all ordinary operating
 * conditions rather than faults, and each is recorded against the signal it
 * belongs to. A signal that was generated but not placed must be visibly
 * different in the journal from one that was never generated — otherwise the
 * forward-test record silently mixes trades that happened with trades that
 * merely could have.
 *
 * WHAT IT DOES NOT DO
 * It does not manage the position afterwards. The stop and target go to the
 * broker with the order, so if this app dies mid-trade the account is still
 * protected by the broker's own bracket rather than by a process that has
 * stopped running. Trailing stops remain the engine's business.
 */

import type { AppConfig } from "../core/config";
import type { Db, TradingIdea } from "./db";
import { publish } from "./events";
import { sendOrder } from "./mt5bridge";

export interface ExecutionOutcome {
  placed: boolean;
  reason: string;
}

/**
 * Place one accepted idea, when everything is armed and agrees.
 *
 * `cfg` is passed in rather than read from a store so a caller can decide the
 * snapshot: an order must be judged against the settings that were live when
 * the signal fired, not against a save that landed a moment later.
 */
export function executeIdea(
  db: Db,
  cfg: AppConfig,
  idea: TradingIdea,
): ExecutionOutcome {
  // The one refusal that is NOT recorded. Disarmed is the app's resting state,
  // and a journal row per signal would bury the events that mean something
  // under a running commentary on a switch the operator already knows is off.
  if (!cfg.mt5.enabled || !cfg.mt5.executionEnabled) {
    return { placed: false, reason: "MT5 execution is not armed" };
  }

  /** Record a refusal against the signal, so it is visible beside the idea. */
  const skip = (reason: string): ExecutionOutcome => {
    db.logJournal({
      eventType: "ORDER_SKIPPED",
      asset: idea.asset,
      source: "mt5",
      ideaId: idea.id,
      direction: idea.direction,
      price: idea.entry_price,
      details: reason,
    });
    publish("journal");
    return { placed: false, reason };
  };

  const asset = cfg.assets.find(a => a.id === idea.asset);
  if (!asset) {
    return skip(`${idea.asset} is not a configured instrument`);
  }

  // An order is routed by the BROKER's symbol, which is only meaningful for an
  // instrument the terminal actually serves. Sending an exchange ticker like
  // BTCUSDT to MT5 would be rejected by the broker at best and fill something
  // unintended at worst, so it is refused here where the reason is still clear.
  if (asset.dataSource !== "mt5") {
    return skip(`${idea.asset} is not a MetaTrader 5 instrument`);
  }

  const result = sendOrder(cfg, {
    symbol: asset.dataSourceSymbol,
    direction: idea.direction,
    lots: cfg.mt5.lotSize,
    stopLoss: idea.stop_loss,
    // TP2, not TP1: the broker holds one bracket, and it must be the level the
    // trade is actually aiming at. The TP1 partial stays with the engine's
    // monitor, which is the only side that knows about partials at all.
    takeProfit: idea.tp2,
    ideaId: idea.id,
    comment: `teo-${idea.id}-${idea.grade}`,
  });

  db.logJournal({
    eventType: result.sent ? "ORDER_SENT" : "ORDER_SKIPPED",
    asset: idea.asset,
    source: "mt5",
    ideaId: idea.id,
    direction: idea.direction,
    price: idea.entry_price,
    details: result.reason,
    metadata: {
      symbol: asset.dataSourceSymbol,
      lots: cfg.mt5.lotSize,
      stopLoss: idea.stop_loss,
      takeProfit: idea.tp2,
      orderId: result.order?.id ?? null,
    },
  });
  publish("journal");

  if (result.sent) {
    console.log(
      `[mt5] order for idea ${idea.id}: ${idea.direction} ${asset.dataSourceSymbol} ${cfg.mt5.lotSize} lots`,
    );
    publish("mt5");
  }

  return { placed: result.sent, reason: result.reason };
}
