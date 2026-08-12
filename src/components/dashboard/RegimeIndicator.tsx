import { useLive } from "@/hooks/useLive";
import { api } from "@/lib/api";

const REGIME_CONFIG: Record<
  string,
  {
    icon: string;
    color: string;
    bgColor: string;
    borderColor: string;
    label: string;
  }
> = {
  TRENDING_UP: {
    icon: "📈",
    color: "#00E676",
    bgColor: "rgba(0,230,118,0.08)",
    borderColor: "rgba(0,230,118,0.25)",
    label: "TRENDING UP",
  },
  TRENDING_DOWN: {
    icon: "📉",
    color: "#FF5252",
    bgColor: "rgba(255,82,82,0.08)",
    borderColor: "rgba(255,82,82,0.25)",
    label: "TRENDING DOWN",
  },
  RANGING: {
    icon: "↔️",
    color: "#FFB74D",
    bgColor: "rgba(255,183,77,0.08)",
    borderColor: "rgba(255,183,77,0.25)",
    label: "RANGING",
  },
  VOLATILE: {
    icon: "⚡",
    color: "#E040FB",
    bgColor: "rgba(224,64,251,0.08)",
    borderColor: "rgba(224,64,251,0.25)",
    label: "VOLATILE",
  },
};

export function RegimeIndicator() {
  const regime = useLive<any>(
    () => api.state<any>("marketRegime").catch(() => null),
    ["engine"],
  );

  if (!regime) {
    return (
      <div className="rounded-lg bg-secondary/20 border border-white/5 p-3 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-32" />
      </div>
    );
  }

  const cfg = REGIME_CONFIG[regime.regime] || REGIME_CONFIG.RANGING;
  const ageMinutes = regime.timestamp
    ? Math.round((Date.now() - regime.timestamp) / 60000)
    : 0;

  return (
    <div
      className="rounded-lg border p-3 transition-all duration-500"
      style={{ backgroundColor: cfg.bgColor, borderColor: cfg.borderColor }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">{cfg.icon}</span>
          <span
            className="text-[11px] font-bold font-mono tracking-wider"
            style={{ color: cfg.color }}
          >
            {cfg.label}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground/60 px-1.5 py-0.5 rounded bg-white/5">
            {regime.confidence}% conf
          </span>
        </div>
        <span className="text-[9px] text-muted-foreground/40 font-mono shrink-0 ml-2">
          {ageMinutes < 1 ? "just now" : `${ageMinutes}m ago`}
        </span>
      </div>

      {/* Description */}
      <p className="text-[10px] text-muted-foreground/70 leading-relaxed mb-2.5">
        {regime.description}
      </p>

      {/* Metrics grid — 2 cols on mobile, 4 on sm+ */}
      <div className="grid grid-cols-4 gap-2">
        <MetricPill
          label="ATR Ratio"
          value={regime.atrRatio.toFixed(2)}
          highlight={regime.atrRatio > 1.3}
          color={cfg.color}
        />
        <MetricPill
          label="ADX"
          value={regime.adxProxy.toFixed(0)}
          highlight={regime.adxProxy > 30}
          color={cfg.color}
        />
        <MetricPill
          label="BB Width"
          value={`${regime.bbWidth.toFixed(1)}%`}
          highlight={regime.bbWidth > 2}
          color={cfg.color}
        />
        <MetricPill
          label="Trend"
          value={`${regime.trendStrength > 0 ? "+" : ""}${regime.trendStrength.toFixed(0)}`}
          highlight={Math.abs(regime.trendStrength) > 20}
          color={cfg.color}
        />
      </div>

      {/* Adaptive parameters */}
      <div className="mt-2.5 pt-2 border-t border-white/5">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider">
            Adaptive Parameters · enforced
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <AdaptiveTag label="SL" value={`${regime.slMultiplier}×`} />
          <AdaptiveTag label="TP" value={`${regime.tpMultiplier}×`} />
          <AdaptiveTag
            label="Size"
            value={`${regime.positionSizeMultiplier}×`}
          />
          <AdaptiveTag label="Min" value={regime.minGrade} />
          <AdaptiveTag label="Bias" value={regime.favorDirection} />
        </div>
      </div>
    </div>
  );
}

function MetricPill({
  label,
  value,
  highlight,
  color,
}: {
  label: string;
  value: string;
  highlight: boolean;
  color: string;
}) {
  return (
    <div className="text-center min-w-0">
      <div
        className={`text-[11px] font-mono font-bold truncate ${highlight ? "" : "text-muted-foreground"}`}
        style={highlight ? { color } : undefined}
      >
        {value}
      </div>
      <div className="text-[8px] text-muted-foreground/40 uppercase tracking-wider truncate">
        {label}
      </div>
    </div>
  );
}

function AdaptiveTag({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-mono bg-white/5 rounded px-1.5 py-0.5 text-muted-foreground/60">
      <span className="text-muted-foreground/40">{label}</span>
      <span className="text-foreground/80">{value}</span>
    </span>
  );
}
