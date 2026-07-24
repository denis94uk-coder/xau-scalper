import { useQuery } from "convex/react";
import { useTimezone } from "@/contexts/TimezoneContext";
import { api } from "../../../convex/_generated/api";

export function NewsShield() {
  const news = useQuery(api.newsQueries.getNewsState);
  const { formatShortTime } = useTimezone();

  if (!news) {
    return (
      <div className="rounded-lg bg-secondary/20 border border-white/5 p-3 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-36" />
      </div>
    );
  }

  const events = news.events || [];
  const upcomingEvents = events.slice(0, 8);

  return (
    <div className="rounded-lg bg-secondary/20 border border-white/5 overflow-hidden">
      {/* Shield Banner — only shows when active */}
      {news.isShieldActive && (
        <div className="bg-red-500/10 border-b border-red-500/20 px-3 py-2 flex items-center gap-2 animate-pulse">
          <span className="text-sm">🛡️</span>
          <span className="text-[11px] font-mono font-bold text-red-400">
            NEWS SHIELD ACTIVE
          </span>
          <span className="text-[10px] text-red-400/70 font-mono">
            {news.shieldReason}
          </span>
        </div>
      )}

      <div className="p-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono font-bold text-muted-foreground/70 uppercase tracking-wider">
              📅 Economic Calendar
            </span>
          </div>
          {news.nextHighImpactEvent && !news.isShieldActive && (
            <div className="flex items-center gap-1.5">
              {news.minutesToNextEvent < 60 ? (
                <span className="text-[9px] font-mono text-amber-400 animate-pulse">
                  ⚡ {news.nextHighImpactEvent.title} in{" "}
                  {news.minutesToNextEvent}m
                </span>
              ) : (
                <span className="text-[9px] font-mono text-muted-foreground/40">
                  Next: {Math.round(news.minutesToNextEvent / 60)}h
                </span>
              )}
            </div>
          )}
        </div>

        {/* Events list */}
        {upcomingEvents.length > 0 ? (
          <div className="space-y-1">
            {upcomingEvents.map((event: any, i: number) => {
              const isPast = event.dateTime < Date.now();
              const isImminent =
                !isPast && event.dateTime - Date.now() < 60 * 60 * 1000;
              const impactColor =
                event.impact === "HIGH"
                  ? "#FF5252"
                  : event.impact === "MEDIUM"
                    ? "#FFB74D"
                    : "#888";

              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 text-[10px] rounded-md px-2 py-1 transition-colors ${
                    isPast
                      ? "opacity-40"
                      : isImminent
                        ? "bg-amber-500/5 border border-amber-500/10"
                        : "hover:bg-white/[0.02]"
                  }`}
                >
                  {/* Impact dot */}
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: impactColor }}
                  />

                  {/* Country */}
                  <span className="text-[8px] font-mono text-muted-foreground/40 w-5 flex-shrink-0">
                    {event.country}
                  </span>

                  {/* Time */}
                  <span className="text-[9px] font-mono text-muted-foreground/60 w-12 flex-shrink-0">
                    {formatShortTime(event.dateTime)}
                  </span>

                  {/* Title */}
                  <span
                    className={`font-mono flex-1 truncate ${
                      isImminent
                        ? "text-amber-400 font-bold"
                        : "text-muted-foreground/70"
                    }`}
                  >
                    {event.title}
                  </span>

                  {/* Impact badge */}
                  <span
                    className="text-[8px] font-mono px-1 py-0.5 rounded"
                    style={{
                      backgroundColor: `${impactColor}15`,
                      color: impactColor,
                    }}
                  >
                    {event.impact}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-[10px] text-muted-foreground/40 font-mono text-center py-4">
            No upcoming events
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact shield indicator for top bar */
export function NewsShieldBadge() {
  const news = useQuery(api.newsQueries.getNewsState);

  if (!news) return null;

  if (news.isShieldActive) {
    return (
      <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 animate-pulse">
        <span className="text-[9px]">🛡️</span>
        <span className="text-[9px] font-mono font-bold text-red-400">
          SHIELD
        </span>
      </div>
    );
  }

  if (news.minutesToNextEvent < 30) {
    return (
      <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20">
        <span className="text-[8px]">⚡</span>
        <span className="text-[9px] font-mono text-amber-400">
          {news.minutesToNextEvent}m
        </span>
      </div>
    );
  }

  return null;
}
