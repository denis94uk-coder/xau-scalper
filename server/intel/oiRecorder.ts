/**
 * Open-interest recorder: the engine's answer to the venue's 30-day memory.
 *
 * The perp positioning hypotheses in core/hypotheses-positioning.ts could not
 * be measured — not because the claims were tested and failed, but because
 * Binance serves only about a month of open-interest history (see ROADMAP-
 * CRYPTO.md round 3). This job samples what the feed DOES show on a fixed
 * cadence and upserts it into oi_snapshots, so the archive grows by one row
 * per symbol per tick forever. In two months the OI rows of every future scan
 * become measurable, using data nobody can revoke.
 *
 * Cheap by construction: one keyless public request per venue symbol per run,
 * incremental since the newest stored observation (with overlap, because the
 * most recent bucket is usually still forming), deduplicated by primary key.
 */

import { getEnabledAssets } from "../../core/assets";
import type { Db } from "../db";
import {
  fetchOpenInterestHistory,
  type OpenInterestPoint,
} from "../market-futures";

/** Venue bucket size requested from openInterestHist. */
export const OI_PERIOD = "5m";

/** Re-request this many seconds before the newest stored point. */
const OVERLAP_SECONDS = 30 * 60;

/** The venue refuses windows older than about thirty days (-1130). */
const VENUE_WINDOW_SECONDS = 30 * 86_400;

export interface OiRecorderDeps {
  db: Db;
  fetcher?: typeof fetch;
  /** Symbols to record. Defaults to enabled Binance assets' feed symbols. */
  symbols?: string[];
  /** Overridable for tests. */
  now?: () => number;
}

/** How many NEW observations this run added (deduped upserts excluded). */
export async function recordOpenInterest(
  deps: OiRecorderDeps,
): Promise<number> {
  const { db } = deps;
  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);

  const symbols = deps.symbols ?? [
    ...new Set(
      getEnabledAssets()
        .filter(a => a.dataSource === "binance")
        .map(a => a.dataSourceSymbol),
    ),
  ];

  let added = 0;
  for (const symbol of symbols) {
    const latest = db.latestOiTime(symbol);
    // A first-ever run asks for the whole venue window; later runs ask for
    // only what could have changed, plus overlap for the forming bucket.
    const floor = nowSec - VENUE_WINDOW_SECONDS;
    const from =
      latest !== null ? Math.max(floor, latest - OVERLAP_SECONDS) : floor;

    let points: OpenInterestPoint[];
    try {
      points = await fetchOpenInterestHistory(symbol, OI_PERIOD, from, nowSec, {
        fetcher: deps.fetcher,
      });
    } catch (e) {
      // One dead symbol must not stop the archive of the others; the failure
      // is visible through job_runs ("oi" job) rather than swallowed here.
      console.error(`[oi] ${symbol}: ${e instanceof Error ? e.message : e}`);
      continue;
    }

    db.saveOiSnapshots(symbol, points);
    added += points.filter(p => latest === null || p.time > latest).length;
  }
  return added;
}
