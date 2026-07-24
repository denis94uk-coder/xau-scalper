import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

interface MacroAsset {
  label: string;
  icon: string;
  price: number;
  change: number;
  correlation: number;
  divergence: boolean;
  divType: string;
  relationship: string;
}

export function MacroCorrelation() {
  const macro = useQuery(api.macroQueries.getMacroState);

  if (!macro) {
    return (
      <div className="rounded-lg bg-secondary/20 border border-white/5 p-3 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-40" />
      </div>
    );
  }

  const assets: MacroAsset[] = [
    {
      label: "DXY",
      icon: "💵",
      price: macro.dxyPrice,
      change: macro.dxyChange,
      correlation: macro.dxyCorrelation,
      divergence: macro.dxyDivergence,
      divType: macro.dxyDivType,
      relationship: "Inverse",
    },
    {
      label: "US10Y",
      icon: "🏦",
      price: macro.us10yPrice,
      change: macro.us10yChange,
      correlation: macro.us10yCorrelation,
      divergence: macro.us10yDivergence,
      divType: macro.us10yDivType,
      relationship: "Inverse",
    },
    {
      label: "S&P 500",
      icon: "📊",
      price: macro.spxPrice,
      change: macro.spxChange,
      correlation: macro.spxCorrelation,
      divergence: macro.spxDivergence,
      divType: macro.spxDivType,
      relationship: "Variable",
    },
  ];

  const biasColor =
    macro.overallMacroBias === "BULLISH"
      ? "#00E676"
      : macro.overallMacroBias === "BEARISH"
        ? "#FF5252"
        : "#FFB74D";

  const biasIcon =
    macro.overallMacroBias === "BULLISH"
      ? "🟢"
      : macro.overallMacroBias === "BEARISH"
        ? "🔴"
        : "🟡";

  return (
    <div className="rounded-lg bg-secondary/20 border border-white/5 p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono font-bold text-muted-foreground/70 uppercase tracking-wider">
            🌍 Macro Correlations
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[9px]">{biasIcon}</span>
          <span
            className="text-[10px] font-mono font-bold"
            style={{ color: biasColor }}
          >
            {macro.overallMacroBias}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground/40">
            ({macro.macroBiasStrength}%)
          </span>
        </div>
      </div>

      {/* Asset grid — 3 columns, responsive sizing */}
      <div className="grid grid-cols-3 gap-1.5 sm:gap-2 mb-2">
        {assets.map(asset => (
          <AssetCard key={asset.label} asset={asset} />
        ))}
      </div>

      {/* Divergence alerts */}
      {assets.some(a => a.divergence) && (
        <div className="mt-2 pt-2 border-t border-white/5 space-y-1">
          {assets
            .filter(a => a.divergence)
            .map(asset => (
              <div
                key={`div-${asset.label}`}
                className="flex items-center gap-2 text-[10px] rounded-md px-2 py-1"
                style={{
                  backgroundColor:
                    asset.divType === "BULLISH_GOLD"
                      ? "rgba(0,230,118,0.08)"
                      : "rgba(255,82,82,0.08)",
                  color:
                    asset.divType === "BULLISH_GOLD" ? "#00E676" : "#FF5252",
                }}
              >
                <span>⚠️</span>
                <span className="font-mono truncate">
                  {asset.label} divergence →{" "}
                  {asset.divType === "BULLISH_GOLD"
                    ? "Gold may rally"
                    : "Gold may correct"}
                </span>
              </div>
            ))}
        </div>
      )}

      {/* Description */}
      <p className="text-[9px] text-muted-foreground/50 mt-2 leading-relaxed">
        {macro.description}
      </p>
    </div>
  );
}

function AssetCard({ asset }: { asset: MacroAsset }) {
  const changeColor =
    asset.change > 0 ? "#00E676" : asset.change < 0 ? "#FF5252" : "#888";
  const changeSign = asset.change > 0 ? "+" : "";

  return (
    <div
      className={`rounded-md p-1.5 sm:p-2 bg-white/[0.02] border ${
        asset.divergence ? "border-amber-500/30" : "border-white/5"
      } transition-colors min-w-0`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[8px] sm:text-[9px] font-mono text-muted-foreground/50 truncate">
          {asset.icon} {asset.label}
        </span>
        {asset.divergence && <span className="text-[8px]">⚠️</span>}
      </div>
      <div className="text-[11px] sm:text-[12px] font-mono font-bold text-foreground/90 truncate">
        {asset.label === "US10Y"
          ? `${asset.price.toFixed(2)}%`
          : asset.price.toFixed(2)}
      </div>
      <div className="flex items-center justify-between mt-0.5">
        <span
          className="text-[8px] sm:text-[9px] font-mono"
          style={{ color: changeColor }}
        >
          {changeSign}
          {asset.change.toFixed(2)}%
        </span>
        <span className="text-[7px] sm:text-[8px] font-mono text-muted-foreground/40 hidden sm:inline">
          {asset.relationship}
        </span>
      </div>
    </div>
  );
}
