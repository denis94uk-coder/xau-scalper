/**
 * LSE economic calendar — the real event feed, writing to its OWN setting key.
 *
 * `newsShield` (the synthetic recurring-events table) stays untouched: the
 * top10 book keeps its historical behaviour bit-for-bit. This module serves
 * the LSE engine, which prefers the vault's actual calendar — real FOMC/CPI/
 * NFP timestamps instead of a guess — and classifies impact by name because
 * the vault often leaves the impact column null.
 *
 * Shield windows match the house rule: no new signals 15m before / 10m after
 * a high-impact event.
 */

import type { Db } from "../db";
import { fetchLseCalendar } from "../lse";

const KEY = "lseNewsShield";
const BEFORE_MS = 15 * 60 * 1000;
const AFTER_MS = 10 * 60 * 1000;

export interface LseShieldEvent {
  title: string;
  region: string;
  impact: "HIGH" | "MEDIUM" | "LOW";
  dateTime: number; // epoch ms
}

/**
 * Events the vault may not grade, so HIGH impact is classified by name.
 * Gold trades the dollar, so the list is US-centric with the two European
 * rate decisions that move it.
 */
const HIGH_IMPACT_PATTERNS: Array<[RegExp, "HIGH" | "MEDIUM"]> = [
  [/fomc|federal funds rate|fed interest rate/i, "HIGH"],
  [/non-farm|nonfarm|nfp/i, "HIGH"],
  [/unemployment rate/i, "HIGH"],
  [/cpi/i, "HIGH"],
  [/pce/i, "HIGH"],
  [/gdp/i, "HIGH"],
  [/retail sales/i, "HIGH"],
  [/ism manufacturing/i, "HIGH"],
  [/ecb.*(rate|deposit)/i, "MEDIUM"],
  [/boe.*rate|bank rate/i, "MEDIUM"],
];

export function classifyImpact(event: string): "HIGH" | "MEDIUM" | null {
  for (const [pattern, impact] of HIGH_IMPACT_PATTERNS) {
    if (pattern.test(event)) return impact;
  }
  return null;
}

/** Events from now-1h to now+8d that the shield cares about. */
export async function fetchShieldEvents(
  fetcher?: typeof fetch,
): Promise<LseShieldEvent[]> {
  const now = Date.now();
  const rows = await fetchLseCalendar({
    fetcher,
    regions: ["US", "EU", "GB"],
    start: new Date(now - 3_600_000).toISOString().slice(0, 10),
    end: new Date(now + 8 * 86_400_000).toISOString().slice(0, 10),
  });
  const events: LseShieldEvent[] = [];
  for (const r of rows) {
    const impact = classifyImpact(r.event);
    if (!impact) continue;
    events.push({
      title: r.event,
      region: r.region,
      impact,
      dateTime: r.datetime * 1000,
    });
  }
  events.sort((a, b) => a.dateTime - b.dateTime);
  return events.slice(0, 15);
}

export interface LseShieldState {
  source: "lse";
  events: LseShieldEvent[];
  isShieldActive: boolean;
  shieldReason: string;
  nextHighImpactEvent: LseShieldEvent | null;
  minutesToNextEvent: number;
  shieldStartsAt: number;
  shieldEndsAt: number;
}

/** Pure window logic, exported for tests. */
export function shieldState(
  events: LseShieldEvent[],
  now = Date.now(),
): LseShieldState {
  const highImpact = events.filter(e => e.impact === "HIGH");
  let nextHigh: LseShieldEvent | null = null;
  let isActive = false;
  let reason = "";
  let shieldStart = 0;
  let shieldEnd = 0;

  for (const event of highImpact) {
    const beforeWindow = event.dateTime - BEFORE_MS;
    const afterWindow = event.dateTime + AFTER_MS;
    if (now >= beforeWindow && now <= afterWindow) {
      isActive = true;
      const mins = Math.round((event.dateTime - now) / 60000);
      reason =
        mins > 0
          ? `⚠️ ${event.title} in ${mins} min — signals paused`
          : `⚠️ ${event.title} released ${Math.round((now - event.dateTime) / 60000)} min ago — shield active`;
      shieldStart = beforeWindow;
      shieldEnd = afterWindow;
      nextHigh = event;
      break;
    }
    if (event.dateTime > now && !nextHigh) {
      nextHigh = event;
      shieldStart = beforeWindow;
      shieldEnd = afterWindow;
    }
  }

  return {
    source: "lse",
    events,
    isShieldActive: isActive,
    shieldReason: reason,
    nextHighImpactEvent: nextHigh,
    minutesToNextEvent: nextHigh
      ? Math.round((nextHigh.dateTime - now) / 60000)
      : 9999,
    shieldStartsAt: shieldStart,
    shieldEndsAt: shieldEnd,
  };
}

export async function updateLseCalendar(
  db: Db,
  fetcher?: typeof fetch,
): Promise<void> {
  try {
    let events: LseShieldEvent[] = [];
    try {
      events = await fetchShieldEvents(fetcher);
    } catch {
      // Feed down or key missing: write an empty-but-honest state. A shield
      // that silently claims "all clear" while blind would be worse.
      events = [];
      const stale = db.getSetting<LseShieldState>(KEY);
      if (stale) {
        db.setSetting(KEY, { ...stale, events: [], source: "lse" as const });
        console.log("[LSE News] feed unreachable — kept stale shield state");
        return;
      }
    }
    const state = shieldState(events);
    db.setSetting(KEY, state);

    if (state.isShieldActive) {
      console.log(`[LSE News] 🛡️ SHIELD ACTIVE: ${state.shieldReason}`);
    } else if (state.minutesToNextEvent < 60) {
      console.log(
        `[LSE News] Next high-impact: ${state.nextHighImpactEvent?.title} in ${state.minutesToNextEvent} min`,
      );
    } else {
      console.log(`[LSE News] No imminent events. ${events.length} in queue.`);
    }
  } catch (e) {
    console.error("[LSE News] Error:", e instanceof Error ? e.message : e);
  }
}
