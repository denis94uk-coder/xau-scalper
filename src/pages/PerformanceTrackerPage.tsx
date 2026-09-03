import { format } from "date-fns";
import {
  BarChart3,
  Bot,
  Flame,
  Shield,
  Target,
  TrendingDown,
  TrendingUp,
  User,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  DailyPnlCalendar,
  pnlPct,
} from "@/components/dashboard/DailyPnlCalendar";
import { useLive } from "@/hooks/useLive";
import { api, type Significance } from "@/lib/api";

type SourceFilter = "all" | "engine" | "dashboard";

export function PerformanceTrackerPage() {
  const [source, setSource] = useState<SourceFilter>("all");
  // Performance is per asset. Summing points across gold, BTC and LINK would
  // produce a headline number with no unit and no meaning, so the page picks
  // one instrument rather than aggregating them.
  // Experimental is isolated — it has its own performance inside the Lab so
  // the main book isn't polluted by XAU paper trades.
  const [asset, setAsset] = useState<string>("");

  const assets = useLive(() => api.assets().then(r => r.assets), ["hello"]);
  const byAsset = useLive(
    () => api.performance({ source: "engine" }).then(r => r.byAsset),
    ["ideas"],
  );
  const allIdeas = useLive(
    () => api.ideas({ limit: 500, source: "engine" }).then(r => r.ideas),
    ["ideas"],
  );
  const [toggling, setToggling] = useState(false);

  async function toggleDeadAssets(disable: boolean) {
    setToggling(true);
    try {
      const cfg = await api.config();
      const tradedSet = new Set(
        (byAsset ?? []).filter(a => a.closed + a.open > 0).map(a => a.asset),
      );
      let changed = 0;
      for (const a of cfg.assets) {
        const isDead = !tradedSet.has(a.id) && a.enabled;
        const shouldToggle = disable ? isDead : !a.enabled;
        if (shouldToggle) {
          a.enabled = !disable;
          changed++;
        }
      }
      if (changed === 0) {
        toast.info(
          disable
            ? "No dead assets to disable"
            : "No disabled assets to enable",
        );
        return;
      }
      await api.saveConfig(cfg);
      toast.success(
        `${disable ? "Disabled" : "Enabled"} ${changed} asset${changed === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  }

  // Only show assets that have trades — 100 pills is a mess.
  const tradedAssets = (byAsset ?? []).filter(a => a.closed + a.open > 0);
  const sortedTraded = [...tradedAssets].sort(
    (a, b) => b.closed + b.open - (a.closed + a.open),
  );
  const hasTrades = sortedTraded.length > 0;
  // "ALL" aggregates across traded assets; otherwise per-asset.
  const isAll = asset === "ALL" || asset === "";
  const selected = isAll
    ? "ALL"
    : asset || sortedTraded[0]?.asset || byAsset?.[0]?.asset || "";
  const singleStats = !isAll
    ? (byAsset?.find(a => a.asset === selected) ?? byAsset?.[0])
    : null;

  // Aggregated stats for "All" — wins/losses are comparable, points are summed
  // for reference but not used as a headline (points across assets aren't comparable).
  const stats =
    isAll && hasTrades
      ? (() => {
          const wins = tradedAssets.reduce((s, a) => s + a.wins, 0);
          const losses = tradedAssets.reduce((s, a) => s + a.losses, 0);
          const closed = tradedAssets.reduce((s, a) => s + a.closed, 0);
          const open = tradedAssets.reduce((s, a) => s + a.open, 0);
          const grossWin = tradedAssets.reduce(
            (s, a) => s + a.avgWinPoints * a.wins,
            0,
          );
          const grossLoss = tradedAssets.reduce(
            (s, a) => s + a.avgLossPoints * a.losses,
            0,
          );
          const totalPnl = tradedAssets.reduce(
            (s, a) => s + a.totalPnlPoints,
            0,
          );
          const avgWin = wins ? grossWin / wins : 0;
          const avgLoss = losses ? grossLoss / losses : 0;
          const winRate = wins + losses ? (wins / (wins + losses)) * 100 : 0;
          const pf = grossLoss === 0 ? null : grossWin / grossLoss;
          const maxWinStreak = Math.max(
            ...tradedAssets.map(a => a.maxWinStreak),
            0,
          );
          const maxLossStreak = Math.max(
            ...tradedAssets.map(a => a.maxLossStreak),
            0,
          );
          // currentStreak not meaningful aggregated — show 0
          const breakeven =
            avgWin + avgLoss > 0 ? (avgLoss / (avgWin + avgLoss)) * 100 : 50;
          // Recompute significance for the aggregate
          // We need to import assess locally? Use a simple inline p-value via byAsset's significance not needed — show aggregate counts.
          return {
            asset: "ALL",
            closed,
            open,
            wins,
            losses,
            expired: tradedAssets.reduce((s, a) => s + a.expired, 0),
            winRate,
            totalPnlPoints: totalPnl,
            avgWinPoints: avgWin,
            avgLossPoints: avgLoss,
            avgRR: avgLoss > 0 ? avgWin / avgLoss : null,
            maxWinStreak,
            maxLossStreak,
            currentStreak: 0,
            profitFactor: pf,
            significance: {
              trades: wins + losses,
              wins,
              winRate,
              breakevenRate: breakeven,
              pValue: 0,
              interval: { low: 0, high: 100 },
              verdict: "insufficient_data" as const,
              tradesNeeded: null,
              summary: `${wins + losses} trades aggregated across ${tradedAssets.length} assets. Per-asset points aren't comparable — use win rate / profit factor.`,
            },
          } as typeof singleStats & { asset: string };
        })()
      : singleStats;

  if (!stats || !allIdeas) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading performance data...
      </div>
    );
  }

  const forAsset =
    selected === "ALL" ? allIdeas : allIdeas.filter(i => i.asset === selected);

  // Derived here rather than served: it is a running sum of the same resolved
  // ideas already on this page, so a second endpoint could only disagree.
  const resolved = forAsset
    .filter(i => i.pnlPoints !== null)
    .sort(
      (a, b) => (a.resolvedAt ?? a.createdAt) - (b.resolvedAt ?? b.createdAt),
    );
  let running = 0;
  const equityCurve = resolved.map(i => {
    running += i.pnlPoints ?? 0;
    return { equity: running, at: i.resolvedAt ?? i.createdAt };
  });
  const filtered =
    source === "all"
      ? forAsset
      : forAsset.filter(i => (i.source ?? "dashboard") === source);
  const closed = filtered.filter(
    i =>
      i.status === "TP1_HIT" ||
      i.status === "TP2_HIT" ||
      i.status === "STOPPED" ||
      i.status === "EXPIRED",
  );

  // Group by day for calendar. Local-date keys, not UTC — an evening-resolved
  // trade belongs on the day the operator saw it happen.
  const byDay: Record<
    string,
    { wins: number; losses: number; pnl: number; count: number }
  > = {};
  for (const idea of closed) {
    const d = format(new Date(idea.resolvedAt ?? idea.createdAt), "yyyy-MM-dd");
    if (!byDay[d]) byDay[d] = { wins: 0, losses: 0, pnl: 0, count: 0 };
    byDay[d].count++;
    byDay[d].pnl += pnlPct(idea) ?? 0;
    // By realized P&L, not status — a STOPPED exit can still be a trailed win.
    if ((idea.pnlPoints ?? 0) > 0) byDay[d].wins++;
    else byDay[d].losses++;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-[#D4A843]" />
            Performance
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Win rate, profit factor, P&L tracking across all auto-generated
            trades
          </p>
        </div>
        {/* Source Filter */}
        <div className="flex gap-1 bg-[#12141A] rounded-lg p-0.5 border border-white/5">
          {(
            [
              { key: "all", label: "All", icon: null },
              { key: "engine", label: "Engine", icon: Bot },
              { key: "dashboard", label: "Manual", icon: User },
            ] as const
          ).map(s => (
            <button
              key={s.key}
              onClick={() => setSource(s.key)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${
                source === s.key
                  ? "bg-white/10 text-white font-medium"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              {s.icon && <s.icon className="w-3 h-3" />}
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Asset selector — only traded assets, with All aggregate */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setAsset("ALL")}
          className={`px-3 py-1 rounded-md text-[11px] font-mono transition-colors border ${
            selected === "ALL"
              ? "bg-[#D4A843] text-black border-[#D4A843] font-medium"
              : "bg-[#12141A] border-white/5 text-muted-foreground hover:text-white"
          }`}
        >
          All (
          {tradedAssets.length
            ? `${tradedAssets.reduce((s, a) => s + a.closed, 0)} trades`
            : "0"}
          )
        </button>
        {sortedTraded.map(a => {
          const info = assets?.find(x => x.id === a.asset);
          return (
            <button
              type="button"
              key={a.asset}
              onClick={() => setAsset(a.asset)}
              className={`px-2 py-1 rounded-md text-[11px] font-mono transition-colors border flex items-center gap-1 ${
                a.asset === selected
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-[#12141A] border-white/5 text-muted-foreground hover:text-white"
              }`}
              title={`${a.asset} · ${a.closed + a.open} trades · ${a.wins}W/${a.losses}L`}
            >
              {info?.symbol ?? a.asset}
              <span className="text-[9px] opacity-60">
                ({a.closed + a.open})
              </span>
            </button>
          );
        })}
        <div className="ml-2 flex gap-1">
          <button
            onClick={() => toggleDeadAssets(true)}
            disabled={toggling}
            className="px-2 py-1 rounded-md text-[10px] border border-white/10 bg-[#12141A] text-muted-foreground hover:text-white hover:border-red-500/30 disabled:opacity-50"
            title="Disable all enabled assets with zero trades"
          >
            Disable dead (
            {(assets ?? []).filter(a => a.enabled).length - tradedAssets.length}
            )
          </button>
          <button
            onClick={() => toggleDeadAssets(false)}
            disabled={toggling}
            className="px-2 py-1 rounded-md text-[10px] border border-white/10 bg-[#12141A] text-muted-foreground hover:text-white hover:border-emerald-500/30 disabled:opacity-50"
            title="Re-enable all disabled assets"
          >
            Enable all
          </button>
        </div>
        {sortedTraded.length === 0 && (
          <span className="text-xs text-muted-foreground ml-2">
            No trades yet
          </span>
        )}
      </div>

      {/* What the numbers below are worth. Placed above them deliberately —
          a win rate read before its sample size is the error this prevents. */}
      <SignificanceBanner sig={stats.significance} />

      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <PerfCard
          label="Win Rate"
          value={`${stats.winRate.toFixed(1)}%`}
          color={stats.winRate >= 50 ? "text-emerald-400" : "text-red-400"}
          icon={<Target className="w-4 h-4" />}
          detail={`${stats.wins}W / ${stats.losses}L`}
        />
        <PerfCard
          label="Profit Factor"
          value={
            (stats.profitFactor ?? 0) >= 999
              ? "∞"
              : (stats.profitFactor ?? 0).toFixed(2)
          }
          color={
            (stats.profitFactor ?? 0) >= 1.5
              ? "text-emerald-400"
              : (stats.profitFactor ?? 0) >= 1
                ? "text-yellow-400"
                : "text-red-400"
          }
          icon={<TrendingUp className="w-4 h-4" />}
          detail="Gross profit / loss"
        />
        <PerfCard
          label="Total P&L"
          value={`${stats.totalPnlPoints >= 0 ? "+" : ""}${stats.totalPnlPoints.toFixed(1)}`}
          color={
            stats.totalPnlPoints >= 0 ? "text-emerald-400" : "text-red-400"
          }
          icon={
            stats.totalPnlPoints >= 0 ? (
              <TrendingUp className="w-4 h-4" />
            ) : (
              <TrendingDown className="w-4 h-4" />
            )
          }
          detail="Points total"
        />
        <PerfCard
          label="Avg Win"
          value={`+${stats.avgWinPoints.toFixed(1)}`}
          color="text-emerald-400"
          icon={<TrendingUp className="w-4 h-4" />}
          detail="Points per win"
        />
        <PerfCard
          label="Avg Loss"
          value={`-${stats.avgLossPoints.toFixed(1)}`}
          color="text-red-400"
          icon={<TrendingDown className="w-4 h-4" />}
          detail="Points per loss"
        />
        <PerfCard
          label="Avg R:R"
          value={(stats.avgRR ?? 0).toFixed(2)}
          color={
            (stats.avgRR ?? 0) >= 1.5 ? "text-emerald-400" : "text-yellow-400"
          }
          icon={<Shield className="w-4 h-4" />}
          detail="Risk/Reward ratio"
        />
      </div>

      {/* Streaks + Signals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <Flame className="w-4 h-4 text-orange-400" />
            <span className="text-sm font-medium">Streaks</span>
          </div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Best Win Streak</span>
              <span className="text-emerald-400 font-mono">
                {stats.maxWinStreak}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Worst Loss Streak</span>
              <span className="text-red-400 font-mono">
                {stats.maxLossStreak}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Current</span>
              <span
                className={`font-mono ${stats.currentStreak > 0 ? "text-emerald-400" : stats.currentStreak < 0 ? "text-red-400" : "text-muted-foreground"}`}
              >
                {stats.currentStreak > 0
                  ? `${stats.currentStreak}W`
                  : stats.currentStreak < 0
                    ? `${Math.abs(stats.currentStreak)}L`
                    : "—"}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
          <div className="text-sm font-medium mb-2">Signal Counts</div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-mono">{stats.closed + stats.open}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Active</span>
              <span className="font-mono text-blue-400">{stats.open}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Closed</span>
              <span className="font-mono">{stats.closed}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Expired</span>
              <span className="font-mono text-gray-400">{stats.expired}</span>
            </div>
          </div>
        </div>

        {/* Win/Loss Breakdown Bar */}
        <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
          <div className="text-sm font-medium mb-2">Win/Loss Breakdown</div>
          <div className="space-y-2">
            <div className="h-4 rounded-full overflow-hidden bg-white/5 flex">
              {stats.closed > 0 && (
                <>
                  <div
                    className="bg-emerald-500 h-full transition-all"
                    style={{
                      width: `${(stats.wins / stats.closed) * 100}%`,
                    }}
                  />
                  <div
                    className="bg-red-500 h-full transition-all"
                    style={{
                      width: `${(stats.losses / stats.closed) * 100}%`,
                    }}
                  />
                </>
              )}
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-emerald-400">
                {stats.wins} wins (
                {stats.closed > 0
                  ? Math.round((stats.wins / stats.closed) * 100)
                  : 0}
                %)
              </span>
              <span className="text-red-400">
                {stats.losses} losses (
                {stats.closed > 0
                  ? Math.round((stats.losses / stats.closed) * 100)
                  : 0}
                %)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Equity Curve */}
      {equityCurve.length > 0 && (
        <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
          <div className="text-sm font-medium mb-3">Equity Curve (Points)</div>
          <div className="h-40 flex items-end gap-0.5">
            {(() => {
              const data = equityCurve;
              const maxEquity = Math.max(...data.map(d => d.equity), 0);
              const minEquity = Math.min(...data.map(d => d.equity), 0);
              const range = maxEquity - minEquity || 1;
              const zeroLine = maxEquity / range;

              return data.map((d, i) => {
                const isPositive = d.equity >= 0;
                const height = Math.abs(d.equity) / range;
                return (
                  <div
                    key={i}
                    className="flex-1 flex flex-col justify-end relative group"
                    style={{ height: "100%" }}
                  >
                    <div
                      className={`w-full rounded-sm transition-colors ${
                        isPositive
                          ? "bg-emerald-500/60 hover:bg-emerald-500"
                          : "bg-red-500/60 hover:bg-red-500"
                      }`}
                      style={{
                        height: `${height * 100}%`,
                        marginTop: isPositive ? "auto" : undefined,
                        marginBottom: isPositive
                          ? `${(1 - zeroLine) * 100}%`
                          : undefined,
                      }}
                    />
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 opacity-0 group-hover:opacity-100 transition-opacity bg-[#1A1D27] border border-white/10 rounded px-2 py-1 text-[10px] whitespace-nowrap z-50 pointer-events-none">
                      <div>Equity: {d.equity.toFixed(1)} pts</div>
                      <div className="text-muted-foreground">
                        Trade P&L: {d.equity >= 0 ? "+" : ""}
                        {d.equity.toFixed(1)}
                      </div>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Daily P&L Calendar — click a day to see its trades */}
      <DailyPnlCalendar byDay={byDay} ideas={closed} />

      {/* Recent Closed */}
      <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
        <div className="text-sm font-medium mb-2">Recent Closed Signals</div>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {closed.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">
              No closed signals yet
            </div>
          ) : (
            closed.slice(0, 30).map(idea => (
              <div
                key={idea.id}
                className="flex items-center gap-2 text-xs py-1 border-b border-white/5"
              >
                <span
                  className={`font-medium px-1.5 rounded ${
                    idea.direction === "LONG"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-red-500/20 text-red-400"
                  }`}
                >
                  {idea.direction}
                </span>
                <span className="font-mono">{idea.entryPrice.toFixed(2)}</span>
                <span className="text-muted-foreground">→</span>
                <span
                  className={`text-[10px] px-1.5 rounded ${
                    idea.status === "TP1_HIT" || idea.status === "TP2_HIT"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-red-500/20 text-red-400"
                  }`}
                >
                  {idea.status.replace("_", " ")}
                </span>
                <span
                  className={`font-mono ml-auto ${
                    (idea.pnlPoints ?? 0) >= 0
                      ? "text-emerald-400"
                      : "text-red-400"
                  }`}
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

/**
 * The verdict on whether this record beats chance.
 *
 * Deliberately plain-spoken. "p = 0.14" means nothing to most people looking at
 * a trading dashboard at 2am; "this could easily be luck" means the right thing.
 */
function SignificanceBanner({ sig }: { sig: Significance }) {
  const style = {
    significant: {
      box: "bg-emerald-500/10 border-emerald-500/25",
      dot: "bg-emerald-400",
      title: "text-emerald-400",
      label: "Real edge, so far",
    },
    indistinguishable_from_chance: {
      box: "bg-yellow-500/10 border-yellow-500/25",
      dot: "bg-yellow-400",
      title: "text-yellow-400",
      label: "Could be luck",
    },
    insufficient_data: {
      box: "bg-white/5 border-white/10",
      dot: "bg-muted-foreground",
      title: "text-muted-foreground",
      label: "Not enough trades",
    },
  }[sig.verdict];

  return (
    <div className={`rounded-lg border p-3 ${style.box}`}>
      <div className="flex items-start gap-2">
        <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${style.dot}`} />
        <div className="min-w-0">
          <div className={`text-sm font-medium ${style.title}`}>
            {style.label}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{sig.summary}</p>
          {sig.trades > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] font-mono text-muted-foreground">
              <span>
                true rate {sig.interval.low.toFixed(0)}–
                {sig.interval.high.toFixed(0)}%
              </span>
              <span>breakeven {sig.breakevenRate.toFixed(1)}%</span>
              <span>p = {sig.pValue.toFixed(3)}</span>
              {sig.tradesNeeded !== null && (
                <span>
                  {sig.tradesNeeded} trades to confirm ({sig.trades} so far)
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PerfCard({
  label,
  value,
  color,
  icon,
  detail,
}: {
  label: string;
  value: string;
  color: string;
  icon: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{detail}</div>
    </div>
  );
}
