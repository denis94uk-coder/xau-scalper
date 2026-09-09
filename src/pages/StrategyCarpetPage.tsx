import { CheckCircle2, Trash2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useLive } from "@/hooks/useLive";
import { api, type DiscoveredStrategy } from "@/lib/api";
import { LSE_UNIVERSE } from "../../core/assets";

const LSE_IDS = new Set(LSE_UNIVERSE.map(u => u.id));

function isLsePin(s: DiscoveredStrategy): boolean {
  if (LSE_IDS.has(s.assetId)) return true;
  // Legacy / lse-discovery + lse-per-asset-tune prefixes, including lse-tune-
  if ((s.runId ?? "").startsWith("lse")) return true;
  // Fallback: symbol matches an LSE id (defensive for older pins)
  if (LSE_IDS.has(s.symbol)) return true;
  return false;
}

/**
 * The Strategy Carpet.
 *
 * Every research run pins its qualified survivors here automatically, so the
 * carpet is the collection of strategies that beat all three validation
 * windows, the walk-forward folds and the search-size correction. A strategy
 * on this page is evidence, not a guarantee — but everything NOT on this page
 * failed a check that was designed to be hard to pass.
 *
 * Topped by the live framework: every signal engine with the strategies it
 * runs right now, read live from the server — adding a strategy or asset
 * anywhere in the app shows up here on the next fetch.
 */
export function StrategyCarpetPage({ filter }: { filter?: "lse" } = {}) {
  const lseOnly = filter === "lse";
  const [busyId, setBusyId] = useState<number | null>(null);
  const carpetRaw = useLive(
    () => api.discoveredStrategies().then(r => r.strategies),
    ["research", "hello"],
  );
  const carpet = useMemo(() => {
    if (!carpetRaw) return carpetRaw;
    if (!lseOnly) return carpetRaw;
    return carpetRaw.filter(isLsePin);
  }, [carpetRaw, lseOnly]);
  // Live framework — refetches on engine/config/research activity, so newly
  // added strategies and assets appear without a code change here.
  const frameworkRaw = useLive(
    () => api.engines().then(r => r.engines),
    ["research", "ideas", "engine", "config"],
  );
  const framework = useMemo(() => {
    if (!frameworkRaw) return frameworkRaw;
    if (!lseOnly) return frameworkRaw;
    return frameworkRaw.filter(e => e.id === "lse");
  }, [frameworkRaw, lseOnly]);

  if (!carpet) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading the carpet…
      </div>
    );
  }

  if (carpet.length === 0) {
    return (
      <div className="max-w-[1100px] mx-auto p-4 space-y-4">
        <Header count={0} lseOnly={lseOnly} />
        <Card>
          <CardContent className="py-10 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              {lseOnly
                ? "No LSE-qualified strategies yet."
                : "No qualified strategies yet."}
            </p>
            <p className="text-xs text-muted-foreground/70 max-w-md mx-auto">
              {lseOnly ? (
                <>
                  Run a search under <strong>Find Strategies</strong> for an LSE
                  instrument (XAUUSD, EURUSD, FTSE, GER, …). Only LSE-validated
                  pins appear here — strictly the LSE selection.
                </>
              ) : (
                <>
                  Run a search under <strong>Find Strategies</strong>. Every
                  configuration that survives all three validation windows, the
                  walk-forward folds and the significance correction lands here
                  automatically. Most searches honestly find nothing — that is
                  the filter working.
                </>
              )}
            </p>
          </CardContent>
        </Card>
        {lseOnly && framework && framework.length > 0 && (
          <FrameworkBoard framework={framework} lseOnly />
        )}
      </div>
    );
  }

  const adopt = async (s: DiscoveredStrategy) => {
    setBusyId(s.id);
    try {
      const r = await api.adoptDiscovered(s.id);
      const book = (r as any).book ?? "engine";
      toast.success(
        r.added
          ? book === "lse"
            ? `Added ${s.symbol} to the LSE carpet.`
            : `${s.symbol} added to Instruments (disabled) with this strategy.`
          : book === "lse"
            ? `Strategy added to ${r.assetId} LSE carpet.`
            : `Strategy applied to ${r.assetId}.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not adopt");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (s: DiscoveredStrategy) => {
    setBusyId(s.id);
    try {
      await api.deleteDiscovered(s.id);
      toast.success("Removed from the carpet.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove");
    } finally {
      setBusyId(null);
    }
  };

  // Pins grouped per engine — a new pin lands in its engine's group
  // automatically via its run-id prefix.
  const allGroups = groupPins(carpet);
  const groups = lseOnly ? allGroups.filter(g => g.id === "lse") : allGroups;

  return (
    <div className="max-w-[1100px] mx-auto p-3 sm:p-4 space-y-4">
      <Header count={carpet.length} lseOnly={lseOnly} />
      <FrameworkBoard framework={framework} lseOnly={lseOnly} />
      {groups.map(
        g =>
          g.pins.length > 0 && (
            <section key={g.id} className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">{g.label}</h2>
                <Badge variant="outline" className="text-[10px] font-mono">
                  {g.pins.length} pinned
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  {g.hint}
                </span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {g.pins.map(s => (
                  <StrategyCard
                    key={s.id}
                    strategy={s}
                    busy={busyId === s.id}
                    onAdopt={() => adopt(s)}
                    onRemove={() => remove(s)}
                  />
                ))}
              </div>
            </section>
          ),
      )}
    </div>
  );
}

/** Research pins bucketed by owning engine (run-id prefix), in engine order. */
function groupPins(carpet: DiscoveredStrategy[]): Array<{
  id: string;
  label: string;
  hint: string;
  pins: DiscoveredStrategy[];
}> {
  const bucket = (s: DiscoveredStrategy): string => {
    const r = s.runId ?? "";
    if (r.startsWith("lse-")) return "lse";
    if (r.startsWith("top10-")) return "top10";
    return "engine";
  };
  const defs = [
    {
      id: "engine",
      label: "Main Engine",
      hint: "batch discoveries on the crypto book",
    },
    {
      id: "top10",
      label: "Top 10",
      hint: "top-10 universe discoveries",
    },
    {
      id: "lse",
      label: "LSE",
      hint: "vault-data discoveries, per-asset edges",
    },
  ];
  return defs.map(d => ({
    ...d,
    pins: carpet.filter(s => bucket(s) === d.id),
  }));
}

function FrameworkBoard({
  framework,
  lseOnly,
}: {
  framework:
    | Array<{
        id: string;
        label: string;
        template?: string;
        strategies: Array<{
          asset: string;
          family: string | null;
          status: string;
        }>;
      }>
    | undefined;
  lseOnly?: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">
          {lseOnly ? "LSE framework — live" : "Live framework"}
        </h2>
        <Badge
          variant="outline"
          className="text-[10px] font-mono text-emerald-500 border-emerald-500/30"
        >
          {framework
            ? `${framework.reduce((s, e) => s + e.strategies.filter(t => t.status === "trading").length, 0)} firing`
            : "loading…"}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          {lseOnly
            ? "LSE book only — per-asset carpets, strictly LSE selection"
            : "every engine, right now — updates itself when strategies are added"}
        </span>
      </div>
      {!framework ? (
        <Card>
          <CardContent className="py-6 text-center text-xs text-muted-foreground">
            Loading live strategies…
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {framework.map(e => (
            <Card key={e.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-sm">{e.label}</CardTitle>
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    {e.strategies.filter(t => t.status === "trading").length}/
                    {e.strategies.length}
                  </Badge>
                  {e.template && (
                    <span className="text-[10px] text-muted-foreground font-mono truncate">
                      {e.template}
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pb-3">
                {e.strategies.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    No strategies running.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {e.strategies.map((t, i) => (
                      <span
                        key={`${e.id}:${t.asset}:${t.family ?? i}`}
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                          t.status === "trading"
                            ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                            : t.status === "blocked"
                              ? "bg-red-500/10 border-red-500/20 text-red-400"
                              : "bg-white/5 border-white/10 text-muted-foreground"
                        }`}
                        title={`${t.asset} · ${t.family ?? "no edge yet"} · ${t.status}`}
                      >
                        {t.asset} · {t.family ?? "no edge"}
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function Header({ count, lseOnly }: { count: number; lseOnly?: boolean }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div>
        <h1 className="text-xl font-semibold">
          {lseOnly ? "LSE Carpet" : "Strategy Carpet"}
        </h1>
        <p className="text-xs text-muted-foreground">
          {lseOnly
            ? count === 0
              ? "LSE-validated discoveries — strictly the LSE selection"
              : `${count} LSE-validated ${count === 1 ? "strategy" : "strategies"} — strictly LSE, vault-data per-asset edges`
            : count === 0
              ? "Validated discoveries land here"
              : `${count} validated ${count === 1 ? "strategy" : "strategies"} — survived every check the discovery could throw at them`}
        </p>
      </div>
      {count > 0 && (
        <Badge
          variant="outline"
          className="text-emerald-500 border-emerald-500/30"
        >
          walk-forward verified
        </Badge>
      )}
    </div>
  );
}

function StrategyCard({
  strategy: s,
  busy,
  onAdopt,
  onRemove,
}: {
  strategy: DiscoveredStrategy;
  busy: boolean;
  onAdopt: () => void;
  onRemove: () => void;
}) {
  const t = s.testMetrics;
  const o = s.overallMetrics;
  const breakeven = o.breakevenWinRate ?? 50;
  const edge = o.winRate - breakeven;

  // Walk-forward fold bar: one segment per fold, green when it made money.
  const folds = s.walkForward?.foldNetPoints ?? [];
  const maxAbsFold = Math.max(1, ...folds.map(Math.abs));

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              <span className="truncate">{s.symbol}</span>
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {s.interval}
              </Badge>
              {s.model === "custom" && (
                <Badge
                  variant="outline"
                  className="text-[9px] font-mono border-fuchsia-500/30 text-fuchsia-300"
                >
                  CUSTOM
                </Badge>
              )}
              {s.model && s.model !== "custom" && s.model !== "combined" && (
                <Badge variant="outline" className="text-[9px] font-mono">
                  {s.model}
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-[11px]">
              pinned{" "}
              {new Date(s.pinnedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
              {" · "}p = {s.adjustedP.toFixed(4)} after search correction
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-8 w-8 text-muted-foreground hover:text-red-400"
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pb-3">
        {/* Headline numbers from the untouched test window */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Test net pts" value={t.netPoints} goodWhenPositive />
          <Stat
            label="Expectancy"
            value={t.expectancyPerTrade}
            suffix="/tr"
            goodWhenPositive
          />
          <Stat label="Trades (test)" value={t.trades} />
        </div>

        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="rounded-lg bg-secondary/40 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Win rate vs breakeven
            </div>
            <div className="text-xs font-mono font-semibold">
              {o.winRate.toFixed(1)}%
              <span className="text-muted-foreground font-normal"> vs </span>
              {breakeven.toFixed(1)}%
            </div>
            <div
              className={`text-[10px] font-mono ${edge > 0 ? "text-emerald-500" : "text-red-400"}`}
            >
              +{edge.toFixed(1)} pts of real edge
            </div>
          </div>
          <div className="rounded-lg bg-secondary/40 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Profit factor
            </div>
            <div className="text-xs font-mono font-semibold">
              {o.profitFactor === null ? "∞" : o.profitFactor.toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground font-mono">
              max DD {o.maxDrawdown.toFixed(0)} pts
            </div>
          </div>
        </div>

        {/* Walk-forward folds */}
        {folds.length > 0 && (
          <div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">
              Walk-forward folds ({s.walkForward?.profitableFolds}/
              {folds.length} profitable)
            </div>
            <div className="flex items-end gap-1 h-8">
              {folds.map((p, i) => (
                <div key={i} className="flex-1 flex flex-col justify-end">
                  <div
                    className={`rounded-sm ${p > 0 ? "bg-emerald-500/70" : "bg-red-400/60"}`}
                    style={{
                      height: `${Math.max(8, (Math.abs(p) / maxAbsFold) * 100)}%`,
                      minHeight: 4,
                    }}
                    title={`fold ${i + 1}: ${p.toFixed(1)} pts`}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <Button size="sm" className="w-full" disabled={busy} onClick={onAdopt}>
          <Zap className="w-3.5 h-3.5 mr-1" />
          Apply to{" "}
          {s.assetId.startsWith("MT5:") ? s.assetId.slice(4) : s.assetId}
        </Button>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  suffix,
  goodWhenPositive,
}: {
  label: string;
  value: number;
  suffix?: string;
  goodWhenPositive?: boolean;
}) {
  return (
    <div className="rounded-lg bg-secondary/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`text-sm font-mono font-semibold ${
          goodWhenPositive
            ? value > 0
              ? "text-emerald-500"
              : "text-red-400"
            : ""
        }`}
      >
        {value > 0 && goodWhenPositive ? "+" : ""}
        {value.toFixed(1)}
        {suffix ?? ""}
      </div>
    </div>
  );
}
