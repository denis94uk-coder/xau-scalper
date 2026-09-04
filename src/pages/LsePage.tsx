import { Award, BarChart3, Target, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  DailyPnlCalendar,
  pnlPct,
} from "@/components/dashboard/DailyPnlCalendar";
import { PriceTicker } from "@/components/dashboard/PriceTicker";
import { useLive } from "@/hooks/useLive";
import { type AssetPerformance, api } from "@/lib/api";
import { fetchGoldPrice, fmtPrice, type PriceData } from "@/lib/priceApi";

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

function LsePill({ perf, rank }: { perf: AssetPerformance; rank: number }) {
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

function LseTicker({ symbol }: { symbol: string }) {
  const data = usePrice(symbol);
  if (!data)
    return (
      <div className="h-[52px] rounded bg-white/[0.02] border border-white/5 animate-pulse" />
    );
  return <PriceTicker data={data} symbol={symbol} />;
}

/** Honest age label for a vault bar — staleness stays visible. */
function barAge(timeSec: number | null): string {
  if (timeSec === null) return "no data";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - timeSec);
  if (s < 90) return "live";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Vault-price ticker strip: the venue can't quote these instruments, so the
 * latest stored vault bar stands in — labeled vault with its age. */
function LsePriceStrip({
  prices,
}: {
  prices:
    | Array<{
        id: string;
        symbol: string;
        price: number | null;
        time: number | null;
        interval: string | null;
      }>
    | undefined;
}) {
  return (
    <div className="rounded-lg bg-[#12141A] border border-white/5 p-2">
      <div className="flex items-center gap-2 px-1 mb-2">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Vault tickers
        </span>
        <span
          className="text-[10px] text-muted-foreground ml-auto"
          title="Venue feed cannot quote these instruments; latest stored vault bar"
        >
          vault · age shown
        </span>
      </div>
      {!prices ? (
        <div className="text-xs text-muted-foreground text-center py-3">
          Loading prices…
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {prices.map(p => (
            <div
              key={p.id}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-mono border bg-white/[0.02] border-white/5"
              title={`${p.symbol} · ${p.interval ?? "—"} bar${p.time ? ` · ${new Date(p.time * 1000).toLocaleString()}` : ""}`}
            >
              <span className="font-bold text-white">{p.id}</span>
              <span className={p.price === null ? "text-muted-foreground" : ""}>
                {p.price === null ? "—" : fmtPrice(p.price)}
              </span>
              <span className="text-[9px] text-muted-foreground">
                {barAge(p.time)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LseAssetCard({
  asset,
}: {
  asset: import("@/lib/api").LseAssetStatus;
}) {
  const status = asset.trading
    ? { label: "TRADING", cls: "bg-emerald-500/15 text-emerald-400" }
    : asset.aliasOf
      ? { label: "ALIAS", cls: "bg-yellow-500/15 text-yellow-400" }
      : asset.strategy
        ? { label: "BLOCKED", cls: "bg-red-500/15 text-red-400" }
        : { label: "NO EDGE", cls: "bg-white/5 text-muted-foreground" };
  return (
    <div
      className="rounded-md border border-white/5 bg-white/[0.02] p-1.5 min-w-0"
      title={asset.reason}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-mono font-bold truncate">
          {asset.id}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono truncate">
          {asset.symbol}
        </span>
        <span
          className={`text-[9px] px-1 py-0.5 rounded font-mono ml-auto shrink-0 ${status.cls}`}
        >
          {status.label}
        </span>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground truncate mt-0.5">
        {asset.strategy
          ? `${asset.strategy.family}@${asset.strategy.interval}${asset.strategy.confirm ? `+${asset.strategy.confirm}` : ""}`
          : asset.aliasOf
            ? `mirrors ${asset.aliasOf}`
            : "no strategy"}
      </div>
      <div className="text-[10px] font-mono flex items-center gap-1 mt-0.5">
        {asset.strategy && (
          <span className="text-muted-foreground">
            p={asset.strategy.adjustedP.toExponential(1)}
          </span>
        )}
        {asset.openIdeas > 0 && (
          <span className="text-blue-400 ml-auto">{asset.openIdeas} open</span>
        )}
      </div>
    </div>
  );
}

export default function LsePage() {
  const [selectedTicker, setSelectedTicker] = useState<string>("PAXGUSDT");
  // Strictly the LSE book — isolated from the main engine and top10
  const byAsset = useLive(
    () => api.performance({ source: "lse" }).then(r => r.byAsset),
    ["ideas"],
  );
  const ideas = useLive(
    () => api.ideas({ limit: 500, source: "lse" }).then(r => r.ideas),
    ["ideas"],
  );
  // Every instrument under the book with its INDEPENDENT strategy — not just
  // the ones with trades. Each strategy fires ideas for its own asset only.
  const universe = useLive(
    () => api.lseUniverse().then(r => r.assets),
    ["ideas", "engine"],
  );
  // Vault tickers — venue can't quote LSE instruments.
  const vaultPrices = useLive(
    () => api.lsePrices().then(r => r.prices),
    ["ideas", "engine"],
  );

  const traded = useMemo(
    () => (byAsset ?? []).filter(a => a.closed + a.open > 0),
    [byAsset],
  );

  const aggregated = useMemo(() => {
    if (traded.length === 0) return null;
    const wins = traded.reduce((s, a) => s + a.wins, 0);
    const losses = traded.reduce((s, a) => s + a.losses, 0);
    const closed = traded.reduce((s, a) => s + a.closed, 0);
    const open = traded.reduce((s, a) => s + a.open, 0);
    const grossWin = traded.reduce((s, a) => s + a.avgWinPoints * a.wins, 0);
    const grossLoss = traded.reduce(
      (s, a) => s + a.avgLossPoints * a.losses,
      0,
    );
    return {
      wins,
      losses,
      closed,
      open,
      winRate: wins + losses ? (wins / (wins + losses)) * 100 : 0,
      profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    };
  }, [traded]);

  // Total P&L as % of entry — points can't be summed across instruments, so
  // the headline aggregates per-trade % like every other book.
  const lseResolved = useMemo(
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
  const lseTotalPct = useMemo(
    () => lseResolved.reduce((s, i) => s + (pnlPct(i) ?? 0), 0),
    [lseResolved],
  );

  const lseIdeas = ideas ?? [];

  const byDay: Record<
    string,
    { wins: number; losses: number; pnl: number; count: number }
  > = {};
  for (const idea of lseIdeas.filter(
    i =>
      i.status === "TP2_HIT" ||
      i.status === "STOPPED" ||
      i.status === "EXPIRED",
  )) {
    // Rows without realized P&L carry no result — never a phantom loss.
    if (idea.pnlPoints === null) continue;
    const d = new Date(idea.resolvedAt ?? idea.createdAt).toLocaleDateString(
      "en-CA",
    );
    if (!byDay[d]) byDay[d] = { wins: 0, losses: 0, pnl: 0, count: 0 };
    byDay[d].count++;
    byDay[d].pnl += pnlPct(idea) ?? 0;
    if (idea.pnlPoints > 0) byDay[d].wins++;
    else byDay[d].losses++;
  }

  const dailyTarget = useMemo(() => {
    // UTC midnight — this bar mirrors the engine's daily gate, which resets
    // on UTC midnight (server/lse-engine.ts). Local midnight would disagree.
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const todayIdeas = lseIdeas.filter(
      i =>
        (i.status === "TP2_HIT" ||
          i.status === "STOPPED" ||
          i.status === "EXPIRED") &&
        (i.resolvedAt ?? i.createdAt) >= start.getTime() &&
        i.pnlPoints !== null &&
        i.entryPrice > 0,
    );
    let pct = 0;
    for (const idea of todayIdeas)
      pct += (idea.pnlPoints! / idea.entryPrice) * 100;
    const hit = pct >= 1.0;
    const stopped = pct <= -0.5;
    return { pct, hit, stopped, count: todayIdeas.length };
  }, [lseIdeas]);

  if (!byAsset || !ideas) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading LSE book…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2 sm:p-3 max-w-[1440px] mx-auto w-full min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg border bg-[#12141A] border-white/5">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-[#D4A843] to-[#9A7A30] flex items-center justify-center">
          <Award className="w-4 h-4 text-black" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-bold flex items-center gap-2">
            LSE{" "}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">
              PER-ASSET ENGINES · 1% daily
            </span>
          </h1>
          <p className="text-[10px] text-muted-foreground truncate">
            Real-market instruments (vault data) — each asset trades only its
            own qualified strategy · COT + calendar hedges · isolated book
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
                  lseTotalPct >= 0 ? "text-emerald-400" : "text-red-400"
                }
              >
                {lseTotalPct >= 0 ? "+" : ""}
                {lseTotalPct.toFixed(1)}%
              </span>
            </>
          )}
        </div>
      </div>

      {/* Daily 1% progress */}
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

      {/* Assets under LSE — each with its independent strategy */}
      <div className="rounded-lg bg-[#12141A] border border-white/5 p-2">
        <div className="flex items-center gap-2 px-1 mb-2">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            Assets under LSE · independent strategy each
          </span>
          <span className="text-[10px] text-muted-foreground ml-auto font-mono">
            {(universe ?? []).filter(a => a.trading).length} trading ·{" "}
            {universe?.length ?? "…"} instruments
          </span>
        </div>
        {universe ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
            {universe.map(a => (
              <LseAssetCard key={a.id} asset={a} />
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground text-center py-4">
            Loading instruments…
          </div>
        )}
      </div>

      {/* Universe pills */}
      <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-lg bg-[#12141A] border border-white/5">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1">
          LSE book
        </span>
        {traded.map((p, i) => (
          <LsePill key={p.asset} perf={p} rank={i + 1} />
        ))}
        {traded.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No trades yet — waiting for the first qualified breakout
          </span>
        )}
      </div>

      {/* Engine + Performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <div className="rounded-lg border border-white/5 bg-[#12141A] p-2">
          <div className="flex items-center gap-1.5 mb-2">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-semibold">
              Engine — LSE only{" "}
              <span className="text-[10px] font-normal text-muted-foreground">
                (source=lse)
              </span>
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono ml-auto">
              {
                lseIdeas.filter(
                  i => i.status === "ACTIVE" || i.status === "TP1_HIT",
                ).length
              }{" "}
              open
            </span>
          </div>
          <div className="space-y-1 max-h-[320px] overflow-y-auto">
            {lseIdeas.slice(0, 12).map(idea => (
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
            {lseIdeas.length === 0 && (
              <div className="text-xs text-muted-foreground text-center py-6">
                No LSE signals yet — breakout setups only fire at channel
                extremes
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-white/5 bg-[#12141A] p-2">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="w-3.5 h-3.5 text-[#D4A843]" />
            <span className="text-xs font-semibold">
              Performance — LSE book{" "}
              <span className="text-[10px] font-normal text-muted-foreground">
                (isolated)
              </span>
            </span>
            <span className="text-[10px] text-muted-foreground ml-auto">
              {traded.length} assets · source=lse
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {traded.slice(0, 9).map(p => (
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

      {/* Calendar + Tickers */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
        <div className="lg:col-span-2 space-y-2">
          <LsePriceStrip prices={vaultPrices} />
          <DailyPnlCalendar
            byDay={byDay}
            ideas={
              lseIdeas.filter(
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
                { id: "PAXGUSDT", label: "XAU" },
                { id: "BTCUSDT", label: "BTC" },
              ].map(opt => (
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
          <LseTicker symbol={selectedTicker} />
          <div className="text-[10px] text-muted-foreground text-center">
            Gold quotes via the exchange proxy; signals use vault 1h bars
          </div>
        </div>
      </div>
    </div>
  );
}
