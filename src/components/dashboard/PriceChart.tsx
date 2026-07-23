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
import { useCallback, useEffect, useRef } from "react";
import type { Candle } from "@/lib/indicators";
import { calcBollingerBands, calcEMA } from "@/lib/indicators";

interface PriceChartProps {
  candles: Candle[];
  showEMA?: boolean;
  showBB?: boolean;
  height?: number;
}

export function PriceChart({
  candles,
  showEMA = true,
  showBB = true,
  height = 420,
}: PriceChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const initChart = useCallback(() => {
    if (!chartContainerRef.current) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#6B7280",
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: "rgba(30, 35, 48, 0.6)" },
        horzLines: { color: "rgba(30, 35, 48, 0.6)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(212, 168, 67, 0.3)",
          labelBackgroundColor: "#D4A843",
        },
        horzLine: {
          color: "rgba(212, 168, 67, 0.3)",
          labelBackgroundColor: "#D4A843",
        },
      },
      rightPriceScale: {
        borderColor: "#1E2330",
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: "#1E2330",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    // Candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#00E676",
      downColor: "#FF1744",
      borderUpColor: "#00E676",
      borderDownColor: "#FF1744",
      wickUpColor: "#00E676",
      wickDownColor: "#FF1744",
    });

    const chartData: CandlestickData<Time>[] = candles.map(c => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    candleSeries.setData(chartData);

    const closes = candles.map(c => c.close);

    // EMA overlays
    if (showEMA) {
      const ema9 = calcEMA(closes, 9);
      const ema21 = calcEMA(closes, 21);
      const ema50 = calcEMA(closes, 50);

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

      const ema50Series = chart.addSeries(LineSeries, {
        color: "#AB47BC",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      ema50Series.setData(
        candles
          .map((c, i) =>
            ema50[i] !== undefined
              ? { time: c.time as Time, value: ema50[i] }
              : null,
          )
          .filter(Boolean) as { time: Time; value: number }[],
      );
    }

    // Bollinger Bands
    if (showBB) {
      const bb = calcBollingerBands(closes, 20);

      const bbUpper = chart.addSeries(LineSeries, {
        color: "rgba(212, 168, 67, 0.3)",
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
        color: "rgba(212, 168, 67, 0.3)",
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
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    volumeSeries.setData(
      candles.map(c => ({
        time: c.time as Time,
        value: c.volume,
        color:
          c.close >= c.open
            ? "rgba(0, 230, 118, 0.2)"
            : "rgba(255, 23, 68, 0.2)",
      })),
    );

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [candles, showEMA, showBB, height]);

  useEffect(() => {
    const cleanup = initChart();
    return cleanup;
  }, [initChart]);

  return (
    <div
      ref={chartContainerRef}
      className="w-full rounded-lg overflow-hidden"
      style={{ height }}
    />
  );
}
