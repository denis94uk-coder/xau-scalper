import {
  ColorType,
  createChart,
  type IChartApi,
  LineSeries,
  type Time,
} from "lightweight-charts";
import { useCallback, useEffect, useRef } from "react";
import type { Candle } from "@/lib/indicators";
import { calcRSI } from "@/lib/indicators";

interface RSIChartProps {
  candles: Candle[];
  height?: number;
}

export function RSIChart({ candles, height = 120 }: RSIChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const initChart = useCallback(() => {
    if (!containerRef.current) return;
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(containerRef.current, {
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
      rightPriceScale: {
        borderColor: "#1E2330",
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      timeScale: {
        borderColor: "#1E2330",
        timeVisible: true,
        visible: false,
      },
      crosshair: {
        vertLine: { visible: false },
        horzLine: {
          color: "rgba(212, 168, 67, 0.3)",
          labelBackgroundColor: "#D4A843",
        },
      },
    });

    chartRef.current = chart;

    const closes = candles.map(c => c.close);
    const rsi = calcRSI(closes, 14);

    // RSI Line
    const rsiSeries = chart.addSeries(LineSeries, {
      color: "#D4A843",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    rsiSeries.setData(
      candles
        .map((c, i) =>
          rsi[i] !== undefined ? { time: c.time as Time, value: rsi[i] } : null,
        )
        .filter(Boolean) as { time: Time; value: number }[],
    );

    // Overbought / Oversold lines
    const ob = chart.addSeries(LineSeries, {
      color: "rgba(255, 23, 68, 0.3)",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ob.setData(
      candles
        .filter((_, i) => rsi[i] !== undefined)
        .map(c => ({ time: c.time as Time, value: 70 })),
    );

    const os = chart.addSeries(LineSeries, {
      color: "rgba(0, 230, 118, 0.3)",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    os.setData(
      candles
        .filter((_, i) => rsi[i] !== undefined)
        .map(c => ({ time: c.time as Time, value: 30 })),
    );

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [candles, height]);

  useEffect(() => {
    const cleanup = initChart();
    return cleanup;
  }, [initChart]);

  return (
    <div className="flex flex-col gap-1 p-3 rounded-xl bg-card border border-border">
      <div className="text-xs font-medium text-muted-foreground tracking-wider uppercase px-1">
        RSI (14)
      </div>
      <div
        ref={containerRef}
        className="w-full rounded overflow-hidden"
        style={{ height }}
      />
    </div>
  );
}
