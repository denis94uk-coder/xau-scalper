import { Layers, ShieldCheck, TriangleAlert } from "lucide-react";
import { useLive } from "@/hooks/useLive";
import { api, type Portfolio } from "@/lib/api";

/**
 * Concentration risk across the open book.
 *
 * The rest of the app reports one asset at a time, which cannot show that five
 * crypto longs are one bet at five times the size. That is the number here.
 */
export function PortfolioRisk() {
  const p = useLive(() => api.portfolio(), ["ideas"]);
  if (!p) return null;

  const over = p.portfolioRisk > p.maxRisk;
  const crowded = p.concentration > 0.85 && p.positions.length > 1;

  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Layers className="w-4 h-4 text-[#D4A843]" />
        <span className="text-sm font-medium">Portfolio Risk</span>
        {over ? (
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 flex items-center gap-1">
            <TriangleAlert className="w-3 h-3" />
            over cap
          </span>
        ) : (
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" />
            within cap
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{p.summary}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat
          label="Effective risk"
          value={p.portfolioRisk.toFixed(2)}
          hint={`cap ${p.maxRisk.toFixed(2)}`}
          color={over ? "text-red-400" : "text-white"}
        />
        <Stat
          label="Gross size"
          value={p.grossRisk.toFixed(0)}
          hint={`${p.positions.length} open`}
          color="text-white"
        />
        <Stat
          label="Concentration"
          value={`${(p.concentration * 100).toFixed(0)}%`}
          hint={crowded ? "one bet, repeated" : "diversified"}
          color={crowded ? "text-yellow-400" : "text-emerald-400"}
        />
        <Stat
          label="Net exposure"
          value={`${p.netExposure > 0 ? "+" : ""}${p.netExposure.toFixed(0)}`}
          hint={p.netExposure === 0 ? "balanced" : "directional"}
          color={
            p.netExposure > 0
              ? "text-emerald-400"
              : p.netExposure < 0
                ? "text-red-400"
                : "text-muted-foreground"
          }
        />
      </div>

      {/* How much of the record is independent evidence. */}
      {p.evidence.trades > 0 && (
        <div className="text-[11px] text-muted-foreground border-t border-white/5 pt-2">
          <span className="font-mono text-white">
            {p.evidence.trades} trades
          </span>{" "}
          carry the weight of{" "}
          <span className="font-mono text-white">
            {p.evidence.effectiveTrades}
          </span>{" "}
          independent ones — {p.evidence.averageConcurrency.toFixed(1)} held at
          once, at ρ {p.evidence.averageCorrelation.toFixed(2)}.
        </div>
      )}

      <Correlations pairs={p.correlations} measured={p.correlationsMeasured} />
    </div>
  );
}

function Correlations({
  pairs,
  measured,
}: {
  pairs: Portfolio["correlations"];
  measured: boolean;
}) {
  // Strongest first: those are the pairs that decide whether a new signal is
  // diversification or the same bet again.
  const top = [...pairs]
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 6);
  if (top.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground">
        Strongest correlations
        {!measured && " · some assumed, not enough overlapping history"}
      </div>
      {top.map(c => (
        <div
          key={`${c.a}|${c.b}`}
          className="flex items-center gap-2 text-[11px]"
        >
          <span className="font-mono text-muted-foreground truncate w-32 shrink-0">
            {c.a} · {c.b}
          </span>
          <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className={`h-full ${c.value >= 0 ? "bg-yellow-400/70" : "bg-blue-400/70"}`}
              style={{ width: `${Math.abs(c.value) * 100}%` }}
            />
          </div>
          <span className="font-mono w-14 text-right shrink-0">
            {c.value.toFixed(2)}
          </span>
          <span className="text-[9px] text-muted-foreground w-16 text-right shrink-0">
            {c.assumed ? "assumed" : `${c.samples} bars`}
          </span>
        </div>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint: string;
  color: string;
}) {
  return (
    <div className="bg-black/20 rounded-md px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{hint}</div>
    </div>
  );
}
