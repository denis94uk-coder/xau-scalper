import type { Candle, ScalpSignal } from "@/lib/indicators";
import {
  calcATR,
  calcEMA,
  calcMACD,
  calcRSI,
  calcStochastic,
} from "@/lib/indicators";

interface SignalPanelProps {
  signal: ScalpSignal;
  candles: Candle[];
}

function IndicatorBar({
  label,
  value,
  min,
  max,
  zones,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  zones?: { low: number; high: number };
}) {
  if (value === undefined) return null;
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  const isOversold = zones && value < zones.low;
  const isOverbought = zones && value > zones.high;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between items-center">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span
          className={`text-xs font-mono tabular-nums font-semibold ${
            isOversold
              ? "text-[#00E676]"
              : isOverbought
                ? "text-[#FF1744]"
                : "text-foreground"
          }`}
        >
          {value.toFixed(1)}
        </span>
      </div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden relative">
        {zones && (
          <>
            <div
              className="absolute inset-y-0 bg-[#00E676]/10 rounded-l-full"
              style={{ width: `${((zones.low - min) / (max - min)) * 100}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-[#FF1744]/10 rounded-r-full"
              style={{
                width: `${((max - zones.high) / (max - min)) * 100}%`,
              }}
            />
          </>
        )}
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            isOversold
              ? "bg-[#00E676]"
              : isOverbought
                ? "bg-[#FF1744]"
                : "bg-[#D4A843]"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function SignalPanel({ signal, candles }: SignalPanelProps) {
  const closes = candles.map(c => c.close);
  const last = closes.length - 1;

  const rsi = calcRSI(closes, 14);
  const stoch = calcStochastic(candles);
  const { macd, signal: macdSignal } = calcMACD(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const atr = calcATR(candles, 14);

  const signalColor =
    signal.type === "BUY"
      ? "#00E676"
      : signal.type === "SELL"
        ? "#FF1744"
        : "#6B7280";

  const signalBg =
    signal.type === "BUY"
      ? "rgba(0, 230, 118, 0.08)"
      : signal.type === "SELL"
        ? "rgba(255, 23, 68, 0.08)"
        : "rgba(107, 114, 128, 0.08)";

  return (
    <div className="flex flex-col gap-4 p-4 rounded-xl bg-card border border-border h-full">
      {/* Signal Header */}
      <div className="text-xs font-medium text-muted-foreground tracking-wider uppercase">
        Scalp Signal
      </div>

      <div
        className="flex flex-col items-center py-4 rounded-lg border"
        style={{
          borderColor: signalColor,
          backgroundColor: signalBg,
        }}
      >
        <div
          className="text-2xl font-bold font-mono tracking-wide"
          style={{ color: signalColor }}
        >
          {signal.type}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-muted-foreground">Strength</span>
          <div className="w-24 h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${signal.strength}%`,
                backgroundColor: signalColor,
              }}
            />
          </div>
          <span
            className="text-xs font-mono font-semibold"
            style={{ color: signalColor }}
          >
            {signal.strength}%
          </span>
        </div>
      </div>

      {/* Reasons */}
      <div className="flex flex-col gap-1">
        {signal.reasons.slice(0, 4).map((reason, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span
              className="w-1 h-1 rounded-full"
              style={{ backgroundColor: signalColor }}
            />
            <span className="text-muted-foreground">{reason}</span>
          </div>
        ))}
      </div>

      {/* Indicators */}
      <div className="border-t border-border pt-3 flex flex-col gap-3">
        <div className="text-xs font-medium text-muted-foreground tracking-wider uppercase">
          Indicators
        </div>

        <IndicatorBar
          label="RSI (14)"
          value={rsi[last]}
          min={0}
          max={100}
          zones={{ low: 30, high: 70 }}
        />
        <IndicatorBar
          label="Stochastic %K"
          value={stoch.k[last]}
          min={0}
          max={100}
          zones={{ low: 20, high: 80 }}
        />

        <div className="grid grid-cols-2 gap-3 mt-1">
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">MACD</span>
            <span
              className={`text-xs font-mono tabular-nums font-semibold ${
                macd[last] !== undefined && macd[last] > 0
                  ? "text-[#00E676]"
                  : "text-[#FF1744]"
              }`}
            >
              {macd[last]?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">Signal</span>
            <span className="text-xs font-mono tabular-nums">
              {macdSignal[last]?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">EMA 9</span>
            <span className="text-xs font-mono tabular-nums">
              {ema9[last]?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">EMA 21</span>
            <span className="text-xs font-mono tabular-nums">
              {ema21[last]?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">ATR (14)</span>
            <span className="text-xs font-mono tabular-nums text-[#D4A843]">
              {atr[last]?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">Trend</span>
            <span
              className={`text-xs font-mono font-semibold ${
                ema9[last] !== undefined &&
                ema21[last] !== undefined &&
                ema9[last] > ema21[last]
                  ? "text-[#00E676]"
                  : "text-[#FF1744]"
              }`}
            >
              {ema9[last] !== undefined &&
              ema21[last] !== undefined &&
              ema9[last] > ema21[last]
                ? "▲ BULL"
                : "▼ BEAR"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
