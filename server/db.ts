/**
 * Local SQLite data layer — replaces every Convex query and mutation.
 *
 * Uses bun:sqlite, which ships with Bun, so this adds no dependency. The whole
 * dataset is one file (data/teo.db by default) that can be copied, inspected
 * with any SQLite tool, or deleted to start fresh.
 *
 * All timestamps are epoch milliseconds except candle open_time, which is epoch
 * SECONDS to match the Candle type the strategy core consumes.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Candle, StrategyConfig } from "../core/strategy";
import { SCHEMA_SQL } from "./schema";

export type Direction = "LONG" | "SHORT";
export type IdeaStatus =
  | "ACTIVE"
  | "TP1_HIT"
  | "TP2_HIT"
  | "STOPPED"
  | "EXPIRED";
export type IdeaSource = "engine" | "teo" | "dashboard" | "experimental";

export interface TradingIdea {
  id: number;
  asset: string;
  direction: Direction;
  status: IdeaStatus;
  source: IdeaSource;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  trailing_sl: number | null;
  confidence: number;
  grade: string | null;
  reason: string;
  timeframe: string;
  bias: string;
  bias_strength: number;
  spot_price: number;
  teo_score: number | null;
  teo_regime: string | null;
  pnl_points: number | null;
  created_at: number;
  resolved_at: number | null;
}

export interface JournalRow {
  id: number;
  event_type: string;
  asset: string;
  source: string;
  idea_id: number | null;
  direction: Direction | null;
  price: number | null;
  details: string;
  metadata: string | null;
  timestamp: number;
}

export interface NewIdea {
  asset: string;
  direction: Direction;
  source?: IdeaSource;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  confidence?: number;
  grade?: string | null;
  reason?: string;
  timeframe?: string;
  bias?: string;
  biasStrength?: number;
  spotPrice: number;
  teoScore?: number | null;
  teoRegime?: string | null;
}

export interface JournalEntry {
  eventType: string;
  asset: string;
  source?: string;
  ideaId?: number | null;
  direction?: Direction | null;
  price?: number | null;
  details?: string;
  metadata?: unknown;
}

/** Shape written by server/intel/regime.ts, consumed by the signal engine. */
export interface RegimeSettings {
  timestamp: number;
  regime: "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "VOLATILE";
  confidence: number;
  atrRatio: number;
  adxProxy: number;
  trendStrength: number;
  priceVsEma50: number;
  priceVsEma200: number;
  bbWidth: number;
  rangeHighLow: number;
  recommendedStrategy: string;
  description: string;
  slMultiplier: number;
  tpMultiplier: number;
  positionSizeMultiplier: number;
  minGrade: "A" | "B" | "C";
  favorDirection: "LONG" | "SHORT" | "BOTH";
}

const OPEN_STATUSES = ["ACTIVE", "TP1_HIT"] as const;

export class Db {
  readonly raw: Database;

  constructor(path = process.env.TEO_DB_PATH ?? "data/teo.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path, { create: true });
    // WAL lets the Python side read while the server writes. It is a no-op for
    // :memory: databases, which is why tests still work unchanged.
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  /** Apply the schema. Every statement is CREATE ... IF NOT EXISTS, so this is idempotent. */
  migrate(): void {
    this.raw.exec(SCHEMA_SQL);
  }

  close(): void {
    this.raw.close();
  }

  // ─── Candles ───

  /** Upsert candles. Re-fetching an overlapping window is normal, so conflicts replace. */
  saveCandles(asset: string, interval: string, candles: Candle[]): void {
    if (candles.length === 0) return;
    const stmt = this.raw.prepare(
      `INSERT INTO candles (asset, interval, open_time, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset, interval, open_time) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume`,
    );
    this.raw.transaction(() => {
      for (const c of candles) {
        stmt.run(
          asset,
          interval,
          c.time,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
        );
      }
    })();
  }

  /** Most recent `limit` candles, oldest-first (the order the strategy expects). */
  getCandles(asset: string, interval: string, limit = 200): Candle[] {
    const rows = this.raw
      .query<
        { open_time: number } & Record<string, number>,
        [string, string, number]
      >(
        `SELECT open_time, open, high, low, close, volume FROM candles
         WHERE asset = ? AND interval = ?
         ORDER BY open_time DESC LIMIT ?`,
      )
      .all(asset, interval, limit);
    return rows
      .map(r => ({
        time: r.open_time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      }))
      .reverse();
  }

  /**
   * Every stored candle in a time range, oldest-first.
   *
   * Unlimited by design, unlike getCandles: a research window is defined by its
   * dates, and silently truncating it to the newest N bars would answer a
   * different question from the one asked while looking like it had worked.
   */
  getCandleRange(
    asset: string,
    interval: string,
    from: number,
    to: number,
  ): Candle[] {
    const rows = this.raw
      .query<
        { open_time: number } & Record<string, number>,
        [string, string, number, number]
      >(
        `SELECT open_time, open, high, low, close, volume FROM candles
         WHERE asset = ? AND interval = ? AND open_time >= ? AND open_time <= ?
         ORDER BY open_time ASC`,
      )
      .all(asset, interval, from, to);
    return rows.map(r => ({
      time: r.open_time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }

  /** Open time of the newest stored candle, or null. Drives incremental fetches. */
  latestCandleTime(asset: string, interval: string): number | null {
    const row = this.raw
      .query<{ t: number | null }, [string, string]>(
        `SELECT MAX(open_time) AS t FROM candles WHERE asset = ? AND interval = ?`,
      )
      .get(asset, interval);
    return row?.t ?? null;
  }

  // ─── Trading ideas ───

  createIdea(idea: NewIdea): number {
    const now = Date.now();
    const row = this.raw
      .query<{ id: number }, never[]>(
        `INSERT INTO trading_ideas (
           asset, direction, status, source, entry_price, stop_loss, tp1, tp2,
           confidence, grade, reason, timeframe, bias, bias_strength,
           spot_price, teo_score, teo_regime, created_at
         ) VALUES (
           $asset, $direction, 'ACTIVE', $source, $entry, $sl, $tp1, $tp2,
           $confidence, $grade, $reason, $timeframe, $bias, $biasStrength,
           $spot, $teoScore, $teoRegime, $now
         ) RETURNING id`,
      )
      .get({
        $asset: idea.asset,
        $direction: idea.direction,
        $source: idea.source ?? "engine",
        $entry: idea.entryPrice,
        $sl: idea.stopLoss,
        $tp1: idea.tp1,
        $tp2: idea.tp2,
        $confidence: idea.confidence ?? 0,
        $grade: idea.grade ?? null,
        $reason: idea.reason ?? "",
        $timeframe: idea.timeframe ?? "5m",
        $bias: idea.bias ?? "NEUTRAL",
        $biasStrength: idea.biasStrength ?? 0,
        $spot: idea.spotPrice,
        $teoScore: idea.teoScore ?? null,
        $teoRegime: idea.teoRegime ?? null,
        $now: now,
      } as never);
    const id = row!.id;
    this.addIdeaEvent(id, "SIGNAL_GENERATED", idea.spotPrice, now);
    this.addIdeaEvent(id, "ENTRY_TRIGGERED", idea.entryPrice, now);
    return id;
  }

  getIdea(id: number): TradingIdea | null {
    return (
      this.raw
        .query<TradingIdea, [number]>(
          `SELECT * FROM trading_ideas WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  /** Every idea still being tracked toward an exit, optionally for one asset. */
  openIdeas(asset?: string): TradingIdea[] {
    const placeholders = OPEN_STATUSES.map(() => "?").join(", ");
    if (asset) {
      return this.raw
        .query<TradingIdea, string[]>(
          `SELECT * FROM trading_ideas
           WHERE status IN (${placeholders}) AND asset = ?
           ORDER BY created_at`,
        )
        .all(...OPEN_STATUSES, asset);
    }
    return this.raw
      .query<TradingIdea, string[]>(
        `SELECT * FROM trading_ideas
         WHERE status IN (${placeholders}) ORDER BY created_at`,
      )
      .all(...OPEN_STATUSES);
  }

  listIdeas(opts: { asset?: string; limit?: number } = {}): TradingIdea[] {
    const limit = opts.limit ?? 100;
    if (opts.asset) {
      return this.raw
        .query<TradingIdea, [string, number]>(
          `SELECT * FROM trading_ideas WHERE asset = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(opts.asset, limit);
    }
    return this.raw
      .query<TradingIdea, [number]>(
        `SELECT * FROM trading_ideas ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
  }

  /**
   * Newest same-direction idea for an asset, used for the cooldown guard.
   *
   * The Convex version took the 50 most recent ideas across ALL assets and
   * filtered in memory, so with enough assets a given asset's recent signal
   * could fall outside the window and the cooldown would quietly stop working.
   * An indexed query has no such window.
   */
  lastIdeaAt(asset: string, direction: Direction): number | null {
    const row = this.raw
      .query<{ created_at: number }, [string, string]>(
        `SELECT created_at FROM trading_ideas
         WHERE asset = ? AND direction = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(asset, direction);
    return row?.created_at ?? null;
  }

  updateIdea(
    id: number,
    patch: Partial<
      Pick<TradingIdea, "status" | "trailing_sl" | "pnl_points" | "resolved_at">
    >,
  ): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    const sets = keys.map(k => `${k} = ?`).join(", ");
    this.raw
      .prepare(`UPDATE trading_ideas SET ${sets} WHERE id = ?`)
      .run(...keys.map(k => patch[k] ?? null), id);
  }

  deleteIdea(id: number): void {
    this.raw.prepare(`DELETE FROM trading_ideas WHERE id = ?`).run(id);
  }

  addIdeaEvent(
    ideaId: number,
    event: string,
    price: number,
    timestamp = Date.now(),
  ): void {
    this.raw
      .prepare(
        `INSERT INTO idea_events (idea_id, event, price, timestamp) VALUES (?, ?, ?, ?)`,
      )
      .run(ideaId, event, price, timestamp);
  }

  ideaEvents(
    ideaId: number,
  ): Array<{ event: string; price: number; timestamp: number }> {
    return this.raw
      .query<{ event: string; price: number; timestamp: number }, [number]>(
        `SELECT event, price, timestamp FROM idea_events
         WHERE idea_id = ? ORDER BY timestamp, id`,
      )
      .all(ideaId);
  }

  // ─── Journal ───

  logJournal(entry: JournalEntry): void {
    this.raw
      .prepare(
        `INSERT INTO signal_journal
           (event_type, asset, source, idea_id, direction, price, details, metadata, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.eventType,
        entry.asset,
        entry.source ?? "engine",
        entry.ideaId ?? null,
        entry.direction ?? null,
        entry.price ?? null,
        entry.details ?? "",
        entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
        Date.now(),
      );
  }

  listJournal(opts: { asset?: string; limit?: number } = {}): JournalRow[] {
    const limit = opts.limit ?? 200;
    if (opts.asset) {
      return this.raw
        .query<JournalRow, [string, number]>(
          `SELECT * FROM signal_journal WHERE asset = ?
           ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(opts.asset, limit);
    }
    return this.raw
      .query<JournalRow, [number]>(
        `SELECT * FROM signal_journal ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Counts per event type. An aggregate, not a full-table read into memory. */
  journalCounts(): Record<string, number> {
    const rows = this.raw
      .query<{ event_type: string; n: number }, []>(
        `SELECT event_type, COUNT(*) AS n FROM signal_journal GROUP BY event_type`,
      )
      .all();
    return Object.fromEntries(rows.map(r => [r.event_type, r.n]));
  }

  /** Drop journal rows older than `days`, keeping the file from growing forever. */
  pruneJournal(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    return this.raw
      .prepare(`DELETE FROM signal_journal WHERE timestamp < ?`)
      .run(cutoff).changes;
  }

  // ─── Settings ───

  setSetting(key: string, value: unknown): void {
    this.raw
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  getSetting<T>(key: string): T | null {
    const row = this.raw
      .query<{ value: string }, [string]>(
        `SELECT value FROM settings WHERE key = ?`,
      )
      .get(key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  /**
   * Latest regime intel, if any. The intel engine writes this every 15m; the
   * signal engine reads it to tighten risk in volatile regimes. Returns null
   * until the first intel run has completed.
   */
  regimeFromDb(): RegimeSettings | null {
    return this.getSetting<RegimeSettings>("marketRegime");
  }

  // ─── Job bookkeeping (gap recovery) ───

  recordRun(job: string, ok: boolean, error?: string): void {
    const now = Date.now();
    this.raw
      .prepare(
        `INSERT INTO job_runs (job, last_run_at, last_ok_at, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (job) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           last_ok_at  = COALESCE(excluded.last_ok_at, job_runs.last_ok_at),
           last_error  = excluded.last_error`,
      )
      .run(job, now, ok ? now : null, error ?? null);
  }

  lastRun(job: string): number | null {
    const row = this.raw
      .query<{ last_run_at: number }, [string]>(
        `SELECT last_run_at FROM job_runs WHERE job = ?`,
      )
      .get(job);
    return row?.last_run_at ?? null;
  }

  // ─── Manual trades (Risk Manager) ───

  createManualTrade(t: {
    asset: string;
    direction: Direction;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    lotSize: number;
    riskAmount?: number | null;
    notes?: string | null;
  }): number {
    const row = this.raw
      .query<{ id: number }, never[]>(
        `INSERT INTO manual_trades
           (asset, direction, status, entry_price, stop_loss, take_profit,
            lot_size, risk_amount, notes, opened_at)
         VALUES ($asset, $dir, 'OPEN', $entry, $sl, $tp, $lot, $risk, $notes, $now)
         RETURNING id`,
      )
      .get({
        $asset: t.asset,
        $dir: t.direction,
        $entry: t.entryPrice,
        $sl: t.stopLoss,
        $tp: t.takeProfit,
        $lot: t.lotSize,
        $risk: t.riskAmount ?? null,
        $notes: t.notes ?? null,
        $now: Date.now(),
      } as never);
    return row!.id;
  }

  /**
   * Close a manual trade at `exitPrice`.
   *
   * P&L is derived here rather than accepted from the caller: a journal whose
   * numbers can be supplied independently of its prices cannot be audited.
   */
  closeManualTrade(id: number, exitPrice: number): void {
    const t = this.raw
      .query<
        { direction: Direction; entry_price: number; lot_size: number },
        [number]
      >(
        `SELECT direction, entry_price, lot_size FROM manual_trades WHERE id = ?`,
      )
      .get(id);
    if (!t) return;

    const points =
      t.direction === "LONG"
        ? exitPrice - t.entry_price
        : t.entry_price - exitPrice;
    const dollars = points * t.lot_size;
    const status = points > 0 ? "WIN" : points < 0 ? "LOSS" : "BREAKEVEN";

    this.raw
      .prepare(
        `UPDATE manual_trades
         SET status = ?, exit_price = ?, pnl_points = ?, pnl_dollars = ?, closed_at = ?
         WHERE id = ?`,
      )
      .run(status, exitPrice, points, dollars, Date.now(), id);
  }

  deleteManualTrade(id: number): void {
    this.raw.prepare(`DELETE FROM manual_trades WHERE id = ?`).run(id);
  }

  listManualTrades(limit = 100): Record<string, unknown>[] {
    return this.raw
      .query<Record<string, unknown>, [number]>(
        `SELECT * FROM manual_trades ORDER BY opened_at DESC LIMIT ?`,
      )
      .all(limit);
  }

  manualTradeStats(): {
    totalTrades: number;
    openTrades: number;
    wins: number;
    losses: number;
    breakeven: number;
    winRate: number;
    netDollars: number;
    totalPnlPoints: number;
    avgWinDollars: number;
    avgLossDollars: number;
    profitFactor: number | null;
  } {
    const r = this.raw
      .query<Record<string, number | null>, []>(
        `SELECT
           COUNT(*)                                        AS total,
           COUNT(*) FILTER (WHERE status = 'OPEN')         AS open,
           COUNT(*) FILTER (WHERE status = 'WIN')          AS wins,
           COUNT(*) FILTER (WHERE status = 'LOSS')         AS losses,
           COUNT(*) FILTER (WHERE status = 'BREAKEVEN')    AS breakeven,
           COALESCE(SUM(pnl_dollars), 0)                   AS net,
           COALESCE(SUM(pnl_points), 0)                    AS net_points,
           COALESCE(SUM(pnl_dollars) FILTER (WHERE pnl_dollars > 0), 0)   AS gross_win,
           COALESCE(-SUM(pnl_dollars) FILTER (WHERE pnl_dollars < 0), 0)  AS gross_loss
         FROM manual_trades`,
      )
      .get()!;
    const wins = Number(r.wins ?? 0);
    const losses = Number(r.losses ?? 0);
    const decided = wins + losses;
    const grossWin = Number(r.gross_win ?? 0);
    const grossLoss = Number(r.gross_loss ?? 0);
    return {
      totalTrades: Number(r.total ?? 0),
      openTrades: Number(r.open ?? 0),
      wins,
      losses,
      breakeven: Number(r.breakeven ?? 0),
      winRate: decided ? (wins / decided) * 100 : 0,
      netDollars: Number(r.net ?? 0),
      totalPnlPoints: Number(r.net_points ?? 0),
      avgWinDollars: wins ? grossWin / wins : 0,
      avgLossDollars: losses ? grossLoss / losses : 0,
      // null, not 0 — zero reads as "worst possible" to any comparison.
      profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    };
  }

  // ─── Performance ───

  /**
   * Aggregate performance for ONE asset.
   *
   * Asset is required, not optional: points are not comparable across assets —
   * summing gold, BTC and LINK points produces a number with no meaning, which
   * is exactly what the Convex getPerformanceStats did.
   */
  performance(asset: string): {
    asset: string;
    closed: number;
    open: number;
    wins: number;
    losses: number;
    expired: number;
    winRate: number;
    totalPnlPoints: number;
    avgWinPoints: number;
    avgLossPoints: number;
    avgRR: number | null;
    maxWinStreak: number;
    maxLossStreak: number;
    currentStreak: number;
    profitFactor: number | null;
  } {
    const agg = this.raw
      .query<Record<string, number | null>, [string]>(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('TP1_HIT','TP2_HIT','STOPPED','EXPIRED')) AS closed,
           COUNT(*) FILTER (WHERE status IN ('ACTIVE','TP1_HIT'))                      AS open,
           COUNT(*) FILTER (WHERE pnl_points > 0)                                      AS wins,
           COUNT(*) FILTER (WHERE pnl_points <= 0 AND pnl_points IS NOT NULL)          AS losses,
           COUNT(*) FILTER (WHERE status = 'EXPIRED')                                  AS expired,
           COALESCE(SUM(pnl_points), 0)                                                AS net,
           COALESCE(SUM(pnl_points) FILTER (WHERE pnl_points > 0), 0)                  AS gross_win,
           COALESCE(-SUM(pnl_points) FILTER (WHERE pnl_points <= 0), 0)                AS gross_loss
         FROM trading_ideas WHERE asset = ?`,
      )
      .get(asset)!;

    // Streaks need the resolved sequence in order, which an aggregate cannot give.
    const resolved = this.raw
      .query<{ pnl_points: number }, [string]>(
        `SELECT pnl_points FROM trading_ideas
         WHERE asset = ? AND pnl_points IS NOT NULL
         ORDER BY COALESCE(resolved_at, created_at)`,
      )
      .all(asset);

    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let run = 0;
    for (const r of resolved) {
      const won = r.pnl_points > 0;
      // Reset to +/-1 when the sign flips, otherwise extend the run.
      run = won ? (run > 0 ? run + 1 : 1) : run < 0 ? run - 1 : -1;
      if (run > maxWinStreak) maxWinStreak = run;
      if (-run > maxLossStreak) maxLossStreak = -run;
    }

    const wins = Number(agg.wins ?? 0);
    const losses = Number(agg.losses ?? 0);
    const grossWin = Number(agg.gross_win ?? 0);
    const grossLoss = Number(agg.gross_loss ?? 0);
    const decided = wins + losses;
    const avgWinPoints = wins ? grossWin / wins : 0;
    const avgLossPoints = losses ? grossLoss / losses : 0;

    return {
      asset,
      closed: Number(agg.closed ?? 0),
      open: Number(agg.open ?? 0),
      wins,
      losses,
      expired: Number(agg.expired ?? 0),
      winRate: decided ? (wins / decided) * 100 : 0,
      totalPnlPoints: Number(agg.net ?? 0),
      avgWinPoints,
      avgLossPoints,
      avgRR: avgLossPoints > 0 ? avgWinPoints / avgLossPoints : null,
      maxWinStreak,
      maxLossStreak,
      // Positive = consecutive wins, negative = consecutive losses.
      currentStreak: run,
      // null, not 0 — see core/backtest.ts computeMetrics.
      profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    };
  }

  /**
   * Every resolved position across all assets, with the window it was held for.
   *
   * Cross-asset on purpose: this feeds the portfolio view, where the question
   * is how many of these results were independent of each other rather than how
   * one instrument did. `performance()` answers the per-asset question and this
   * one deliberately does not duplicate it.
   */
  holdingPeriods(): Array<{
    asset: string;
    start: number;
    end: number;
    won: boolean;
  }> {
    return this.raw
      .query<
        {
          asset: string;
          created_at: number;
          resolved_at: number | null;
          pnl_points: number;
        },
        []
      >(
        `SELECT asset, created_at, resolved_at, pnl_points FROM trading_ideas
         WHERE pnl_points IS NOT NULL
         ORDER BY created_at`,
      )
      .all()
      .map(r => ({
        asset: r.asset,
        start: r.created_at,
        // A resolved row with no timestamp predates that column being written.
        // Treating it as instantaneous understates concurrency; the alternative
        // is dropping the trade, which understates the sample. Keep the trade.
        end: r.resolved_at ?? r.created_at,
        won: r.pnl_points > 0,
      }));
  }

  // ─── Self-heal outcome memory ───

  /**
   * Append one self-heal outcome. Never updates: this is a record of what was
   * decided at a moment, and a record that can be edited is not evidence.
   */
  recordOutcome(o: {
    asset: string;
    regime: string;
    action: string;
    status: string;
    score: number;
    config: unknown;
    reason: string;
    metadata?: unknown;
    at?: number;
  }): number {
    const r = this.raw
      .prepare(
        `INSERT INTO strategy_outcomes
           (asset, regime, action, status, score, config, reason, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.asset,
        o.regime,
        o.action,
        o.status,
        o.score,
        JSON.stringify(o.config),
        o.reason,
        o.metadata === undefined ? null : JSON.stringify(o.metadata),
        o.at ?? Date.now(),
      );
    return Number(r.lastInsertRowid);
  }

  /** Recorded outcomes, newest first. */
  outcomes(opts: { asset?: string; limit?: number } = {}): Array<{
    id: number;
    asset: string;
    regime: string;
    action: string;
    status: string;
    score: number;
    config: StrategyConfig;
    reason: string;
    metadata: unknown;
    at: number;
  }> {
    const limit = opts.limit ?? 100;
    const rows = opts.asset
      ? this.raw
          .query<Record<string, string | number | null>, [string, number]>(
            `SELECT * FROM strategy_outcomes WHERE asset = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(opts.asset, limit)
      : this.raw
          .query<Record<string, string | number | null>, [number]>(
            `SELECT * FROM strategy_outcomes ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit);

    return rows.map(r => ({
      id: Number(r.id),
      asset: String(r.asset),
      regime: String(r.regime),
      action: String(r.action),
      status: String(r.status),
      score: Number(r.score),
      config: JSON.parse(String(r.config)) as StrategyConfig,
      reason: String(r.reason),
      metadata: r.metadata === null ? null : JSON.parse(String(r.metadata)),
      at: Number(r.created_at),
    }));
  }
}

/** Process-wide handle, opened lazily so importing this module is side-effect free. */
let singleton: Db | null = null;
export function db(): Db {
  if (!singleton) singleton = new Db();
  return singleton;
}
