import {
  eachDayOfInterval,
  endOfMonth,
  format,
  getDay,
  isToday,
  startOfMonth,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

export interface DayStats {
  wins: number;
  losses: number;
  pnl: number;
  count: number;
}

/**
 * Month-navigating daily P&L calendar. Green/red cells by realized points,
 * hover for the W/L split. Local-date keys ("yyyy-MM-dd") — a trade resolved
 * in the evening belongs on the day the operator saw it happen, not on UTC's
 * tomorrow.
 */
export function DailyPnlCalendar({
  byDay,
}: {
  byDay: Record<string, DayStats>;
}) {
  const [cursor, setCursor] = useState<Date>(() => new Date());

  const monthPrefix = format(cursor, "yyyy-MM");
  const monthKeys = Object.keys(byDay).filter(k => k.startsWith(monthPrefix));
  const monthPnl = monthKeys.reduce((sum, k) => sum + byDay[k].pnl, 0);

  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() =>
            setCursor(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))
          }
          className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-sm font-medium">
          {format(cursor, "MMMM yyyy")}
          {monthKeys.length > 0 && (
            <span
              className={`font-mono ml-2 ${monthPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}
            >
              {monthPnl >= 0 ? "+" : ""}
              {monthPnl.toFixed(1)} pts
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() =>
            setCursor(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))
          }
          className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
          aria-label="Next month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
          <div
            key={d}
            className="text-[10px] text-center text-muted-foreground pb-1"
          >
            {d}
          </div>
        ))}
        {(() => {
          const days = eachDayOfInterval({
            start: startOfMonth(cursor),
            end: endOfMonth(cursor),
          });
          // Monday-first offset so the 1st lands under its weekday header.
          const lead = (getDay(days[0]) + 6) % 7;
          return (
            <>
              {Array.from({ length: lead }, (_, i) => (
                <div key={`lead-${i}`} />
              ))}
              {days.map(day => {
                const key = format(day, "yyyy-MM-dd");
                const data = byDay[key];
                return (
                  <div
                    key={key}
                    className={`aspect-square rounded-md flex flex-col items-center justify-center text-[10px] border ${
                      data
                        ? data.pnl > 0
                          ? "bg-emerald-500/15 border-emerald-500/20"
                          : data.pnl < 0
                            ? "bg-red-500/15 border-red-500/20"
                            : "bg-white/5 border-white/5"
                        : isToday(day)
                          ? "border-white/20 bg-white/[0.02]"
                          : "border-transparent"
                    }`}
                    title={
                      data
                        ? `${key}: ${data.count} trades (${data.wins}W/${data.losses}L), ${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(1)} pts`
                        : key
                    }
                  >
                    <span
                      className={
                        isToday(day)
                          ? "text-white font-semibold"
                          : "text-muted-foreground"
                      }
                    >
                      {day.getDate()}
                    </span>
                    {data && (
                      <span
                        className={`font-mono font-medium ${data.pnl > 0 ? "text-emerald-400" : data.pnl < 0 ? "text-red-400" : "text-muted-foreground"}`}
                      >
                        {data.pnl >= 0 ? "+" : ""}
                        {data.pnl.toFixed(0)}
                      </span>
                    )}
                  </div>
                );
              })}
            </>
          );
        })()}
      </div>
    </div>
  );
}
