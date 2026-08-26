import { format } from "date-fns";
import { BarChart3, Flame, Layers, Target } from "lucide-react";
import { useState } from "react";
import {
  DailyPnlCalendar,
  type DayStats,
} from "@/components/dashboard/DailyPnlCalendar";
import { useLive } from "@/hooks/useLive";
import { api } from "@/lib/api";

type ViewMode = "all" | "asset";

/**
 * The calendar as its own page: month by month, either one instrument or
 * every instrument at once. Points are only comparable within an asset, so
 * the combined view is framed as a breadth lens — activity and day counts —
 * rather than a precise P&L statement.
 */
export function CalendarPage() {
  const [view, setView] = useState<ViewMode>("asset");
  const [asset, setAsset] = useState<string>("");

  const assets = useLive(() => api.assets().then(r => r.assets), ["hello"]);
  const allIdeas = useLive(
    () => api.ideas({ limit: 500 }).then(r => r.ideas),
    ["ideas"],
  );

  const selected = asset || assets?.find(a => a.enabled)?.id || "";

  if (!allIdeas) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading calendar data...
      </div>
    );
  }

  const inScope =
    view === "all" ? allIdeas : allIdeas.filter(i => i.asset === selected);

  const closed = inScope.filter(
    i =>
      i.status === "TP1_HIT" ||
      i.status === "TP2_HIT" ||
      i.status === "STOPPED" ||
      i.status === "EXPIRED",
  );

  const byDay: Record<string, DayStats> = {};
  for (const idea of closed) {
    const d = format(new Date(idea.resolvedAt ?? idea.createdAt), "yyyy-MM-dd");
    if (!byDay[d]) byDay[d] = { wins: 0, losses: 0, pnl: 0, count: 0 };
    byDay[d].count++;
    byDay[d].pnl += idea.pnlPoints ?? 0;
    // By realized P&L, not status — a STOPPED exit can still be a trailed win.
    if ((idea.pnlPoints ?? 0) > 0) byDay[d].wins++;
    else byDay[d].losses++;
  }

  const days = Object.keys(byDay);
  const totalPnl = days.reduce((s, k) => s + byDay[k].pnl, 0);
  const greenDays = days.filter(k => byDay[k].pnl > 0).length;
  const redDays = days.filter(k => byDay[k].pnl < 0).length;
  const bestDay = days.reduce<string | null>(
    (best, k) => (!best || byDay[k].pnl > byDay[best].pnl ? k : best),
    null,
  );
  const assetsTraded = new Set(closed.map(i => i.asset)).size;

  // Per-asset ranking, best first. Only assets with at least one resolved
  // trade appear — an empty row is noise, not information.
  const symbols = new Map((assets ?? []).map(a => [a.id, a.symbol] as const));
  const ranking = Object.entries(
    closed.reduce<
      Record<string, { pnl: number; wins: number; losses: number }>
    >((acc, idea) => {
      if (!acc[idea.asset]) acc[idea.asset] = { pnl: 0, wins: 0, losses: 0 };
      acc[idea.asset].pnl += idea.pnlPoints ?? 0;
      if ((idea.pnlPoints ?? 0) > 0) acc[idea.asset].wins++;
      else acc[idea.asset].losses++;
      return acc;
    }, {}),
  )
    .map(([id, s]) => ({ id, symbol: symbols.get(id) ?? id, ...s }))
    .sort((a, b) => b.pnl - a.pnl);
  const worstRankPnl = Math.min(...ranking.map(r => r.pnl), 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-[#D4A843]" />
            Calendar
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Daily realized P&L per asset, month by month
          </p>
        </div>
        {/* View mode */}
        <div className="flex gap-1 bg-[#12141A] rounded-lg p-0.5 border border-white/5">
          {(
            [
              { key: "asset", label: "Single Asset", icon: Target },
              { key: "all", label: "All Assets", icon: Layers },
            ] as const
          ).map(m => (
            <button
              key={m.key}
              type="button"
              onClick={() => setView(m.key)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${
                view === m.key
                  ? "bg-white/10 text-white font-medium"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              <m.icon className="w-3 h-3" />
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Asset selector — only meaningful in single-asset view */}
      {view === "asset" && (
        <div className="flex flex-wrap items-center gap-1">
          {(assets ?? [])
            .filter(a => a.enabled)
            .map(a => (
              <button
                type="button"
                key={a.id}
                onClick={() => setAsset(a.id)}
                className={`px-2 py-1 rounded-md text-[11px] font-mono transition-colors ${
                  a.id === selected
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                {a.symbol}
              </button>
            ))}
        </div>
      )}
      {view === "all" && (
        <p className="text-[11px] text-muted-foreground">
          Combined view across {assetsTraded} traded asset
          {assetsTraded === 1 ? "" : "s"}. Point values mix instruments of very
          different price scales — read the colours and day counts first, the
          totals second.
        </p>
      )}

      {/* Summary strip */}
      {days.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <SummaryCard
            label={
              view === "all" ? "Trading Days (all assets)" : "Trading Days"
            }
            value={`${days.length}`}
            icon={<BarChart3 className="w-4 h-4" />}
            color="text-white"
          />
          <SummaryCard
            label="Total P&L"
            value={`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(1)} pts`}
            icon={<Target className="w-4 h-4" />}
            color={totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          <SummaryCard
            label="Green / Red Days"
            value={`${greenDays} / ${redDays}`}
            icon={<Flame className="w-4 h-4" />}
            color="text-muted-foreground"
          />
          <SummaryCard
            label="Best Day"
            value={
              bestDay
                ? `${byDay[bestDay].pnl >= 0 ? "+" : ""}${byDay[bestDay].pnl.toFixed(1)}`
                : "—"
            }
            icon={<Target className="w-4 h-4" />}
            color="text-emerald-400"
            detail={bestDay ?? undefined}
          />
        </div>
      )}

      {/* Asset ranking — only traded assets, best performer first.
          Click a row to focus the calendar on that instrument. */}
      {ranking.length > 0 && (
        <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
          <div className="text-sm font-medium mb-2">Assets by Performance</div>
          <div className="space-y-1">
            {(() => {
              const bestPnl = Math.max(...ranking.map(r => r.pnl), 1);
              return ranking.map((r, i) => {
                // Bar width relative to the best performer; losses scale
                // against the worst so both directions stay readable.
                const width =
                  r.pnl >= 0
                    ? Math.max((r.pnl / bestPnl) * 100, 4)
                    : Math.max((r.pnl / (worstRankPnl || -1)) * 100, 4);
                const isFocused = view === "asset" && r.id === selected;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setAsset(r.id);
                      setView("asset");
                    }}
                    className={`w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded-md transition-colors text-left ${
                      isFocused ? "bg-white/10" : "hover:bg-white/5"
                    }`}
                  >
                    <span className="text-muted-foreground font-mono w-5 text-right">
                      {i + 1}
                    </span>
                    <span className="font-mono font-medium w-24 shrink-0 truncate">
                      {r.symbol}
                    </span>
                    <span className="flex-1 h-3 relative rounded-sm overflow-hidden bg-white/[0.03]">
                      {r.pnl >= 0 ? (
                        <span
                          className="absolute inset-y-0 left-0 bg-emerald-500/50 rounded-sm"
                          style={{ width: `${width}%` }}
                        />
                      ) : (
                        <span
                          className="absolute inset-y-0 right-0 bg-red-500/50 rounded-sm"
                          style={{ width: `${width}%` }}
                        />
                      )}
                    </span>
                    <span className="text-[10px] text-muted-foreground w-16 shrink-0 text-right">
                      {r.wins}W / {r.losses}L
                    </span>
                    <span
                      className={`font-mono font-medium w-20 shrink-0 text-right ${
                        r.pnl > 0
                          ? "text-emerald-400"
                          : r.pnl < 0
                            ? "text-red-400"
                            : "text-muted-foreground"
                      }`}
                    >
                      {r.pnl >= 0 ? "+" : ""}
                      {r.pnl.toFixed(1)} pts
                    </span>
                  </button>
                );
              });
            })()}
          </div>
        </div>
      )}

      <DailyPnlCalendar byDay={byDay} />

      {days.length === 0 && (
        <div className="bg-[#12141A] border border-white/5 rounded-lg p-6 text-center text-xs text-muted-foreground">
          No resolved trades for this scope yet — cells fill in as the engine
          closes ideas.
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  color,
  detail,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: string;
  detail?: string;
}) {
  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
      {detail && (
        <div className="text-[10px] text-muted-foreground">{detail}</div>
      )}
    </div>
  );
}
