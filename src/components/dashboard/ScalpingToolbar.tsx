import { useMutation } from "convex/react";
import { toast } from "sonner";
import type { ScalpAnalysis, ScalpEntry } from "@/lib/indicators";
import { api } from "../../../convex/_generated/api";

interface ScalpingToolbarProps {
  analysis1m: ScalpAnalysis | null;
  analysis3m: ScalpAnalysis | null;
  analysis5m: ScalpAnalysis | null;
  analysis15m: ScalpAnalysis | null;
  activeTimeframe: "1m" | "3m" | "5m" | "15m";
}

const BIAS_COLORS = {
  BULLISH: {
    text: "#00E676",
    bg: "rgba(0,230,118,0.08)",
    border: "rgba(0,230,118,0.25)",
  },
  BEARISH: {
    text: "#FF1744",
    bg: "rgba(255,23,68,0.08)",
    border: "rgba(255,23,68,0.25)",
  },
  NEUTRAL: {
    text: "#D4A843",
    bg: "rgba(212,168,67,0.06)",
    border: "rgba(212,168,67,0.20)",
  },
};

export function ScalpingToolbar({
  analysis1m,
  analysis3m,
  analysis5m,
  analysis15m,
  activeTimeframe,
}: ScalpingToolbarProps) {
  const activeAnalysis =
    activeTimeframe === "1m"
      ? analysis1m
      : activeTimeframe === "3m"
        ? analysis3m
        : activeTimeframe === "5m"
          ? analysis5m
          : analysis15m;

  if (!activeAnalysis) {
    return (
      <div className="rounded-xl bg-card border border-border p-4">
        <span className="text-xs text-muted-foreground">Loading analysis…</span>
      </div>
    );
  }

  const { bias, biasStrength, entries } = activeAnalysis;
  const colors = BIAS_COLORS[bias];

  // Multi-TF confluence
  const tfBiases = [
    { label: "1M", analysis: analysis1m },
    { label: "3M", analysis: analysis3m },
    { label: "5M", analysis: analysis5m },
    { label: "15M", analysis: analysis15m },
  ];

  const alignedCount = tfBiases.filter(
    t => t.analysis && t.analysis.bias === bias,
  ).length;
  const confluence =
    alignedCount >= 3 ? "STRONG" : alignedCount === 2 ? "MODERATE" : "WEAK";

  return (
    <div
      className="rounded-xl border p-3 sm:p-4"
      style={{ backgroundColor: colors.bg, borderColor: colors.border }}
    >
      {/* Row 1: Bias + Multi-TF + Confluence */}
      <div className="flex flex-col gap-3">
        {/* Bias Badge + strength */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <div
              className="w-2.5 h-2.5 rounded-full animate-pulse-dot"
              style={{ backgroundColor: colors.text }}
            />
            <span
              className="text-lg sm:text-xl font-bold font-mono tracking-wider"
              style={{ color: colors.text }}
            >
              {bias}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-2 bg-secondary/50 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${biasStrength}%`,
                  backgroundColor: colors.text,
                }}
              />
            </div>
            <span
              className="text-xs font-mono tabular-nums"
              style={{ color: colors.text }}
            >
              {biasStrength}%
            </span>
          </div>
        </div>

        {/* Multi-TF alignment + Confluence */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="text-[10px] text-muted-foreground tracking-wider uppercase">
            Timeframes
          </span>
          <div className="flex items-center gap-1 sm:gap-1.5">
            {tfBiases.map(tf => {
              const b = tf.analysis?.bias;
              const c =
                b === "BULLISH"
                  ? "#00E676"
                  : b === "BEARISH"
                    ? "#FF1744"
                    : "#6B7280";
              const arrow = b === "BULLISH" ? "▲" : b === "BEARISH" ? "▼" : "—";
              return (
                <div
                  key={tf.label}
                  className="flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded bg-secondary/40"
                >
                  <span className="text-[9px] sm:text-[10px] font-mono text-muted-foreground">
                    {tf.label}
                  </span>
                  <span
                    className="text-[10px] sm:text-xs font-bold font-mono"
                    style={{ color: c }}
                  >
                    {arrow}
                  </span>
                </div>
              );
            })}
          </div>
          <div
            className={`px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-bold tracking-wider ${
              confluence === "STRONG"
                ? "bg-[#00E676]/15 text-[#00E676]"
                : confluence === "MODERATE"
                  ? "bg-[#D4A843]/15 text-[#D4A843]"
                  : "bg-secondary text-muted-foreground"
            }`}
          >
            {confluence} CONFLUENCE
          </div>
        </div>

        {/* Key S/R levels */}
        <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
          {activeAnalysis.keyResistances.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">R:</span>
              {activeAnalysis.keyResistances.slice(0, 2).map((r, i) => (
                <span
                  key={i}
                  className="text-xs font-mono tabular-nums text-[#FF1744]/80"
                >
                  {r.toFixed(2)}
                </span>
              ))}
            </div>
          )}
          {activeAnalysis.keySupports.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">S:</span>
              {activeAnalysis.keySupports.slice(0, 2).map((s, i) => (
                <span
                  key={i}
                  className="text-xs font-mono tabular-nums text-[#00E676]/80"
                >
                  {s.toFixed(2)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Row 2: Entry Ideas */}
      {entries.length > 0 && (
        <div
          className="mt-3 pt-3 border-t"
          style={{ borderColor: colors.border }}
        >
          <div className="flex flex-col sm:flex-row gap-3">
            {entries.map((entry, i) => (
              <EntryCard
                key={i}
                entry={entry}
                isPrimary={i === 0}
                timeframe={activeTimeframe}
                bias={bias}
                biasStrength={biasStrength}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  isPrimary,
  timeframe,
  bias,
  biasStrength,
}: {
  entry: ScalpEntry;
  isPrimary: boolean;
  timeframe: string;
  bias: string;
  biasStrength: number;
}) {
  const logIdea = useMutation(api.tradingIdeas.logIdea);
  const isLong = entry.direction === "LONG";
  const dirColor = isLong ? "#00E676" : "#FF1744";
  const slDistance = Math.abs(entry.entryPrice - entry.stopLoss);

  const handleLog = async () => {
    try {
      await logIdea({
        direction: entry.direction,
        entryPrice: entry.entryPrice,
        stopLoss: entry.stopLoss,
        tp1: entry.tp1,
        tp2: entry.tp2,
        confidence: entry.confidence,
        reason: entry.reason,
        timeframe,
        bias,
        biasStrength,
        spotPrice: entry.entryPrice,
      });
      toast.success("Idea logged!", {
        description: `${entry.direction} @ ${entry.entryPrice.toFixed(2)}`,
      });
    } catch {
      toast.error("Failed to log idea");
    }
  };

  return (
    <div
      className={`flex-1 rounded-lg p-3 border ${
        isPrimary ? "bg-card/80" : "bg-card/40"
      }`}
      style={{ borderColor: isPrimary ? `${dirColor}40` : "var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span
            className="text-xs font-bold font-mono px-2 py-0.5 rounded"
            style={{
              color: dirColor,
              backgroundColor: `${dirColor}15`,
            }}
          >
            {entry.direction}
          </span>
          {isPrimary && (
            <span className="text-[10px] text-[#D4A843] bg-[#D4A843]/10 px-1.5 py-0.5 rounded font-medium">
              PREFERRED
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="w-10 h-1.5 bg-secondary/50 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${entry.confidence}%`,
                  backgroundColor: entry.confidence > 60 ? dirColor : "#6B7280",
                }}
              />
            </div>
            <span
              className="text-[10px] font-mono tabular-nums"
              style={{ color: dirColor }}
            >
              {entry.confidence}%
            </span>
          </div>
          <button
            onClick={handleLog}
            className="text-[10px] font-semibold px-2 py-1 rounded bg-[#D4A843]/15 text-[#D4A843] border border-[#D4A843]/25 hover:bg-[#D4A843]/25 transition-colors"
          >
            📌 Log Idea
          </button>
        </div>
      </div>

      {/* Price Levels */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <PriceLevel label="ENTRY" value={entry.entryPrice} color="#D4A843" />
        <PriceLevel
          label="STOP LOSS"
          value={entry.stopLoss}
          color="#FF1744"
          sublabel={`${slDistance.toFixed(2)} pts`}
        />
        <PriceLevel
          label="TP 1"
          value={entry.tp1}
          color="#00E676"
          sublabel={`R:R 1.5`}
        />
        <PriceLevel
          label="TP 2"
          value={entry.tp2}
          color="#00E676"
          sublabel={`R:R 2.5`}
        />
      </div>

      {/* Reason */}
      <div className="mt-2 text-[10px] text-muted-foreground">
        {entry.reason}
      </div>
    </div>
  );
}

function PriceLevel({
  label,
  value,
  color,
  sublabel,
}: {
  label: string;
  value: number;
  color: string;
  sublabel?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-muted-foreground tracking-wider">
        {label}
      </span>
      <span
        className="text-sm font-mono tabular-nums font-semibold"
        style={{ color }}
      >
        {value.toFixed(2)}
      </span>
      {sublabel && (
        <span className="text-[9px] text-muted-foreground/60 font-mono">
          {sublabel}
        </span>
      )}
    </div>
  );
}
