import {
  Award,
  BarChart3,
  FlaskConical,
  Globe,
  LayoutDashboard,
  Shield,
  Target,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  DailyPnlCalendar,
  pnlPct,
} from "@/components/dashboard/DailyPnlCalendar";
import { eachDayOfInterval, endOfMonth, format, getDay, startOfMonth } from "date-fns";
import { useLive } from "@/hooks/useLive";
import { type AssetPerformance, api, type Idea } from "@/lib/api";

type EngineId = "engine" | "top10" | "lse" | "experimental";
type TabId = "overview" | EngineId;

const ENGINES: Array<{
  id: EngineId;
  label: string;
  shortLabel: string;
  icon: typeof BarChart3;
  color: string;
  bg: string;
  border: string;
  description: string;
}> = [
  {
    id: "engine",
    label: "Crypto Engine",
    shortLabel: "Crypto",
    icon: LayoutDashboard,
    color: "text-[#D4A843]",
    bg: "bg-[#D4A843]/10",
    border: "border-[#D4A843]/20",
    description: "Main crypto book · combined signals",
  },
  {
    id: "top10",
    label: "Top 10",
    shortLabel: "Top 10",
    icon: Award,
    color: "text-[#D4A843]",
    bg: "bg-[#D4A843]/10",
    border: "border-[#D4A843]/20",
    description: "Reversion 15m/30m · isolated",
  },
  {
    id: "lse",
    label: "LSE Terminal",
    shortLabel: "LSE",
    icon: Globe,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    description: "Vault data · per-asset carpet",
  },
  {
    id: "experimental",
    label: "Experimental",
    shortLabel: "Exp",
    icon: FlaskConical,
    color: "text-[#AB47BC]",
    bg: "bg-[#AB47BC]/10",
    border: "border-[#AB47BC]/20",
    description: "8-tool confluence · PAXGUSDT",
  },
];

function useEnginePerformance(source: EngineId) {
  const byAsset = useLive(
    () => api.performance({ source }).then(r => r.byAsset),
    ["ideas"],
    [source],
  );
  const ideas = useLive(
    () => api.ideas({ limit: 500, source }).then(r => r.ideas),
    ["ideas"],
    [source],
  );
  return { byAsset, ideas };
}

function aggregatePerformance(byAsset: AssetPerformance[] | undefined) {
  const traded = (byAsset ?? []).filter(a => a.closed + a.open > 0);
  if (traded.length === 0) {
    return {
      traded,
      wins: 0,
      losses: 0,
      closed: 0,
      open: 0,
      winRate: 0,
      profitFactor: null as number | null,
      totalPnlPoints: 0,
      totalPnlPct: 0,
      hasTrades: false,
    };
  }
  const wins = traded.reduce((s, a) => s + a.wins, 0);
  const losses = traded.reduce((s, a) => s + a.losses, 0);
  const closed = traded.reduce((s, a) => s + a.closed, 0);
  const open = traded.reduce((s, a) => s + a.open, 0);
  const grossWin = traded.reduce((s, a) => s + a.avgWinPoints * a.wins, 0);
  const grossLoss = traded.reduce((s, a) => s + a.avgLossPoints * a.losses, 0);
  const totalPnlPoints = traded.reduce((s, a) => s + a.totalPnlPoints, 0);
  const profitFactor = grossLoss === 0 ? null : grossWin / grossLoss;
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : 0;
  return {
    traded,
    wins,
    losses,
    closed,
    open,
    winRate,
    profitFactor,
    totalPnlPoints,
    hasTrades: true,
  };
}

function EngineHeadline({ source }: { source: EngineId }) {
  const { byAsset, ideas } = useEnginePerformance(source);
  const agg = aggregatePerformance(byAsset);
  const closedIdeas = useMemo(
    () =>
      (ideas ?? []).filter(
        i =>
          (i.status === "TP2_HIT" ||
            i.status === "STOPPED" ||
            i.status === "EXPIRED") &&
          i.pnlPoints !== null,
      ),
    [ideas],
  );
  const totalPnlPct = useMemo(
    () => closedIdeas.reduce((s, i) => s + (pnlPct(i) ?? 0), 0),
    [closedIdeas],
  );
  const dailyPnlPct = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return closedIdeas
      .filter(i => (i.resolvedAt ?? i.createdAt) >= start.getTime())
      .reduce((s, i) => s + (pnlPct(i) ?? 0), 0);
  }, [closedIdeas]);

  if (!byAsset || !ideas) {
    return (
      <div className="bg-[#12141A] border border-white/5 rounded-lg p-3 animate-pulse h-[110px]" />
    );
  }

  const meta = ENGINES.find(e => e.id === source)!;
  const Icon = meta.icon;

  return (
    <div className={`bg-[#12141A] border rounded-lg p-3 ${meta.border}`}>
      <div className="flex items-center gap-2 mb-2">
        <div
          className={`w-6 h-6 rounded-md flex items-center justify-center ${meta.bg}`}
        >
          <Icon className={`w-3.5 h-3.5 ${meta.color}`} />
        </div>
        <span className="text-xs font-semibold">{meta.label}</span>
        <span
          className={`text-[9px] px-1.5 py-0.5 rounded-full font-mono ml-auto ${
            agg.hasTrades
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-white/5 text-muted-foreground"
          }`}
        >
          {agg.closed + agg.open} trades
        </span>
      </div>
      {agg.hasTrades ? (
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div
              className={`text-sm font-bold font-mono ${agg.winRate >= 50 ? "text-emerald-400" : "text-red-400"}`}
            >
              {agg.winRate.toFixed(1)}%
            </div>
            <div className="text-[9px] text-muted-foreground">
              WR · {agg.wins}W/{agg.losses}L
            </div>
          </div>
          <div>
            <div
              className={`text-sm font-bold font-mono ${
                agg.profitFactor === null
                  ? "text-emerald-400"
                  : agg.profitFactor >= 1.5
                    ? "text-emerald-400"
                    : agg.profitFactor >= 1
                      ? "text-yellow-400"
                      : "text-red-400"
              }`}
            >
              {agg.profitFactor === null ? "∞" : agg.profitFactor.toFixed(2)}
            </div>
            <div className="text-[9px] text-muted-foreground">PF</div>
          </div>
          <div>
            <div
              className={`text-sm font-bold font-mono ${totalPnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}
            >
              {totalPnlPct >= 0 ? "+" : ""}
              {totalPnlPct.toFixed(1)}%
            </div>
            <div className="text-[9px] text-muted-foreground">Total %</div>
          </div>
          <div>
            <div
              className={`text-sm font-bold font-mono ${dailyPnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}
            >
              {dailyPnlPct >= 0 ? "+" : ""}
              {dailyPnlPct.toFixed(1)}%
            </div>
            <div className="text-[9px] text-muted-foreground">Today</div>
          </div>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground text-center py-3">
          No trades yet
        </div>
      )}
      <div className="text-[10px] text-muted-foreground mt-2 truncate">
        {meta.description}
      </div>
    </div>
  );
}

function EnginePanel({ source, unit = "pct" }: { source: EngineId; unit?: "pct" | "points" }) {
  const { byAsset, ideas } = useEnginePerformance(source);
  const [asset, setAsset] = useState<string>("ALL");
  const meta = ENGINES.find(e => e.id === source)!;

  const traded = useMemo(
    () => (byAsset ?? []).filter(a => a.closed + a.open > 0),
    [byAsset],
  );
  const sortedTraded = useMemo(
    () => [...traded].sort((a, b) => b.closed + b.open - (a.closed + a.open)),
    [traded],
  );
  const selected = asset === "ALL" || asset === "" ? "ALL" : asset;
  const filteredIdeas = useMemo(() => {
    if (!ideas) return [];
    if (selected === "ALL") return ideas;
    return ideas.filter(i => i.asset === selected);
  }, [ideas, selected]);

  const closed = useMemo(
    () =>
      filteredIdeas.filter(
        i =>
          i.status === "TP2_HIT" ||
          i.status === "STOPPED" ||
          i.status === "EXPIRED",
      ),
    [filteredIdeas],
  );
  const scored = useMemo(
    () => closed.filter(i => i.pnlPoints !== null),
    [closed],
  );
  const wins = scored.filter(i => (i.pnlPoints ?? 0) > 0).length;
  const losses = scored.length - wins;
  const winRate = scored.length ? (wins / scored.length) * 100 : 0;
  const grossWin = scored.reduce(
    (s, i) => s + Math.max(0, i.pnlPoints ?? 0),
    0,
  );
  const grossLoss = scored.reduce(
    (s, i) => s + Math.max(0, -(i.pnlPoints ?? 0)),
    0,
  );
  const pf =
    scored.length === 0 ? null : grossLoss === 0 ? null : grossWin / grossLoss;
  const totalPnlPct = useMemo(
    () => closed.reduce((s, i) => s + (pnlPct(i) ?? 0), 0),
    [closed],
  );
  const dailyPnlPct = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return closed
      .filter(i => (i.resolvedAt ?? i.createdAt) >= start.getTime())
      .reduce((s, i) => s + (pnlPct(i) ?? 0), 0);
  }, [closed]);

  const equityCurve = useMemo(() => {
    const resolved = filteredIdeas
      .filter(i => i.pnlPoints !== null)
      .sort(
        (a, b) => (a.resolvedAt ?? a.createdAt) - (b.resolvedAt ?? b.createdAt),
      );
    let running = 0;
    return resolved.map(i => {
      const delta = unit === "points" ? (i.pnlPoints ?? 0) : (pnlPct(i) ?? 0);
      running += delta;
      return { equity: running, at: i.resolvedAt ?? i.createdAt };
    });
  }, [filteredIdeas, unit]);

  const byDay: Record<
    string,
    { wins: number; losses: number; pnl: number; count: number }
  > = {};
  for (const idea of closed) {
    if (idea.pnlPoints === null) continue;
    const d = format(new Date(idea.resolvedAt ?? idea.createdAt), "yyyy-MM-dd");
    if (!byDay[d]) byDay[d] = { wins: 0, losses: 0, pnl: 0, count: 0 };
    byDay[d].count++;
    byDay[d].pnl += pnlPct(idea) ?? 0;
    if (idea.pnlPoints > 0) byDay[d].wins++;
    else byDay[d].losses++;
  }

  if (!byAsset || !ideas) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        Loading {meta.label}…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Asset selector */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setAsset("ALL")}
          className={`px-3 py-1 rounded-md text-[11px] font-mono border ${
            selected === "ALL"
              ? "bg-[#D4A843] text-black border-[#D4A843]"
              : "bg-[#12141A] border-white/5 text-muted-foreground hover:text-white"
          }`}
        >
          All (
          {traded.length ? `${traded.reduce((s, a) => s + a.closed, 0)}` : "0"})
        </button>
        {sortedTraded.map(a => (
          <button
            type="button"
            key={a.asset}
            onClick={() => setAsset(a.asset)}
            className={`px-2 py-1 rounded-md text-[11px] font-mono border ${
              a.asset === selected
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-[#12141A] border-white/5 text-muted-foreground hover:text-white"
            }`}
          >
            {a.asset} <span className="opacity-60">({a.closed + a.open})</span>
          </button>
        ))}
        {sortedTraded.length === 0 && (
          <span className="text-xs text-muted-foreground ml-2">
            No trades yet
          </span>
        )}
      </div>

      {/* Headline cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MiniCard
          label="Daily P&L %"
          value={`${dailyPnlPct >= 0 ? "+" : ""}${dailyPnlPct.toFixed(2)}%`}
          color={dailyPnlPct >= 0 ? "text-emerald-400" : "text-red-400"}
          detail="Today"
          icon={<Target className="w-3 h-3" />}
        />
        <MiniCard
          label="Total P&L %"
          value={`${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%`}
          color={totalPnlPct >= 0 ? "text-emerald-400" : "text-red-400"}
          detail={`${closed.length} trades`}
          icon={<TrendingUp className="w-3 h-3" />}
        />
        <MiniCard
          label="Win Rate"
          value={`${winRate.toFixed(1)}%`}
          color={winRate >= 50 ? "text-emerald-400" : "text-red-400"}
          detail={`${wins}W / ${losses}L`}
          icon={<Target className="w-3 h-3" />}
        />
        <MiniCard
          label="Profit Factor"
          value={scored.length === 0 ? "—" : pf === null ? "∞" : pf.toFixed(2)}
          color={
            pf === null && scored.length > 0
              ? "text-emerald-400"
              : pf !== null && pf >= 1.5
                ? "text-emerald-400"
                : pf !== null && pf >= 1
                  ? "text-yellow-400"
                  : "text-muted-foreground"
          }
          detail="Gross profit / loss"
          icon={<Shield className="w-3 h-3" />}
        />
      </div>

      {/* Asset grid */}
      {selected === "ALL" && traded.length > 0 && (
        <div className="rounded-lg border border-white/5 bg-[#12141A] p-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
            Assets · {meta.label}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
            {traded.slice(0, 12).map(p => (
              <div
                key={p.asset}
                className="rounded-md border border-white/5 bg-white/[0.02] p-1.5"
              >
                <div className="text-[10px] font-mono font-medium truncate">
                  {p.asset}
                </div>
                <div
                  className={`text-xs font-bold font-mono ${p.winRate >= 50 ? "text-emerald-400" : "text-red-400"}`}
                >
                  {p.winRate.toFixed(0)}%{" "}
                  <span className="text-[10px] font-normal text-muted-foreground">
                    · {p.wins}W/{p.losses}L
                  </span>
                </div>
                <div className="text-[10px] font-mono flex gap-1">
                  <span
                    className={
                      (p.profitFactor ?? 0) >= 1.5
                        ? "text-emerald-400"
                        : "text-muted-foreground"
                    }
                  >
                    PF {p.profitFactor?.toFixed(1) ?? "—"}
                  </span>
                  <span
                    className={
                      p.totalPnlPoints >= 0
                        ? "text-emerald-400/70"
                        : "text-red-400/70"
                    }
                  >
                    {p.totalPnlPoints >= 0 ? "+" : ""}
                    {p.totalPnlPoints.toFixed(1)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Equity curve — trackable: zero baseline, green above / red below */}
      {equityCurve.length > 0 && (
        <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">Equity Curve ({unit === "pct" ? "%" : "pts"}) · {meta.label}</span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {equityCurve[equityCurve.length - 1].equity >= 0 ? "+" : ""}
              {equityCurve[equityCurve.length - 1].equity.toFixed(2)}{unit === "pct" ? "%" : ""}
            </span>
          </div>
          <div className="relative h-32 flex gap-0.5">
            {(() => {
              const maxEquity = Math.max(...equityCurve.map(d => d.equity), 0);
              const minEquity = Math.min(...equityCurve.map(d => d.equity), 0);
              const range = maxEquity - minEquity || 1;
              const zeroTopPct = (maxEquity / range) * 100;
              return (
                <>
                  {/* zero baseline */}
                  <div
                    className="absolute left-0 right-0 h-px bg-white/15 pointer-events-none"
                    style={{ top: `${zeroTopPct}%` }}
                    title={`0${unit === "pct" ? "%" : ""} baseline (max ${maxEquity.toFixed(1)}${unit === "pct" ? "%" : ""} / min ${minEquity.toFixed(1)}${unit === "pct" ? "%" : ""})`}
                  />
                  {equityCurve.map((d, i) => {
                    const isPositive = d.equity >= 0;
                    const hPct = (Math.abs(d.equity) / range) * 100;
                    const style: React.CSSProperties = isPositive
                      ? {
                          position: "absolute",
                          bottom: `${100 - zeroTopPct}%`,
                          height: `${hPct}%`,
                          left: 0,
                          right: 0,
                        }
                      : {
                          position: "absolute",
                          top: `${zeroTopPct}%`,
                          height: `${hPct}%`,
                          left: 0,
                          right: 0,
                        };
                    return (
                      <div
                        key={i}
                        className="flex-1 relative group"
                        style={{ height: "100%" }}
                        title={`${new Date(d.at).toLocaleDateString()} ${d.equity >= 0 ? "+" : ""}${d.equity.toFixed(2)}${unit === "pct" ? "%" : "pts"}`}
                      >
                        <div
                          className={`w-full rounded-sm absolute ${isPositive ? "bg-emerald-500/70 hover:bg-emerald-500" : "bg-red-500/70 hover:bg-red-500"}`}
                          style={style}
                        />
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
          <div className="flex justify-between text-[9px] font-mono text-muted-foreground mt-1">
            <span>min {Math.min(...equityCurve.map(d => d.equity), 0).toFixed(1)}{unit === "pct" ? "%" : ""}</span>
            <span>0{unit === "pct" ? "%" : ""}</span>
            <span>max {Math.max(...equityCurve.map(d => d.equity), 0).toFixed(1)}{unit === "pct" ? "%" : ""}</span>
          </div>
        </div>
      )}

      {/* Calendar */}
      <DailyPnlCalendar byDay={byDay} ideas={closed as Idea[]} />

      {/* Recent closed */}
      <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
        <div className="text-sm font-medium mb-2">
          Recent Closed · {meta.label}
        </div>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {closed.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">
              No closed signals yet
            </div>
          ) : (
            closed.slice(0, 20).map(idea => (
              <div
                key={idea.id}
                className="flex items-center gap-2 text-xs py-1 border-b border-white/5"
              >
                <span
                  className={`font-medium px-1.5 rounded text-[10px] ${idea.direction === "LONG" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}
                >
                  {idea.direction}
                </span>
                <span className="font-mono text-[11px]">{idea.asset}</span>
                <span
                  className={`text-[10px] px-1.5 rounded ${idea.status === "TP2_HIT" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}
                >
                  {idea.status.replace("_", " ")}
                </span>
                <span
                  className={`font-mono ml-auto text-[11px] ${(idea.pnlPoints ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}
                >
                  {(idea.pnlPoints ?? 0) >= 0 ? "+" : ""}
                  {(idea.pnlPoints ?? 0).toFixed(1)}
                </span>
                <span className="text-muted-foreground text-[10px]">
                  {new Date(
                    idea.resolvedAt ?? idea.createdAt,
                  ).toLocaleDateString()}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MiniCard({
  label,
  value,
  color,
  detail,
  icon,
}: {
  label: string;
  value: string;
  color: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
        {icon}
        {label}
      </div>
      <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function ComparisonTable() {
  const engine = useEnginePerformance("engine");
  const top10 = useEnginePerformance("top10");
  const lse = useEnginePerformance("lse");
  const exp = useEnginePerformance("experimental");

  const rows = useMemo(() => {
    const sources: Array<{
      id: EngineId;
      byAsset: AssetPerformance[] | undefined;
      ideas: Idea[] | undefined;
    }> = [
      { id: "engine", byAsset: engine.byAsset, ideas: engine.ideas },
      { id: "top10", byAsset: top10.byAsset, ideas: top10.ideas },
      { id: "lse", byAsset: lse.byAsset, ideas: lse.ideas },
      { id: "experimental", byAsset: exp.byAsset, ideas: exp.ideas },
    ];
    return sources.map(({ id, byAsset, ideas }) => {
      const agg = aggregatePerformance(byAsset);
      const closedIdeas = (ideas ?? []).filter(
        i =>
          (i.status === "TP2_HIT" ||
            i.status === "STOPPED" ||
            i.status === "EXPIRED") &&
          i.pnlPoints !== null,
      );
      const totalPnlPct = closedIdeas.reduce((s, i) => s + (pnlPct(i) ?? 0), 0);
      const daily = (() => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        return closedIdeas
          .filter(i => (i.resolvedAt ?? i.createdAt) >= start.getTime())
          .reduce((s, i) => s + (pnlPct(i) ?? 0), 0);
      })();
      const meta = ENGINES.find(e => e.id === id)!;
      return {
        id,
        meta,
        agg,
        totalPnlPct,
        daily,
        closedCount: closedIdeas.length,
      };
    });
  }, [
    engine.byAsset,
    engine.ideas,
    top10.byAsset,
    top10.ideas,
    lse.byAsset,
    lse.ideas,
    exp.byAsset,
    exp.ideas,
  ]);

  const bestWr = Math.max(...rows.map(r => r.agg.winRate));
  const bestPf = Math.max(...rows.map(r => r.agg.profitFactor ?? -1));

  return (
    <div className="rounded-lg border border-white/5 bg-[#12141A] overflow-hidden">
      <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
        <BarChart3 className="w-3.5 h-3.5 text-[#D4A843]" />
        <span className="text-xs font-semibold">Head-to-Head — independent per-engine</span>
        <span className="text-[10px] text-muted-foreground">
          each row is its own isolated book (source filter), never summed
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-muted-foreground border-b border-white/5">
              <th className="text-left px-3 py-1.5 font-normal">Engine</th>
              <th className="text-right px-2 py-1.5 font-normal">Trades</th>
              <th className="text-right px-2 py-1.5 font-normal">W/L</th>
              <th className="text-right px-2 py-1.5 font-normal">Win Rate</th>
              <th className="text-right px-2 py-1.5 font-normal">PF</th>
              <th className="text-right px-2 py-1.5 font-normal">Total %</th>
              <th className="text-right px-3 py-1.5 font-normal">Today</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const Icon = r.meta.icon;
              return (
                <tr
                  key={r.id}
                  className="border-b border-white/[0.03] hover:bg-white/[0.02]"
                >
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className={`w-5 h-5 rounded flex items-center justify-center ${r.meta.bg}`}
                      >
                        <Icon className={`w-3 h-3 ${r.meta.color}`} />
                      </span>
                      <span className="font-medium text-[11px]">
                        {r.meta.label}
                      </span>
                    </span>
                  </td>
                  <td className="text-right px-2 py-2 font-mono text-[11px]">
                    {r.agg.closed + r.agg.open}
                  </td>
                  <td className="text-right px-2 py-2 font-mono text-[11px]">
                    <span className="text-emerald-400">{r.agg.wins}</span>
                    <span className="text-muted-foreground">/</span>
                    <span className="text-red-400">{r.agg.losses}</span>
                  </td>
                  <td
                    className={`text-right px-2 py-2 font-mono text-[11px] font-bold ${r.agg.winRate === bestWr && r.agg.hasTrades ? "text-emerald-400" : r.agg.winRate >= 50 ? "text-emerald-400/80" : "text-red-400"}`}
                  >
                    {r.agg.hasTrades ? `${r.agg.winRate.toFixed(1)}%` : "—"}
                  </td>
                  <td
                    className={`text-right px-2 py-2 font-mono text-[11px] font-bold ${r.agg.profitFactor === bestPf && r.agg.hasTrades ? "text-emerald-400" : ""}`}
                  >
                    {r.agg.hasTrades
                      ? r.agg.profitFactor === null
                        ? "∞"
                        : r.agg.profitFactor.toFixed(2)
                      : "—"}
                  </td>
                  <td
                    className={`text-right px-2 py-2 font-mono text-[11px] font-bold ${r.totalPnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {r.agg.hasTrades
                      ? `${r.totalPnlPct >= 0 ? "+" : ""}${r.totalPnlPct.toFixed(1)}%`
                      : "—"}
                  </td>
                  <td
                    className={`text-right px-3 py-2 font-mono text-[11px] font-bold ${r.daily >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {r.agg.hasTrades
                      ? `${r.daily >= 0 ? "+" : ""}${r.daily.toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground bg-white/[0.02] border-t border-white/5">
        Independent: each engine’s PF/WR/% is from ONLY its own ideas (source = engine/top10/lse/experimental). Nothing is summed across engines — that would be an overall number. Today resets local midnight.
      </div>
    </div>
  );
}

export default function EnginesPerformancePage() {
  const [tab, setTab] = useState<TabId>("overview");
  const [equityUnit, setEquityUnit] = useState<"pct" | "points">("pct");

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-4 max-w-[1440px] mx-auto w-full min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg border bg-[#12141A] border-white/5">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-[#D4A843] to-[#9A7A30] flex items-center justify-center">
          <BarChart3 className="w-4 h-4 text-black" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-bold flex items-center gap-2">
            4-Engine Performance
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#D4A843]/15 text-[#D4A843] font-mono">
              LIVE
            </span>
          </h1>
          <p className="text-[10px] text-muted-foreground truncate">
            Independent per-engine — Crypto / Top 10 / LSE / Experimental each score ONLY their own isolated book. No overall aggregate; points stay per-asset, % is comparable.
          </p>
        </div>
      </div>

      {/* Tabs + equity unit toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 bg-[#12141A] rounded-lg p-1 border border-white/5 w-fit flex-wrap">
          {(
            [
              { id: "overview" as const, label: "Overview", icon: BarChart3 },
              ...ENGINES.map(e => ({
                id: e.id as TabId,
                label: e.shortLabel,
                icon: e.icon,
              })),
            ] as const
          ).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors flex items-center gap-1.5 ${
                tab === t.id
                  ? "bg-[#D4A843] text-black font-medium"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-[#12141A] rounded-lg p-1 border border-white/5 ml-auto">
          <span className="text-[10px] text-muted-foreground px-1">Equity</span>
          <button
            onClick={() => setEquityUnit("pct")}
            className={`px-2 py-1 text-xs rounded-md font-mono ${equityUnit === "pct" ? "bg-white text-black" : "text-muted-foreground hover:text-white"}`}
          >
            %
          </button>
          <button
            onClick={() => setEquityUnit("points")}
            className={`px-2 py-1 text-xs rounded-md font-mono ${equityUnit === "points" ? "bg-white text-black" : "text-muted-foreground hover:text-white"}`}
          >
            Points
          </button>
        </div>
      </div>

      {tab === "overview" ? (
        <div className="space-y-3">
          {/* 4 headline cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {(["engine", "top10", "lse", "experimental"] as EngineId[]).map(
              id => (
                <EngineHeadline key={id} source={id} />
              ),
            )}
          </div>

          {/* Comparison table */}
          <ComparisonTable />

          {/* Per-engine equity strip + 7-day weekday performance for current month */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {(["engine", "top10", "lse", "experimental"] as EngineId[]).map(
              id => {
                const meta = ENGINES.find(e => e.id === id)!;
                return (
                  <div
                    key={id}
                    className="rounded-lg border border-white/5 bg-[#12141A] p-3"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <meta.icon className={`w-3.5 h-3.5 ${meta.color}`} />
                      <span className="text-xs font-semibold">
                        {meta.label}
                      </span>
                      <span className="text-[9px] font-mono text-muted-foreground ml-auto">
                        {equityUnit === "pct" ? "%" : "pts"}
                      </span>
                    </div>
                    <EngineMiniEquity source={id} unit={equityUnit} />
                    <div className="mt-2 pt-2 border-t border-white/5">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">
                        7-day (Mon–Sun) · {format(new Date(), "MMM yyyy")}
                      </div>
                      <WeekdayStrip source={id} unit={equityUnit} />
                    </div>
                  </div>
                );
              },
            )}
          </div>
        </div>
      ) : (
        <EnginePanel source={tab as EngineId} unit={equityUnit} />
      )}
    </div>
  );
}

function EngineMiniEquity({ source, unit = "pct" }: { source: EngineId; unit?: "pct" | "points" }) {
  const { ideas } = useEnginePerformance(source);
  const curve = useMemo(() => {
    const resolved = (ideas ?? [])
      .filter(i => i.pnlPoints !== null)
      .sort(
        (a, b) => (a.resolvedAt ?? a.createdAt) - (b.resolvedAt ?? b.createdAt),
      );
    let running = 0;
    return resolved.map(i => {
      const delta = unit === "points" ? (i.pnlPoints ?? 0) : (pnlPct(i) ?? 0);
      return (running += delta);
    });
  }, [ideas, unit]);

  if (curve.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center">
        No closed trades yet
      </div>
    );
  }
  const max = Math.max(...curve, 0);
  const min = Math.min(...curve, 0);
  const range = max - min || 1;
  const zeroTopPct = (max / range) * 100;
  const slice = curve.slice(-60);
  return (
    <div className="relative h-20 flex gap-px">
      <div
        className="absolute left-0 right-0 h-px bg-white/15 pointer-events-none"
        style={{ top: `${zeroTopPct}%` }}
        title={`0${unit === "pct" ? "%" : ""}`}
      />
      {slice.map((v, i) => {
        const isPos = v >= 0;
        const hPct = (Math.abs(v) / range) * 100;
        const style: React.CSSProperties = isPos
          ? {
              position: "absolute",
              bottom: `${100 - zeroTopPct}%`,
              height: `${hPct}%`,
              left: 0,
              right: 0,
            }
          : {
              position: "absolute",
              top: `${zeroTopPct}%`,
              height: `${hPct}%`,
              left: 0,
              right: 0,
            };
        return (
          <div key={i} className="flex-1 relative" style={{ height: "100%" }} title={`${v >= 0 ? "+" : ""}${v.toFixed(2)}${unit === "pct" ? "%" : ""}`}>
            <div
              className={`w-full rounded-sm absolute ${isPos ? "bg-emerald-500/70" : "bg-red-500/70"}`}
              style={style}
            />
          </div>
        );
      })}
    </div>
  );
}

function WeekdayStrip({ source, unit = "pct" }: { source: EngineId; unit?: "pct" | "points" }) {
  const { ideas } = useEnginePerformance(source);
  const byDay = useMemo(() => {
    const map: Record<string, { pnl: number; count: number }> = {};
    if (!ideas) return map;
    for (const idea of ideas) {
      if (idea.pnlPoints === null) continue;
      const status = idea.status;
      if (status !== "TP2_HIT" && status !== "STOPPED" && status !== "EXPIRED") continue;
      const d = new Date(idea.resolvedAt ?? idea.createdAt);
      const key = format(d, "yyyy-MM-dd");
      const delta = unit === "points" ? (idea.pnlPoints ?? 0) : (pnlPct(idea) ?? 0);
      if (!map[key]) map[key] = { pnl: 0, count: 0 };
      map[key].pnl += delta;
      map[key].count++;
    }
    return map;
  }, [ideas, unit]);

  const monthStart = startOfMonth(new Date());
  const monthEnd = endOfMonth(new Date());
  const monthKey = format(monthStart, "yyyy-MM");
  const hasAny = Object.keys(byDay).some(k => k.startsWith(monthKey));
  if (!hasAny) {
    return <div className="text-[10px] text-muted-foreground text-center py-1">No trades this month</div>;
  }

  // Build weeks Monday-first
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const lead = (getDay(days[0]) + 6) % 7;
  const cells: Array<Date | null> = [...Array(lead).fill(null) as null[], ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<Date | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-7 gap-1 text-[8px] text-muted-foreground text-center">
        {labels.map(l => (
          <div key={l}>{l}</div>
        ))}
      </div>
      {weeks.map((week, wi) => {
        const weekPnl = week.reduce((s, d) => {
          if (!d) return s;
          const k = format(d, "yyyy-MM-dd");
          return s + (byDay[k]?.pnl ?? 0);
        }, 0);
        const weekCount = week.reduce((s, d) => {
          if (!d) return s;
          const k = format(d, "yyyy-MM-dd");
          return s + (byDay[k]?.count ?? 0);
        }, 0);
        return (
          <div key={wi} className="grid grid-cols-7 gap-1">
            {week.map((d, di) => {
              if (!d) return <div key={di} />;
              const key = format(d, "yyyy-MM-dd");
              const b = byDay[key];
              const pnl = b?.pnl ?? 0;
              const count = b?.count ?? 0;
              const isPos = pnl > 0;
              const isZero = count === 0;
              return (
                <div
                  key={key}
                  className={`rounded-md border px-1 py-1 text-center ${
                    isZero
                      ? "bg-white/[0.02] border-white/5"
                      : isPos
                        ? "bg-emerald-500/15 border-emerald-500/20"
                        : "bg-red-500/15 border-red-500/20"
                  }`}
                  title={`${key}: ${count} trades ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}${unit === "pct" ? "%" : ""}`}
                >
                  <div className="text-[9px] text-muted-foreground">{d.getDate()}</div>
                  <div className={`text-[9px] font-mono font-bold ${isZero ? "text-muted-foreground" : isPos ? "text-emerald-400" : "text-red-400"}`}>
                    {isZero ? "—" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}${unit === "pct" ? "%" : ""}`}
                  </div>
                </div>
              );
            })}
            <div className="col-span-7 flex justify-between text-[8px] font-mono text-muted-foreground px-1">
              <span>W{wi + 1}</span>
              <span className={weekPnl > 0 ? "text-emerald-400" : weekPnl < 0 ? "text-red-400" : ""}>
                {weekCount > 0 ? `${weekPnl >= 0 ? "+" : ""}${weekPnl.toFixed(1)}${unit === "pct" ? "%" : ""} · ${weekCount}tr` : "—"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
