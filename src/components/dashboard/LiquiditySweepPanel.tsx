import { useQuery } from "convex/react";
import { useTimezone } from "@/contexts/TimezoneContext";
import { api } from "../../../convex/_generated/api";

export function LiquiditySweepPanel() {
  const sweepData = useQuery(api.sweepQueries.getSweeps);
  const { formatShortTime } = useTimezone();

  if (!sweepData) {
    return (
      <div className="rounded-lg bg-secondary/20 border border-white/5 p-3 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-36" />
      </div>
    );
  }

  const { sweeps, supportLevels, resistanceLevels } = sweepData;
  const actionable = sweeps.filter((s: any) => s.actionable);

  return (
    <div className="rounded-lg bg-secondary/20 border border-white/5 p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono font-bold text-muted-foreground/70 uppercase tracking-wider">
            🔍 Liquidity Sweeps
          </span>
          {actionable.length > 0 && (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-[#00E5FF]/10 text-[#00E5FF] font-bold">
              {actionable.length} active
            </span>
          )}
        </div>
      </div>

      {/* Active sweeps */}
      {sweeps.length > 0 ? (
        <div className="space-y-2 mb-3">
          {sweeps.map((sweep: any, i: number) => (
            <SweepCard key={i} sweep={sweep} formatTime={formatShortTime} />
          ))}
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground/40 font-mono text-center py-3 mb-3">
          No sweeps detected in recent candles
        </div>
      )}

      {/* Key Levels */}
      <div className="border-t border-white/5 pt-2">
        <div className="text-[9px] font-mono text-muted-foreground/40 uppercase tracking-wider mb-1.5">
          Key Levels Being Watched
        </div>
        <div className="flex flex-wrap gap-1">
          {resistanceLevels
            .slice(-5)
            .reverse()
            .map((lvl: number, i: number) => (
              <span
                key={`r-${i}`}
                className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-400/80 border border-red-500/10"
              >
                R {lvl.toFixed(1)}
              </span>
            ))}
          {supportLevels
            .slice(-5)
            .reverse()
            .map((lvl: number, i: number) => (
              <span
                key={`s-${i}`}
                className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-green-500/10 text-green-400/80 border border-green-500/10"
              >
                S {lvl.toFixed(1)}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}

function SweepCard({
  sweep,
  formatTime,
}: {
  sweep: any;
  formatTime: (ts: number) => string;
}) {
  const isBull = sweep.type === "BULL_SWEEP";
  const color = isBull ? "#00E676" : "#FF5252";
  const bgColor = isBull ? "rgba(0,230,118,0.06)" : "rgba(255,82,82,0.06)";
  const borderColor = isBull ? "rgba(0,230,118,0.15)" : "rgba(255,82,82,0.15)";

  return (
    <div
      className="rounded-md p-2.5 border transition-all"
      style={{ backgroundColor: bgColor, borderColor }}
    >
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px]">{isBull ? "🐂" : "🐻"}</span>
          <span className="text-[10px] font-mono font-bold" style={{ color }}>
            {sweep.type.replace("_", " ")}
          </span>
          {sweep.actionable && (
            <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-[#00E5FF]/15 text-[#00E5FF] font-bold">
              TRADE
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-muted-foreground/40">
            {sweep.confidence}%
          </span>
          <span className="text-[8px] font-mono text-muted-foreground/30">
            {formatTime(sweep.timestamp)}
          </span>
        </div>
      </div>

      <p className="text-[9px] text-muted-foreground/60 font-mono leading-relaxed mb-1.5">
        {sweep.description}
      </p>

      {sweep.actionable && (
        <div className="flex items-center gap-2 sm:gap-3 text-[9px] font-mono flex-wrap">
          <span className="text-muted-foreground/40">
            Entry{" "}
            <span className="text-foreground/80">
              ${sweep.suggestedEntry.toFixed(1)}
            </span>
          </span>
          <span className="text-muted-foreground/40">
            SL{" "}
            <span className="text-red-400/80">
              ${sweep.suggestedSL.toFixed(1)}
            </span>
          </span>
          <span className="text-muted-foreground/40">
            TP{" "}
            <span className="text-green-400/80">
              ${sweep.suggestedTP.toFixed(1)}
            </span>
          </span>
          <span className="text-muted-foreground/40">
            Vol <span className="text-foreground/60">{sweep.volumeSpike}×</span>
          </span>
        </div>
      )}
    </div>
  );
}
