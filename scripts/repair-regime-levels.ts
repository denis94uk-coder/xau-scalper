/**
 * One-off repair for ideas corrupted by the regime-multiplier bug.
 *
 * The engine used to scale SL/TP by multiplying the stored PRICE LEVEL
 * (`sl * 1.5`) instead of the DISTANCE from entry. Under RANGING (0.8×/0.7×)
 * that dragged a long's targets below its entry — booked as instant "TP2 HIT"
 * losses — and a short's stop below its entry — booked as instant fake stops.
 *
 * The multipliers are recorded in the idea's reason string
 * ("regime RANGING (SL 0.8× TP 0.7×)"), so the intended base levels are
 * recoverable: base = stored / mult, correct = entry + (base - entry) * mult.
 *
 * For every affected idea this script:
 *   1. rewrites stop_loss / tp1 / tp2 to the corrected levels,
 *   2. resets the bogus exit (status, pnl, trailing stop, idea_events,
 *      signal_journal rows) back to ACTIVE,
 *   3. replays stored 5m candles through the engine's own `applyPrice` so the
 *      idea's outcome is re-derived honestly from what price actually did.
 *
 * Idempotent: the rewrite only fires when the stored levels still show the
 * corruption signature (a target on the wrong side of entry), and repaired
 * ideas are marked in their reason string. Ideas whose candles are not stored
 * stay ACTIVE with corrected levels for the live engine to track.
 *
 * Usage:
 *   bun scripts/repair-regime-levels.ts            # apply
 *   bun scripts/repair-regime-levels.ts --dry-run  # report only
 */

import {
  getAsset,
  type AssetDefinition,
} from "../core/assets";
import {
  DEFAULT_STRATEGY_CONFIG,
  type Candle,
} from "../core/strategy";
import { applyPrice } from "../server/engine";
import { db as openDb } from "../server/db";

const db = openDb();
const DRY_RUN = process.argv.includes("--dry-run");

const REGIME_TAG = /regime [A-Z_]+ \(SL ([\d.]+)× TP ([\d.]+)×\)/;
const REPAIR_MARK = "· levels repaired";

// Exit events written by applyPrice — all of them are bogus for a corrupted
// idea and are rebuilt by the replay.
const EXIT_EVENTS = [
  "TP1_HIT",
  "TP2_HIT",
  "SL_HIT",
  "TRAIL_SL_HIT",
  "TRAIL_SL_UPDATE",
];

interface CorruptIdea {
  id: number;
  asset: string;
  direction: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  reason: string;
  slMult: number;
  tpMult: number;
}

function roundTo(n: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round(n * f) / f;
}

function correctedLevel(
  stored: number,
  entry: number,
  mult: number,
  precision: number,
): number {
  const base = stored / mult;
  return roundTo(entry + (base - entry) * mult, precision);
}

/**
 * Did the level multiplication actually invert this idea's geometry?
 * Under RANGING (mults < 1) it always did — a long's targets land below
 * entry, a short's stop below entry. This check is what makes a re-run safe:
 * already-corrected levels have sane ordering and are left alone.
 */
function isCorrupted(idea: CorruptIdea): boolean {
  if (idea.reason.includes(REPAIR_MARK)) return false;
  if (idea.direction === "LONG") {
    return idea.tp1 < idea.entry || idea.tp2 < idea.entry || idea.stopLoss > idea.entry;
  }
  return idea.tp1 > idea.entry || idea.tp2 > idea.entry || idea.stopLoss < idea.entry;
}

/** Classic Wilder ATR over the candles up to and including index i. */
function atrAt(candles: Candle[], i: number, period = 14): number {
  if (i < period) return 0;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const prev = candles[j - 1].close;
    sum += Math.max(
      candles[j].high - candles[j].low,
      Math.abs(candles[j].high - prev),
      Math.abs(candles[j].low - prev),
    );
  }
  return sum / period;
}

// Assets that have left the registry can still be replayed: applyPrice only
// reads id, pricePrecision and the trail multiplier.
function assetDefFor(id: string, precision: number): AssetDefinition {
  return (
    getAsset(id) ??
    ({
      id,
      pricePrecision: precision,
      config: { ...DEFAULT_STRATEGY_CONFIG },
    } as AssetDefinition)
  );
}

const all = db.listIdeas({ limit: 500 });
const tagged: CorruptIdea[] = [];
for (const idea of all) {
  const m = idea.reason.match(REGIME_TAG);
  if (!m) continue;
  const slMult = Number(m[1]);
  const tpMult = Number(m[2]);
  if (slMult === 1 && tpMult === 1) continue;
  tagged.push({
    id: idea.id,
    asset: idea.asset,
    direction: idea.direction,
    entry: idea.entry_price,
    stopLoss: idea.stop_loss,
    tp1: idea.tp1,
    tp2: idea.tp2,
    reason: idea.reason,
    slMult,
    tpMult,
  });
}

console.log(
  `${all.length} ideas scanned, ${tagged.length} carry regime multipliers\n`,
);

for (const idea of tagged) {
  const precision = getAsset(idea.asset)?.pricePrecision ?? 8;
  const needsRewrite = isCorrupted(idea);

  if (needsRewrite) {
    const sl = correctedLevel(idea.stopLoss, idea.entry, idea.slMult, precision);
    const tp1 = correctedLevel(idea.tp1, idea.entry, idea.tpMult, precision);
    const tp2 = correctedLevel(idea.tp2, idea.entry, idea.tpMult, precision);
    console.log(
      `#${idea.id} ${idea.asset} ${idea.direction} @ ${idea.entry}\n` +
        `  SL  ${idea.stopLoss} -> ${sl}\n` +
        `  TP1 ${idea.tp1} -> ${tp1}\n` +
        `  TP2 ${idea.tp2} -> ${tp2}`,
    );
    if (DRY_RUN) continue;

    db.raw
      .prepare(
        `UPDATE trading_ideas
         SET stop_loss = ?, tp1 = ?, tp2 = ?, status = 'ACTIVE',
             trailing_sl = NULL, pnl_points = NULL, resolved_at = NULL,
             reason = ?
         WHERE id = ?`,
      )
      .run(sl, tp1, tp2, `${idea.reason} ${REPAIR_MARK}`, idea.id);

    const evDel = db.raw
      .prepare(
        `DELETE FROM idea_events WHERE idea_id = ? AND event IN (${EXIT_EVENTS.map(() => "?").join(", ")})`,
      )
      .run(idea.id, ...EXIT_EVENTS);
    const jrDel = db.raw
      .prepare(
        `DELETE FROM signal_journal WHERE idea_id = ? AND event_type IN (${EXIT_EVENTS.map(() => "?").join(", ")})`,
      )
      .run(idea.id, ...EXIT_EVENTS);

    // The SIGNAL_GENERATED journal row quotes the corrupted levels; rewrite it
    // so the journal reads coherently with the repaired idea.
    const row = db.raw
      .query<{ id: number; details: string }, [number]>(
        `SELECT id, details FROM signal_journal
         WHERE idea_id = ? AND event_type = 'SIGNAL_GENERATED'`,
      )
      .get(idea.id);
    if (row) {
      const details = row.details
        .replace(/SL [0-9.]+/, `SL ${sl}`)
        .replace(/TP1 [0-9.]+/, `TP1 ${tp1}`)
        .replace(/TP2 [0-9.]+/, `TP2 ${tp2}`);
      db.raw
        .prepare(`UPDATE signal_journal SET details = ? WHERE id = ?`)
        .run(details, row.id);
    }
    console.log(
      `  reset (${evDel.changes} events, ${jrDel.changes} journal rows cleared)`,
    );
  }

  if (DRY_RUN) continue;

  // Replay stored candles so the idea's outcome reflects the corrected levels.
  const current = db.getIdea(idea.id);
  if (!current || (current.status !== "ACTIVE" && current.status !== "TP1_HIT"))
    continue;
  const candles = db
    .getCandleRange(
      idea.asset,
      "5m",
      Math.floor(current.created_at / 1000),
      Math.ceil(Date.now() / 1000),
    )
    .filter(c => c.time * 1000 > current.created_at);
  if (candles.length === 0) {
    console.log(`#${idea.id} ${idea.asset}  no stored candles — left ACTIVE`);
    continue;
  }
  let tracked = current;
  for (let i = 0; i < candles.length; i++) {
    applyPrice(
      db,
      assetDefFor(idea.asset, precision),
      tracked,
      candles[i],
      atrAt(candles, i),
    );
    tracked = db.getIdea(idea.id)!;
    if (tracked.status !== "ACTIVE" && tracked.status !== "TP1_HIT") break;
  }
  const done = db.getIdea(idea.id)!;
  console.log(
    `#${idea.id} ${idea.asset}  replayed ${candles.length} bars -> ${done.status}${done.pnl_points !== null ? ` (${done.pnl_points >= 0 ? "+" : ""}${done.pnl_points} pts)` : ""}`,
  );
}

if (!DRY_RUN) console.log("\nDone.");
