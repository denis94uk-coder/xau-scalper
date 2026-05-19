import { useEffect, useRef, useState } from "react";

interface PriceData {
  price: number;
  bid: number;
  ask: number;
  high24h: number;
  low24h: number;
  change24h: number;
  changePct24h: number;
  timestamp: number;
}

interface PriceTickerProps {
  data: PriceData | null;
  loading?: boolean;
}

export function PriceTicker({ data, loading }: PriceTickerProps) {
  const [flashClass, setFlashClass] = useState("");
  const prevPrice = useRef<number | null>(null);

  useEffect(() => {
    if (data && prevPrice.current !== null) {
      if (data.price > prevPrice.current) {
        setFlashClass("flash-green");
      } else if (data.price < prevPrice.current) {
        setFlashClass("flash-red");
      }
      const t = setTimeout(() => setFlashClass(""), 600);
      return () => clearTimeout(t);
    }
    if (data) prevPrice.current = data.price;
  }, [data]);

  if (loading || !data) {
    return (
      <div className="flex items-center gap-6 p-4 rounded-xl bg-card border border-border animate-pulse">
        <div className="h-12 w-48 bg-muted rounded" />
        <div className="h-8 w-32 bg-muted rounded" />
      </div>
    );
  }

  const isPositive = data.change24h >= 0;
  const spread = data.ask - data.bid;

  return (
    <div
      className={`flex flex-wrap items-center gap-4 sm:gap-6 p-4 rounded-xl bg-card border border-border ${flashClass}`}
    >
      {/* Symbol & Price */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#D4A843] animate-pulse-dot" />
          <span className="text-xs font-medium text-muted-foreground tracking-wider uppercase">
            XAU/USD
          </span>
        </div>
        <span className="text-3xl sm:text-4xl font-bold tabular-nums font-mono tracking-tight">
          {data.price.toFixed(2)}
        </span>
      </div>

      {/* Change */}
      <div className="flex flex-col">
        <span
          className={`text-sm font-semibold tabular-nums font-mono ${isPositive ? "text-[#00E676]" : "text-[#FF1744]"}`}
        >
          {isPositive ? "+" : ""}
          {data.change24h.toFixed(2)} ({isPositive ? "+" : ""}
          {data.changePct24h.toFixed(2)}%)
        </span>
        <span className="text-xs text-muted-foreground">24h Change</span>
      </div>

      {/* Bid / Ask */}
      <div className="flex gap-4 ml-auto">
        <div className="flex flex-col items-center">
          <span className="text-xs text-muted-foreground mb-0.5">BID</span>
          <span className="text-sm font-mono tabular-nums text-[#00E676]">
            {data.bid.toFixed(2)}
          </span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-muted-foreground mb-0.5">ASK</span>
          <span className="text-sm font-mono tabular-nums text-[#FF1744]">
            {data.ask.toFixed(2)}
          </span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-muted-foreground mb-0.5">SPREAD</span>
          <span className="text-sm font-mono tabular-nums text-[#D4A843]">
            {spread.toFixed(2)}
          </span>
        </div>
      </div>

      {/* High / Low */}
      <div className="flex gap-4">
        <div className="flex flex-col items-center">
          <span className="text-xs text-muted-foreground mb-0.5">24H HIGH</span>
          <span className="text-sm font-mono tabular-nums">
            {data.high24h.toFixed(2)}
          </span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-muted-foreground mb-0.5">24H LOW</span>
          <span className="text-sm font-mono tabular-nums">
            {data.low24h.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
