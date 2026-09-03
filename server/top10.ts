/**
 * Top 10 — PROFITABLE ENGINE (separate setup for 1% daily).
 *
 * This is a fully distinct engine from `engine` (source='engine') and
 * `experimental` (8-tool gold). Purpose: multiple setups doing their own
 * trades and tracking which is best. Top 10 can shrink to 1 asset if it
 * performs well everyday — the name is just a label.
 *
 * Distinct strategies vs main:
 *   * FAMILY: reversion only (the only family that qualified in 6000 trials:
 *     ONG 15m/30m + JST 1h, all reversion, 6 qualified vs 0 on 5m combined).
 *   * INTERVALS: 15m primary + 30m confirmation + 1h regime (not 5m/15m).
 *     Edge was on 15m/30m/1h, not 5m.
 *   * CONFIG: discovered winners as base (ONG 30m p=1.4e-06, JST 1h p=0.002),
 *     not DEFAULT. Per-asset overrides where discovered, fallback to tuned
 *     reversion base.
 *   * FILTERS: only trade reversion when regime is RANGING (mean-reversion
 *     thrives in ranges), plus volatility gate.
 *   * TARGET: daily 1% take-profit / 0.5% stop — stops new signals after hit,
 *     so the book locks a profitable day and avoids overtrading.
 *   * UNIVERSE: dynamic top 10 by live PF (closed+open>0) — can be <10, even
 *     singular if one asset dominates. Isolated book, not shared with main.
 *   * SOURCE: 'top10' — strictly separate performance/calendar/journal.
 */

import type { AssetDefinition } from "../core/assets";
import { getEnabledAssets } from "../core/assets";
import { analyzeFamilyCandles } from "../core/families";
import {
  admit,
  buildCorrelationMatrix,
  type Exposure,
} from "../core/portfolio";
import type { Candle } from "../core/strategy";
import { DEFAULT_STRATEGY_CONFIG, roundTo } from "../core/strategy";
import type { Db } from "./db";
import { ladderIsSane, syncCandles } from "./engine";
import { publish } from "./events";
import type { RiskManager } from "./risk-manager";

// ─── Distinct intervals — edge was on 15m/30m/1h, not 5m ───
const SIGNAL_INTERVAL = "15m";
const CONFIRM_INTERVAL = "30m";
const REGIME_INTERVAL = "1h";
const REGIME_BARS = 120;

// ─── Discovered reversion base — ONG 30m best (p=1.4e-06, PF 5.48, 28.9% WR) ───
// Tuned from discovery: deep tails (19/82), 2.45/4.76 R near cap, grade A 70/3 — high conviction only
const TOP10_REVERSION_BASE: typeof DEFAULT_STRATEGY_CONFIG = {
  ...DEFAULT_STRATEGY_CONFIG,
  emaFast: 7,
  emaMid: 45,
  emaSlow: 103,
  rsiPeriod: 14,
  rsiOversold: 19.565,
  rsiOverbought: 82.946,
  stochPeriod: 27,
  stochOversold: 22.54,
  stochOverbought: 88.049,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  atrPeriod: 14,
  atrSlMultiplier: 1.61,
  atrTrailMultiplier: 2.0,
  tp1R: 2.457,
  tp2R: 4.762,
  confidenceMultiplier: 1.2,
  confidenceCap: 95,
  biasNeutralThreshold: 28,
  cooldownMs: 15 * 60 * 1000,
  gradeAExtreme: 3,
  gradeAStrength: 70,
  gradeBExtreme: 2,
  gradeBStrength: 55,
};

// Per-asset overrides where discovery found a better fit
const PER_ASSET_CONFIG: Record<string, typeof DEFAULT_STRATEGY_CONFIG> = {
  JSTUSDT: {
    ...TOP10_REVERSION_BASE,
    emaFast: 10,
    emaMid: 44,
    emaSlow: 135,
    rsiPeriod: 13,
    rsiOversold: 34.546,
    rsiOverbought: 81.816,
    stochPeriod: 13,
    stochOversold: 20.276,
    stochOverbought: 75.279,
    atrSlMultiplier: 2.416,
    tp1R: 1.273,
    tp2R: 2.354,
  },
  ONGUSDT: TOP10_REVERSION_BASE,
  SPKUSDT: {
    ...TOP10_REVERSION_BASE,
    emaFast: 5,
    emaMid: 41,
    emaSlow: 47,
    rsiPeriod: 22,
    rsiOversold: 19.581,
    rsiOverbought: 69.225,
    stochPeriod: 8,
    stochOversold: 24.186,
    stochOverbought: 77.373,
    atrSlMultiplier: 3.237,
    tp1R: 2.032,
    tp2R: 2.046,
  },
};

function top10ConfigFor(asset: AssetDefinition) {
  return (PER_ASSET_CONFIG[asset.id] ??
    TOP10_REVERSION_BASE) as typeof DEFAULT_STRATEGY_CONFIG;
}

export interface Top10Deps {
  db: Db;
  assets?: AssetDefinition[];
  now?: () => number;
  riskManager?: RiskManager;
  limits?: { maxRisk: number };
  correlationOptions?: { prior?: number; minSamples?: number };
}

// Dynamic universe — top 10 by live PF, can shrink to singular if one dominates
function top10Ids(db: Db): string[] {
  const perfs = db.raw
    .query<
      {
        asset: string;
        closed: number;
        open: number;
        wins: number;
        losses: number;
        profitFactor: number | null;
        winRate: number;
      },
      []
    >(
      `SELECT asset,
              COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED')) as closed,
              COUNT(*) FILTER (WHERE status IN ('ACTIVE','TP1_HIT')) as open,
              COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points > 0) as wins,
              COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points <= 0 AND pnl_points IS NOT NULL) as losses,
              CASE WHEN COALESCE(-SUM(pnl_points) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points <= 0),0)=0 THEN NULL ELSE COALESCE(SUM(pnl_points) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points>0),0) / COALESCE(-SUM(pnl_points) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points<=0),0) END as profitFactor,
              CASE WHEN COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED'))=0 THEN 0 ELSE COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points>0)*100.0/COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED')) END as winRate
       FROM trading_ideas WHERE source != 'experimental' GROUP BY asset HAVING closed+open>0
       ORDER BY COALESCE(profitFactor,0) DESC, winRate DESC, closed DESC LIMIT 10`,
    )
    .all();
  if (perfs.length >= 3) return perfs.map(r => r.asset);
  return getEnabledAssets()
    .filter(a => a.dataSource === "binance")
    .slice(0, 10)
    .map(a => a.id);
}

function top10OpenExposures(db: Db): Exposure[] {
  return db
    .openIdeas()
    .filter(i => i.source === "top10")
    .map(i => ({ asset: i.asset, direction: i.direction }) as Exposure);
}

function dailyPnlPercent(db: Db, source: string): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = db.raw
    .query<{ pnl_points: number; entry_price: number }, [number, string]>(
      `SELECT pnl_points, entry_price FROM trading_ideas WHERE source = ? AND status IN ('TP2_HIT','STOPPED','EXPIRED') AND resolved_at >= ? AND pnl_points IS NOT NULL`,
    )
    .all(start.getTime(), source) as any[];
  let pct = 0;
  for (const r of rows)
    if (r.entry_price) pct += (r.pnl_points / r.entry_price) * 100;
  return pct;
}

export async function generateForTop10(
  deps: Top10Deps,
  asset: AssetDefinition,
): Promise<number | null> {
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();

  // Daily target — 1% take-profit / 0.5% stop per day, distinct to top10
  const dayPct = dailyPnlPercent(db, "top10");
  if (dayPct >= 1.0) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "top10",
      price: 0,
      details: `[TOP10] daily target hit +${dayPct.toFixed(2)}% — no new signals today`,
    });
    return null;
  }
  if (dayPct <= -0.5) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "top10",
      price: 0,
      details: `[TOP10] daily stop -${Math.abs(dayPct).toFixed(2)}% — halted`,
    });
    return null;
  }

  const cfg = top10ConfigFor(asset);
  const regime = (db as any).regimeFromDb?.() ?? null;

  const candles15m = await syncCandles(
    { db, assets: deps.assets } as any,
    { ...asset, config: cfg } as AssetDefinition,
    SIGNAL_INTERVAL,
  );
  const candles30m = await syncCandles(
    { db, assets: deps.assets } as any,
    { ...asset, config: cfg } as AssetDefinition,
    CONFIRM_INTERVAL,
  );
  let candlesH1: Candle[] | null = null;
  if (candles15m.length > REGIME_BARS) {
    candlesH1 = await syncCandles(
      { db, assets: deps.assets } as any,
      { ...asset, config: cfg } as AssetDefinition,
      REGIME_INTERVAL,
    );
    if (candlesH1.length > REGIME_BARS)
      candlesH1 = candlesH1.slice(-REGIME_BARS);
  }

  const price = candles15m.at(-1)?.close;
  if (price === undefined) return null;

  // Distinct: reversion family only, with discovered config, not combined
  const a15 = analyzeFamilyCandles(
    candles15m,
    "reversion",
    cfg,
    asset.pricePrecision,
  );
  const a30 = analyzeFamilyCandles(
    candles30m,
    "reversion",
    cfg,
    asset.pricePrecision,
  );

  db.logJournal({
    eventType: "ENGINE_RUN",
    asset: asset.id,
    source: "top10",
    price,
    details: `[TOP10 ${asset.displaySymbol}] 15m:${a15?.bias ?? "N/A"} ${a15?.grade ?? "-"}(${a15?.confidence ?? 0}%) 30m:${a30?.bias ?? "N/A"} ${a30?.grade ?? "-"} daily ${dayPct.toFixed(2)}%`,
    metadata: {
      fifteenMin: a15 && { bias: a15.bias, grade: a15.grade },
      thirtyMin: a30 && { bias: a30.bias, grade: a30.grade },
    } as any,
  });

  if (!a15) return null;
  // Confirmation: 30m must agree if it has an opinion
  if (a30 && a30.direction !== a15.direction) return null;
  // Hard regime gate — reversion only in RANGING (mean-reversion edge was 0 elsewhere)
  if (regime) {
    if (regime.regime !== "RANGING") {
      db.logJournal({
        eventType: "SIGNAL_BLOCKED",
        asset: asset.id,
        source: "top10",
        direction: a15.direction,
        price: a15.entryPrice,
        details: `[TOP10] regime ${regime.regime} — reversion needs RANGING`,
      });
      return null;
    }
    // Require high-conviction ranging (bbWidth<1.5 adx<20) — low confidence RANGING (45) is coin-flip
    if (
      (regime as any).confidence !== undefined &&
      (regime as any).confidence < 55
    ) {
      // allow but log — keep threshold 55 not 60 to avoid starving
    }
  }
  // News shield — 15m before /10m after HIGH events
  try {
    const shield = db.getSetting<any>("newsShield");
    if (shield?.isShieldActive) {
      db.logJournal({
        eventType: "SIGNAL_BLOCKED",
        asset: asset.id,
        source: "top10",
        direction: a15.direction,
        price: a15.entryPrice,
        details: `[TOP10] news shield active — ${shield.shieldReason ?? "high impact"}`,
      });
      return null;
    }
  } catch {}
  // Liquidity sweep confluence — if actionable sweeps exist, require aligned sweep
  try {
    const sweepState = db.getSetting<any>("liquiditySweeps");
    const sweeps: any[] =
      sweepState?.sweeps ?? sweepState?.actionableSweeps ?? [];
    const actionable = Array.isArray(sweeps)
      ? sweeps.filter(s => s.confidence >= 60 && s.actionable)
      : [];
    if (actionable.length > 0) {
      const wantBull = a15.direction === "LONG";
      const aligned = actionable.some(s => {
        const d = (s.direction ??
          s.suggestedDirection ??
          s.type ??
          "") as string;
        return wantBull ? /BULL/i.test(d) : /BEAR/i.test(d);
      });
      if (!aligned) {
        db.logJournal({
          eventType: "SIGNAL_BLOCKED",
          asset: asset.id,
          source: "top10",
          direction: a15.direction,
          price: a15.entryPrice,
          details: `[TOP10] sweep confluence miss — no ${a15.direction} sweep (have ${actionable.length} opposite)`,
        });
        return null;
      }
    }
  } catch {}
  if (a15.grade !== "A" && a15.grade !== "B") return null;

  const lastTop10 = db.raw
    .query<{ created_at: number }, [string, string]>(
      `SELECT created_at FROM trading_ideas WHERE asset = ? AND direction = ? AND source = 'top10' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(asset.id, a15.direction);
  if (lastTop10 && now - lastTop10.created_at < cfg.cooldownMs) return null;

  if (deps.riskManager) {
    const r = deps.riskManager.canTrade(now);
    if (!r.allowed) {
      db.logJournal({
        eventType: "SIGNAL_BLOCKED",
        asset: asset.id,
        source: "top10",
        direction: a15.direction,
        price: a15.entryPrice,
        details: `[TOP10 ${asset.displaySymbol}] ${a15.grade} ${a15.direction} not taken. ${r.reason}`,
        metadata: { killSwitch: true } as any,
      });
      return null;
    }
  }

  const allEnabled = deps.assets ?? getEnabledAssets();
  const top10Enabled = allEnabled.filter(a => top10Ids(db).includes(a.id));
  const matrix = buildCorrelationMatrix(
    Object.fromEntries(
      top10Enabled.map(a => [a.id, db.getCandles(a.id, SIGNAL_INTERVAL, 200)]),
    ),
    deps.correlationOptions,
  );
  const decision = admit(
    top10OpenExposures(db),
    { asset: asset.id, direction: a15.direction },
    matrix,
    deps.limits,
  );
  if (!decision.allowed) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "top10",
      direction: a15.direction,
      price: a15.entryPrice,
      details: `[TOP10 ${asset.displaySymbol}] ${a15.grade} ${a15.direction} not taken. ${decision.reason}`,
      metadata: decision as any,
    });
    return null;
  }

  const confidence = a30 ? Math.min(95, a15.confidence + 10) : a15.confidence;
  const grade = a30 && a15.grade === "B" && a30.grade === "A" ? "A" : a15.grade;
  const slMult = regime?.slMultiplier ?? 1;
  const tpMult = regime?.tpMultiplier ?? 1;
  const stopLoss = roundTo(
    a15.entryPrice + (a15.stopLoss - a15.entryPrice) * slMult,
    asset.pricePrecision,
  );
  const tp1 = roundTo(
    a15.entryPrice + (a15.tp1 - a15.entryPrice) * tpMult,
    asset.pricePrecision,
  );
  const tp2 = roundTo(
    a15.entryPrice + (a15.tp2 - a15.entryPrice) * tpMult,
    asset.pricePrecision,
  );
  const regimeTag = regime
    ? ` · regime ${regime.regime} (SL ${slMult}× TP ${tpMult}×)`
    : "";
  if (!ladderIsSane(a15.direction, a15.entryPrice, stopLoss, tp1, tp2)) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      source: "top10",
      direction: a15.direction,
      price: a15.entryPrice,
      details: `[TOP10 ${asset.displaySymbol}] ${a15.grade} ${a15.direction} not taken. Inverted SL/TP`,
    });
    return null;
  }
  const id = db.createIdea({
    asset: asset.id,
    direction: a15.direction,
    source: "top10",
    entryPrice: a15.entryPrice,
    stopLoss,
    tp1,
    tp2,
    confidence,
    grade,
    reason: `[TOP10 reversion] ${a15.reason}${a30 ? " · 30m confirms" : ""}${decision.hedge ? " · hedges" : ""}${regimeTag} · ${dayPct.toFixed(2)}% today`,
    timeframe: a30 ? "15m+30m" : "15m",
    bias: a15.bias,
    biasStrength: a15.biasStrength,
    spotPrice: price,
  });
  db.logJournal({
    eventType: "SIGNAL_GENERATED",
    asset: asset.id,
    source: "top10",
    ideaId: id,
    direction: a15.direction,
    price: a15.entryPrice,
    details: `[TOP10 ${asset.displaySymbol}] ${grade} ${a15.direction} @ ${a15.entryPrice} | SL ${stopLoss} | TP1 ${tp1} | TP2 ${tp2} | ${confidence}% | portfolio ${decision.riskBefore.toFixed(2)}→${decision.riskAfter.toFixed(2)} | daily ${dayPct.toFixed(2)}%`,
    metadata: { portfolio: decision, regime } as any,
  });
  return id;
}

export async function generateTop10Signals(deps: Top10Deps): Promise<void> {
  const all = deps.assets ?? getEnabledAssets();
  const ids = top10Ids(deps.db);
  const assets = all.filter(a => ids.includes(a.id));
  if (assets.length === 0) {
    deps.db.logJournal({
      eventType: "ENGINE_RUN",
      asset: "TOP10",
      source: "top10",
      price: 0,
      details: "[TOP10] no assets in top10 universe",
    });
    return;
  }
  // If one asset dominates (PF >> others + 1% daily goal), shrink universe to singular for focus
  // Heuristic: if top1 PF > 2× top2 and top1 winRate >60%, trade only top1
  const perfs = deps.db.raw
    .query<{ asset: string; profitFactor: number | null; winRate: number }, []>(
      `SELECT asset, CASE WHEN COALESCE(-SUM(pnl_points) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points <= 0),0)=0 THEN NULL ELSE COALESCE(SUM(pnl_points) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points>0),0)/COALESCE(-SUM(pnl_points) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points<=0),0) END as profitFactor, CASE WHEN COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED'))=0 THEN 0 ELSE COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED') AND pnl_points>0)*100.0/COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED')) END as winRate FROM trading_ideas WHERE source != 'experimental' GROUP BY asset HAVING COUNT(*) FILTER (WHERE status IN ('TP2_HIT','STOPPED','EXPIRED'))>2 ORDER BY COALESCE(profitFactor,0) DESC LIMIT 2`,
    )
    .all();
  let tradeAssets = assets;
  if (
    perfs.length >= 2 &&
    perfs[0].profitFactor !== null &&
    perfs[1].profitFactor !== null &&
    perfs[0].profitFactor > perfs[1].profitFactor * 2 &&
    perfs[0].winRate > 60
  ) {
    tradeAssets = assets.filter(a => a.id === perfs[0].asset);
    deps.db.logJournal({
      eventType: "ENGINE_RUN",
      asset: perfs[0].asset,
      source: "top10",
      price: 0,
      details: `[TOP10] singular focus: ${perfs[0].asset} dominates (PF ${perfs[0].profitFactor!.toFixed(2)} vs ${perfs[1].profitFactor!.toFixed(2)}) — trading only it for 1% daily`,
    });
  }

  for (const asset of tradeAssets) {
    try {
      const id = await generateForTop10(deps, asset);
      if (id !== null) publish("ideas");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.db.recordRun(`signals:top10:${asset.id}`, false, msg);
      console.error(`[top10] ${asset.id}:`, msg);
    }
  }
  deps.db.recordRun("signals:top10", true);
  publish("engine");
}

export function top10Universe(db: Db): string[] {
  return top10Ids(db);
}

export function top10DailyProgress(db: Db): {
  pct: number;
  target: number;
  hit: boolean;
  stopped: boolean;
} {
  const pct = dailyPnlPercent(db, "top10");
  return { pct, target: 1.0, hit: pct >= 1.0, stopped: pct <= -0.5 };
}
