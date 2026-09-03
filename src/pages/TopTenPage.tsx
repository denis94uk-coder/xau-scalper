import { Award, BarChart3, Target, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  DailyPnlCalendar,
  pnlPct,
} from "@/components/dashboard/DailyPnlCalendar";
import { PriceTicker } from "@/components/dashboard/PriceTicker";
import { useLive } from "@/hooks/useLive";
import { type AssetPerformance, api } from "@/lib/api";
import { fetchGoldPrice, type PriceData } from "@/lib/priceApi";

function usePrice(symbol: string) {
  const [data, setData] = useState<PriceData | null>(null);
  useEffect(() => {
    let alive = true;
    fetchGoldPrice(symbol)
      .then(d => {
        if (alive) setData(d);
      })
      .catch(() => {});
    const id = setInterval(
      () =>
        fetchGoldPrice(symbol)
          .then(d => {
            if (alive) setData(d);
          })
          .catch(() => {}),
      30000,
    );
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol]);
  return data;
}

function TopTenPill({ perf, rank }: { perf: AssetPerformance; rank: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-mono border bg-[#12141A] border-white/5 text-muted-foreground">
      <span className="text-[9px] font-bold text-[#D4A843]">#{rank}</span>
      <span className="font-medium text-white">{perf.asset}</span>
      <span
        className={`text-[10px] ${perf.winRate >= 50 ? "text-emerald-400" : "text-red-400"}`}
      >
        {perf.winRate.toFixed(0)}%
      </span>
      <span className="text-[10px] opacity-60">({perf.closed})</span>
    </div>
  );
}

function TopTicker({ symbol }: { symbol: string }) {
  const data = usePrice(symbol);
  if (!data)
    return (
      <div className="h-[52px] rounded bg-white/[0.02] border border-white/5 animate-pulse" />
    );
  return <PriceTicker data={data} symbol={symbol} />;
}

export default function TopTenPage() {
  const [selectedTicker, setSelectedTicker] = useState<string>("BNBUSDT");
  // Strictly top10 engine only — separate performance book
  const byAsset = useLive(
    () => api.performance({ source: "top10" }).then(r => r.byAsset),
    ["ideas"],
  );
  const ideas = useLive(
    () => api.ideas({ limit: 500, source: "top10" }).then(r => r.ideas),
    ["ideas"],
  );

  const top10 = useMemo(() => {
    if (!byAsset) return [];
    const traded = byAsset.filter(a => a.closed + a.open > 0);
    if (traded.length > 0) {
      return [...traded]
        .sort((a, b) => {
          const pfA = a.profitFactor ?? 0;
          const pfB = b.profitFactor ?? 0;
          if (pfB !== pfA) return pfB - pfA;
          if (b.winRate !== a.winRate) return b.winRate - a.winRate;
          return b.closed - a.closed;
        })
        .slice(0, 10);
    }
    // Cold start — show placeholder so the tab isn't empty before first top10 trade closes
    return (byAsset ?? []).slice(0, 10);
  }, [byAsset]);

  const topIds = useMemo(() => new Set(top10.map(t => t.asset)), [top10]);
  const topIdeas = useMemo(
    () => (ideas ?? []).filter(i => topIds.has(i.asset)),
    [ideas, topIds],
  );

  const aggregated = useMemo(() => {
    if (top10.length === 0) return null;
    const wins = top10.reduce((s, a) => s + a.wins, 0);
    const losses = top10.reduce((s, a) => s + a.losses, 0);
    const closed = top10.reduce((s, a) => s + a.closed, 0);
    const open = top10.reduce((s, a) => s + a.open, 0);
    const grossWin = top10.reduce((s, a) => s + a.avgWinPoints * a.wins, 0);
    const grossLoss = top10.reduce((s, a) => s + a.avgLossPoints * a.losses, 0);
    const totalPnl = top10.reduce((s, a) => s + a.totalPnlPoints, 0);
    return {
      wins,
      losses,
      closed,
      open,
      winRate: wins + losses ? (wins / (wins + losses)) * 100 : 0,
      profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
      totalPnl,
    };
  }, [top10]);

  const byDay: Record<
    string,
    { wins: number; losses: number; pnl: number; count: number }
  > = {};
  for (const idea of topIdeas.filter(
    i =>
      i.status === "TP2_HIT" ||
      i.status === "STOPPED" ||
      i.status === "EXPIRED",
  )) {
    const d = new Date(idea.resolvedAt ?? idea.createdAt).toLocaleDateString(
      "en-CA",
    ); // local yyyy-MM-dd matches DailyPnlCalendar's format(day)
    if (!byDay[d]) byDay[d] = { wins: 0, losses: 0, pnl: 0, count: 0 };
    byDay[d].count++;
    byDay[d].pnl += pnlPct(idea) ?? 0;
    if ((idea.pnlPoints ?? 0) > 0) byDay[d].wins++;
    else byDay[d].losses++;
  }

  const dailyTarget = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const todayIdeas = topIdeas.filter(
      i =>
        (i.status === "TP2_HIT" ||
          i.status === "STOPPED" ||
          i.status === "EXPIRED") &&
        (i.resolvedAt ?? i.createdAt) >= start.getTime() &&
        i.pnlPoints !== null,
    );
    let pct = 0;
    for (const idea of todayIdeas)
      pct += (idea.pnlPoints! / idea.entryPrice) * 100;
    const hit = pct >= 1.0;
    const stopped = pct <= -0.5;
    return { pct, hit, stopped, count: todayIdeas.length };
  }, [topIdeas]);

  if (!byAsset || !ideas) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading Top 10…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2 sm:p-3 max-w-[1440px] mx-auto w-full min-w-0">
      {/* Header — compact + 1% daily target */}
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg border bg-[#12141A] border-white/5">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-[#D4A843] to-[#9A7A30] flex items-center justify-center">
          <Award className="w-4 h-4 text-black" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-bold flex items-center gap-2">
            Top 10{" "}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">
              REVERSION ENGINE · 15m/30m · 1% daily
            </span>
          </h1>
          <p className="text-[10px] text-muted-foreground truncate">
            Distinct strategies — reversion (ONG 30m / JST 1h discovered) —
            isolated book, singular focus if one dominates
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[10px] font-mono">
          {aggregated && (
            <>
              <span
                className={
                  aggregated.winRate >= 50 ? "text-emerald-400" : "text-red-400"
                }
              >
                {aggregated.winRate.toFixed(1)}% WR
              </span>
              <span className="text-white/20">·</span>
              <span
                className={
                  aggregated.profitFactor !== null &&
                  aggregated.profitFactor >= 1.5
                    ? "text-emerald-400"
                    : "text-yellow-400"
                }
              >
                PF {aggregated.profitFactor?.toFixed(2) ?? "—"}
              </span>
              <span className="text-white/20">·</span>
              <span
                className={
                  aggregated.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"
                }
              >
                {aggregated.totalPnl >= 0 ? "+" : ""}
                {aggregated.totalPnl.toFixed(1)} pts
              </span>
            </>
          )}
        </div>
      </div>

      {/* Daily 1% progress — distinct target */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg border bg-white/[0.02] border-white/5">
        <div className="flex items-center gap-2">
          <Target className="w-3.5 h-3.5 text-[#D4A843]" />
          <span className="text-xs font-medium">Daily 1% Target</span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${dailyTarget.hit ? "bg-emerald-500/20 text-emerald-400" : dailyTarget.stopped ? "bg-red-500/20 text-red-400" : "bg-white/5 text-muted-foreground"}`}
          >
            {dailyTarget.hit
              ? "HIT ✓"
              : dailyTarget.stopped
                ? "STOPPED"
                : `${dailyTarget.count} trades today`}
          </span>
        </div>
        <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden max-w-[240px] ml-auto">
          <div
            className={`h-full rounded-full transition-all ${dailyTarget.hit ? "bg-emerald-500" : dailyTarget.pct >= 0 ? "bg-[#D4A843]" : "bg-red-500"}`}
            style={{
              width: `${Math.min(100, Math.max(0, (dailyTarget.pct / 1) * 100))}%`,
            }}
          />
        </div>
        <span
          className={`text-xs font-mono font-bold ${dailyTarget.hit ? "text-emerald-400" : dailyTarget.pct >= 0 ? "text-[#D4A843]" : "text-red-400"}`}
        >
          {dailyTarget.pct >= 0 ? "+" : ""}
          {dailyTarget.pct.toFixed(2)}% / 1.00%
        </span>
      </div>

      {/* Top 10 pills — compact */}
      <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-lg bg-[#12141A] border border-white/5">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1">
          Top 10
        </span>
        {top10.map((p, i) => (
          <TopTenPill key={p.asset} perf={p} rank={i + 1} />
        ))}
        {top10.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No trades yet — engine warming up
          </span>
        )}
      </div>

      {/* Engine + Performance — side by side compact */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {/* Left: Engine — recent signals for top 10 */}
        <div className="rounded-lg border border-white/5 bg-[#12141A] p-2">
          <div className="flex items-center gap-1.5 mb-2">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-semibold">
              Engine — Top 10 only{" "}
              <span className="text-[10px] font-normal text-muted-foreground">
                (source=top10)
              </span>
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono ml-auto">
              {
                topIdeas.filter(
                  i => i.status === "ACTIVE" || i.status === "TP1_HIT",
                ).length
              }{" "}
              open
            </span>
          </div>
          <div className="space-y-1 max-h-[320px] overflow-y-auto">
            {topIdeas.slice(0, 12).map(idea => (
              <div
                key={idea.id}
                className="flex items-center gap-1.5 text-xs py-1 px-2 rounded bg-white/[0.02] border border-white/5"
              >
                <span
                  className={`text-[10px] font-bold px-1 py-0.5 rounded ${idea.direction === "LONG" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}
                >
                  {idea.direction}
                </span>
                <span className="font-mono text-[#D4A843] text-[11px] truncate max-w-[70px]">
                  {idea.asset}
                </span>
                <span
                  className={`text-[10px] px-1 rounded ${idea.status === "ACTIVE" ? "bg-blue-500/15 text-blue-400" : idea.status.includes("TP") ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}
                >
                  {idea.status.replace("_", " ")}
                </span>
                <span
                  className={`font-mono ml-auto text-[11px] ${(idea.pnlPoints ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}
                >
                  {idea.pnlPoints !== null
                    ? `${idea.pnlPoints >= 0 ? "+" : ""}${idea.pnlPoints.toFixed(1)}`
                    : "—"}
                </span>
              </div>
            ))}
            {topIdeas.length === 0 && (
              <div className="text-xs text-muted-foreground text-center py-6">
                No signals for top 10 yet
              </div>
            )}
          </div>
        </div>

        {/* Right: Performance — compact grid */}
        <div className="rounded-lg border border-white/5 bg-[#12141A] p-2">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="w-3.5 h-3.5 text-[#D4A843]" />
            <span className="text-xs font-semibold">
              Performance — Top 10{" "}
              <span className="text-[10px] font-normal text-muted-foreground">
                (isolated)
              </span>
            </span>
            <span className="text-[10px] text-muted-foreground ml-auto">
              {top10.length} assets · source=top10
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {top10.slice(0, 9).map(p => (
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
                <div className="text-[10px] font-mono flex items-center gap-1">
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
      </div>

      {/* Calendar + Tickers — compact */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
        <div className="lg:col-span-2">
          <DailyPnlCalendar
            byDay={byDay}
            ideas={
              topIdeas.filter(
                i =>
                  i.status === "TP2_HIT" ||
                  i.status === "STOPPED" ||
                  i.status === "EXPIRED",
              ) as any
            }
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 px-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
              Live ticker
            </span>
            <div className="flex gap-1 ml-auto">
              {[
                { id: "BNBUSDT", label: "BNB" },
                { id: "ETHUSDT", label: "ETH" },
                ...top10.slice(0, 4).map(p => ({
                  id: p.asset,
                  label: p.asset.replace("USDT", ""),
                })),
              ]
                .filter((v, i, a) => a.findIndex(x => x.id === v.id) === i)
                .slice(0, 6)
                .map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setSelectedTicker(opt.id)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border ${selectedTicker === opt.id ? "bg-[#D4A843] text-black border-[#D4A843]" : "bg-[#12141A] border-white/5 text-muted-foreground hover:text-white"}`}
                  >
                    {opt.label}
                  </button>
                ))}
            </div>
          </div>
          <TopTicker symbol={selectedTicker} />
          <div className="text-[10px] text-muted-foreground text-center">
            Tap BNB/ETH or top assets to switch — only selected ticker loads
          </div>
        </div>
      </div>
    </div>
  );
}
