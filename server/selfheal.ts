/**
 * The self-heal loop.
 *
 * Ported from teo/loop.py. Every cycle, per asset: pull a deep candle window,
 * tag the regime, sweep the parameter grid with an out-of-sample split, and ask
 * whether the running config is degraded and whether anything demonstrably
 * beats it. The decision is recorded — including the holds — and never applied.
 *
 * **It proposes; it never applies.** A system that silently rewrites its own
 * trading parameters cannot be reasoned about after the fact, and the failure
 * mode is not theoretical: on a synthetic random walk with no signal in it at
 * all, best-of-N selection cleared the improvement threshold by 14×. Everything
 * below exists to keep that noise out of a live config.
 *
 * Three gates stand between "a candidate scored higher" and "swap proposed":
 *
 *   1. Out-of-sample. The candidate must hold up on bars it was not selected
 *      on. Enforced inside `assess`.
 *   2. Improvement margin. A hair's-width gain is not a reason to change
 *      anything. Also inside `assess`.
 *   3. The live veto, below. A config whose REAL record is beating its
 *      breakeven by more than chance explains is not replaced on the strength
 *      of a backtest, however good the backtest looks.
 *
 * The third exists because the first two are both computed from history, and
 * history is what a sweep overfits. The live record is the only evidence that
 * was not selected on.
 */

import { type AssetDefinition, getEnabledAssets } from "../core/assets";
import { computeMetrics, runBacktest, toBacktestModel } from "../core/backtest";
import { detectRegime, type Regime } from "../core/regime";
import {
  assess,
  DEFAULT_THRESHOLDS,
  type HealthDecision,
  type HealthThresholds,
} from "../core/selfheal";
import {
  assessSignificance,
  type SignificanceReport,
} from "../core/significance";
import type { Candle } from "../core/strategy";
import { runSweep, type SweepResult } from "../core/sweep";
import type { Db } from "./db";
import { publish } from "./events";
import { type Fetcher, fetchCandles } from "./market";

/**
 * Bars pulled per asset for a sweep.
 *
 * Far more than the 200 the engine keeps for indicators. A sweep splits its
 * window in two and needs enough trades on each side to mean anything; at 200
 * bars the held-out half produces single-digit trade counts, and every verdict
 * built on those is noise wearing a decimal point.
 */
const SWEEP_BARS = 1000;
const SWEEP_INTERVAL = "5m";
const SPLIT_RATIO = 0.7;

export interface SelfHealDeps {
  db: Db;
  fetcher?: Fetcher;
  assets?: AssetDefinition[];
  thresholds?: HealthThresholds;
  now?: () => number;
  /** Skip the network and use these bars. For tests. */
  candles?: Candle[];
}

export interface LiveRecord {
  trades: number;
  wins: number;
  winRate: number;
  breakevenRate: number;
  significance: SignificanceReport;
}

export interface HealOutcome {
  asset: string;
  regime: Regime;
  decision: HealthDecision;
  /** The live trading record, when there is one to read. */
  live: LiveRecord | null;
  /** Set when a proposal was overruled by the live record. */
  veto: string | null;
  /** The best candidate the sweep found, whether or not it was proposed. */
  candidate: SweepResult | null;
  /** Row id in strategy_outcomes. */
  recorded: number;
}

/**
 * What the asset's real trades say, if anything.
 *
 * Breakeven is derived from the realised average win and loss rather than
 * assumed, so the bar moves with the geometry the config actually produced.
 */
export function liveRecord(db: Db, asset: string): LiveRecord | null {
  const perf = db.performance(asset);
  const decided = perf.wins + perf.losses;
  if (decided === 0) return null;

  const breakevenRate =
    perf.avgWinPoints + perf.avgLossPoints > 0
      ? (perf.avgLossPoints / (perf.avgWinPoints + perf.avgLossPoints)) * 100
      : 50;

  return {
    trades: decided,
    wins: perf.wins,
    winRate: perf.winRate,
    breakevenRate,
    significance: assessSignificance(perf.wins, decided, breakevenRate),
  };
}

/**
 * Should the live record overrule a proposed swap?
 *
 * Only when the evidence is strong enough to be worth trusting over the
 * backtest — a statistically significant result against the config's own
 * breakeven. A merely-positive record is not enough; that is the same
 * small-sample reading this whole module exists to refuse.
 */
export function liveVeto(live: LiveRecord | null): string | null {
  if (!live) return null;
  if (live.significance.verdict !== "significant") return null;
  return (
    `held: the running config is beating its ${live.breakevenRate.toFixed(1)}% breakeven ` +
    `at ${live.winRate.toFixed(1)}% over ${live.trades} live trades ` +
    `(p = ${live.significance.pValue.toFixed(4)}). A backtest does not outrank that.`
  );
}

/** Run one cycle for one asset. */
export async function healAsset(
  deps: SelfHealDeps,
  asset: AssetDefinition,
): Promise<HealOutcome> {
  const { db } = deps;
  const at = deps.now?.() ?? Date.now();

  let candles = deps.candles;
  if (!candles) {
    const fresh = await fetchCandles(asset.dataSourceSymbol, SWEEP_INTERVAL, {
      fetcher: deps.fetcher,
      limit: SWEEP_BARS,
    });
    db.saveCandles(asset.id, SWEEP_INTERVAL, fresh);
    candles = db.getCandles(asset.id, SWEEP_INTERVAL, SWEEP_BARS);
  }

  const regime = detectRegime(candles);
  const thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;

  // The running config, measured on the same window the candidates are.
  // Scoring them on different data would compare the windows, not the configs.
  const current = computeMetrics(
    runBacktest(
      candles,
      asset.config,
      asset.pricePrecision,
      60,
      asset.costs,
      toBacktestModel(asset.model),
    ),
  );

  const ranked = runSweep(candles, asset, {
    base: asset.config,
    splitRatio: SPLIT_RATIO,
    minTrades: thresholds.minTrades,
  });
  // The running config is usually in the grid. Proposing it back to itself is
  // not a change, so the candidate is the best config that differs.
  const candidate =
    ranked.find(
      r => JSON.stringify(r.config) !== JSON.stringify(asset.config),
    ) ?? null;

  const decision = assess(current, candidate, { regime, thresholds });

  const live = liveRecord(db, asset.id);
  const veto = decision.action === "propose_swap" ? liveVeto(live) : null;

  const final: HealthDecision = veto
    ? { ...decision, action: "hold", reason: `${decision.reason} — ${veto}` }
    : decision;

  const recorded = db.recordOutcome({
    asset: asset.id,
    regime: regime.label,
    action: final.action,
    status: final.status,
    score: final.currentScore,
    // The config in force, not the proposal: this row records what was running
    // when the decision was taken, so a later reader can reconstruct the state.
    config: asset.config,
    reason: final.reason,
    metadata: {
      current,
      candidate: candidate && {
        config: candidate.config,
        score: candidate.score,
        outOfSampleScore: candidate.outOfSampleScore,
      },
      proposedConfig: final.proposedConfig,
      proposedScore: final.proposedScore,
      improvement: final.improvement,
      live,
      veto,
      regime,
      bars: candles.length,
    },
    at,
  });

  db.logJournal({
    eventType: final.action === "propose_swap" ? "HEAL_PROPOSAL" : "HEAL_HOLD",
    asset: asset.id,
    source: "selfheal",
    details: `[${asset.displaySymbol}] ${final.status} · ${final.action} — ${final.reason}`,
    metadata: { regime: regime.label, score: final.currentScore },
  });

  return {
    asset: asset.id,
    regime,
    decision: final,
    live,
    veto,
    candidate,
    recorded,
  };
}

/**
 * Run a cycle across every enabled asset.
 *
 * One asset failing does not stop the rest: a sweep is per-instrument and a
 * fetch failure on TAO says nothing about gold.
 */
export async function runSelfHeal(deps: SelfHealDeps): Promise<HealOutcome[]> {
  const assets = deps.assets ?? getEnabledAssets();
  const results: HealOutcome[] = [];

  for (const asset of assets) {
    try {
      results.push(await healAsset(deps, asset));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.db.recordRun(`selfheal:${asset.id}`, false, msg);
      console.error(`[selfheal] ${asset.id}:`, msg);
    }
  }

  deps.db.recordRun("selfheal", true);
  if (results.length > 0) publish("journal");
  return results;
}
