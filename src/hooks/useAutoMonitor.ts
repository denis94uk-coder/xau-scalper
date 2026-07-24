/**
 * Auto-monitor hook: checks live price every 30s against ACTIVE trading ideas.
 * Aware of partial TP + trailing stops — server engine does the heavy lifting,
 * this is a client-side backup for faster UI feedback.
 */

import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchGoldPrice } from "@/lib/priceApi";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type StatusType = "TP1_HIT" | "TP2_HIT" | "STOPPED";

interface MonitorEvent {
  ideaId: string;
  direction: "LONG" | "SHORT";
  status: StatusType;
  entryPrice: number;
  exitPrice: number;
  pnlPoints: number;
  timestamp: number;
}

const MONITOR_INTERVAL_MS = 30_000; // 30 seconds
const ALERT_SOUND_URL =
  "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbsGczHj+R0NvKdEMtRYS+0dR8RjhEeLS/wJBgUWB3oq2jfVdNYnudoZNxXU9xkqqbiHBcWGR8g3FyZm1nc3Z0a1VLWGVxaW1wdXR+iJOWjHVgWWBqc4CRl5OIe3V2eH2CiY2LhX56eHh6foOLkpOIeXBsb3d+hIqMi4mEfnl5en5+goiNj4yGfXdyc3uDio6Oj4yFfnd1eX+Ei42Ni4V+eXd5f4SMj46LhH54d3l+hIuPj4uFfnh3eX+Ej4+OioR9eHZ5f4WNkI6Kg3x4dnn/";

export function useAutoMonitor() {
  const activeIdeas = useQuery(api.tradingIdeas.listActiveIdeas, {});
  const updateStatus = useMutation(api.tradingIdeas.updateIdeaStatus);

  // Alerts toggle — persisted in localStorage
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("xau-alerts-enabled") === "true";
    } catch {
      return false;
    }
  });

  // Monitor active state
  const [isMonitoring, setIsMonitoring] = useState(true);
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [recentEvents, setRecentEvents] = useState<MonitorEvent[]>([]);

  // Track which ideas we've already processed to avoid duplicate notifications
  const processedRef = useRef<Set<string>>(new Set());

  const toggleAlerts = useCallback((enabled: boolean) => {
    setAlertsEnabled(enabled);
    try {
      localStorage.setItem("xau-alerts-enabled", String(enabled));
    } catch {}

    // Request notification permission when enabling
    if (
      enabled &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission();
    }
  }, []);

  const sendNotification = useCallback(
    (title: string, body: string, isWin: boolean) => {
      if (!alertsEnabled) return;

      // Browser notification
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification(title, {
            body,
            icon: isWin ? "🟢" : "🔴",
            tag: `xau-${Date.now()}`,
          });
        } catch {}
      }

      // In-app toast
      if (isWin) {
        toast.success(title, { description: body, duration: 8000 });
      } else {
        toast.error(title, { description: body, duration: 8000 });
      }

      // Play alert sound
      try {
        const audio = new Audio(ALERT_SOUND_URL);
        audio.volume = 0.3;
        audio.play().catch(() => {});
      } catch {}
    },
    [alertsEnabled],
  );

  const checkIdeas = useCallback(async () => {
    if (!activeIdeas || activeIdeas.length === 0 || !isMonitoring) return;

    try {
      const priceData = await fetchGoldPrice();
      const currentPrice = priceData.price;
      setLastPrice(currentPrice);
      setLastCheck(Date.now());

      for (const idea of activeIdeas) {
        // Skip already processed
        if (processedRef.current.has(idea._id)) continue;

        const isLong = idea.direction === "LONG";
        // Use trailing SL if set, otherwise original SL
        const effectiveSL = idea.trailingSL ?? idea.stopLoss;

        let newStatus: StatusType | null = null;
        let pnl = 0;
        let exitPrice = currentPrice;

        // Check SL (with trailing awareness)
        const slHit = isLong
          ? currentPrice <= effectiveSL
          : currentPrice >= effectiveSL;
        if (slHit) {
          newStatus = "STOPPED";
          pnl = isLong
            ? effectiveSL - idea.entryPrice
            : idea.entryPrice - effectiveSL;
          exitPrice = effectiveSL;
        }

        // Check TP2 (for ideas already at TP1_HIT or gap through)
        if (!newStatus) {
          const tp2Hit = isLong
            ? currentPrice >= idea.tp2
            : currentPrice <= idea.tp2;
          if (tp2Hit) {
            newStatus = "TP2_HIT";
            pnl = isLong
              ? idea.tp2 - idea.entryPrice
              : idea.entryPrice - idea.tp2;
            exitPrice = idea.tp2;
          }
        }

        // Check TP1 (only for ACTIVE status)
        if (!newStatus && idea.status === "ACTIVE") {
          const tp1Hit = isLong
            ? currentPrice >= idea.tp1
            : currentPrice <= idea.tp1;
          if (tp1Hit) {
            newStatus = "TP1_HIT";
            pnl = isLong
              ? idea.tp1 - idea.entryPrice
              : idea.entryPrice - idea.tp1;
            exitPrice = idea.tp1;
          }
        }

        if (newStatus) {
          processedRef.current.add(idea._id);
          const roundedPnl = Math.round(pnl * 100) / 100;

          // Update in database
          await updateStatus({
            id: idea._id as Id<"tradingIdeas">,
            status: newStatus,
            pnlPoints: roundedPnl,
          });

          const event: MonitorEvent = {
            ideaId: idea._id,
            direction: idea.direction,
            status: newStatus,
            entryPrice: idea.entryPrice,
            exitPrice,
            pnlPoints: roundedPnl,
            timestamp: Date.now(),
          };

          setRecentEvents(prev => [event, ...prev].slice(0, 20));

          // Send notification
          const isWin = newStatus === "TP1_HIT" || newStatus === "TP2_HIT";
          const emoji = isWin ? "✅" : "🛑";
          const label =
            newStatus === "TP1_HIT"
              ? "TP1 Hit (SL → BE)"
              : newStatus === "TP2_HIT"
                ? "TP2 Hit (Full Close)"
                : idea.trailingSL
                  ? "Trailing Stop Hit"
                  : "Stop Loss Hit";

          sendNotification(
            `${emoji} ${idea.direction} ${label}`,
            `Entry: ${idea.entryPrice.toFixed(2)} → Exit: ${exitPrice.toFixed(2)} | P&L: ${roundedPnl >= 0 ? "+" : ""}${roundedPnl.toFixed(2)} pts`,
            isWin,
          );
        }
      }
    } catch (e) {
      console.warn("Auto-monitor price check failed:", e);
    }
  }, [activeIdeas, isMonitoring, updateStatus, sendNotification]);

  // Run the monitor loop
  useEffect(() => {
    if (!isMonitoring) return;

    // Initial check after a small delay
    const timeout = setTimeout(() => checkIdeas(), 3000);
    const interval = setInterval(() => checkIdeas(), MONITOR_INTERVAL_MS);

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [checkIdeas, isMonitoring]);

  return {
    alertsEnabled,
    toggleAlerts,
    isMonitoring,
    setIsMonitoring,
    lastCheck,
    lastPrice,
    activeCount: activeIdeas?.length ?? 0,
    recentEvents,
  };
}
