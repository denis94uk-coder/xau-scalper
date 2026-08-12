import {
  BarChart3,
  Bot,
  Flame,
  FlaskConical,
  Shield,
  Target,
  TrendingDown,
  TrendingUp,
  User,
} from "lucide-react";
import { useState } from "react";
import { useLive } from "@/hooks/useLive";
import { api, type Significance } from "@/lib/api";

type SourceFilter = "all" | "engine" | "dashboard" | "experimental";

export function PerformanceTrackerPage() {
  const [source, setSource] = useState<SourceFilter>("all");
  // Performance is per asset. Summing points across gold, BTC and LINK would
  // produce a headline number with no unit and no meaning, so the page picks
  // one instrument rather than aggregating them.
  const [asset, setAsset] = useState<string>("");

  const assets = useLive(() => api.assets().then(r => r.assets), ["hello"]);
  const byAsset = useLive(
    () => api.performance().then(r => r.byAsset),
    ["ideas"],
  );
  const allIdeas = useLive(
    () => api.ideas({ limit: 500 }).then(r => r.ideas),
    ["ideas"],
  );

  const selected = asset || byAsset?.[0]?.asset || "";
  const stats = byAsset?.find(a => a.asset === selected) ?? byAsset?.[0];

  if (!stats || !allIdeas) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading performance data...
      </div>
    );
  }

  const forAsset = allIdeas.filter(i => i.asset === selected);

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

  // Group by day for calendar
  const byDay: Record<
    string,
    { wins: number; losses: number; pnl: number; count: number }
  > = {};
  for (const idea of closed) {
    const d = new Date(idea.resolvedAt ?? idea.createdAt)
      .toISOString()
      .split("T")[0];
    if (!byDay[d]) byDay[d] = { wins: 0, losses: 0, pnl: 0, count: 0 };
    byDay[d].count++;
    byDay[d].pnl += idea.pnlPoints ?? 0;
    if (idea.status === "TP1_HIT" || idea.status === "TP2_HIT") byDay[d].wins++;
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
              { key: "experimental", label: "EXP", icon: FlaskConical },
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

      {/* Asset selector — points are only comparable within one instrument */}
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

      {/* Daily P&L Calendar */}
      {Object.keys(byDay).length > 0 && (
        <div className="bg-[#12141A] border border-white/5 rounded-lg p-3">
          <div className="text-sm font-medium mb-3">Daily P&L</div>
          <div className="grid grid-cols-7 gap-1">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
              <div
                key={d}
                className="text-[10px] text-center text-muted-foreground"
              >
                {d}
              </div>
            ))}
            {Object.entries(byDay)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, data]) => (
                <div
                  key={date}
                  className={`aspect-square rounded-md flex flex-col items-center justify-center text-[10px] border ${
                    data.pnl > 0
                      ? "bg-emerald-500/15 border-emerald-500/20"
                      : data.pnl < 0
                        ? "bg-red-500/15 border-red-500/20"
                        : "bg-white/5 border-white/5"
                  }`}
                  title={`${date}: ${data.count} trades, ${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(1)} pts`}
                >
                  <span className="text-muted-foreground">
                    {new Date(`${date}T12:00:00`).getDate()}
                  </span>
                  <span
                    className={`font-mono font-medium ${data.pnl > 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {data.pnl >= 0 ? "+" : ""}
                    {data.pnl.toFixed(0)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

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
