/**
 * Signal engine and position monitor. Ports convex/signalEngine.ts to run
 * in-process against SQLite, with three behavioural fixes.
 *
 * 1. NO WEEKEND GATE. The Convex version skipped Fri 22:00 → Sun 21:00 UTC on
 *    forex hours, but every registered asset trades 24/7 — and the gate applied
 *    to MONITORING too, so open positions went unwatched for ~49 hours a week.
 *    Session handling belongs to the asset definition, not a global clock.
 *
 * 2. GAP RECOVERY. A local process can be asleep. On startup, rather than
 *    checking open positions against the current price (which would book an
 *    exit at a price that was never available), the monitor replays the candles
 *    that elapsed while it was down and resolves exits at the bar that actually
 *    hit them.
 *
 * 3. EXITS CARRY THEIR ASSET. Every journal write is tagged, so exit rows stop
 *    defaulting to gold.
 */

import {
  type AssetDefinition,
  DEFAULT_ASSET_ID,
  getEnabledAssets,
} from "../convex/lib/assets";
import {
  analyzeCandles,
  type Candle,
  calcATR,
  roundTo,
} from "../convex/lib/strategy";
import type { Db, TradingIdea } from "./db";
import { publish } from "./events";
import {
  type Fetcher,
  fetchCandles,
  fetchPrices,
  intervalMs,
  venueSymbols,
} from "./market";

export interface EngineDeps {
  db: Db;
  fetcher?: Fetcher;
  assets?: AssetDefinition[];
  /** Overridable for tests. */
  now?: () => number;
}

const SIGNAL_INTERVAL = "5m";
const CONFIRM_INTERVAL = "15m";
/** Bars of history kept per asset/interval. 200 covers every indicator warm-up. */
const HISTORY_BARS = 200;

// ─── Candle upkeep ───

/**
 * Refresh stored candles for one asset/interval, fetching only what is missing.
 *
 * Returns the full window the strategy should analyse, read back from the
 * database so a restart mid-session still sees complete history.
 */
export async function syncCandles(
  deps: EngineDeps,
  asset: AssetDefinition,
  interval: string,
): Promise<Candle[]> {
  const { db } = deps;
  const stored = db.latestCandleTime(asset.id, interval);

  const fresh = await fetchCandles(asset.dataSourceSymbol, interval, {
    fetcher: deps.fetcher,
    limit: HISTORY_BARS,
    // Re-request the newest stored bar: it was probably still open, so its
    // high/low/close were not final when we saved it.
    since: stored,
  });
  db.saveCandles(asset.id, interval, fresh);

  return db.getCandles(asset.id, interval, HISTORY_BARS);
}

// ─── Signal generation ───

/**
 * Analyse one asset and record a signal if the setup qualifies.
 *
 * Mirrors the live rules: 5m primary, 15m must agree if it has an opinion,
 * A/B grades only, per-asset same-direction cooldown.
 */
export async function generateForAsset(
  deps: EngineDeps,
  asset: AssetDefinition,
): Promise<number | null> {
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();

  const candles5m = await syncCandles(deps, asset, SIGNAL_INTERVAL);
  const candles15m = await syncCandles(deps, asset, CONFIRM_INTERVAL);

  const price = candles5m.at(-1)?.close;
  if (price === undefined) return null;

  const a5 = analyzeCandles(candles5m, asset.config, asset.pricePrecision);
  const a15 = analyzeCandles(candles15m, asset.config, asset.pricePrecision);

  db.logJournal({
    eventType: "ENGINE_RUN",
    asset: asset.id,
    price,
    details:
      `[${asset.displaySymbol}] 5m: ${a5?.bias ?? "N/A"} ${a5?.grade ?? "-"} ` +
      `(${a5?.confidence ?? 0}%) | 15m: ${a15?.bias ?? "N/A"} ${a15?.grade ?? "-"}`,
    metadata: {
      fiveMin: a5 && {
        bias: a5.bias,
        grade: a5.grade,
        confidence: a5.confidence,
        indicators: a5.indicators,
      },
      fifteenMin: a15 && { bias: a15.bias, grade: a15.grade },
    },
  });

  if (!a5) return null;
  // 15m disagreement vetoes; 15m silence does not.
  if (a15 && a15.direction !== a5.direction) return null;
  if (a5.grade !== "A" && a5.grade !== "B") return null;

  // Per-asset, per-direction cooldown.
  const last = db.lastIdeaAt(asset.id, a5.direction);
  if (last !== null && now - last < asset.config.cooldownMs) return null;

  const confidence = a15 ? Math.min(95, a5.confidence + 10) : a5.confidence;
  const grade = a15 && a5.grade === "B" && a15.grade === "A" ? "A" : a5.grade;

  const id = db.createIdea({
    asset: asset.id,
    direction: a5.direction,
    source: "engine",
    entryPrice: a5.entryPrice,
    stopLoss: a5.stopLoss,
    tp1: a5.tp1,
    tp2: a5.tp2,
    confidence,
    grade,
    reason: `[ENGINE] ${a5.reason}${a15 ? " · 15m confirms" : ""}`,
    timeframe: a15 ? "5m+15m" : "5m",
    bias: a5.bias,
    biasStrength: a5.biasStrength,
    spotPrice: price,
  });

  db.logJournal({
    eventType: "SIGNAL_GENERATED",
    asset: asset.id,
    ideaId: id,
    direction: a5.direction,
    price: a5.entryPrice,
    details:
      `[${asset.displaySymbol}] ${grade} ${a5.direction} @ ${a5.entryPrice} | ` +
      `SL ${a5.stopLoss} | TP1 ${a5.tp1} | TP2 ${a5.tp2} | ${confidence}%`,
  });

  return id;
}

export async function generateSignals(deps: EngineDeps): Promise<void> {
  const assets = deps.assets ?? getEnabledAssets();
  for (const asset of assets) {
    try {
      const id = await generateForAsset(deps, asset);
      if (id !== null) publish("ideas");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.db.recordRun(`signals:${asset.id}`, false, msg);
      console.error(`[engine] ${asset.id}:`, msg);
    }
  }
  deps.db.recordRun("signals", true);
  publish("engine");
}

// ─── Exit evaluation ───

/**
 * Apply one price observation to one open idea.
 *
 * `high`/`low` describe the range the price covered since the last check. For a
 * live tick they equal `price`; for a replayed bar they are the bar's extremes,
 * which is what makes gap recovery honest — a stop that was passed through
 * while the process was down is booked at the stop, not at wherever price
 * happens to sit now.
 *
 * Returns true if the idea changed state.
 */
export function applyPrice(
  db: Db,
  asset: AssetDefinition,
  idea: TradingIdea,
  bar: { high: number; low: number; close: number },
  currentATR: number,
): boolean {
  const r = (n: number) => roundTo(n, asset.pricePrecision);
  const isLong = idea.direction === "LONG";
  const effectiveSL = idea.trailing_sl ?? idea.stop_loss;

  // Stop first — the conservative ordering when a single bar spans both levels.
  const slHit = isLong ? bar.low <= effectiveSL : bar.high >= effectiveSL;
  if (slHit) {
    const pnl = r(
      isLong ? effectiveSL - idea.entry_price : idea.entry_price - effectiveSL,
    );
    db.updateIdea(idea.id, {
      status: "STOPPED",
      pnl_points: pnl,
      resolved_at: Date.now(),
    });
    db.addIdeaEvent(
      idea.id,
      idea.trailing_sl ? "TRAIL_SL_HIT" : "SL_HIT",
      effectiveSL,
    );
    db.logJournal({
      eventType: "SL_HIT",
      asset: asset.id,
      ideaId: idea.id,
      direction: idea.direction,
      price: effectiveSL,
      details:
        `${idea.direction} ${idea.trailing_sl ? "TRAIL " : ""}SL @ ${effectiveSL} | ` +
        `entry ${idea.entry_price} | ${pnl >= 0 ? "+" : ""}${pnl} pts`,
    });
    return true;
  }

  if (idea.status === "TP1_HIT") {
    const tp2Hit = isLong ? bar.high >= idea.tp2 : bar.low <= idea.tp2;
    if (tp2Hit) {
      const pnl = r(
        isLong ? idea.tp2 - idea.entry_price : idea.entry_price - idea.tp2,
      );
      db.updateIdea(idea.id, {
        status: "TP2_HIT",
        pnl_points: pnl,
        resolved_at: Date.now(),
      });
      db.addIdeaEvent(idea.id, "TP2_HIT", idea.tp2);
      db.logJournal({
        eventType: "TP2_HIT",
        asset: asset.id,
        ideaId: idea.id,
        direction: idea.direction,
        price: idea.tp2,
        details: `${idea.direction} TP2 @ ${idea.tp2} | entry ${idea.entry_price} | +${pnl} pts`,
      });
      return true;
    }

    // ATR trail, only after TP1 and only in the favourable direction.
    if (currentATR > 0) {
      const distance = currentATR * asset.config.atrTrailMultiplier;
      const candidate = isLong
        ? r(bar.close - distance)
        : r(bar.close + distance);
      const current = idea.trailing_sl ?? idea.entry_price;
      const better = isLong ? candidate > current : candidate < current;
      if (better) {
        db.updateIdea(idea.id, { trailing_sl: candidate });
        db.addIdeaEvent(idea.id, "TRAIL_SL_UPDATE", candidate);
        return true;
      }
    }
    return false;
  }

  // status === "ACTIVE"
  const tp1Hit = isLong ? bar.high >= idea.tp1 : bar.low <= idea.tp1;
  if (!tp1Hit) return false;

  const tp1Pnl = r(
    isLong ? idea.tp1 - idea.entry_price : idea.entry_price - idea.tp1,
  );
  db.addIdeaEvent(idea.id, "TP1_HIT", idea.tp1);
  db.logJournal({
    eventType: "TP1_HIT",
    asset: asset.id,
    ideaId: idea.id,
    direction: idea.direction,
    price: idea.tp1,
    details:
      `${idea.direction} TP1 @ ${idea.tp1} | entry ${idea.entry_price} | ` +
      `+${tp1Pnl} pts | SL → BE, trailing to TP2`,
  });

  // The SAME bar may also have reached TP2 — a gap, or any bar wide enough to
  // span both levels. Checking it here rather than in an `else` branch matters:
  // for a long, high >= tp2 implies high >= tp1, so a TP2-only branch after a
  // TP1 check is unreachable and the position would linger a cycle longer than
  // it should before resolving.
  const tp2Hit = isLong ? bar.high >= idea.tp2 : bar.low <= idea.tp2;
  if (tp2Hit) {
    const tp2Pnl = r(
      isLong ? idea.tp2 - idea.entry_price : idea.entry_price - idea.tp2,
    );
    db.updateIdea(idea.id, {
      status: "TP2_HIT",
      pnl_points: tp2Pnl,
      resolved_at: Date.now(),
    });
    db.addIdeaEvent(idea.id, "TP2_HIT", idea.tp2);
    db.logJournal({
      eventType: "TP2_HIT",
      asset: asset.id,
      ideaId: idea.id,
      direction: idea.direction,
      price: idea.tp2,
      details: `${idea.direction} TP2 (same bar as TP1) @ ${idea.tp2} | entry ${idea.entry_price} | +${tp2Pnl} pts`,
    });
    return true;
  }

  db.updateIdea(idea.id, {
    status: "TP1_HIT",
    pnl_points: tp1Pnl,
    trailing_sl: idea.entry_price, // move to breakeven
  });
  return true;
}

// ─── Live monitoring ───

export async function monitorIdeas(deps: EngineDeps): Promise<void> {
  const { db } = deps;
  const assets = deps.assets ?? getEnabledAssets();
  const open = db.openIdeas();
  if (open.length === 0) {
    db.recordRun("monitor", true);
    return;
  }

  const active = assets.filter(a => open.some(i => i.asset === a.id));
  if (active.length === 0) {
    db.recordRun("monitor", true);
    return;
  }

  let prices: Map<string, number>;
  try {
    // ONE request covering every asset that has something open.
    prices = await fetchPrices(venueSymbols(active), { fetcher: deps.fetcher });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.recordRun("monitor", false, msg);
    console.error("[monitor]", msg);
    return;
  }

  let changed = 0;
  for (const asset of active) {
    const price = prices.get(asset.dataSourceSymbol);
    if (price === undefined) continue;

    const atr = latestATR(db, asset);
    for (const idea of open.filter(i => i.asset === asset.id)) {
      // A live tick is a zero-width bar.
      if (
        applyPrice(
          db,
          asset,
          idea,
          { high: price, low: price, close: price },
          atr,
        )
      ) {
        changed++;
      }
    }
  }

  db.recordRun("monitor", true);
  if (changed > 0) {
    publish("ideas");
    publish("journal");
  }
  publish("prices", Object.fromEntries(prices));
}

function latestATR(db: Db, asset: AssetDefinition): number {
  const candles = db.getCandles(asset.id, SIGNAL_INTERVAL, 60);
  if (candles.length < asset.config.atrPeriod + 1) return 0;
  const series = calcATR(candles, asset.config.atrPeriod);
  return series.at(-1) ?? 0;
}

// ─── Gap recovery ───

/**
 * Resolve exits that happened while the process was not running.
 *
 * Without this, a machine that slept through a stop would compare the position
 * against the CURRENT price on wake and either miss the exit entirely (price
 * came back) or book it at a price that never existed. Replaying the elapsed
 * bars and testing each one's high/low resolves it where it actually happened.
 *
 * Returns the number of ideas whose state changed.
 */
export async function recoverGap(deps: EngineDeps): Promise<number> {
  const { db } = deps;
  const assets = deps.assets ?? getEnabledAssets();
  const open = db.openIdeas();
  if (open.length === 0) return 0;

  const lastMonitor = db.lastRun("monitor");
  if (lastMonitor === null) return 0;

  const downtime = (deps.now?.() ?? Date.now()) - lastMonitor;
  // Under one bar of downtime there is nothing a replay would add.
  if (downtime < intervalMs(SIGNAL_INTERVAL)) return 0;

  console.log(
    `[recover] ${Math.round(downtime / 60_000)} min since last check; ` +
      `replaying ${open.length} open idea(s)`,
  );

  let changed = 0;
  for (const asset of assets) {
    const mine = open.filter(i => i.asset === asset.id);
    if (mine.length === 0) continue;

    let bars: Candle[];
    try {
      bars = await syncCandles(deps, asset, SIGNAL_INTERVAL);
    } catch (e) {
      console.error(
        `[recover] ${asset.id}:`,
        e instanceof Error ? e.message : String(e),
      );
      continue;
    }

    const atrSeries = calcATR(bars, asset.config.atrPeriod);

    for (const idea of mine) {
      // Only bars after the idea was opened can resolve it.
      const openedSec = Math.floor(idea.created_at / 1000);
      let state = idea;
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        if (bar.time < openedSec) continue;
        const atr = atrSeries[i] ?? 0;
        if (applyPrice(db, asset, state, bar, atr)) {
          changed++;
          const refreshed = db.getIdea(idea.id);
          if (!refreshed || refreshed.resolved_at !== null) break;
          state = refreshed;
        }
      }
    }
  }

  if (changed > 0) {
    db.logJournal({
      eventType: "MONITOR_CHECK",
      asset: DEFAULT_ASSET_ID,
      details: `Gap recovery resolved ${changed} state change(s) after ${Math.round(downtime / 60_000)} min offline`,
    });
    publish("ideas");
    publish("journal");
  }
  return changed;
}
