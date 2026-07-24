import {
  type CandlestickData,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  type IChartApi,
  LineSeries,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle } from "@/lib/indicators";
import { calcBollingerBands, calcEMA } from "@/lib/indicators";

interface MiniChartProps {
  candles: Candle[];
  label: string;
  height?: number;
  showEMA?: boolean;
  showBB?: boolean;
}

export function MiniChart({
  candles,
  label,
  height = 200,
  showEMA = true,
  showBB = false,
}: MiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    // Clean up any existing chart
    if (chartRef.current) {
      try {
        chartRef.current.remove();
      } catch {
        // Already removed
      }
      chartRef.current = null;
    }

    let chart: IChartApi;
    try {
      chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "#6B7280",
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
        },
        grid: {
          vertLines: { color: "rgba(30, 35, 48, 0.4)" },
          horzLines: { color: "rgba(30, 35, 48, 0.4)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: "rgba(212, 168, 67, 0.2)",
            labelBackgroundColor: "#D4A843",
          },
          horzLine: {
            color: "rgba(212, 168, 67, 0.2)",
            labelBackgroundColor: "#D4A843",
          },
        },
        rightPriceScale: {
          borderColor: "#1E2330",
          scaleMargins: { top: 0.1, bottom: 0.15 },
        },
        timeScale: {
          borderColor: "#1E2330",
          timeVisible: true,
          secondsVisible: false,
        },
      });
    } catch (e) {
      console.error("Failed to create chart:", e);
      return;
    }

    chartRef.current = chart;

    try {
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#00E676",
        downColor: "#FF1744",
        borderUpColor: "#00E676",
        borderDownColor: "#FF1744",
        wickUpColor: "#00E676",
        wickDownColor: "#FF1744",
      });

      candleSeries.setData(
        candles.map(c => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })) as CandlestickData<Time>[],
      );

      const closes = candles.map(c => c.close);

      if (showEMA && closes.length > 21) {
        const ema9 = calcEMA(closes, 9);
        const ema21 = calcEMA(closes, 21);

        const ema9Series = chart.addSeries(LineSeries, {
          color: "#FFB300",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        ema9Series.setData(
          candles
            .map((c, i) =>
              ema9[i] !== undefined
                ? { time: c.time as Time, value: ema9[i] }
                : null,
            )
            .filter(Boolean) as { time: Time; value: number }[],
        );

        const ema21Series = chart.addSeries(LineSeries, {
          color: "#29B6F6",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        ema21Series.setData(
          candles
            .map((c, i) =>
              ema21[i] !== undefined
                ? { time: c.time as Time, value: ema21[i] }
                : null,
            )
            .filter(Boolean) as { time: Time; value: number }[],
        );
      }

      if (showBB && closes.length > 20) {
        const bb = calcBollingerBands(closes, 20);
        const bbUpper = chart.addSeries(LineSeries, {
          color: "rgba(212, 168, 67, 0.25)",
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        bbUpper.setData(
          candles
            .map((c, i) =>
              bb.upper[i] !== undefined
                ? { time: c.time as Time, value: bb.upper[i] }
                : null,
            )
            .filter(Boolean) as { time: Time; value: number }[],
        );

        const bbLower = chart.addSeries(LineSeries, {
          color: "rgba(212, 168, 67, 0.25)",
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        bbLower.setData(
          candles
            .map((c, i) =>
              bb.lower[i] !== undefined
                ? { time: c.time as Time, value: bb.lower[i] }
                : null,
            )
            .filter(Boolean) as { time: Time; value: number }[],
        );
      }

      // Volume
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.88, bottom: 0 },
      });
      volumeSeries.setData(
        candles.map(c => ({
          time: c.time as Time,
          value: c.volume,
          color:
            c.close >= c.open
              ? "rgba(0, 230, 118, 0.15)"
              : "rgba(255, 23, 68, 0.15)",
        })),
      );

      chart.timeScale().fitContent();
    } catch (e) {
      console.error("Failed to populate chart:", e);
    }

    const container = containerRef.current;
    const resizeObserver = new ResizeObserver(entries => {
      if (chartRef.current) {
        for (const entry of entries) {
          try {
            chartRef.current.applyOptions({ width: entry.contentRect.width });
          } catch {
            // Chart was removed
          }
        }
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (chartRef.current) {
        try {
          chartRef.current.remove();
        } catch {
          // Already removed
        }
        chartRef.current = null;
      }
    };
  }, [candles, height, showEMA, showBB]);

  // Last candle info
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : null;
  const isUp = lastCandle && prevCandle && lastCandle.close >= prevCandle.close;

  return (
    <div className="flex flex-col rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[#D4A843] tracking-wider">
            {label}
          </span>
          {lastCandle && (
            <span
              className={`text-xs font-mono tabular-nums ${isUp ? "text-[#00E676]" : "text-[#FF1744]"}`}
            >
              {lastCandle.close.toFixed(2)}
            </span>
          )}
        </div>
        {lastCandle && prevCandle && (
          <span
            className={`text-xs font-mono tabular-nums ${isUp ? "text-[#00E676]" : "text-[#FF1744]"}`}
          >
            {isUp ? "▲" : "▼"}{" "}
            {Math.abs(lastCandle.close - prevCandle.close).toFixed(2)}
          </span>
        )}
      </div>
      <div ref={containerRef} className="w-full" style={{ height }} />
    </div>
  );
}
