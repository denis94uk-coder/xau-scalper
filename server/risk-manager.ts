/**
 * Kill Switch / circuit-breaker for the signal engine.
 *
 * Two independent guards operate on every new signal:
 *
 *  1. Daily loss limit — if the net PnL of all ideas resolved today (UTC)
 *     falls to or below `maxDailyLossPts`, new signals are blocked for the
 *     rest of the calendar day. The threshold is a negative number of points
 *     (e.g. -30 means "stop after losing 30 pts today").
 *
 *  2. Open-position cap — if the number of currently open ideas meets or
 *     exceeds `maxOpenPositions`, no new ideas are accepted until one closes.
 *
 * Both limits are checked live on every `canTrade()` call — no polling, no
 * stale state. The halt flag is persisted in the `settings` table (key
 * `risk:killswitch`) so a restart during a halted day resumes halted.
 *
 * Configuration (env vars, all optional):
 *   RISK_MAX_DAILY_LOSS_PTS   negative number, e.g. "-30"  (default: disabled)
 *   RISK_MAX_OPEN_POSITIONS   positive integer, e.g. "5"    (default: disabled)
 *
 * When neither var is set the manager is effectively a no-op and adds no
 * constraint beyond the existing portfolio gate in core/portfolio.ts.
 */

import { DEFAULT_ASSET_ID } from "../core/assets";
import type { Db } from "./db";
import { publish } from "./events";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface RiskConfig {
  /** Halt trading when today's net PnL drops to this (negative) threshold. */
  maxDailyLossPts: number;
  /** Halt trading when this many ideas are simultaneously open. */
  maxOpenPositions: number;
}

/** Build config from environment, applying safe defaults (no-limit). */
export function riskConfigFromEnv(): RiskConfig {
  const lossPts = Number(process.env.RISK_MAX_DAILY_LOSS_PTS ?? "-Infinity");
  const maxOpen = Number(process.env.RISK_MAX_OPEN_POSITIONS ?? "Infinity");
  return {
    maxDailyLossPts: Number.isFinite(lossPts) ? lossPts : -Infinity,
    maxOpenPositions: Number.isFinite(maxOpen) ? maxOpen : Infinity,
  };
}

// ─── Persisted state shape ────────────────────────────────────────────────────

interface PersistedState {
  halted: boolean;
  haltedAt: number | null;
  reason: string | null;
  /** UTC date string, e.g. "2026-08-10". Reset clears the halt for a new day. */
  day: string;
}

const SETTINGS_KEY = "risk:killswitch";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function utcMidnight(now = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ─── Class ───────────────────────────────────────────────────────────────────

export interface TradeDecision {
  allowed: boolean;
  reason?: string;
}

export interface RiskStatus {
  halted: boolean;
  haltedAt: number | null;
  haltReason: string | null;
  dailyLossPts: number;
  openIdeas: number;
  config: RiskConfig;
  day: string;
  limitsActive: boolean;
}

export class RiskManager {
  private db: Db;
  readonly config: RiskConfig;

  constructor(db: Db, config: RiskConfig) {
    this.db = db;
    this.config = config;
  }

  // ── State helpers ──────────────────────────────────────────────────────────

  private load(): PersistedState {
    return (
      this.db.getSetting<PersistedState>(SETTINGS_KEY) ?? {
        halted: false,
        haltedAt: null,
        reason: null,
        day: todayKey(),
      }
    );
  }

  private save(s: PersistedState): void {
    this.db.setSetting(SETTINGS_KEY, s);
  }

  private halt(reason: string, now: number): void {
    const state = this.load();
    if (state.halted) return; // already halted — don't overwrite the first reason
    const next: PersistedState = {
      halted: true,
      haltedAt: now,
      reason,
      day: todayKey(now),
    };
    this.save(next);
    console.error(`[KILL SWITCH] ${reason} — new signals HALTED for today.`);
    publish("risk", { halted: true, reason });
    this.db.logJournal({
      eventType: "KILL_SWITCH_HALT",
      asset: DEFAULT_ASSET_ID,
      details: `[KILL SWITCH] ${reason}`,
      metadata: { haltedAt: now },
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** Net PnL points for all ideas resolved since UTC midnight. */
  dailyLossPts(now = Date.now()): number {
    const since = utcMidnight(now);
    const row = this.db.raw
      .query<{ net: number | null }, [number]>(
        `SELECT COALESCE(SUM(pnl_points), 0) AS net
         FROM trading_ideas
         WHERE resolved_at >= ? AND pnl_points IS NOT NULL`,
      )
      .get(since);
    return row?.net ?? 0;
  }

  /** Count of currently open ideas (ACTIVE + TP1_HIT). */
  openCount(): number {
    const row = this.db.raw
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM trading_ideas WHERE status IN ('ACTIVE','TP1_HIT')`,
      )
      .get();
    return row?.n ?? 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Ask whether a new signal is permitted right now.
   *
   * Checks (in order):
   *  1. Is the kill switch already tripped for today?
   *  2. Has the daily loss threshold just been crossed?
   *  3. Is the open-position cap reached?
   */
  canTrade(now = Date.now()): TradeDecision {
    const { maxDailyLossPts, maxOpenPositions } = this.config;
    const limitsActive =
      Number.isFinite(maxDailyLossPts) || Number.isFinite(maxOpenPositions);
    if (!limitsActive) return { allowed: true };

    // Load persisted state; clear a stale halt from a previous UTC day.
    const state = this.load();
    if (state.halted && state.day !== todayKey(now)) {
      this.save({
        halted: false,
        haltedAt: null,
        reason: null,
        day: todayKey(now),
      });
      console.log("[risk] New UTC day — kill switch reset.");
      publish("risk", { halted: false });
    } else if (state.halted) {
      return { allowed: false, reason: `Kill Switch: ${state.reason}` };
    }

    // Daily loss check.
    if (Number.isFinite(maxDailyLossPts)) {
      const pnl = this.dailyLossPts(now);
      if (pnl <= maxDailyLossPts) {
        const reason =
          `Daily loss limit hit (${pnl.toFixed(1)} pts ≤ ${maxDailyLossPts} pts). ` +
          `Trading halted until UTC midnight.`;
        this.halt(reason, now);
        return { allowed: false, reason: `Kill Switch: ${reason}` };
      }
    }

    // Open-position cap.
    if (Number.isFinite(maxOpenPositions)) {
      const open = this.openCount();
      if (open >= maxOpenPositions) {
        return {
          allowed: false,
          reason: `Kill Switch: Max open positions (${maxOpenPositions}) reached — ${open} currently open.`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Manually clear the halt — useful when the operator has reviewed the
   * situation and wants to resume intraday. Logs the override to the journal.
   */
  resume(now = Date.now()): void {
    const state = this.load();
    if (!state.halted) return;
    this.save({
      halted: false,
      haltedAt: null,
      reason: null,
      day: todayKey(now),
    });
    console.log("[risk] Kill switch manually cleared.");
    publish("risk", { halted: false, manual: true });
    this.db.logJournal({
      eventType: "KILL_SWITCH_RESUME",
      asset: DEFAULT_ASSET_ID,
      details: "[KILL SWITCH] Manually resumed by operator.",
      metadata: { resumedAt: now },
    });
  }

  /**
   * Explicit UTC-midnight reset. Called by the daily timer in index.ts.
   * Clears the halt and starts the new day's accounting fresh.
   */
  dailyReset(now = Date.now()): void {
    const state = this.load();
    const key = todayKey(now);
    if (!state.halted && state.day === key) return; // already current
    this.save({ halted: false, haltedAt: null, reason: null, day: key });
    console.log(`[risk] UTC midnight reset — new trading day: ${key}`);
    publish("risk", { halted: false, day: key });
  }

  /** Snapshot of current risk state for the API. */
  status(now = Date.now()): RiskStatus {
    const state = this.load();
    return {
      halted: state.day === todayKey(now) ? state.halted : false,
      haltedAt: state.haltedAt,
      haltReason: state.reason,
      dailyLossPts: this.dailyLossPts(now),
      openIdeas: this.openCount(),
      config: this.config,
      day: todayKey(now),
      limitsActive:
        Number.isFinite(this.config.maxDailyLossPts) ||
        Number.isFinite(this.config.maxOpenPositions),
    };
  }
}
