import {
  Award,
  BarChart3,
  Calculator,
  FlaskConical,
  Globe,
  LayoutDashboard,
  Shield,
  Target,
  TrendingUp,
  Trophy,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  DailyPnlCalendar,
  pnlPct,
} from "@/components/dashboard/DailyPnlCalendar";
import { EngineHeartbeat } from "@/components/EngineHeartbeat";
import {
  liquidationPct,
  stopPctOf,
} from "@/lib/leverage";
import { eachDayOfInterval, endOfMonth, format, getDay, startOfMonth } from "date-fns";
import { useLive } from "@/hooks/useLive";
import { type AssetPerformance, api, type Idea } from "@/lib/api";

type EngineId = "engine" | "top10" | "lse" | "experimental";
type TabId = "overview" | EngineId | "roi" | "rank";

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

function EngineHeadline({ source, simCapital, leverage = 1 }: { source: EngineId; simCapital?: number; leverage?: number }) {
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
  const cardTrades = useMemo(
    () =>
      closedIdeas.map(i => ({
        pct: pnlPct(i) ?? 0,
        stop: stopPctOf(i.entryPrice, i.stopLoss),
      })),
    [closedIdeas],
  );
  const cardSim =
    typeof simCapital === "number" && simCapital > 0 && agg.hasTrades
      ? simulateRoi(
          cardTrades.map(t => t.pct),
          simCapital,
          100,
          false,
          leverage,
          cardTrades.map(t => t.stop),
        )
      : null;

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
      {cardSim && (
        <div
          className={`mt-2 rounded-md px-2 py-1.5 text-center font-mono text-[11px] font-bold ${
            cardSim.profit >= 0
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-red-500/10 text-red-400"
          }`}
        >
          {cardSim.profit >= 0 ? "+" : "−"}${Math.abs(cardSim.profit).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
          <span className="font-normal opacity-70">
            on ${simCapital!.toLocaleString()}{leverage > 1 ? ` · x${leverage}` : ""}
          </span>
          {cardSim.liquidated > 0 && (
            <span className="ml-1.5 px-1 rounded bg-red-500/20 text-red-300 font-mono text-[10px]">
              ⚠ {cardSim.liquidated} liq
            </span>
          )}
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

/** Walk closed-trade % returns in order, staking a fraction of bankroll. */
export function simulateRoi(
  tradePct: number[],
  capital: number,
  stakePct: number,
  compound: boolean,
  leverage = 1,
  stops: Array<number | null> | null = null,
): { profit: number; end: number; roi: number; maxDd: number; liquidated: number } {
  const stake = Math.min(100, Math.max(0, stakePct)) / 100;
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  const liq = liquidationPct(lev);
  let bank = Math.max(0, capital);
  let peak = bank;
  let maxDd = 0;
  let liquidated = 0;
  for (let k = 0; k < tradePct.length; k++) {
    const r = tradePct[k];
    if (!Number.isFinite(r)) continue;
    const deployed = (compound ? bank : Math.max(0, capital)) * stake;
    const sp = stops?.[k] ?? null;
    if (sp !== null && sp > liq) {
      // Stop sits beyond liquidation: position dies before the stop can trigger.
      bank -= deployed;
      liquidated++;
    } else {
      bank += deployed * ((r * lev) / 100);
    }
    peak = Math.max(peak, bank);
    maxDd = Math.max(maxDd, peak - bank);
  }
  const profit = bank - Math.max(0, capital);
  const roi = capital > 0 ? (profit / capital) * 100 : 0;
  return { profit, end: bank, roi, maxDd, liquidated };
}

// Re-exported from the shared lib so existing imports keep working.
export { liquidationPct, stopPctOf };

export interface RiskTrade {
  pct: number;
  stop: number | null;
}

/**
 * Risk-% sizing: each trade is sized from its own stop so a stop-out costs
 * ~riskPct of bankroll. Trades the leverage cannot protect (stop wider than
 * liquidation distance, or margin unaffordable) are skipped — or downsized
 * to posted margin when mode is "downsize".
 */
export function simulateRiskMode(
  trades: RiskTrade[],
  capital: number,
  riskPct: number,
  leverage: number,
  compound: boolean,
  mode: "skip" | "downsize",
): {
  profit: number;
  end: number;
  roi: number;
  maxDd: number;
  skipped: number;
  liquidated: number;
} {
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  const liq = liquidationPct(lev);
  const risk = Math.min(100, Math.max(0, riskPct)) / 100;
  const start = Math.max(0, capital);
  let bank = start;
  let peak = bank;
  let maxDd = 0;
  let skipped = 0;
  let liquidated = 0;
  for (const t of trades) {
    if (!Number.isFinite(t.pct)) continue;
    const base = compound ? bank : start;
    if (base <= 0) break; // wiped — no margin left to post
    const sp = t.stop;
    if (sp === null || !Number.isFinite(sp) || sp <= 0) {
      skipped++;
      continue;
    }
    if (sp > liq) {
      skipped++;
      liquidated++;
      continue;
    }
    // Margin posting so a stop-out costs risk% of bankroll.
    let margin = (base * risk * 100) / (lev * sp);
    if (margin > base) {
      if (mode === "skip") {
        skipped++;
        continue;
      }
      margin = base; // ponytail: cap at posted bankroll, stop-out costs less than risk%
    }
    bank += margin * lev * (t.pct / 100);
    peak = Math.max(peak, bank);
    maxDd = Math.max(maxDd, peak - bank);
  }
  const profit = bank - start;
  const roi = start > 0 ? (profit / start) * 100 : 0;
  return { profit, end: bank, roi, maxDd, skipped, liquidated };
}

export const LEVERAGES = [1, 5, 10, 15, 30, 50, 100, 200, 500];

const ROI_STORE_KEY = "roi-sim-v1";

function RoiSimulator({ sharedCapital, sharedLeverage = 1 }: { sharedCapital?: number; sharedLeverage?: number }) {
  const engine = useEnginePerformance("engine");
  const top10 = useEnginePerformance("top10");
  const lse = useEnginePerformance("lse");
  const exp = useEnginePerformance("experimental");

  const [capitals, setCapitals] = useState<Record<EngineId, number>>(() => {
    try {
      const raw = localStorage.getItem(ROI_STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<
          Record<EngineId, number> & { stakePct: number; compound: boolean }
        >;
        if (typeof p.engine === "number") return p as Record<EngineId, number>;
      }
    } catch {
      // fresh defaults below
    }
    return { engine: 1000, top10: 1000, lse: 1000, experimental: 1000 };
  });
  const [stakePct, setStakePct] = useState(() => {
    try {
      const raw = localStorage.getItem(ROI_STORE_KEY);
      if (raw) {
        const s = (JSON.parse(raw) as { stakePct?: number }).stakePct;
        if (typeof s === "number" && s > 0 && s <= 100) return s;
      }
    } catch {
      // ignore
    }
    return 100;
  });
  const [compound, setCompound] = useState(() => {
    try {
      const raw = localStorage.getItem(ROI_STORE_KEY);
      if (raw) {
        const c = (JSON.parse(raw) as { compound?: boolean }).compound;
        if (typeof c === "boolean") return c;
      }
    } catch {
      // ignore
    }
    return true;
  });
  const [mode, setMode] = useState<"stake" | "risk">(() => {
    try {
      const raw = localStorage.getItem(ROI_STORE_KEY);
      if (raw) {
        const m = (JSON.parse(raw) as { mode?: string }).mode;
        if (m === "risk" || m === "stake") return m;
      }
    } catch {
      // ignore
    }
    return "stake";
  });
  const [riskPct, setRiskPct] = useState(() => {
    try {
      const raw = localStorage.getItem(ROI_STORE_KEY);
      if (raw) {
        const r = (JSON.parse(raw) as { riskPct?: number }).riskPct;
        if (typeof r === "number" && r > 0 && r <= 100) return r;
      }
    } catch {
      // ignore
    }
    return 1;
  });
  const [skipMode, setSkipMode] = useState<"skip" | "downsize">(() => {
    try {
      const raw = localStorage.getItem(ROI_STORE_KEY);
      if (raw) {
        const m = (JSON.parse(raw) as { skipMode?: string }).skipMode;
        if (m === "skip" || m === "downsize") return m;
      }
    } catch {
      // ignore
    }
    return "skip";
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        ROI_STORE_KEY,
        JSON.stringify({ ...capitals, stakePct, compound, mode, riskPct, skipMode }),
      );
    } catch {
      // private mode — simulator still works for the session
    }
  }, [capitals, stakePct, compound, mode, riskPct, skipMode]);

  const rows = useMemo(() => {
    const books: Array<{ id: EngineId; ideas: Idea[] | undefined }> = [
      { id: "engine", ideas: engine.ideas },
      { id: "top10", ideas: top10.ideas },
      { id: "lse", ideas: lse.ideas },
      { id: "experimental", ideas: exp.ideas },
    ];
    return books.map(({ id, ideas }) => {
      const trades: RiskTrade[] = (ideas ?? [])
        .filter(
          i =>
            (i.status === "TP2_HIT" ||
              i.status === "STOPPED" ||
              i.status === "EXPIRED") &&
            i.pnlPoints !== null,
        )
        .sort((a, b) => (a.resolvedAt ?? a.createdAt) - (b.resolvedAt ?? b.createdAt))
        .map(i => ({ pct: pnlPct(i) ?? 0, stop: stopPctOf(i.entryPrice, i.stopLoss) }));
      const sim =
        mode === "risk"
          ? simulateRiskMode(trades, capitals[id] ?? 0, riskPct, sharedLeverage, compound, skipMode)
          : {
              ...simulateRoi(
                trades.map(t => t.pct),
                capitals[id] ?? 0,
                stakePct,
                compound,
                sharedLeverage,
                trades.map(t => t.stop),
              ),
              skipped: 0,
            };
      return {
        id,
        meta: ENGINES.find(e => e.id === id)!,
        trades: trades.length,
        capital: capitals[id] ?? 0,
        ...sim,
      };
    });
  }, [engine.ideas, top10.ideas, lse.ideas, exp.ideas, capitals, stakePct, compound, sharedLeverage, mode, riskPct, skipMode]);

  const loading = !engine.ideas || !top10.ideas || !lse.ideas || !exp.ideas;
  const totalCapital = rows.reduce((s, r) => s + r.capital, 0);
  const totalProfit = rows.reduce((s, r) => s + r.profit, 0);
  const totalRoi = totalCapital > 0 ? (totalProfit / totalCapital) * 100 : 0;
  const best = rows.reduce<EngineId | null>(
    (b, r) => (b === null || r.roi > rows.find(x => x.id === b)!.roi ? r.id : b),
    null,
  );

  const setCapital = (id: EngineId, v: string) => {
    const n = Number.parseFloat(v);
    setCapitals(c => ({
      ...c,
      [id]: Number.isFinite(n) ? Math.max(0, Math.min(1_000_000_000, n)) : 0,
    }));
  };

  return (
    <div className="rounded-lg border border-white/5 bg-[#12141A] overflow-hidden">
      <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2 flex-wrap">
        <Calculator className="w-3.5 h-3.5 text-[#D4A843]" />
        <span className="text-xs font-semibold">ROI Simulator — capital in, profit out</span>
        {sharedLeverage > 1 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#D4A843]/15 text-[#D4A843] font-mono font-bold">
            x{sharedLeverage}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          replays each engine&apos;s own closed trades in order
        </span>
        {typeof sharedCapital === "number" && (
          <button
            type="button"
            onClick={() =>
              setCapitals({
                engine: sharedCapital,
                top10: sharedCapital,
                lse: sharedCapital,
                experimental: sharedCapital,
              })
            }
            className="ml-auto text-[10px] font-mono px-2 py-1 rounded-md border border-[#D4A843]/40 text-[#D4A843] hover:bg-[#D4A843]/10"
          >
            Use ${sharedCapital.toLocaleString()} for all
          </button>
        )}
      </div>

      <div className="p-3 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {rows.map(r => (
            <label key={r.id} className="block">
              <span className="text-[10px] text-muted-foreground flex items-center gap-1 mb-1">
                <Wallet className="w-3 h-3" />
                {r.meta.label} capital $
              </span>
              <input
                type="number"
                min={0}
                step={100}
                value={Number.isFinite(r.capital) ? r.capital : 0}
                onChange={e => setCapital(r.id, e.target.value)}
                className="w-full bg-white/[0.03] border border-white/10 rounded-md px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[#D4A843]/60"
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 bg-white/[0.03] rounded-md p-0.5 border border-white/10">
            {(["stake", "risk"] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                title={m === "stake" ? "Fixed fraction of bankroll per trade" : "Size each trade from its stop: a stop-out costs risk %"}
                className={`px-2 py-1 text-[11px] rounded font-mono ${mode === m ? "bg-[#D4A843] text-black font-bold" : "text-muted-foreground hover:text-white"}`}
              >
                {m === "stake" ? "Stake" : "Risk %"}
              </button>
            ))}
          </div>
          {mode === "stake" ? (
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Stake</span>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={stakePct}
                onChange={e => setStakePct(Number(e.target.value))}
                className="w-28 accent-[#D4A843]"
              />
              <span className="font-mono w-11 text-right">{stakePct}%</span>
            </label>
          ) : (
            <>
              <label className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Risk/trade</span>
                <input
                  type="number"
                  min={0.1}
                  max={100}
                  step={0.5}
                  value={riskPct}
                  onChange={e => {
                    const n = Number.parseFloat(e.target.value);
                    setRiskPct(Number.isFinite(n) ? Math.max(0.1, Math.min(100, n)) : 1);
                  }}
                  className="w-16 bg-white/[0.03] border border-white/10 rounded-md px-1.5 py-1 text-xs font-mono focus:outline-none focus:border-[#D4A843]/60"
                />
                <span className="font-mono text-muted-foreground">%</span>
              </label>
              <div className="flex items-center gap-1 bg-white/[0.03] rounded-md p-0.5 border border-white/10">
                {(["skip", "downsize"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSkipMode(m)}
                    title={m === "skip" ? "Skip trades the leverage cannot protect" : "Shrink unprotectable trades to posted margin"}
                    className={`px-2 py-1 text-[11px] rounded font-mono ${skipMode === m ? "bg-[#D4A843] text-black font-bold" : "text-muted-foreground hover:text-white"}`}
                  >
                    {m === "skip" ? "Skip" : "Downsize"}
                  </button>
                ))}
              </div>
            </>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={compound}
              onChange={e => setCompound(e.target.checked)}
              className="accent-[#D4A843]"
            />
            Compound
          </label>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-muted-foreground border-y border-white/5">
              <th className="text-left px-3 py-1.5 font-normal">Engine</th>
              <th className="text-right px-2 py-1.5 font-normal">Trades</th>
              <th className="text-right px-2 py-1.5 font-normal">Capital</th>
              <th className="text-right px-2 py-1.5 font-normal">Profit</th>
              <th className="text-right px-2 py-1.5 font-normal">End</th>
              <th className="text-right px-2 py-1.5 font-normal">ROI</th>
              <th className="text-right px-3 py-1.5 font-normal">Max DD</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const Icon = r.meta.icon;
              const pos = r.profit >= 0;
              return (
                <tr key={r.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className={`w-5 h-5 rounded flex items-center justify-center ${r.meta.bg}`}>
                        <Icon className={`w-3 h-3 ${r.meta.color}`} />
                      </span>
                      <span className="font-medium text-[11px]">
                        {r.meta.label}
                        {best === r.id && r.trades > 0 && (
                          <span className="ml-1.5 text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-400 font-mono">
                            BEST
                          </span>
                        )}
                        {r.liquidated > 0 && (
                          <span className="ml-1.5 text-[9px] px-1 rounded bg-red-500/20 text-red-300 font-mono" title="Trades whose stop sits beyond liquidation distance — the position dies before the stop">
                            ⚠ {r.liquidated} liq
                          </span>
                        )}
                        {r.skipped > 0 && (
                          <span className="ml-1.5 text-[9px] px-1 rounded bg-yellow-500/15 text-yellow-300 font-mono" title="Trades skipped: leverage cannot protect their stop">
                            skip {r.skipped}
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="text-right px-2 py-2 font-mono text-[11px]">{loading ? "…" : r.trades}</td>
                  <td className="text-right px-2 py-2 font-mono text-[11px]">${r.capital.toLocaleString()}</td>
                  <td className={`text-right px-2 py-2 font-mono text-[11px] font-bold ${pos ? "text-emerald-400" : "text-red-400"}`}>
                    {loading ? "…" : `${pos ? "+" : "−"}$${Math.abs(r.profit).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                  </td>
                  <td className="text-right px-2 py-2 font-mono text-[11px]">${r.end.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className={`text-right px-2 py-2 font-mono text-[11px] font-bold ${pos ? "text-emerald-400" : "text-red-400"}`}>
                    {loading ? "…" : `${pos ? "+" : ""}${r.roi.toFixed(1)}%`}
                  </td>
                  <td className="text-right px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    {loading ? "…" : `−$${r.maxDd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                  </td>
                </tr>
              );
            })}
            <tr className="bg-white/[0.02] font-bold">
              <td className="px-3 py-2 text-[11px]">Total · 4 engines</td>
              <td className="text-right px-2 py-2 font-mono text-[11px]">
                {loading ? "…" : rows.reduce((s, r) => s + r.trades, 0)}
              </td>
              <td className="text-right px-2 py-2 font-mono text-[11px]">${totalCapital.toLocaleString()}</td>
              <td className={`text-right px-2 py-2 font-mono text-[11px] ${totalProfit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {loading ? "…" : `${totalProfit >= 0 ? "+" : "−"}$${Math.abs(totalProfit).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
              </td>
              <td className="text-right px-2 py-2 font-mono text-[11px]">
                ${(totalCapital + totalProfit).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </td>
              <td className={`text-right px-2 py-2 font-mono text-[11px] ${totalProfit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {loading ? "…" : `${totalProfit >= 0 ? "+" : ""}${totalRoi.toFixed(1)}%`}
              </td>
              <td className="text-right px-3 py-2" />
            </tr>
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground bg-white/[0.02] border-t border-white/5">
        {mode === "risk" ? (
          <>
            Risk mode: each trade sized from its own stop so a stop-out costs ~{riskPct}% of {compound ? "running" : "initial"} bankroll at x{sharedLeverage}; unprotectable trades (stop beyond liquidation at ~{liquidationPct(sharedLeverage).toFixed(1)}%, or margin unaffordable) are {skipMode === "skip" ? "skipped" : "downsized"} — {rows.reduce((s, r) => s + r.skipped, 0)} skipped, {rows.reduce((s, r) => s + r.liquidated, 0)} would-liquidate across engines. Past signals ≠ future returns.
          </>
        ) : (
          <>
            Stake mode: each closed trade deploys stake % of {compound ? "running" : "initial"} bankroll{sharedLeverage > 1 ? ` at x${sharedLeverage} leverage` : ""}; P&amp;L = deployed × trade % of entry{sharedLeverage > 1 ? ` × ${sharedLeverage}` : ""} (the engine&apos;s own history, chronological). Trades whose stop sits beyond liquidation (~{liquidationPct(sharedLeverage).toFixed(1)}% at x{sharedLeverage}) are capped at −100% of deployed margin — {rows.reduce((s, r) => s + r.liquidated, 0)} across engines. Past signals ≠ future returns.
          </>
        )}
      </div>
    </div>
  );
}

const SIM_CAPITAL_KEY = "sim-capital-v1";
const SIM_LEVERAGE_KEY = "sim-leverage-v1";

function useSimCapital() {
  const [simCapital, setSimCapital] = useState(() => {
    try {
      const raw = localStorage.getItem(SIM_CAPITAL_KEY);
      if (raw !== null) {
        const n = Number.parseFloat(raw);
        if (Number.isFinite(n) && n >= 0) return Math.min(1_000_000_000, n);
      }
    } catch {
      // fresh default below
    }
    return 1000;
  });
  const [leverage, setLeverage] = useState(() => {
    try {
      const raw = localStorage.getItem(SIM_LEVERAGE_KEY);
      if (raw !== null) {
        const n = Number.parseFloat(raw);
        if (LEVERAGES.includes(n)) return n;
      }
    } catch {
      // fresh default below
    }
    return 1;
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIM_CAPITAL_KEY, String(simCapital));
    } catch {
      // private mode — still works for the session
    }
  }, [simCapital]);
  useEffect(() => {
    try {
      localStorage.setItem(SIM_LEVERAGE_KEY, String(leverage));
    } catch {
      // private mode — still works for the session
    }
  }, [leverage]);
  return [simCapital, setSimCapital, leverage, setLeverage] as const;
}

function SimCapitalBox({
  value,
  onChange,
  leverage,
  onLeverage,
  levels = LEVERAGES,
  cap,
}: {
  value: number;
  onChange: (n: number) => void;
  leverage: number;
  onLeverage: (n: number) => void;
  levels?: number[];
  /** Settings cap — shown when it hides higher buttons. */
  cap?: number | null;
}) {
  return (
    <div className="rounded-lg border border-[#D4A843]/30 bg-[#D4A843]/[0.06] px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-8 h-8 rounded-md bg-gradient-to-br from-[#D4A843] to-[#9A7A30] flex items-center justify-center shrink-0">
          <Wallet className="w-4 h-4 text-black" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-bold tracking-wide">SIMULATION CAPITAL</div>
          <div className="text-[10px] text-muted-foreground">
            Type an amount — every engine card shows its $ profit on it
          </div>
        </div>
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          {[1000, 5000, 10000].map(p => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={`px-2 py-1 rounded-md text-[11px] font-mono border ${
                value === p
                  ? "bg-[#D4A843] text-black border-[#D4A843] font-bold"
                  : "bg-[#12141A] border-white/10 text-muted-foreground hover:text-white"
              }`}
            >
              ${p.toLocaleString()}
            </button>
          ))}
          <label className="flex items-center gap-1 text-sm font-mono font-bold">
            <span className="text-muted-foreground">$</span>
            <input
              type="number"
              min={0}
              step={100}
              value={Number.isFinite(value) ? value : 0}
              onChange={e => {
                const n = Number.parseFloat(e.target.value);
                onChange(Number.isFinite(n) ? Math.max(0, Math.min(1_000_000_000, n)) : 0);
              }}
              className="w-32 bg-[#12141A] border border-[#D4A843]/40 rounded-md px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[#D4A843]"
            />
          </label>
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap pl-0 sm:pl-11">
        <span className="text-[10px] text-muted-foreground font-semibold tracking-wide mr-1">
          LEVERAGE
        </span>
        {levels.map(l => (
          <button
            key={l}
            type="button"
            onClick={() => onLeverage(l)}
            className={`px-2 py-1 rounded-md text-[11px] font-mono border ${
              leverage === l
                ? "bg-[#D4A843] text-black border-[#D4A843] font-bold"
                : "bg-[#12141A] border-white/10 text-muted-foreground hover:text-white"
            }`}
          >
            x{l}
          </button>
        ))}
        {cap != null && levels.length < LEVERAGES.length && (
          <span className="text-[10px] text-muted-foreground font-mono">
            capped at x{cap} (Settings → Risk)
          </span>
        )}
      </div>
    </div>
  );
}

type RankVerdict = "trade" | "watching" | "paused" | "collecting";

/**
 * Engine ranking: which book earned capital, split of one bankroll pot.
 * Qualified = 30+ trades, positive total %, PF ≥ 1.3; score haircut by
 * sample size (full credit at 200 trades). Copy writes the split into the
 * ROI simulator's per-engine capitals — open the ROI Sim tab to apply.
 */
function EngineRank({ pot }: { pot: number }) {
  const engine = useEnginePerformance("engine");
  const top10 = useEnginePerformance("top10");
  const lse = useEnginePerformance("lse");
  const exp = useEnginePerformance("experimental");
  const [bankroll, setBankroll] = useState(pot > 0 ? pot : 1000);
  const [copied, setCopied] = useState(false);

  const rows = useMemo(() => {
    const books: Array<{ id: EngineId; ideas: Idea[] | undefined }> = [
      { id: "engine", ideas: engine.ideas },
      { id: "top10", ideas: top10.ideas },
      { id: "lse", ideas: lse.ideas },
      { id: "experimental", ideas: exp.ideas },
    ];
    return books.map(({ id, ideas }) => {
      const closed = (ideas ?? []).filter(
        i =>
          (i.status === "TP2_HIT" || i.status === "STOPPED" || i.status === "EXPIRED") &&
          i.pnlPoints !== null,
      );
      const wins = closed.filter(i => (i.pnlPoints ?? 0) > 0).length;
      const grossWin = closed.reduce((s, i) => s + Math.max(0, i.pnlPoints ?? 0), 0);
      const grossLoss = closed.reduce((s, i) => s + Math.max(0, -(i.pnlPoints ?? 0)), 0);
      const pf = closed.length === 0 || grossLoss === 0 ? null : grossWin / grossLoss;
      const totalPct = closed.reduce((s, i) => s + (pnlPct(i) ?? 0), 0);
      const wr = closed.length ? (wins / closed.length) * 100 : 0;
      let verdict: RankVerdict = "collecting";
      if (closed.length >= 30 && totalPct <= 0) verdict = "paused";
      else if (closed.length >= 30 && (pf ?? 0) < 1.3) verdict = "watching";
      else if (closed.length >= 30) verdict = "trade";
      const score = verdict === "trade" ? totalPct * Math.min(1, closed.length / 200) : 0;
      return { id, meta: ENGINES.find(e => e.id === id)!, trades: closed.length, wr, pf, totalPct, verdict, score };
    });
  }, [engine.ideas, top10.ideas, lse.ideas, exp.ideas]);

  const loading = !engine.ideas || !top10.ideas || !lse.ideas || !exp.ideas;
  const totalScore = rows.reduce((s, r) => s + r.score, 0);
  const potSafe = Math.max(0, bankroll);

  const copyToSimulator = () => {
    try {
      const raw = localStorage.getItem(ROI_STORE_KEY);
      const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const next: Record<string, unknown> = { ...prev };
      for (const r of rows) {
        const w = totalScore > 0 ? r.score / totalScore : 0;
        next[r.id] = Math.round(potSafe * w);
      }
      localStorage.setItem(ROI_STORE_KEY, JSON.stringify(next));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // private mode — nothing to write to
    }
  };

  const verdictStyle: Record<RankVerdict, string> = {
    trade: "bg-emerald-500/15 text-emerald-400",
    watching: "bg-yellow-500/15 text-yellow-300",
    paused: "bg-red-500/15 text-red-300",
    collecting: "bg-white/5 text-muted-foreground",
  };

  return (
    <div className="rounded-lg border border-white/5 bg-[#12141A] overflow-hidden">
      <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2 flex-wrap">
        <Trophy className="w-3.5 h-3.5 text-[#D4A843]" />
        <span className="text-xs font-semibold">Engine Rank — who earned the capital</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Bankroll $</span>
          <input
            type="number"
            min={0}
            step={100}
            value={Number.isFinite(bankroll) ? bankroll : 0}
            onChange={e => {
              const n = Number.parseFloat(e.target.value);
              setBankroll(Number.isFinite(n) ? Math.max(0, Math.min(1_000_000_000, n)) : 0);
            }}
            className="w-28 bg-white/[0.03] border border-white/10 rounded-md px-2 py-1 text-sm font-mono focus:outline-none focus:border-[#D4A843]/60"
          />
        </label>
        <button
          type="button"
          onClick={copyToSimulator}
          className="text-[11px] font-mono px-2 py-1 rounded-md border border-[#D4A843]/40 text-[#D4A843] hover:bg-[#D4A843]/10"
        >
          {copied ? "Copied ✓" : "Copy split to ROI Sim"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-muted-foreground border-b border-white/5">
              <th className="text-left px-3 py-1.5 font-normal">Engine</th>
              <th className="text-right px-2 py-1.5 font-normal">Trades</th>
              <th className="text-right px-2 py-1.5 font-normal">WR</th>
              <th className="text-right px-2 py-1.5 font-normal">PF</th>
              <th className="text-right px-2 py-1.5 font-normal">Total %</th>
              <th className="text-right px-2 py-1.5 font-normal">Verdict</th>
              <th className="text-right px-2 py-1.5 font-normal">Weight</th>
              <th className="text-right px-3 py-1.5 font-normal">$ Split</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const Icon = r.meta.icon;
              const w = totalScore > 0 ? r.score / totalScore : 0;
              return (
                <tr key={r.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className={`w-5 h-5 rounded flex items-center justify-center ${r.meta.bg}`}>
                        <Icon className={`w-3 h-3 ${r.meta.color}`} />
                      </span>
                      <span className="font-medium text-[11px]">{r.meta.label}</span>
                    </span>
                  </td>
                  <td className="text-right px-2 py-2 font-mono text-[11px]">{loading ? "…" : r.trades}</td>
                  <td className={`text-right px-2 py-2 font-mono text-[11px] ${r.wr >= 50 ? "text-emerald-400" : "text-red-400"}`}>
                    {loading ? "…" : `${r.wr.toFixed(1)}%`}
                  </td>
                  <td className="text-right px-2 py-2 font-mono text-[11px]">
                    {loading ? "…" : r.trades === 0 ? "—" : r.pf === null ? "∞" : r.pf.toFixed(2)}
                  </td>
                  <td className={`text-right px-2 py-2 font-mono text-[11px] font-bold ${r.totalPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {loading ? "…" : `${r.totalPct >= 0 ? "+" : ""}${r.totalPct.toFixed(1)}%`}
                  </td>
                  <td className="text-right px-2 py-2">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono uppercase ${verdictStyle[r.verdict]}`}>
                      {r.verdict}
                    </span>
                  </td>
                  <td className="text-right px-2 py-2 font-mono text-[11px]">{loading ? "…" : `${(w * 100).toFixed(0)}%`}</td>
                  <td className="text-right px-3 py-2 font-mono text-[11px] font-bold">
                    {loading ? "…" : `$${Math.round(potSafe * w).toLocaleString()}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground bg-white/[0.02] border-t border-white/5">
        Trade = 30+ trades, positive total %, PF ≥ 1.3 · weight by total % with sample-size haircut (full credit at 200 trades) · copy writes the split into the ROI simulator — open its tab to apply.
      </div>
    </div>
  );
}

export default function EnginesPerformancePage() {
  const [tab, setTab] = useState<TabId>("overview");
  const [equityUnit, setEquityUnit] = useState<"pct" | "points">("pct");
  const [simCapital, setSimCapital, leverage, setLeverage] = useSimCapital();
  const maxLevCap = useLive(
    () => api.config().then(c => c.risk.maxLeverage ?? 500).catch(() => 500),
    ["config"],
  ) ?? 500;
  const allowedLevs = LEVERAGES.filter(l => l <= maxLevCap);
  const levels = allowedLevs.length > 0 ? allowedLevs : [1];
  // A lowered cap demotes the stored leverage instead of simulating over it.
  useEffect(() => {
    if (!levels.includes(leverage)) setLeverage(levels[levels.length - 1]);
  }, [levels.join(","), leverage]);

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
              { id: "roi" as const, label: "ROI Sim", icon: Calculator },
              { id: "rank" as const, label: "Rank", icon: Trophy },
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
          {/* Heartbeat — alive-but-quiet vs frozen, at a glance */}
          <EngineHeartbeat />

          {/* Simulation capital — one amount, $ profit on all 4 cards */}
          <SimCapitalBox value={simCapital} onChange={setSimCapital} leverage={leverage} onLeverage={setLeverage} levels={levels} cap={levels.length < LEVERAGES.length ? maxLevCap : null} />

          {/* 4 headline cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {(["engine", "top10", "lse", "experimental"] as EngineId[]).map(
              id => (
                <EngineHeadline key={id} source={id} simCapital={simCapital} leverage={leverage} />
              ),
            )}
          </div>

          {/* Comparison table */}
          <ComparisonTable />

          {/* ROI simulator — capital + profit/ROI per engine */}
          <RoiSimulator sharedCapital={simCapital} sharedLeverage={leverage} />

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
      ) : tab === "roi" ? (
        <div className="space-y-3">
          <SimCapitalBox value={simCapital} onChange={setSimCapital} leverage={leverage} onLeverage={setLeverage} levels={levels} cap={levels.length < LEVERAGES.length ? maxLevCap : null} />
          <RoiSimulator sharedCapital={simCapital} sharedLeverage={leverage} />
        </div>
      ) : tab === "rank" ? (
        <div className="space-y-3">
          <EngineHeartbeat />
          <EngineRank pot={simCapital} />
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
