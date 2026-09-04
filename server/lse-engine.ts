/**
 * LSE ENGINE — separate book for real-market instruments (gold first).
 *
 * Same concepts as top10, fully isolated: its own source ('lse'), its own
 * daily 1% take-profit / 0.5% stop circuit breakers, its own performance
 * tracking, its own portfolio admission. It never shares a universe, a
 * signal, or a journal row with the main engine or top10.
 *
 * What lives here:
 *   * PER-ASSET STRATEGIES (`lse:strategies` store): each instrument trades
 *     ONLY its own discovered edge — the family, config and interval the
 *     data qualified for that instrument, never a book-wide template. An
 *     entry that fails the strict gate (p > 0.05, relaxed, failed verdict)
 *     does not trade. Aliases (UK100→FTSE, DE30→GER) mirror the canonical
 *     instrument and never trade themselves.
 *   * GOLD fallback: XAUUSD hand-qualified 1h breakout (20y, PF 1.24,
 *     p = 0.006, 4/4 folds) until discovery adopts its own entry.
 *   * GOLD: breakout family on 1h — the family/interval the data chose.
 *     Reversion on real gold produced nothing.
 *   * HEDGES: COT crowd gate (never join a ≥90th/≤10th percentile fund
 *     positioning) and the real economic-calendar shield (lseNewsShield).
 *   * REGIME: carried as context (SL/TP multipliers + reason tag), never a
 *     veto — the qualified edge was measured with no regime filter, and a
 *     RANGING block was observed refusing grade-A setups on live day one.
 *
 * Gold trades paper-tracked like top10 (no MT5 execution) until the user
 * promotes the book.
 */

import type { AssetDefinition } from "../core/assets";
import { LSE_UNIVERSE, lseAsset } from "../core/assets";
import { analyzeFamilyCandles } from "../core/families";
import {
  admit,
  buildCorrelationMatrix,
  type Exposure,
} from "../core/portfolio";
import { DEFAULT_STRATEGY_CONFIG, roundTo } from "../core/strategy";
import type { Db } from "./db";
import { ladderIsSane, syncCandles } from "./engine";
import { publish } from "./events";
import type { RiskManager } from "./risk-manager";

/**
 * XAUUSD gold 1h breakout — the strongest survivor of the 3000-config deep
 * search over 20 years of vault history: PF 1.24, 816 trades, adjusted
 * p = 0.006, all 4 walk-forward folds profitable. Taken from the Strategy
 * Carpet verbatim, not retuned.
 */
const XAUUSD_BREAKOUT: typeof DEFAULT_STRATEGY_CONFIG = {
  ...DEFAULT_STRATEGY_CONFIG,
  emaFast: 7,
  emaMid: 31,
  emaSlow: 132,
  rsiPeriod: 13,
  rsiOversold: 23.147,
  rsiOverbought: 80.368,
  macdFast: 7,
  macdSlow: 47,
  macdSignal: 10,
  atrPeriod: 16,
  atrSlMultiplier: 2.988,
  atrTrailMultiplier: 3.792,
  stochPeriod: 24,
  stochOversold: 26.009,
  stochOverbought: 74.419,
  bollingerPeriod: 13,
  bollingerStdDev: 1.952,
  tp1R: 0.88,
  tp2R: 3.481,
  gradeAExtreme: 3,
  gradeAStrength: 63.542,
  gradeBExtreme: 2,
  gradeBStrength: 63.542,
  gradeCStrength: 50,
  confidenceMultiplier: 1.2,
  confidenceCap: 95,
  biasNeutralThreshold: 34.225,
  cooldownMs: 10 * 60 * 1000,
  breakoutPeriod: 10,
  momentumLookback: 95,
};

type Family = "reversion" | "trend" | "breakout" | "momentum";

/**
 * Per-asset strategy. An asset absent here has no qualified edge yet and
 * must not trade: research earns a place in the book, nothing else.
 */
const LSE_STRATEGIES: Record<
  string,
  { family: Family; config: typeof DEFAULT_STRATEGY_CONFIG }
> = {
  XAUUSD: { family: "breakout", config: XAUUSD_BREAKOUT },
};

// ─── Per-asset discovered strategies ───

/**
 * One instrument's independent strategy, as adopted by
 * scripts/lse-discovery.ts --adopt. The book's promise: an instrument
 * trades only on ITS OWN edge — the family, config and interval the data
 * qualified for that instrument, never a book-wide template.
 */
export interface LseStrategy {
  family: Family;
  config: typeof DEFAULT_STRATEGY_CONFIG;
  interval: string;
  /** Higher-timeframe confirmation bar, when the strategy wants one. */
  confirm: string | null;
  adjustedP: number;
  adoptedAt: number;
  /** Set when adopted via --adopt-relaxed: best-effort, not an edge. */
  relaxed?: boolean;
  /** Discovery verdict at adoption ("qualified" or the failure mode). */
  verdict?: string;
}

const STRATEGIES_KEY = "lse:strategies";

/**
 * Alias → canonical instrument. FTSE/UK100 are the same index (UK100/GBP),
 * GER/DE30 the same (DE30/EUR): one underlying, one trader. Without this the
 * book opens two identical positions on the same market move.
 */
export const LSE_CANONICAL: Record<string, string> = {
  UK100: "FTSE",
  DE30: "GER",
};

/** Canonical id an instrument trades under (itself, unless an alias). */
export function lseCanonicalId(assetId: string): string {
  return LSE_CANONICAL[assetId] ?? assetId;
}

/**
 * Strict gate: a strategy trades its instrument only if it is a qualified
 * edge — Šidák-adjusted p ≤ 0.05 and no relaxed/failed verdict. Legacy store
 * entries (adopted before verdict tagging) pass on p alone; anything adopted
 * via --adopt-relaxed never trades, no matter its p.
 */
export function strategyIsQualified(s: LseStrategy): boolean {
  if (s.relaxed) return false;
  if (s.verdict !== undefined && s.verdict !== "qualified") return false;
  return (s.adjustedP ?? 1) <= 0.05;
}

/** Interval → its confirmation interval (the next one up). */
export function confirmFor(interval: string): string | null {
  switch (interval) {
    case "5m":
      return "15m";
    case "15m":
      return "30m";
    case "30m":
      return "1h";
    default:
      return null; // 1h+ strategies stand alone
  }
}

/**
 * Regime veto, family-aware. Reversion's edge is a range edge — it needs
 * RANGING. Every other family was validated by discovery with no regime
 * filter, so it gets context, not a veto: a hard RANGING block on breakout
 * was measured refusing grade-A gold setups on live day one.
 */
export function lseRegimeBlocks(
  family: Family,
  regime: string | null | undefined,
): boolean {
  return family === "reversion" && regime !== "RANGING";
}

/**
 * The strategy an instrument trades: its OWN discovered edge, gated strict.
 * A discovered entry wins when present AND qualified; otherwise the
 * hand-qualified fallbacks apply; an instrument with neither — or with an
 * unqualified entry — has no edge and must not trade. A strategy NEVER
 * applies to another instrument: callers always look up by their own id and
 * open ideas only under that same id.
 */
export function lseStrategyFor(db: Db, assetId: string): LseStrategy | null {
  const store = db.getSetting<Record<string, LseStrategy>>(STRATEGIES_KEY);
  const discovered = store?.[assetId];
  if (discovered?.config) {
    if (!strategyIsQualified(discovered)) return null;
    return discovered;
  }
  const qualified = LSE_STRATEGIES[assetId];
  if (!qualified) return null;
  return {
    ...qualified,
    interval: "1h",
    confirm: null,
    adjustedP: 0.006,
    adoptedAt: 0,
  };
}

/** One row of the "assets under LSE" board: instrument + its own edge. */
export interface LseAssetStatus {
  id: string;
  symbol: string;
  digits: number;
  /** Null for canonical instruments; the canonical id for aliases. */
  aliasOf: string | null;
  strategy: {
    family: Family;
    interval: string;
    confirm: string | null;
    adjustedP: number;
    verdict?: string;
    relaxed?: boolean;
    adoptedAt: number;
  } | null;
  qualified: boolean;
  /** Actually trading: qualified, canonical, and vault spec present. */
  trading: boolean;
  hasSpec: boolean;
  openIdeas: number;
  reason: string;
}

/**
 * Every LSE instrument with its independent strategy status — the data
 * behind the LSE page's asset board. An instrument trades only its own
 * strategy; aliases mirror the canonical instrument's status and never
 * trade themselves.
 */
export function lseUniverseStatus(db: Db): LseAssetStatus[] {
  const store = db.getSetting<Record<string, LseStrategy>>(STRATEGIES_KEY);
  const open = db.openIdeas().filter(i => i.source === "lse");
  const seenUnderlying = new Set<string>();
  return LSE_UNIVERSE.map(inst => {
    const aliasOf = LSE_CANONICAL[inst.id] ?? null;
    // Resolve through the same gate the signal path uses, so the board can
    // never disagree with it — including the hand-qualified fallbacks.
    // Blocked entries are still reported (with qualified=false) so the board
    // shows BLOCKED rather than pretending no research exists.
    const effective = lseStrategyFor(db, inst.id);
    const raw = store?.[inst.id];
    const shown = raw?.config ? raw : effective;
    const strategy = shown
      ? {
          family: shown.family,
          interval: shown.interval,
          confirm: shown.confirm,
          adjustedP: shown.adjustedP,
          verdict: shown.verdict,
          relaxed: shown.relaxed,
          adoptedAt: shown.adoptedAt,
        }
      : null;
    const qualified = effective !== null;
    const hasSpec = db.getSetting(`lse:${inst.id}`) !== null;
    const isDuplicate = seenUnderlying.has(inst.lse);
    seenUnderlying.add(inst.lse);
    const trading = qualified && !isDuplicate;
    const openIdeas = open.filter(i => i.asset === inst.id).length;
    // strategy and qualified stand together, except blocked entries which
    // report their research with qualified=false.
    const reason = isDuplicate
      ? `Alias of ${lseCanonicalId(inst.id)} — mirrors it, never trades itself`
      : qualified && strategy
        ? `Qualified ${strategy.family}@${strategy.interval} (p=${strategy.adjustedP})${raw ? "" : " · hand-qualified fallback"}`
        : strategy
          ? strategy.relaxed
            ? "Relaxed best-effort, not a qualified edge — blocked"
            : `Unqualified (p=${strategy.adjustedP}) — blocked`
          : "No discovered edge yet — research earns a place, nothing else";
    return {
      id: inst.id,
      symbol: inst.lse,
      digits: inst.digits,
      aliasOf,
      strategy,
      qualified,
      trading,
      hasSpec,
      openIdeas,
      reason,
    };
  });
}
/** Universe: instruments with a qualified strategy of their own. */
function lseUniverse(db: Db): AssetDefinition[] {
  const assets: AssetDefinition[] = [];
  const seenUnderlying = new Set<string>();
  for (const inst of LSE_UNIVERSE) {
    // One trader per underlying: FTSE before UK100, GER before DE30.
    if (seenUnderlying.has(inst.lse)) continue;
    if (!lseStrategyFor(db, inst.id)) continue;
    seenUnderlying.add(inst.lse);
    const meta = db.getSetting<{
      symbol: string;
      digits: number;
      assetId: string;
      spreadBps: number;
    }>(`lse:${inst.id}`);
    assets.push(
      meta
        ? lseAsset(meta)
        : lseAsset({
            symbol: inst.lse,
            digits: inst.digits,
            assetId: inst.id,
            spreadBps: inst.spreadBps,
          }),
    );
  }
  return assets;
}

function lseOpenExposures(db: Db): Exposure[] {
  return db
    .openIdeas()
    .filter(i => i.source === "lse")
    .map(i => ({ asset: i.asset, direction: i.direction }) as Exposure);
}

function dailyPnlPercent(db: Db, source: string): number {
  // UTC midnight — must match RiskManager.utcMidnight/todayKey, otherwise the
  // daily breaker resets in a different window than the kill-switch on
  // non-UTC hosts.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = db.raw
    .query<{ pnl_points: number; entry_price: number }, [number, string]>(
      `SELECT pnl_points, entry_price FROM trading_ideas WHERE source = ? AND status IN ('TP2_HIT','STOPPED','EXPIRED') AND resolved_at >= ? AND pnl_points IS NOT NULL`,
    )
    .all(start.getTime(), source) as any[];
  let pct = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.entry_price) || r.entry_price <= 0) continue;
    if (!Number.isFinite(r.pnl_points)) continue;
    pct += (r.pnl_points / r.entry_price) * 100;
  }
  return pct;
}

export interface LseEngineDeps {
  db: Db;
  assets?: AssetDefinition[];
  now?: () => number;
  riskManager?: RiskManager;
  limits?: { maxRisk: number };
  correlationOptions?: { prior?: number; minSamples?: number };
}

export async function generateForLse(
  deps: LseEngineDeps,
  asset: AssetDefinition,
): Promise<number | null> {
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();
  // This instrument's own strategy — discovered per instrument, never a
  // book-wide template. Only this strategy can trigger a trade here.
  const strategy = lseStrategyFor(db, asset.id);
  if (!strategy) return null;
  const { family, config: cfg } = strategy;

  // Daily circuit breakers — same shape as top10, separate accounting.
  const dayPct = dailyPnlPercent(db, "lse");
  if (dayPct >= 1.0) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "lse",
      price: 0,
      details: `[LSE] daily target hit +${dayPct.toFixed(2)}% — no new signals today`,
    });
    return null;
  }
  if (dayPct <= -0.5) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "lse",
      price: 0,
      details: `[LSE] daily stop ${dayPct.toFixed(2)}% — halted`,
    });
    return null;
  }

  const regime = (db as any).regimeFromDb?.() ?? null;

  const candles = await syncCandles(
    { db, assets: deps.assets } as any,
    { ...asset, config: cfg } as AssetDefinition,
    strategy.interval,
  );
  const confirmCandles = strategy.confirm
    ? await syncCandles(
        { db, assets: deps.assets } as any,
        { ...asset, config: cfg } as AssetDefinition,
        strategy.confirm,
      )
    : [];
  const price = candles.at(-1)?.close;
  if (price === undefined) return null;

  const signal = analyzeFamilyCandles(
    candles,
    family,
    cfg,
    asset.pricePrecision,
  );
  const confirmation = confirmCandles.length
    ? analyzeFamilyCandles(confirmCandles, family, cfg, asset.pricePrecision)
    : null;

  db.logJournal({
    eventType: "ENGINE_RUN",
    asset: asset.id,
    source: "lse",
    price,
    details: `[LSE ${asset.displaySymbol}] ${strategy.interval}:${family} ${signal?.bias ?? "N/A"} ${signal?.grade ?? "-"}(${signal?.confidence ?? 0}%) ${strategy.confirm ? `${strategy.confirm}:${confirmation?.bias ?? "N/A"} ${confirmation?.grade ?? "-"}` : "(no confirm)"} daily ${dayPct.toFixed(2)}%`,
    metadata: {
      signal: signal && { bias: signal.bias, grade: signal.grade },
    } as any,
  });

  if (!signal) return null;
  // Confirmation: the confirm interval must agree if it has an opinion
  if (confirmation && confirmation.direction !== signal.direction) return null;

  // Regime veto, family-aware (see lseRegimeBlocks): reversion needs
  // RANGING; every other family was validated with no regime filter and
  // gets context via the regimeTag on the idea, never a veto.
  if (regime && lseRegimeBlocks(family, regime.regime)) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "lse",
      direction: signal.direction,
      price: signal.entryPrice,
      details: `[LSE] regime ${regime.regime} — reversion needs RANGING`,
    });
    return null;
  }

  // COT crowd gate — gold only; the percentile is a GC futures rank.
  if (asset.id === "XAUUSD") {
    try {
      const cot = db.getSetting<any>("lseCot");
      if (cot?.crowded) {
        const wantSide = signal.direction === "LONG" ? "LONG" : "SHORT";
        if (cot.crowded === wantSide) {
          db.logJournal({
            eventType: "SIGNAL_BLOCKED",
            asset: asset.id,
            source: "lse",
            direction: signal.direction,
            price: signal.entryPrice,
            details: `[LSE] COT ${cot.reportDate}: non-comm crowd ${cot.crowded} at ${cot.percentile}th pct — refusing to join`,
          });
          return null;
        }
      }
    } catch {}
  }

  // News shield — real events, 15m before / 10m after HIGH impact.
  try {
    const shield = db.getSetting<any>("lseNewsShield");
    if (shield?.isShieldActive) {
      db.logJournal({
        eventType: "SIGNAL_BLOCKED",
        asset: asset.id,
        source: "lse",
        direction: signal.direction,
        price: signal.entryPrice,
        details: `[LSE] news shield active — ${shield.shieldReason ?? "high impact"}`,
      });
      return null;
    }
  } catch {}

  if (signal.grade !== "A" && signal.grade !== "B") return null;

  // Cooldown per asset+direction.
  const last = db.raw
    .query<{ created_at: number }, [string, string]>(
      `SELECT created_at FROM trading_ideas WHERE asset = ? AND direction = ? AND source = 'lse' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(asset.id, signal.direction);
  if (last && now - last.created_at < cfg.cooldownMs) return null;

  if (deps.riskManager) {
    const r = deps.riskManager.canTrade(now);
    if (!r.allowed) {
      db.logJournal({
        eventType: "SIGNAL_BLOCKED",
        asset: asset.id,
        source: "lse",
        direction: signal.direction,
        price: signal.entryPrice,
        details: `[LSE ${asset.displaySymbol}] ${signal.grade} ${signal.direction} not taken. ${r.reason}`,
        metadata: { killSwitch: true } as any,
      });
      return null;
    }
  }

  // Portfolio admission inside the LSE book only.
  const universe = deps.assets ?? lseUniverse(db);
  const matrix = buildCorrelationMatrix(
    Object.fromEntries(
      universe.map(a => [
        a.id,
        db.getCandles(a.id, lseStrategyFor(db, a.id)?.interval ?? "1h", 200),
      ]),
    ),
    deps.correlationOptions,
  );
  const decision = admit(
    lseOpenExposures(db),
    { asset: asset.id, direction: signal.direction },
    matrix,
    deps.limits,
  );
  if (!decision.allowed) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "lse",
      direction: signal.direction,
      price: signal.entryPrice,
      details: `[LSE ${asset.displaySymbol}] ${signal.grade} ${signal.direction} not taken. ${decision.reason}`,
      metadata: decision as any,
    });
    return null;
  }

  const slMult = regime?.slMultiplier ?? 1;
  const tpMult = regime?.tpMultiplier ?? 1;
  const stopLoss = roundTo(
    signal.entryPrice + (signal.stopLoss - signal.entryPrice) * slMult,
    asset.pricePrecision,
  );
  const tp1 = roundTo(
    signal.entryPrice + (signal.tp1 - signal.entryPrice) * tpMult,
    asset.pricePrecision,
  );
  const tp2 = roundTo(
    signal.entryPrice + (signal.tp2 - signal.entryPrice) * tpMult,
    asset.pricePrecision,
  );
  const regimeTag = regime
    ? ` · regime ${regime.regime} (SL ${slMult}× TP ${tpMult}×)`
    : "";
  if (!ladderIsSane(signal.direction, signal.entryPrice, stopLoss, tp1, tp2)) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "lse",
      direction: signal.direction,
      price: signal.entryPrice,
      details: `[LSE ${asset.displaySymbol}] ${signal.grade} ${signal.direction} not taken. Inverted SL/TP`,
    });
    return null;
  }
  const confidence = signal.confidence;
  const id = db.createIdea({
    asset: asset.id,
    direction: signal.direction,
    source: "lse",
    entryPrice: signal.entryPrice,
    stopLoss,
    tp1,
    tp2,
    confidence,
    grade: signal.grade,
    reason: `[LSE ${family}@${strategy.interval}] ${signal.reason}${confirmation ? ` · ${strategy.confirm} confirms` : ""}${decision.hedge ? " · hedges" : ""}${regimeTag} · ${dayPct.toFixed(2)}% today`,
    timeframe: [strategy.interval, strategy.confirm].filter(Boolean).join("+"),
    bias: signal.bias,
    biasStrength: signal.biasStrength,
    spotPrice: price,
  });
  db.logJournal({
    eventType: "SIGNAL_GENERATED",
    asset: asset.id,
    source: "lse",
    ideaId: id,
    direction: signal.direction,
    price: signal.entryPrice,
    details: `[LSE ${asset.displaySymbol}] ${signal.grade} ${signal.direction} @ ${signal.entryPrice} | SL ${stopLoss} | TP1 ${tp1} | TP2 ${tp2} | ${confidence}% | portfolio ${decision.riskBefore.toFixed(2)}→${decision.riskAfter.toFixed(2)} | daily ${dayPct.toFixed(2)}%`,
    metadata: { portfolio: decision, regime } as any,
  });
  return id;
}

export async function generateLseSignals(deps: LseEngineDeps): Promise<void> {
  const universe = deps.assets ?? lseUniverse(deps.db);
  if (universe.length === 0) {
    deps.db.logJournal({
      eventType: "ENGINE_RUN",
      asset: "LSE",
      source: "lse",
      price: 0,
      details: "[LSE] no qualified instruments yet",
    });
    deps.db.recordRun("signals:lse", true);
    return;
  }
  for (const asset of universe) {
    try {
      const id = await generateForLse(deps, asset);
      if (id !== null) publish("ideas");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.db.recordRun(`signals:lse:${asset.id}`, false, msg);
      console.error(`[lse] ${asset.id}:`, msg);
    }
  }
  deps.db.recordRun("signals:lse", true);
  publish("engine");
}

export function lseDailyProgress(db: Db): {
  pct: number;
  target: number;
  hit: boolean;
  stopped: boolean;
} {
  const pct = dailyPnlPercent(db, "lse");
  return { pct, target: 1.0, hit: pct >= 1.0, stopped: pct <= -0.5 };
}
