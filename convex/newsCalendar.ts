"use node";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// ═══════════════════════════════════════════════════
// ECONOMIC CALENDAR + NEWS SHIELD
// Tracks high-impact economic events, pauses signals near them
// ═══════════════════════════════════════════════════

interface EconomicEvent {
  title: string;
  country: string;
  impact: "HIGH" | "MEDIUM" | "LOW";
  dateTime: number;
}

const RECURRING_HIGH_IMPACT: Array<{
  title: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  hour: number;
  minute: number;
  country: string;
  impact: "HIGH" | "MEDIUM";
  frequency: "weekly" | "monthly" | "quarterly";
}> = [
  {
    title: "Non-Farm Payrolls (NFP)",
    dayOfWeek: 5,
    hour: 12,
    minute: 30,
    country: "US",
    impact: "HIGH",
    frequency: "monthly",
  },
  {
    title: "CPI (Consumer Price Index)",
    dayOfMonth: 13,
    hour: 12,
    minute: 30,
    country: "US",
    impact: "HIGH",
    frequency: "monthly",
  },
  {
    title: "Core PCE Price Index",
    dayOfMonth: 28,
    hour: 12,
    minute: 30,
    country: "US",
    impact: "HIGH",
    frequency: "monthly",
  },
  {
    title: "FOMC Rate Decision",
    dayOfMonth: 18,
    hour: 18,
    minute: 0,
    country: "US",
    impact: "HIGH",
    frequency: "quarterly",
  },
  {
    title: "Fed Chair Powell Speaks",
    dayOfMonth: 19,
    hour: 18,
    minute: 30,
    country: "US",
    impact: "HIGH",
    frequency: "quarterly",
  },
  {
    title: "ISM Manufacturing PMI",
    dayOfMonth: 1,
    hour: 14,
    minute: 0,
    country: "US",
    impact: "HIGH",
    frequency: "monthly",
  },
  {
    title: "Retail Sales",
    dayOfMonth: 15,
    hour: 12,
    minute: 30,
    country: "US",
    impact: "HIGH",
    frequency: "monthly",
  },
  {
    title: "Initial Jobless Claims",
    dayOfWeek: 4,
    hour: 12,
    minute: 30,
    country: "US",
    impact: "MEDIUM",
    frequency: "weekly",
  },
  {
    title: "PPI (Producer Price Index)",
    dayOfMonth: 14,
    hour: 12,
    minute: 30,
    country: "US",
    impact: "MEDIUM",
    frequency: "monthly",
  },
  {
    title: "GDP (Advance)",
    dayOfMonth: 25,
    hour: 12,
    minute: 30,
    country: "US",
    impact: "HIGH",
    frequency: "quarterly",
  },
  {
    title: "ECB Rate Decision",
    dayOfMonth: 6,
    hour: 12,
    minute: 15,
    country: "EU",
    impact: "HIGH",
    frequency: "quarterly",
  },
  {
    title: "BOE Rate Decision",
    dayOfMonth: 7,
    hour: 12,
    minute: 0,
    country: "GB",
    impact: "MEDIUM",
    frequency: "quarterly",
  },
];

function generateUpcomingEvents(): EconomicEvent[] {
  const now = Date.now();
  const events: EconomicEvent[] = [];
  const today = new Date();

  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const day = new Date(today);
    day.setDate(day.getDate() + dayOffset);
    const dow = day.getUTCDay();
    const dom = day.getUTCDate();
    const month = day.getUTCMonth();

    for (const t of RECURRING_HIGH_IMPACT) {
      let match = false;
      if (t.frequency === "weekly" && t.dayOfWeek === dow) match = true;
      if (t.frequency === "monthly" && t.dayOfMonth === dom) match = true;
      if (
        t.frequency === "quarterly" &&
        t.dayOfMonth === dom &&
        [0, 2, 5, 8, 11].includes(month)
      )
        match = true;

      if (match) {
        const eventDate = new Date(day);
        eventDate.setUTCHours(t.hour, t.minute, 0, 0);
        const eventTime = eventDate.getTime();
        if (eventTime > now - 60 * 60 * 1000) {
          events.push({
            title: t.title,
            country: t.country,
            impact: t.impact,
            dateTime: eventTime,
          });
        }
      }
    }
  }

  events.sort((a, b) => a.dateTime - b.dateTime);
  return events.slice(0, 15);
}

function calculateShieldStatus(events: EconomicEvent[]) {
  const now = Date.now();
  const BEFORE = 15 * 60 * 1000;
  const AFTER = 10 * 60 * 1000;

  const highImpact = events.filter(e => e.impact === "HIGH");
  let nextHigh: EconomicEvent | null = null;
  let isActive = false;
  let reason = "";
  let shieldStart = 0,
    shieldEnd = 0;

  for (const event of highImpact) {
    const beforeWindow = event.dateTime - BEFORE;
    const afterWindow = event.dateTime + AFTER;

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

export const updateCalendar = internalAction({
  args: {},
  handler: async ctx => {
    try {
      const events = generateUpcomingEvents();
      const shield = calculateShieldStatus(events);

      await ctx.runMutation(internal.newsQueries.saveNewsState, {
        events: JSON.stringify(events),
        isShieldActive: shield.isShieldActive,
        shieldReason: shield.shieldReason,
        nextHighImpactEvent: shield.nextHighImpactEvent
          ? JSON.stringify(shield.nextHighImpactEvent)
          : "",
        minutesToNextEvent: shield.minutesToNextEvent,
        shieldStartsAt: shield.shieldStartsAt,
        shieldEndsAt: shield.shieldEndsAt,
      });

      if (shield.isShieldActive) {
        console.log(`[News] 🛡️ SHIELD ACTIVE: ${shield.shieldReason}`);
      } else if (shield.minutesToNextEvent < 60) {
        console.log(
          `[News] Next high-impact: ${shield.nextHighImpactEvent?.title} in ${shield.minutesToNextEvent} min`,
        );
      } else {
        console.log(
          `[News] No imminent events. ${events.length} events in queue.`,
        );
      }
    } catch (e: any) {
      console.error("[News] Error:", e.message);
    }
  },
});
