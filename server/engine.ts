/**
 * Signal engine and position monitor. Ports the Convex signal engine to run
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
} from "../core/assets";
import { analyzeFamilyCandles, type FamilyAnalysis } from "../core/families";
import {
  admit,
  buildCorrelationMatrix,
  type CorrelationMatrix,
  type Exposure,
  type PortfolioLimits,
} from "../core/portfolio";
import { analyzeQuietTrend, htfRegime } from "../core/quiet-trend";
import {
  type AnalysisResult,
  analyzeCandles,
  type Candle,
  calcATR,
  roundTo,
} from "../core/strategy";
import type { Db, TradingIdea } from "./db";
import { publish } from "./events";
import {
  type Fetcher,
  fetchCandles,
  fetchPrices,
  intervalMs,
  venueSymbols,
} from "./market";
import type { RiskManager } from "./risk-manager";

export interface EngineDeps {
  db: Db;
  fetcher?: Fetcher;
  assets?: AssetDefinition[];
  /** Overridable for tests. */
  now?: () => number;
  /** Portfolio risk cap. Omit for the default. */
  limits?: PortfolioLimits;
  /**
   * Correlation estimation options, from the runtime config. Omit for the
   * module defaults.
   */
  correlationOptions?: { prior?: number; minSamples?: number };
  /**
   * Correlations between assets. Supplied by `generateSignals`; measured from
   * stored candles when absent, so a direct `generateForAsset` call is still
   * gated rather than silently unguarded.
   */
  correlations?: CorrelationMatrix;
  /** Kill-switch / circuit-breaker. When provided, checked before every new idea. */
  riskManager?: RiskManager;
}

const SIGNAL_INTERVAL = "5m";
const CONFIRM_INTERVAL = "15m";
/** H1 bars used for the structural regime filter in quiet-trend mode. */
const REGIME_INTERVAL = "1h";
/** Bars of history kept per asset/interval. 200 covers every indicator warm-up. */
const HISTORY_BARS = 200;
/** H1 bars kept for the regime filter — needs EMA(50) + buffer + some extra. */
const REGIME_BARS = 120;

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

  // MT5 assets are filled by the terminal bridge, not by a venue request.
  // Fetching them from Binance would either 404 on a broker-specific symbol or,
  // worse, silently return an unrelated instrument that happens to share a
  // name — so the stored bars are simply read back as they are.
  if (asset.dataSource === "mt5") {
    return db.getCandles(asset.id, interval, HISTORY_BARS);
  }

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

// ─── Portfolio risk ───

/**
 * Correlations between assets, measured from the 5m candles already stored.
 *
 * No extra fetching: the engine keeps 200 bars per asset for the indicators,
 * which is well past the 30 overlapping bars an estimate needs. Assets without
 * enough shared history fall back to a pessimistic prior inside the matrix.
 */
export function correlationsFrom(
  db: Db,
  assets: AssetDefinition[],
  options: { prior?: number; minSamples?: number } = {},
): CorrelationMatrix {
  const series: Record<string, Candle[]> = {};
  for (const a of assets) {
    series[a.id] = db.getCandles(a.id, SIGNAL_INTERVAL, HISTORY_BARS);
  }
  return buildCorrelationMatrix(series, options);
}

/** Open positions, as the portfolio model sees them. */
export function openExposures(db: Db): Exposure[] {
  return db
    .openIdeas()
    .map(i => ({ asset: i.asset, direction: i.direction }) as Exposure);
}

// ─── Signal generation ───

/**
 * Score a window with whichever model the asset names.
 *
 * The combined model scores trend-following and mean-reversion evidence into
 * one bull/bear pair; because they fire in opposite conditions they cancel, and
 * the backtest that validates a config runs whichever model the asset declares.
 * Routing here keeps the live engine on the same model it was measured with —
 * before this, an asset could be tuned as `trend` and traded as `combined`.
 */
function analyzeFor(
  asset: AssetDefinition,
  candles: Candle[],
): AnalysisResult | FamilyAnalysis | null {
  const model = asset.model ?? "combined";
  if (model === "quiet-trend") {
    return analyzeQuietTrend(candles, asset.pricePrecision);
  }
  return model === "combined"
    ? analyzeCandles(candles, asset.config, asset.pricePrecision)
    : analyzeFamilyCandles(candles, model, asset.config, asset.pricePrecision);
}

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

  // Quiet-trend uses H1 for the structural regime filter. Fetch separately so
  // other models don't pay for the extra request.
  let candlesH1: Candle[] | null = null;
  if (asset.model === "quiet-trend") {
    candlesH1 = await syncCandles(deps, asset, REGIME_INTERVAL);
    // Trim to the window the regime filter needs — avoid growing without bound.
    if (candlesH1.length > REGIME_BARS) {
      candlesH1 = candlesH1.slice(-REGIME_BARS);
    }
  }

  const price = candles5m.at(-1)?.close;
  if (price === undefined) return null;

  const a5 = analyzeFor(asset, candles5m);
  const a15 = analyzeFor(asset, candles15m);

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
        indicators: "indicators" in a5 ? a5.indicators : undefined,
      },
      fifteenMin: a15 && { bias: a15.bias, grade: a15.grade },
    },
  });

  if (!a5) return null;
  // 15m disagreement vetoes; 15m silence does not.
  if (a15 && a15.direction !== a5.direction) return null;

  // H1 structural regime filter (quiet-trend model only).
  // If the 1H is in a structural trend, only signals aligned with it pass.
  // NEUTRAL (price inside EMA buffer) → no veto, both directions allowed.
  if (asset.model === "quiet-trend" && candlesH1 !== null) {
    const regime = htfRegime(candlesH1);
    if (regime !== null && regime !== a5.direction) {
      db.logJournal({
        eventType: "SIGNAL_BLOCKED",
        asset: asset.id,
        direction: a5.direction,
        price,
        details:
          `[${asset.displaySymbol}] Vetoed ${a5.direction} — ` +
          `1H regime is ${regime} (counter-trend signal)`,
      });
      return null;
    }
  }

  if (a5.grade !== "A" && a5.grade !== "B") return null;

  // Regime overlay from the intel engine (written every 15m). Tightens risk in
  // volatile regimes, gating both grade and direction. Absent until the first
  // intel run finishes — then the static config governs, as before.
  const regime = db.regimeFromDb();
  if (regime) {
    const GRADE_RANK = { A: 2, B: 1, C: 0 } as const;
    if (GRADE_RANK[a5.grade] < GRADE_RANK[regime.minGrade]) return null;
    if (
      regime.favorDirection !== "BOTH" &&
      a5.direction !== regime.favorDirection
    )
      return null;
  }

  // Per-asset, per-direction cooldown.
  const last = db.lastIdeaAt(asset.id, a5.direction);
  if (last !== null && now - last < asset.config.cooldownMs) return null;

  // Kill-switch / circuit-breaker — checked before the portfolio gate so that
  // a halt from a daily loss limit blocks the signal without touching the
  // correlation matrix at all.
  if (deps.riskManager) {
    const risk = deps.riskManager.canTrade(now);
    if (!risk.allowed) {
      db.logJournal({
        eventType: "SIGNAL_BLOCKED",
        asset: asset.id,
        direction: a5.direction,
        price: a5.entryPrice,
        details: `[${asset.displaySymbol}] ${a5.grade} ${a5.direction} not taken. ${risk.reason}`,
        metadata: { killSwitch: true, reason: risk.reason },
      });
      return null;
    }
  }

  // Portfolio gate. Every check above this line looks at one asset in
  // isolation, and none of them can see that a fifth crypto long is the same
  // bet as the four already open. This one can, and a short that offsets the
  // book is admitted even when the book is full.
  const matrix =
    deps.correlations ??
    correlationsFrom(
      db,
      deps.assets ?? getEnabledAssets(),
      deps.correlationOptions,
    );
  const decision = admit(
    openExposures(db),
    { asset: asset.id, direction: a5.direction },
    matrix,
    deps.limits,
  );
  if (!decision.allowed) {
    db.logJournal({
      eventType: "SIGNAL_BLOCKED",
      asset: asset.id,
      direction: a5.direction,
      price: a5.entryPrice,
      details: `[${asset.displaySymbol}] ${a5.grade} ${a5.direction} not taken. ${decision.reason}`,
      metadata: decision,
    });
    return null;
  }

  const confidence = a15 ? Math.min(95, a5.confidence + 10) : a5.confidence;
  const grade = a15 && a5.grade === "B" && a15.grade === "A" ? "A" : a5.grade;

  // Regime SL/TP multipliers widen stops and targets in volatile regimes,
  // tighten them in ranges. Multipliers are 1 when no regime is set yet.
  const slMult = regime?.slMultiplier ?? 1;
  const tpMult = regime?.tpMultiplier ?? 1;
  const stopLoss = roundTo(a5.stopLoss * slMult, asset.pricePrecision);
  const tp1 = roundTo(a5.tp1 * tpMult, asset.pricePrecision);
  const tp2 = roundTo(a5.tp2 * tpMult, asset.pricePrecision);
  const regimeTag = regime
    ? ` · regime ${regime.regime} (SL ${slMult}× TP ${tpMult}×)`
    : "";

  const id = db.createIdea({
    asset: asset.id,
    direction: a5.direction,
    source: "engine",
    entryPrice: a5.entryPrice,
    stopLoss,
    tp1,
    tp2,
    confidence,
    grade,
    reason:
      `[ENGINE] ${a5.reason}${a15 ? " · 15m confirms" : ""}` +
      (decision.hedge ? " · hedges the open book" : "") +
      regimeTag,
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
      `SL ${stopLoss} | TP1 ${tp1} | TP2 ${tp2} | ${confidence}% | ` +
      `portfolio risk ${decision.riskBefore.toFixed(2)} → ${decision.riskAfter.toFixed(2)}`,
    metadata: { portfolio: decision, regime: regime ?? undefined },
  });

  return id;
}

export async function generateSignals(deps: EngineDeps): Promise<void> {
  const assets = deps.assets ?? getEnabledAssets();
  for (const asset of assets) {
    try {
      // Rebuilt each iteration: the previous asset may have just synced fresh
      // candles, and may have opened a position that changes what comes next.
      const id = await generateForAsset(
        {
          ...deps,
          correlations: correlationsFrom(
            deps.db,
            assets,
            deps.correlationOptions,
          ),
        },
        asset,
      );
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
