import { useMutation, useQuery } from "convex/react";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Trash2,
  User,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  TP1_HIT: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  TP2_HIT: "bg-green-500/20 text-green-300 border-green-500/30",
  STOPPED: "bg-red-500/20 text-red-400 border-red-500/30",
  EXPIRED: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

const SOURCE_ICONS: Record<
  string,
  { icon: typeof Bot; label: string; color: string }
> = {
  engine: { icon: Bot, label: "Engine", color: "text-cyan-400" },
  dashboard: { icon: User, label: "Manual", color: "text-[#D4A843]" },
  experimental: { icon: FlaskConical, label: "EXP", color: "text-purple-400" },
};

const GRADE_COLORS: Record<string, string> = {
  A: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  B: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  C: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
};

function JourneyTimeline({
  log,
}: {
  log: Array<{ event: string; price: number; timestamp: number }>;
}) {
  if (!log || log.length === 0)
    return (
      <span className="text-xs text-muted-foreground">No journey data</span>
    );

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {log.map((entry, i) => {
        const isWin = entry.event === "TP1_HIT" || entry.event === "TP2_HIT";
        const isLoss = entry.event === "SL_HIT" || entry.event === "STOPPED";
        const color = isWin
          ? "bg-emerald-500"
          : isLoss
            ? "bg-red-500"
            : "bg-blue-500";

        return (
          <div key={i} className="flex items-center gap-1">
            {i > 0 && <div className="w-3 h-px bg-white/20" />}
            <div className="group relative">
              <div
                className={`w-2.5 h-2.5 rounded-full ${color} ring-1 ring-white/10`}
              />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 opacity-0 group-hover:opacity-100 transition-opacity bg-[#1A1D27] border border-white/10 rounded px-2 py-1 text-[10px] whitespace-nowrap z-50 pointer-events-none">
                <div className="font-medium">
                  {entry.event.replace(/_/g, " ")}
                </div>
                <div className="text-muted-foreground">
                  {entry.price.toFixed(2)} ·{" "}
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TradingIdeasPage() {
  const ideas = useQuery(api.tradingIdeas.listIdeas, { limit: 300 });
  const deleteIdea = useMutation(api.tradingIdeas.deleteIdea);
  const [filter, setFilter] = useState<string>("ALL");
  const [sourceFilter, setSourceFilter] = useState<string>("ALL");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<"date" | "pnl" | "confidence">(
    "date",
  );

  if (!ideas) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading signals...
      </div>
    );
  }

  // Filters
  let filtered = ideas;
  if (filter !== "ALL") {
    filtered = filtered.filter(i => i.status === filter);
  }
  if (sourceFilter !== "ALL") {
    filtered = filtered.filter(i => (i.source ?? "dashboard") === sourceFilter);
  }

  // Sort
  if (sortField === "pnl") {
    filtered = [...filtered].sort(
      (a, b) => (b.pnlPoints ?? 0) - (a.pnlPoints ?? 0),
    );
  } else if (sortField === "confidence") {
    filtered = [...filtered].sort((a, b) => b.confidence - a.confidence);
  }

  // Stats
  const active = ideas.filter(
    i => i.status === "ACTIVE" || i.status === "TP1_HIT",
  ).length;
  const wins = ideas.filter(
    i => i.status === "TP1_HIT" || i.status === "TP2_HIT",
  ).length;
  const losses = ideas.filter(i => i.status === "STOPPED").length;
  const totalPnl = ideas.reduce((s, i) => s + (i.pnlPoints ?? 0), 0);
  const engineCount = ideas.filter(i => i.source === "engine").length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-[#D4A843]" />
            Trading Ideas
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Auto-generated signals with live journey tracking
          </p>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCard label="Active" value={active} color="text-blue-400" />
        <StatCard label="Wins" value={wins} color="text-emerald-400" />
        <StatCard label="Losses" value={losses} color="text-red-400" />
        <StatCard
          label="Total P&L"
          value={`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(1)} pts`}
          color={totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}
        />
        <StatCard
          label="Engine Signals"
          value={engineCount}
          color="text-cyan-400"
          icon={<Bot className="w-3.5 h-3.5" />}
        />
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="flex gap-1 bg-[#12141A] rounded-lg p-0.5 border border-white/5">
          {["ALL", "ACTIVE", "TP1_HIT", "TP2_HIT", "STOPPED", "EXPIRED"].map(
            s => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  filter === s
                    ? "bg-white/10 text-white font-medium"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                {s.replace("_", " ")}
              </button>
            ),
          )}
        </div>
        <div className="flex gap-1 bg-[#12141A] rounded-lg p-0.5 border border-white/5">
          {["ALL", "engine", "dashboard", "experimental"].map(s => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                sourceFilter === s
                  ? "bg-white/10 text-white font-medium"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              {s === "ALL"
                ? "All Sources"
                : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-[#12141A] rounded-lg p-0.5 border border-white/5 ml-auto">
          {(["date", "pnl", "confidence"] as const).map(s => (
            <button
              key={s}
              onClick={() => setSortField(s)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                sortField === s
                  ? "bg-white/10 text-white font-medium"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              {s === "pnl" ? "P&L" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Ideas List */}
      <div className="space-y-1.5">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No signals match the current filter
          </div>
        ) : (
          filtered.map(idea => {
            const src =
              SOURCE_ICONS[idea.source ?? "dashboard"] ??
              SOURCE_ICONS.dashboard;
            const SrcIcon = src.icon;
            const isExpanded = expandedId === idea._id;

            return (
              <div
                key={idea._id}
                className="bg-[#12141A] border border-white/5 rounded-lg overflow-hidden hover:border-white/10 transition-colors"
              >
                {/* Main Row */}
                <div
                  role="button"
                  tabIndex={0}
                  className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : idea._id)}
                >
                  {/* Direction */}
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded ${
                      idea.direction === "LONG"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-red-500/20 text-red-400"
                    }`}
                  >
                    {idea.direction}
                  </span>

                  {/* Source */}
                  <SrcIcon className={`w-3.5 h-3.5 ${src.color} shrink-0`} />

                  {/* Grade */}
                  {idea.grade && GRADE_COLORS[idea.grade] && (
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${GRADE_COLORS[idea.grade]}`}
                    >
                      {idea.grade}
                    </span>
                  )}

                  {/* Entry price */}
                  <span className="text-sm font-mono font-medium w-20">
                    {idea.entryPrice.toFixed(2)}
                  </span>

                  {/* Journey */}
                  <div className="flex-1 hidden sm:block">
                    <JourneyTimeline log={idea.journeyLog ?? []} />
                  </div>

                  {/* Status badge */}
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded border ${
                      STATUS_COLORS[idea.status]
                    }`}
                  >
                    {idea.status.replace("_", " ")}
                  </span>

                  {/* P&L */}
                  <span
                    className={`text-sm font-mono w-20 text-right ${
                      (idea.pnlPoints ?? 0) > 0
                        ? "text-emerald-400"
                        : (idea.pnlPoints ?? 0) < 0
                          ? "text-red-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    {idea.pnlPoints !== undefined
                      ? `${idea.pnlPoints >= 0 ? "+" : ""}${idea.pnlPoints.toFixed(1)}`
                      : "—"}
                  </span>

                  {/* Confidence */}
                  <span className="text-xs text-muted-foreground w-10 text-right">
                    {idea.confidence}%
                  </span>

                  {/* Expand */}
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t border-white/5 px-3 py-3 space-y-3 bg-[#0E1015]">
                    {/* Journey on mobile */}
                    <div className="sm:hidden">
                      <div className="text-[10px] text-muted-foreground mb-1">
                        JOURNEY
                      </div>
                      <JourneyTimeline log={idea.journeyLog ?? []} />
                    </div>

                    {/* Levels */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div>
                        <span className="text-muted-foreground">Entry</span>
                        <div className="font-mono">
                          {idea.entryPrice.toFixed(2)}
                        </div>
                      </div>
                      <div>
                        <span className="text-red-400">
                          {idea.trailingSL ? "Trailing SL" : "Stop Loss"}
                        </span>
                        <div className="font-mono text-red-400">
                          {(idea.trailingSL ?? idea.stopLoss).toFixed(2)}
                          {idea.trailingSL && (
                            <span className="text-orange-400 ml-1 text-[10px]">
                              (orig: {idea.stopLoss.toFixed(2)})
                            </span>
                          )}
                          {!idea.trailingSL && (
                            <span className="text-muted-foreground ml-1">
                              (
                              {Math.abs(
                                idea.entryPrice - idea.stopLoss,
                              ).toFixed(1)}{" "}
                              pts)
                            </span>
                          )}
                        </div>
                      </div>
                      <div>
                        <span className="text-emerald-400">TP1</span>
                        <div className="font-mono text-emerald-400">
                          {idea.tp1.toFixed(2)}
                          <span className="text-muted-foreground ml-1">
                            R:R{" "}
                            {(
                              Math.abs(idea.tp1 - idea.entryPrice) /
                              Math.abs(idea.entryPrice - idea.stopLoss)
                            ).toFixed(1)}
                          </span>
                        </div>
                      </div>
                      <div>
                        <span className="text-green-300">TP2</span>
                        <div className="font-mono text-green-300">
                          {idea.tp2.toFixed(2)}
                          <span className="text-muted-foreground ml-1">
                            R:R{" "}
                            {(
                              Math.abs(idea.tp2 - idea.entryPrice) /
                              Math.abs(idea.entryPrice - idea.stopLoss)
                            ).toFixed(1)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Reason + Meta */}
                    <div className="text-xs space-y-1">
                      <div className="text-muted-foreground">{idea.reason}</div>
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span>TF: {idea.timeframe}</span>
                        <span>
                          Bias: {idea.bias} ({idea.biasStrength}%)
                        </span>
                        <span>{new Date(idea.createdAt).toLocaleString()}</span>
                      </div>
                    </div>

                    {/* Journey log details */}
                    {idea.journeyLog && idea.journeyLog.length > 0 && (
                      <div>
                        <div className="text-[10px] text-muted-foreground mb-1">
                          JOURNEY LOG
                        </div>
                        <div className="space-y-0.5">
                          {idea.journeyLog.map((entry, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-2 text-[10px]"
                            >
                              <span className="text-muted-foreground w-16">
                                {new Date(entry.timestamp).toLocaleTimeString()}
                              </span>
                              <span
                                className={`font-medium ${
                                  entry.event.includes("TP")
                                    ? "text-emerald-400"
                                    : entry.event.includes("SL") ||
                                        entry.event.includes("STOP")
                                      ? "text-red-400"
                                      : "text-blue-400"
                                }`}
                              >
                                {entry.event.replace(/_/g, " ")}
                              </span>
                              <span className="font-mono">
                                {entry.price.toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex justify-end">
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          deleteIdea({ id: idea._id as Id<"tradingIdeas"> });
                          toast.success("Idea deleted");
                        }}
                        className="text-xs text-red-400/60 hover:text-red-400 flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: string | number;
  color: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg px-3 py-2">
      <div className="text-[10px] text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
    </div>
  );
}
