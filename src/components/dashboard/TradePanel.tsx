import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Trade {
  id: string;
  type: "BUY" | "SELL";
  entryPrice: number;
  exitPrice?: number;
  lotSize: number;
  stopLoss?: number;
  takeProfit?: number;
  pnl?: number;
  status: "OPEN" | "CLOSED";
  notes?: string;
  openedAt: number;
  closedAt?: number;
}

interface TradePanelProps {
  currentPrice: number;
}

const STORAGE_KEY = "xau-scalper-trades";

function loadTrades(): Trade[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveTrades(trades: Trade[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
}

export function TradePanel({ currentPrice }: TradePanelProps) {
  const [trades, setTrades] = useState<Trade[]>(loadTrades);
  const [lotSize, setLotSize] = useState("0.01");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [notes, setNotes] = useState("");

  // Persist trades to localStorage
  useEffect(() => {
    saveTrades(trades);
  }, [trades]);

  const openTrades = trades.filter(t => t.status === "OPEN");
  const recentClosed = trades
    .filter(t => t.status === "CLOSED")
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, 5);

  const handleOpen = useCallback(
    (type: "BUY" | "SELL") => {
      const trade: Trade = {
        id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        entryPrice: currentPrice,
        lotSize: Number.parseFloat(lotSize) || 0.01,
        stopLoss: stopLoss ? Number.parseFloat(stopLoss) : undefined,
        takeProfit: takeProfit ? Number.parseFloat(takeProfit) : undefined,
        notes: notes || undefined,
        status: "OPEN",
        openedAt: Date.now(),
      };
      setTrades(prev => [trade, ...prev]);
      toast.success(`${type} order opened at ${currentPrice.toFixed(2)}`);
      setNotes("");
    },
    [currentPrice, lotSize, stopLoss, takeProfit, notes],
  );

  const handleClose = useCallback(
    (tradeId: string) => {
      setTrades(prev =>
        prev.map(t => {
          if (t.id !== tradeId || t.status === "CLOSED") return t;
          const pips =
            t.type === "BUY"
              ? currentPrice - t.entryPrice
              : t.entryPrice - currentPrice;
          return {
            ...t,
            exitPrice: currentPrice,
            pnl: pips * t.lotSize * 100,
            status: "CLOSED" as const,
            closedAt: Date.now(),
          };
        }),
      );
      toast.success(`Trade closed at ${currentPrice.toFixed(2)}`);
    },
    [currentPrice],
  );

  const handleDelete = useCallback((tradeId: string) => {
    setTrades(prev => prev.filter(t => t.id !== tradeId));
    toast.success("Trade deleted");
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4 rounded-xl bg-card border border-border">
      <div className="text-xs font-medium text-muted-foreground tracking-wider uppercase">
        Quick Trade
      </div>

      {/* Lot Size & SL/TP */}
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Lot Size</span>
          <Input
            type="number"
            step="0.01"
            min="0.01"
            value={lotSize}
            onChange={e => setLotSize(e.target.value)}
            className="h-8 text-xs font-mono bg-secondary border-border"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Stop Loss</span>
          <Input
            type="number"
            step="0.1"
            placeholder={`${(currentPrice - 5).toFixed(1)}`}
            value={stopLoss}
            onChange={e => setStopLoss(e.target.value)}
            className="h-8 text-xs font-mono bg-secondary border-border"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Take Profit</span>
          <Input
            type="number"
            step="0.1"
            placeholder={`${(currentPrice + 5).toFixed(1)}`}
            value={takeProfit}
            onChange={e => setTakeProfit(e.target.value)}
            className="h-8 text-xs font-mono bg-secondary border-border"
          />
        </div>
      </div>

      {/* Notes */}
      <Input
        placeholder="Trade notes (optional)"
        value={notes}
        onChange={e => setNotes(e.target.value)}
        className="h-8 text-xs bg-secondary border-border"
      />

      {/* Buy / Sell buttons */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={() => handleOpen("BUY")}
          className="bg-[#00E676] hover:bg-[#00C853] text-black font-bold text-sm h-10"
        >
          BUY
          <span className="text-xs font-normal ml-1 opacity-80">
            {currentPrice.toFixed(2)}
          </span>
        </Button>
        <Button
          onClick={() => handleOpen("SELL")}
          className="bg-[#FF1744] hover:bg-[#D50000] text-white font-bold text-sm h-10"
        >
          SELL
          <span className="text-xs font-normal ml-1 opacity-80">
            {currentPrice.toFixed(2)}
          </span>
        </Button>
      </div>

      {/* Open Trades */}
      {openTrades.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          <div className="text-xs font-medium text-muted-foreground tracking-wider uppercase">
            Open Positions ({openTrades.length})
          </div>
          {openTrades.map(trade => {
            const unrealized =
              trade.type === "BUY"
                ? (currentPrice - trade.entryPrice) * trade.lotSize * 100
                : (trade.entryPrice - currentPrice) * trade.lotSize * 100;
            const isProfit = unrealized >= 0;

            return (
              <div
                key={trade.id}
                className="flex items-center justify-between p-2 rounded-lg bg-secondary/50 border border-border"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-bold font-mono ${
                      trade.type === "BUY" ? "text-[#00E676]" : "text-[#FF1744]"
                    }`}
                  >
                    {trade.type}
                  </span>
                  <span className="text-xs font-mono tabular-nums text-muted-foreground">
                    {trade.lotSize} @ {trade.entryPrice.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-mono tabular-nums font-semibold ${
                      isProfit ? "text-[#00E676]" : "text-[#FF1744]"
                    }`}
                  >
                    {isProfit ? "+" : ""}
                    {unrealized.toFixed(2)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs px-2 border-border hover:bg-destructive/20 hover:text-destructive"
                    onClick={() => handleClose(trade.id)}
                  >
                    Close
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent Closed */}
      {recentClosed.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          <div className="text-xs font-medium text-muted-foreground tracking-wider uppercase">
            Recent Trades
          </div>
          {recentClosed.map(trade => (
            <div
              key={trade.id}
              className="flex items-center justify-between p-2 rounded-lg bg-secondary/30"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs font-mono ${
                    trade.type === "BUY"
                      ? "text-[#00E676]/60"
                      : "text-[#FF1744]/60"
                  }`}
                >
                  {trade.type}
                </span>
                <span className="text-xs font-mono tabular-nums text-muted-foreground">
                  {trade.entryPrice.toFixed(2)} → {trade.exitPrice?.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs font-mono tabular-nums font-semibold ${
                    (trade.pnl ?? 0) >= 0 ? "text-[#00E676]" : "text-[#FF1744]"
                  }`}
                >
                  {(trade.pnl ?? 0) >= 0 ? "+" : ""}
                  {(trade.pnl ?? 0).toFixed(2)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(trade.id)}
                >
                  ×
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
