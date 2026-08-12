import {
  Activity,
  BarChart3,
  Eye,
  FlaskConical,
  GitBranch,
  Layers,
  Minus,
  Radio,
  Target,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { MiniChart } from "@/components/dashboard/MultiTimeframeView";
import { PriceTicker } from "@/components/dashboard/PriceTicker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMutation } from "@/hooks/useLive";
import { api } from "@/lib/api";
import {
  analyzeExperimental,
  type ExperimentalAnalysis,
  type ToolSignal,
} from "@/lib/experimentalIndicators";
import type { ScalpEntry } from "@/lib/indicators";
import {
  type Candle,
  fetchGoldCandles,
  fetchGoldPrice,
  type PriceData,
} from "@/lib/priceApi";

// Error boundary
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen gap-4 p-6 bg-[#0A0C10] text-white">
          <FlaskConical className="w-8 h-8 text-[#AB47BC]" />
          <span className="text-lg font-mono text-[#AB47BC]">
            ⚠ Experimental Lab Error
          </span>
          <span className="text-sm text-muted-foreground text-center max-w-md">
            {this.state.error || "Something went wrong."}
          </span>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: "" });
              window.location.reload();
            }}
            className="px-4 py-2 rounded-lg bg-[#AB47BC] text-white text-sm font-semibold hover:bg-[#9C27B0]"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

type Timeframe = "1m" | "3m" | "5m" | "15m";

function ExperimentalContent() {
  const [priceData, setPriceData] = useState<PriceData | null>(null);
  const [candles1m, setCandles1m] = useState<Candle[]>([]);
  const [candles3m, setCandles3m] = useState<Candle[]>([]);
  const [candles5m, setCandles5m] = useState<Candle[]>([]);
  const [candles15m, setCandles15m] = useState<Candle[]>([]);
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("5m");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const loadData = useCallback(async (showRefresh = false) => {
    try {
      if (showRefresh) setRefreshing(true);
      const [priceResult, c1, c3, c5, c15] = await Promise.allSettled([
        fetchGoldPrice(),
        fetchGoldCandles("1m"),
        fetchGoldCandles("3m"),
        fetchGoldCandles("5m"),
        fetchGoldCandles("15m"),
      ]);
      if (priceResult.status === "fulfilled") setPriceData(priceResult.value);
      if (c1.status === "fulfilled") setCandles1m(c1.value);
      if (c3.status === "fulfilled") setCandles3m(c3.value);
      if (c5.status === "fulfilled") setCandles5m(c5.value);
      if (c15.status === "fulfilled") setCandles15m(c15.value);
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Failed to load data:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => loadData(), 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Experimental analysis per timeframe
  const exp1m = useMemo(() => {
    try {
      return analyzeExperimental(candles1m);
    } catch {
      return null;
    }
  }, [candles1m]);
  const exp3m = useMemo(() => {
    try {
      return analyzeExperimental(candles3m);
    } catch {
      return null;
    }
  }, [candles3m]);
  const exp5m = useMemo(() => {
    try {
      return analyzeExperimental(candles5m);
    } catch {
      return null;
    }
  }, [candles5m]);
  const exp15m = useMemo(() => {
    try {
      return analyzeExperimental(candles15m);
    } catch {
      return null;
    }
  }, [candles15m]);

  const activeExp =
    activeTimeframe === "1m"
      ? exp1m
      : activeTimeframe === "3m"
        ? exp3m
        : activeTimeframe === "5m"
          ? exp5m
          : exp15m;

  if (loading) {
    return (
      <div className="flex flex-col gap-3 p-3 sm:p-4 max-w-[1440px] mx-auto">
        <Skeleton className="h-8 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-[200px] rounded-xl" />
          <Skeleton className="h-[200px] rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-4 max-w-[1440px] mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#AB47BC] to-[#7B1FA2] flex items-center justify-center">
            <FlaskConical className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              Experimental Lab
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#AB47BC]/15 text-[#AB47BC] font-mono font-bold">
                BETA
              </span>
            </h1>
            <p className="text-[11px] text-muted-foreground">
              8 proven scalping tools combined — Supertrend · Heikin Ashi · TTM
              Squeeze · EMA Ribbon · RSI Divergence · Order Blocks · FVG · VWAP
              Bands
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-xs text-muted-foreground font-mono">
              {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadData(true)}
            disabled={refreshing}
            className="h-8 text-xs border-[#AB47BC]/20 bg-card hover:bg-[#AB47BC]/5"
          >
            {refreshing ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-[#AB47BC] border-t-transparent rounded-full animate-spin" />
              </span>
            ) : (
              "↻ Refresh"
            )}
          </Button>
        </div>
      </div>

      {/* Price Ticker */}
      <PriceTicker data={priceData} />

      {/* Combined Signal Panel */}
      {activeExp && (
        <CombinedSignalPanel analysis={activeExp} timeframe={activeTimeframe} />
      )}

      {/* Tool Grid — each tool's signal */}
      {activeExp && <ToolGrid analysis={activeExp} />}

      {/* Entry Ideas */}
      {activeExp && activeExp.entries.length > 0 && (
        <ExperimentalEntries
          entries={activeExp.entries}
          timeframe={activeTimeframe}
          bias={activeExp.bias}
          biasStrength={activeExp.biasStrength}
        />
      )}

      {/* Multi-TF Charts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            tf: "1m" as Timeframe,
            label: "1 MIN",
            candles: candles1m,
            exp: exp1m,
          },
          {
            tf: "3m" as Timeframe,
            label: "3 MIN",
            candles: candles3m,
            exp: exp3m,
          },
          {
            tf: "5m" as Timeframe,
            label: "5 MIN",
            candles: candles5m,
            exp: exp5m,
          },
          {
            tf: "15m" as Timeframe,
            label: "15 MIN",
            candles: candles15m,
            exp: exp15m,
          },
        ].map(({ tf, label, candles, exp }) => (
          <div
            key={tf}
            role="button"
            tabIndex={0}
            className={`cursor-pointer transition-all rounded-xl ${
              activeTimeframe === tf
                ? "ring-1 ring-[#AB47BC]/50"
                : "hover:ring-1 hover:ring-[#AB47BC]/20"
            }`}
            onClick={() => setActiveTimeframe(tf)}
          >
            <MiniChart
              candles={candles}
              label={label}
              height={200}
              showEMA
              showBB={tf === "15m"}
            />
            {/* Supertrend badge on chart */}
            {exp && (
              <div className="flex items-center justify-between px-2 py-1 -mt-1">
                <span
                  className={`text-[9px] font-mono font-bold ${
                    exp.supertrend.trend[candles.length - 1] === "UP"
                      ? "text-[#00E676]"
                      : "text-[#FF1744]"
                  }`}
                >
                  ST: {exp.supertrend.trend[candles.length - 1]}
                </span>
                <span
                  className={`text-[9px] font-mono ${
                    exp.squeeze.isSqueezing[candles.length - 1]
                      ? "text-[#FFD600] animate-pulse"
                      : "text-muted-foreground/40"
                  }`}
                >
                  {exp.squeeze.isSqueezing[candles.length - 1] ? "🔥 SQZ" : ""}
                </span>
              </div>
            )}
            {activeTimeframe === tf && (
              <div className="h-0.5 bg-[#AB47BC] rounded-b-xl -mt-px mx-1" />
            )}
          </div>
        ))}
      </div>

      {/* SMC Zones: Order Blocks + FVGs */}
      {activeExp && (
        <SMCZonesPanel analysis={activeExp} price={priceData?.price ?? 0} />
      )}

      {/* Multi-TF Experimental Confluence */}
      <ExperimentalConfluence
        exp1m={exp1m}
        exp3m={exp3m}
        exp5m={exp5m}
        exp15m={exp15m}
      />
    </div>
  );
}

export default function ExperimentalPage() {
  return (
    <ErrorBoundary>
      <ExperimentalContent />
    </ErrorBoundary>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Combined Signal Panel
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function CombinedSignalPanel({
  analysis,
}: {
  analysis: ExperimentalAnalysis;
  timeframe?: string;
}) {
  const sig = analysis.experimentalSignal;
  const dirColor =
    sig.direction === "LONG"
      ? "#00E676"
      : sig.direction === "SHORT"
        ? "#FF1744"
        : "#AB47BC";
  const dirLabel =
    sig.direction === "LONG"
      ? "LONG"
      : sig.direction === "SHORT"
        ? "SHORT"
        : "NEUTRAL";

  const buyTools = sig.tools.filter(t => t.signal === "BUY").length;
  const sellTools = sig.tools.filter(t => t.signal === "SELL").length;
  const squeezeActive = sig.tools.some(t => t.signal === "SQUEEZE");

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        backgroundColor: `${dirColor}06`,
        borderColor: `${dirColor}25`,
      }}
    >
      <div className="flex flex-col lg:flex-row gap-4 lg:items-center">
        {/* Main signal */}
        <div className="flex items-center gap-4">
          <div
            className="flex items-center gap-2 px-4 py-2 rounded-xl border"
            style={{
              borderColor: `${dirColor}40`,
              backgroundColor: `${dirColor}12`,
            }}
          >
            {sig.direction === "LONG" ? (
              <TrendingUp className="w-5 h-5" style={{ color: dirColor }} />
            ) : sig.direction === "SHORT" ? (
              <TrendingDown className="w-5 h-5" style={{ color: dirColor }} />
            ) : (
              <Minus className="w-5 h-5" style={{ color: dirColor }} />
            )}
            <span
              className="text-xl font-bold font-mono tracking-wider"
              style={{ color: dirColor }}
            >
              {dirLabel}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">
                Combined Confidence
              </span>
              <div className="w-20 h-2 bg-secondary/50 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${sig.confidence}%`,
                    backgroundColor: dirColor,
                  }}
                />
              </div>
              <span
                className="text-sm font-mono tabular-nums font-bold"
                style={{ color: dirColor }}
              >
                {sig.confidence}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">Score</span>
              <span className="text-xs font-mono" style={{ color: dirColor }}>
                {sig.combinedScore}%
              </span>
              <span className="text-muted-foreground/30">·</span>
              <span className="text-[10px] font-mono text-[#00E676]">
                ▲{buyTools}
              </span>
              <span className="text-[10px] font-mono text-[#FF1744]">
                ▼{sellTools}
              </span>
              {squeezeActive && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#FFD600]/15 text-[#FFD600] font-bold animate-pulse">
                  🔥 SQUEEZE
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="hidden lg:block w-px h-12 bg-border/30" />

        {/* Quick tool summary */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {sig.tools.map(tool => (
            <ToolPill key={tool.name} tool={tool} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ToolPill({ tool }: { tool: ToolSignal }) {
  const color =
    tool.signal === "BUY"
      ? "#00E676"
      : tool.signal === "SELL"
        ? "#FF1744"
        : tool.signal === "SQUEEZE"
          ? "#FFD600"
          : "#6B7280";

  const ICONS: Record<string, typeof Activity> = {
    Supertrend: Activity,
    "Heikin Ashi": BarChart3,
    "TTM Squeeze": Zap,
    "EMA Ribbon": Layers,
    "RSI Divergence": GitBranch,
    "Order Blocks": Target,
    "Fair Value Gap": Eye,
    "VWAP Bands": Radio,
  };

  const Icon = ICONS[tool.name] ?? Activity;

  return (
    <div
      className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono border"
      style={{
        borderColor: `${color}25`,
        backgroundColor: `${color}08`,
        color,
      }}
    >
      <Icon className="w-2.5 h-2.5" />
      <span className="font-semibold">{tool.name.split(" ")[0]}</span>
      <span className="text-[9px] opacity-70">
        {tool.signal === "BUY"
          ? "▲"
          : tool.signal === "SELL"
            ? "▼"
            : tool.signal === "SQUEEZE"
              ? "◆"
              : "—"}
      </span>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool Detail Grid
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ToolGrid({ analysis }: { analysis: ExperimentalAnalysis }) {
  const tools = analysis.experimentalSignal.tools;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {tools.map(tool => {
        const color =
          tool.signal === "BUY"
            ? "#00E676"
            : tool.signal === "SELL"
              ? "#FF1744"
              : tool.signal === "SQUEEZE"
                ? "#FFD600"
                : "#6B7280";

        const ICONS: Record<string, typeof Activity> = {
          Supertrend: Activity,
          "Heikin Ashi": BarChart3,
          "TTM Squeeze": Zap,
          "EMA Ribbon": Layers,
          "RSI Divergence": GitBranch,
          "Order Blocks": Target,
          "Fair Value Gap": Eye,
          "VWAP Bands": Radio,
        };
        const Icon = ICONS[tool.name] ?? Activity;

        return (
          <div
            key={tool.name}
            className="rounded-xl border p-3 flex flex-col gap-2"
            style={{
              borderColor: `${color}20`,
              backgroundColor: `${color}04`,
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5" style={{ color }} />
                <span className="text-xs font-semibold">{tool.name}</span>
              </div>
              <span
                className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
                style={{ color, backgroundColor: `${color}15` }}
              >
                {tool.signal}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2">
              {tool.detail}
            </p>
            <div className="flex items-center gap-1 mt-auto">
              <span className="text-[9px] text-muted-foreground/50">
                Weight
              </span>
              <div className="flex-1 h-1 bg-secondary/30 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(tool.weight / 20) * 100}%`,
                    backgroundColor: color,
                  }}
                />
              </div>
              <span className="text-[9px] font-mono text-muted-foreground/50">
                {tool.weight}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Experimental Entry Cards
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ExperimentalEntries({
  entries,
  timeframe,
  bias,
  biasStrength,
}: {
  entries: ScalpEntry[];
  timeframe: string;
  bias: string;
  biasStrength: number;
}) {
  const [logIdea] = useMutation((idea: Record<string, unknown>) =>
    api.logIdea(idea),
  );

  const handleLog = async (entry: ScalpEntry) => {
    try {
      await logIdea({
        direction: entry.direction,
        entryPrice: entry.entryPrice,
        stopLoss: entry.stopLoss,
        tp1: entry.tp1,
        tp2: entry.tp2,
        confidence: entry.confidence,
        reason: `[EXP] ${entry.reason}`,
        timeframe,
        bias,
        biasStrength,
        spotPrice: entry.entryPrice,
      });
      toast.success("Experimental idea logged!", {
        description: `${entry.direction} @ ${entry.entryPrice.toFixed(2)}`,
      });
    } catch {
      toast.error("Failed to log idea");
    }
  };

  return (
    <div className="rounded-xl border border-[#AB47BC]/20 bg-[#AB47BC]/[0.03] p-4">
      <div className="flex items-center gap-2 mb-3">
        <FlaskConical className="w-4 h-4 text-[#AB47BC]" />
        <span className="text-sm font-semibold">Experimental Entry Ideas</span>
        <span className="text-[10px] text-muted-foreground">
          Based on 8-tool analysis
        </span>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        {entries.map((entry, i) => {
          const dirColor = entry.direction === "LONG" ? "#00E676" : "#FF1744";
          const slDist = Math.abs(entry.entryPrice - entry.stopLoss);

          return (
            <div
              key={i}
              className="flex-1 rounded-lg border p-3 bg-card/60"
              style={{ borderColor: `${dirColor}30` }}
            >
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
                  <span className="text-[10px] text-[#AB47BC] bg-[#AB47BC]/10 px-1.5 py-0.5 rounded font-medium">
                    EXPERIMENTAL
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    <div className="w-10 h-1.5 bg-secondary/50 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${entry.confidence}%`,
                          backgroundColor: dirColor,
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
                    onClick={() => handleLog(entry)}
                    className="text-[10px] font-semibold px-2 py-1 rounded bg-[#AB47BC]/15 text-[#AB47BC] border border-[#AB47BC]/25 hover:bg-[#AB47BC]/25 transition-colors"
                  >
                    🧪 Log Idea
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2 mb-2">
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground">
                    ENTRY
                  </span>
                  <span className="text-sm font-mono tabular-nums font-semibold text-[#D4A843]">
                    {entry.entryPrice.toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground">
                    STOP
                  </span>
                  <span className="text-sm font-mono tabular-nums font-semibold text-[#FF1744]">
                    {entry.stopLoss.toFixed(2)}
                  </span>
                  <span className="text-[9px] text-muted-foreground/50 font-mono">
                    {slDist.toFixed(2)} pts
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground">TP1</span>
                  <span className="text-sm font-mono tabular-nums font-semibold text-[#00E676]">
                    {entry.tp1.toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground">TP2</span>
                  <span className="text-sm font-mono tabular-nums font-semibold text-[#00E676]">
                    {entry.tp2.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="text-[10px] text-muted-foreground leading-relaxed">
                {entry.reason}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SMC Zones: Order Blocks + FVGs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function SMCZonesPanel({
  analysis,
  price,
}: {
  analysis: ExperimentalAnalysis;
  price: number;
}) {
  const { orderBlocks, fvgs } = analysis;
  const last = analysis.heikinAshi.length - 1;

  if (orderBlocks.length === 0 && fvgs.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Target className="w-4 h-4 text-[#AB47BC]" />
        <span className="text-sm font-semibold">Smart Money Zones</span>
        <span className="text-[10px] text-muted-foreground">
          Order Blocks · FVG · VWAP Bands
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Order Blocks */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] text-muted-foreground tracking-wider uppercase">
            Order Blocks
          </span>
          {orderBlocks.length === 0 ? (
            <span className="text-[10px] text-muted-foreground/50">
              None detected
            </span>
          ) : (
            orderBlocks.slice(-4).map((ob, i) => {
              const isBull = ob.type === "BULLISH_OB";
              const c = isBull ? "#00E676" : "#FF1744";
              const isNear = Math.abs(price - ob.midpoint) / price < 0.003;
              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border ${isNear ? "ring-1" : ""}`}
                  style={{
                    borderColor: `${c}20`,
                    backgroundColor: `${c}05`,
                    ...(isNear ? { ringColor: `${c}40` } : {}),
                  }}
                >
                  <div
                    className="w-1.5 h-4 rounded-full"
                    style={{ backgroundColor: c }}
                  />
                  <div className="flex flex-col flex-1">
                    <span
                      className="text-[10px] font-mono"
                      style={{ color: c }}
                    >
                      {isBull ? "Bull OB" : "Bear OB"}
                      {isNear && " ◄ NEAR"}
                    </span>
                    <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
                      {ob.low.toFixed(2)} – {ob.high.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5">
                    {Array.from({ length: ob.strength }).map((_, j) => (
                      <div
                        key={j}
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Fair Value Gaps */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] text-muted-foreground tracking-wider uppercase">
            Fair Value Gaps
          </span>
          {fvgs.length === 0 ? (
            <span className="text-[10px] text-muted-foreground/50">
              No unfilled FVGs
            </span>
          ) : (
            fvgs.slice(-4).map((fvg, i) => {
              const isBull = fvg.type === "BULLISH_FVG";
              const c = isBull ? "#00E676" : "#FF1744";
              return (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg border"
                  style={{ borderColor: `${c}20`, backgroundColor: `${c}05` }}
                >
                  <div
                    className="w-1.5 h-4 rounded-full"
                    style={{ backgroundColor: c }}
                  />
                  <div className="flex flex-col flex-1">
                    <span
                      className="text-[10px] font-mono"
                      style={{ color: c }}
                    >
                      {isBull ? "Bull FVG" : "Bear FVG"}
                    </span>
                    <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
                      {fvg.low.toFixed(2)} – {fvg.high.toFixed(2)} (
                      {fvg.size.toFixed(2)} pts)
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* VWAP Bands */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] text-muted-foreground tracking-wider uppercase">
            VWAP Bands
          </span>
          {last >= 0 &&
            analysis.vwapBands.vwap[last] !== undefined &&
            [
              {
                label: "+2σ",
                val: analysis.vwapBands.upper2[last],
                c: "#FF1744",
              },
              {
                label: "+1σ",
                val: analysis.vwapBands.upper1[last],
                c: "#FF1744",
              },
              {
                label: "VWAP",
                val: analysis.vwapBands.vwap[last],
                c: "#AB47BC",
              },
              {
                label: "−1σ",
                val: analysis.vwapBands.lower1[last],
                c: "#00E676",
              },
              {
                label: "−2σ",
                val: analysis.vwapBands.lower2[last],
                c: "#00E676",
              },
            ].map(band => {
              const isNear = Math.abs(price - band.val) / price < 0.0008;
              return (
                <div
                  key={band.label}
                  className={`flex items-center justify-between px-2 py-1 rounded ${isNear ? "bg-[#AB47BC]/10" : ""}`}
                >
                  <span
                    className="text-[10px] font-mono"
                    style={{ color: band.c }}
                  >
                    {band.label}
                  </span>
                  <span
                    className={`text-[10px] font-mono tabular-nums ${isNear ? "text-foreground font-bold" : "text-muted-foreground"}`}
                  >
                    {band.val.toFixed(2)}
                    {isNear && " ◄"}
                  </span>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Multi-TF Experimental Confluence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ExperimentalConfluence({
  exp1m,
  exp3m,
  exp5m,
  exp15m,
}: {
  exp1m: ExperimentalAnalysis | null;
  exp3m: ExperimentalAnalysis | null;
  exp5m: ExperimentalAnalysis | null;
  exp15m: ExperimentalAnalysis | null;
}) {
  const tfs = [
    { label: "1M", exp: exp1m },
    { label: "3M", exp: exp3m },
    { label: "5M", exp: exp5m },
    { label: "15M", exp: exp15m },
  ];

  const longCount = tfs.filter(
    t => t.exp?.experimentalSignal.direction === "LONG",
  ).length;
  const shortCount = tfs.filter(
    t => t.exp?.experimentalSignal.direction === "SHORT",
  ).length;
  const confluenceDir =
    longCount > shortCount
      ? "LONG"
      : shortCount > longCount
        ? "SHORT"
        : "NEUTRAL";
  const confluenceStrength = Math.max(longCount, shortCount);
  const confluenceLabel =
    confluenceStrength >= 4
      ? "VERY STRONG"
      : confluenceStrength === 3
        ? "STRONG"
        : confluenceStrength === 2
          ? "MODERATE"
          : "WEAK";
  const confluenceColor =
    confluenceDir === "LONG"
      ? "#00E676"
      : confluenceDir === "SHORT"
        ? "#FF1744"
        : "#6B7280";

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#AB47BC]" />
          <span className="text-sm font-semibold">
            Multi-TF Experimental Confluence
          </span>
        </div>
        <div
          className="px-2.5 py-1 rounded-lg text-[10px] font-bold tracking-wider"
          style={{
            color: confluenceColor,
            backgroundColor: `${confluenceColor}12`,
          }}
        >
          {confluenceLabel} {confluenceDir}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {tfs.map(({ label, exp }) => {
          if (!exp)
            return (
              <div
                key={label}
                className="rounded-lg bg-secondary/10 p-3 text-center"
              >
                <span className="text-xs text-muted-foreground">{label}</span>
                <div className="text-[10px] text-muted-foreground/50 mt-1">
                  Loading…
                </div>
              </div>
            );

          const sig = exp.experimentalSignal;
          const c =
            sig.direction === "LONG"
              ? "#00E676"
              : sig.direction === "SHORT"
                ? "#FF1744"
                : "#6B7280";
          const buyTools = sig.tools.filter(t => t.signal === "BUY").length;
          const sellTools = sig.tools.filter(t => t.signal === "SELL").length;

          return (
            <div
              key={label}
              className="rounded-lg border p-3"
              style={{ borderColor: `${c}20`, backgroundColor: `${c}04` }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono font-bold text-muted-foreground">
                  {label}
                </span>
                <span
                  className="text-xs font-mono font-bold"
                  style={{ color: c }}
                >
                  {sig.direction === "LONG"
                    ? "▲ LONG"
                    : sig.direction === "SHORT"
                      ? "▼ SHORT"
                      : "— NEUTRAL"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <div className="flex-1 h-1.5 bg-secondary/30 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${sig.confidence}%`, backgroundColor: c }}
                  />
                </div>
                <span
                  className="text-[10px] font-mono tabular-nums"
                  style={{ color: c }}
                >
                  {sig.confidence}%
                </span>
              </div>
              <div className="flex items-center gap-2 text-[9px] font-mono">
                <span className="text-[#00E676]">▲{buyTools}</span>
                <span className="text-[#FF1744]">▼{sellTools}</span>
                {exp.squeeze.isSqueezing[exp.heikinAshi.length - 1] && (
                  <span className="text-[#FFD600]">🔥SQZ</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
