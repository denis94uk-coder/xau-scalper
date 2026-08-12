/**
 * Regime-tagged outcome memory — what the self-heal loop learns from.
 *
 * Ported from teo/memory.py, with the storage removed. The Python version was a
 * JSON file that the recall logic read and wrote directly, which made the
 * interesting part (choosing what to recall) untestable without a filesystem.
 * Here the decisions are pure functions over records and the SQLite table lives
 * in `server/db.ts`, matching how every other piece of this codebase is split.
 *
 * The point of tagging by regime: a config that worked in a trending, quiet
 * market says nothing about a choppy, volatile one. Recalling the globally best
 * config would fight the current conditions with the last conditions' answer.
 */

import type { StrategyConfig } from "./strategy";
import { isScored } from "./sweep";

export interface OutcomeRecord {
  asset: string;
  /** Regime label at the time, e.g. "trend_up/high_vol". */
  regime: string;
  score: number;
  config: StrategyConfig;
  action: string;
  at: number;
}

export interface RecallOptions {
  /** Ignore records scoring below this. */
  minScore?: number;
  /**
   * Ignore records older than this many milliseconds.
   *
   * A config that scored well against last quarter's market is a weaker claim
   * than one that scored well last week, even in the same nominal regime — the
   * label is a coarse summary and drift happens inside it.
   */
  maxAgeMs?: number;
  /** Overridable for tests. */
  now?: number;
}

/** Records for one asset in one regime, newest first. */
export function forRegime(
  records: OutcomeRecord[],
  asset: string,
  regime: string,
  opts: RecallOptions = {},
): OutcomeRecord[] {
  const now = opts.now ?? Date.now();
  return records
    .filter(r => r.asset === asset && r.regime === regime)
    .filter(r => opts.minScore === undefined || r.score >= opts.minScore)
    .filter(r => opts.maxAgeMs === undefined || now - r.at <= opts.maxAgeMs)
    .sort((a, b) => b.at - a.at);
}

/**
 * Highest-scoring record for this asset and regime.
 *
 * Ties break toward the more recent record: two configs that scored identically
 * are not equally informative, and the newer one was measured against a market
 * closer to the one being traded now.
 */
export function bestForRegime(
  records: OutcomeRecord[],
  asset: string,
  regime: string,
  opts: RecallOptions = {},
): OutcomeRecord | null {
  // Unscored records are dropped, not ranked. A config that never traded
  // enough to be judged carries the sentinel score, and recalling it as "best"
  // would hand back the one config we know nothing about.
  const candidates = forRegime(records, asset, regime, opts).filter(r =>
    isScored(r.score),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => (r.score > best.score ? r : best));
}

/** The best-known config for this asset and regime, ready to reuse. */
export function recallConfig(
  records: OutcomeRecord[],
  asset: string,
  regime: string,
  opts: RecallOptions = {},
): StrategyConfig | null {
  return bestForRegime(records, asset, regime, opts)?.config ?? null;
}

export interface RegimeSummary {
  regime: string;
  records: number;
  /** Records that actually traded enough to carry a score. */
  scored: number;
  /** null when nothing in this regime traded enough to be judged. */
  bestScore: number | null;
  worstScore: number | null;
  medianScore: number | null;
  /** Proposals made in this regime, as opposed to holds. */
  proposals: number;
}

/**
 * What the loop has learned per regime, for one asset.
 *
 * Reports the median rather than the mean because a single windfall window
 * distorts a mean badly at these sample sizes, and the median answers the
 * question actually being asked: what does this regime usually look like.
 */
export function summariseByRegime(
  records: OutcomeRecord[],
  asset: string,
): RegimeSummary[] {
  const groups = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    if (r.asset !== asset) continue;
    const list = groups.get(r.regime);
    if (list) list.push(r);
    else groups.set(r.regime, [r]);
  }

  return [...groups.entries()]
    .map(([regime, rows]) => {
      // Sentinel scores are excluded from every statistic. Including them
      // would report a regime's best score as -1000000000, which reads as a
      // catastrophic result rather than as "nothing here traded enough".
      const scores = rows
        .map(r => r.score)
        .filter(isScored)
        .sort((a, b) => a - b);
      const mid = Math.floor(scores.length / 2);
      const empty = scores.length === 0;
      return {
        regime,
        records: rows.length,
        scored: scores.length,
        bestScore: empty ? null : scores[scores.length - 1],
        worstScore: empty ? null : scores[0],
        medianScore: empty
          ? null
          : scores.length % 2 === 1
            ? scores[mid]
            : (scores[mid - 1] + scores[mid]) / 2,
        proposals: rows.filter(r => r.action === "propose_swap").length,
      };
    })
    .sort((a, b) => b.records - a.records);
}
