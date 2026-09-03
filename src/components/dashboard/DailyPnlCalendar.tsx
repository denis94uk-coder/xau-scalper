import {
  eachDayOfInterval,
  endOfMonth,
  format,
  getDay,
  isToday,
  startOfMonth,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { fmtPrice } from "@/lib/priceApi";

export interface DayStats {
  wins: number;
  losses: number;
  /** Sum of per-trade % of entry — see pnlPct. Never raw price points. */
  pnl: number;
  count: number;
}

/**
 * P&L as % of entry — the only unit comparable across assets and the
 * calendar's unit throughout. Raw price points span orders of magnitude
 * between BTC and a sub-cent altcoin: a full stop on ONG is 0.003 points,
 * and a day of honest trades sums to a rounded "0.0".
 */
export function pnlPct(idea: {
  pnlPoints: number | null;
  entryPrice: number;
}): number | null {
  if (idea.pnlPoints === null || idea.entryPrice === 0) return null;
  return (idea.pnlPoints / idea.entryPrice) * 100;
}

/**
 * Month-navigating daily P&L calendar. Green/red cells by realized P&L as
 * % of entry, hover for the W/L split. Local-date keys ("yyyy-MM-dd") — a
 * trade resolved in the evening belongs on the day the operator saw it
 * happen, not on UTC's tomorrow.
 */
export function DailyPnlCalendar({
  byDay,
  ideas,
}: {
  byDay: Record<string, DayStats>;
  ideas?: Array<{
    id: number;
    asset: string;
    direction: string;
    entryPrice: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    pnlPoints: number | null;
    status: string;
    createdAt: number;
    resolvedAt: number | null;
  }>;
}) {
  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const monthPrefix = format(cursor, "yyyy-MM");
  const monthKeys = Object.keys(byDay).filter(k => k.startsWith(monthPrefix));
  const monthPnl = monthKeys.reduce((sum, k) => sum + byDay[k].pnl, 0);
  const monthTrades = monthKeys.reduce((sum, k) => sum + byDay[k].count, 0);

  const yearPrefix = format(cursor, "yyyy");
  const yearKeys = Object.keys(byDay).filter(k => k.startsWith(yearPrefix));
  const yearPnl = yearKeys.reduce((sum, k) => sum + byDay[k].pnl, 0);
  const yearTrades = yearKeys.reduce((sum, k) => sum + byDay[k].count, 0);
  const yearWins = yearKeys.reduce((sum, k) => sum + byDay[k].wins, 0);
  const yearLosses = yearKeys.reduce((sum, k) => sum + byDay[k].losses, 0);

  const isCurrentMonth =
    format(cursor, "yyyy-MM") === format(new Date(), "yyyy-MM");

  // Clear day selection when month changes — otherwise Sep 1 stays selected while viewing August
  useEffect(() => {
    setSelectedDay(null);
  }, [format(cursor, "yyyy-MM")]);

  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
      {/* Header: month nav + yearly PnL — so Sep 1 doesn't hide August */}
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() =>
            setCursor(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))
          }
          className="p-1.5 rounded-md hover:bg-white/10 text-muted-foreground hover:text-white transition-colors flex items-center gap-1 text-xs"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Prev</span>
        </button>
        <div className="flex flex-col items-center">
          <div className="text-sm font-medium flex items-center gap-2">
            {format(cursor, "MMMM yyyy")}
            {monthKeys.length > 0 ? (
              <span
                className={`font-mono text-xs px-1.5 py-0.5 rounded ${monthPnl >= 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}
              >
                {monthPnl >= 0 ? "+" : ""}
                {monthPnl >= 0 ? "+" : ""}
                {monthPnl.toFixed(2)}% · {monthTrades} trades
              </span>
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                — no trades
              </span>
            )}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground flex items-center gap-1.5 mt-0.5">
            <span
              className={
                yearPnl >= 0 ? "text-emerald-400/80" : "text-red-400/80"
              }
            >
              {yearPrefix} YTD: {yearPnl >= 0 ? "+" : ""}
              {yearPnl >= 0 ? "+" : ""}
              {yearPnl.toFixed(2)}%
            </span>
            <span>·</span>
            <span>
              {yearTrades} trades · {yearWins}W/{yearLosses}L
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!isCurrentMonth && (
            <button
              type="button"
              onClick={() => setCursor(new Date())}
              className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 text-xs text-white transition-colors"
            >
              Today
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              setCursor(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))
            }
            className="p-1.5 rounded-md hover:bg-white/10 text-muted-foreground hover:text-white transition-colors flex items-center gap-1 text-xs"
            aria-label="Next month"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
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
                const isSelected = selectedDay === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedDay(isSelected ? null : key)}
                    className={`aspect-square rounded-md flex flex-col items-center justify-center text-[10px] border transition-all hover:brightness-110 ${
                      isSelected
                        ? "ring-1 ring-white/30 bg-white/10 border-white/20"
                        : data
                          ? data.pnl > 0
                            ? "bg-emerald-500/15 border-emerald-500/20 hover:bg-emerald-500/20"
                            : data.pnl < 0
                              ? "bg-red-500/15 border-red-500/20 hover:bg-red-500/20"
                              : "bg-white/5 border-white/5"
                          : isToday(day)
                            ? "border-white/20 bg-white/[0.02] hover:bg-white/[0.05]"
                            : "border-transparent hover:bg-white/5"
                    }`}
                    title={
                      data
                        ? `${key}: ${data.count} trades (${data.wins}W/${data.losses}L), ${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(2)}% — click to see trades`
                        : `${key} — click to see trades`
                    }
                  >
                    <span
                      className={
                        isToday(day)
                          ? "text-white font-semibold"
                          : isSelected
                            ? "text-white"
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
                        {data.pnl >= 0 ? "+" : ""}
                        {data.pnl.toFixed(1)}
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          );
        })()}
      </div>

      {/* Trades for selected day */}
      {selectedDay && (
        <div className="mt-3 pt-3 border-t border-white/5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium">
              {selectedDay}{" "}
              <span className="text-muted-foreground font-normal">
                —{" "}
                {byDay[selectedDay]
                  ? `${byDay[selectedDay].count} trades · ${byDay[selectedDay].pnl >= 0 ? "+" : ""}${byDay[selectedDay].pnl.toFixed(2)}%`
                  : "no trades"}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setSelectedDay(null)}
              className="text-[10px] text-muted-foreground hover:text-white px-2 py-0.5 rounded hover:bg-white/10"
            >
              Clear
            </button>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {(() => {
              const dayIdeas = (ideas ?? []).filter(i => {
                const d = format(
                  new Date(i.resolvedAt ?? i.createdAt),
                  "yyyy-MM-dd",
                );
                return d === selectedDay;
              });
              if (dayIdeas.length === 0) {
                return (
                  <div className="text-xs text-muted-foreground text-center py-3">
                    No trades this day
                  </div>
                );
              }
              return dayIdeas
                .sort(
                  (a, b) =>
                    (a.resolvedAt ?? a.createdAt) -
                    (b.resolvedAt ?? b.createdAt),
                )
                .map(idea => (
                  <div
                    key={idea.id}
                    className="flex flex-col gap-1 text-xs py-2 px-2 rounded bg-white/[0.02] border border-white/5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-medium px-1.5 py-0.5 rounded text-[10px] ${idea.direction === "LONG" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}
                      >
                        {idea.direction}
                      </span>
                      <span className="font-mono text-[#D4A843] truncate max-w-[80px]">
                        {idea.asset}
                      </span>
                      <span
                        className={`text-[10px] px-1 py-0.5 rounded ${idea.status.includes("TP") ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}
                      >
                        {idea.status.replace("_", " ")}
                      </span>
                      <span
                        className={`font-mono ml-auto ${(idea.pnlPoints ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {pnlPct(idea) !== null && pnlPct(idea)! >= 0 ? "+" : ""}
                        {pnlPct(idea) !== null
                          ? `${pnlPct(idea)!.toFixed(2)}%`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[10px]">
                      <span className="text-muted-foreground">
                        Entry{" "}
                        <span className="text-white">
                          {fmtPrice(idea.entryPrice)}
                        </span>
                      </span>
                      <span className="text-white/20">→</span>
                      <span className="text-emerald-400/80">
                        TP1{" "}
                        <span className="text-emerald-400">
                          {fmtPrice(idea.tp1)}
                        </span>
                      </span>
                      <span className="text-white/20">·</span>
                      <span className="text-emerald-400/80">
                        TP2{" "}
                        <span className="text-emerald-400">
                          {fmtPrice(idea.tp2)}
                        </span>
                      </span>
                      <span className="text-white/20">·</span>
                      <span className="text-red-400/70">
                        SL{" "}
                        <span className="text-red-400/80">
                          {fmtPrice(idea.stopLoss)}
                        </span>
                      </span>
                    </div>
                  </div>
                ));
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
