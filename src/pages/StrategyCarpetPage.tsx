import { CheckCircle2, Trash2, Zap } from "lucide-react";
import { useState } from "react";
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

/**
 * The Strategy Carpet.
 *
 * Every research run pins its qualified survivors here automatically, so the
 * carpet is the collection of strategies that beat all three validation
 * windows, the walk-forward folds and the search-size correction. A strategy
 * on this page is evidence, not a guarantee — but everything NOT on this page
 * failed a check that was designed to be hard to pass.
 */
export function StrategyCarpetPage() {
  const [busyId, setBusyId] = useState<number | null>(null);
  const carpet = useLive(
    () => api.discoveredStrategies().then(r => r.strategies),
    ["research", "hello"],
  );

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
        <Header count={0} />
        <Card>
          <CardContent className="py-10 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              No qualified strategies yet.
            </p>
            <p className="text-xs text-muted-foreground/70 max-w-md mx-auto">
              Run a search under <strong>Find Strategies</strong>. Every
              configuration that survives all three validation windows, the
              walk-forward folds and the significance correction lands here
              automatically. Most searches honestly find nothing — that is the
              filter working.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const adopt = async (s: DiscoveredStrategy) => {
    setBusyId(s.id);
    try {
      const r = await api.adoptDiscovered(s.id);
      toast.success(
        r.added
          ? `${s.symbol} added to Instruments (disabled) with this strategy.`
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

  return (
    <div className="max-w-[1100px] mx-auto p-3 sm:p-4 space-y-4">
      <Header count={carpet.length} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {carpet.map(s => (
          <StrategyCard
            key={s.id}
            strategy={s}
            busy={busyId === s.id}
            onAdopt={() => adopt(s)}
            onRemove={() => remove(s)}
          />
        ))}
      </div>
    </div>
  );
}

function Header({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div>
        <h1 className="text-xl font-semibold">Strategy Carpet</h1>
        <p className="text-xs text-muted-foreground">
          {count === 0
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
