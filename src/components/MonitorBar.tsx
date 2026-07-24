/**
 * Floating monitor status bar — shows auto-monitor state, alerts toggle,
 * and recent trigger events. Sits at bottom-right of the screen.
 */

import {
  Activity,
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";
import { useState } from "react";
import { useAutoMonitor } from "@/hooks/useAutoMonitor";

export function MonitorBar() {
  const {
    alertsEnabled,
    toggleAlerts,
    isMonitoring,
    setIsMonitoring,
    lastCheck,
    lastPrice,
    activeCount,
    recentEvents,
  } = useAutoMonitor();

  const [expanded, setExpanded] = useState(false);

  const lastCheckStr = lastCheck
    ? new Date(lastCheck).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {/* Expanded event log */}
      {expanded && recentEvents.length > 0 && (
        <div className="w-80 max-h-60 overflow-y-auto rounded-xl bg-[#0D1117] border border-border shadow-2xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-[10px] font-mono text-muted-foreground tracking-wider uppercase">
              Recent Triggers
            </span>
            <button
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="flex flex-col">
            {recentEvents.map((ev, i) => {
              const isWin = ev.status === "TP1_HIT" || ev.status === "TP2_HIT";
              const time = new Date(ev.timestamp).toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
              });
              return (
                <div
                  key={i}
                  className="flex items-center gap-2 px-3 py-2 border-b border-border/30 last:border-0"
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: isWin ? "#00E676" : "#FF1744",
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="text-[10px] font-mono font-bold"
                        style={{
                          color:
                            ev.direction === "LONG" ? "#00E676" : "#FF1744",
                        }}
                      >
                        {ev.direction}
                      </span>
                      <span
                        className="text-[10px] font-mono font-bold px-1 rounded"
                        style={{
                          color: isWin ? "#00E676" : "#FF1744",
                          backgroundColor: isWin
                            ? "rgba(0,230,118,0.1)"
                            : "rgba(255,23,68,0.1)",
                        }}
                      >
                        {ev.status === "TP1_HIT"
                          ? "TP1 ✓"
                          : ev.status === "TP2_HIT"
                            ? "TP2 ✓✓"
                            : "STOPPED"}
                      </span>
                    </div>
                    <span className="text-[9px] text-muted-foreground/60 font-mono">
                      {ev.entryPrice.toFixed(2)} → {ev.exitPrice.toFixed(2)} |{" "}
                      <span
                        style={{
                          color: ev.pnlPoints >= 0 ? "#00E676" : "#FF1744",
                        }}
                      >
                        {ev.pnlPoints >= 0 ? "+" : ""}
                        {ev.pnlPoints.toFixed(2)} pts
                      </span>
                    </span>
                  </div>
                  <span className="text-[9px] text-muted-foreground/40 font-mono flex-shrink-0">
                    {time}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Main bar */}
      <div className="flex items-center gap-1.5 rounded-xl bg-[#0D1117] border border-border shadow-2xl px-3 py-2">
        {/* Monitor status */}
        <button
          onClick={() => setIsMonitoring(!isMonitoring)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono font-medium transition-colors ${
            isMonitoring
              ? "bg-[#00E676]/10 text-[#00E676]"
              : "bg-secondary/30 text-muted-foreground"
          }`}
          title={
            isMonitoring
              ? "Auto-monitor ON — click to pause"
              : "Auto-monitor OFF — click to resume"
          }
        >
          <Activity className="w-3 h-3" />
          <span className={isMonitoring ? "animate-pulse" : ""}>
            {isMonitoring ? "LIVE" : "PAUSED"}
          </span>
        </button>

        {/* Divider */}
        <div className="w-px h-4 bg-border" />

        {/* Active ideas count */}
        <div className="flex items-center gap-1 px-1.5 text-[10px] font-mono text-muted-foreground">
          <span className="text-[#D4A843] font-bold">{activeCount}</span>
          <span>active</span>
        </div>

        {/* Last price */}
        {lastPrice && (
          <>
            <div className="w-px h-4 bg-border" />
            <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
              {lastPrice.toFixed(2)}
            </span>
          </>
        )}

        {/* Last check time */}
        <div className="w-px h-4 bg-border" />
        <span className="text-[9px] font-mono text-muted-foreground/50">
          {lastCheckStr}
        </span>

        {/* Alerts toggle */}
        <div className="w-px h-4 bg-border" />
        <button
          onClick={() => toggleAlerts(!alertsEnabled)}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-mono font-medium transition-colors ${
            alertsEnabled
              ? "bg-[#D4A843]/10 text-[#D4A843]"
              : "bg-secondary/30 text-muted-foreground"
          }`}
          title={
            alertsEnabled
              ? "Alerts ON — click to mute"
              : "Alerts OFF — click to enable"
          }
        >
          {alertsEnabled ? (
            <Bell className="w-3 h-3" />
          ) : (
            <BellOff className="w-3 h-3" />
          )}
          <span>{alertsEnabled ? "ON" : "OFF"}</span>
        </button>

        {/* Expand/collapse recent events */}
        {recentEvents.length > 0 && (
          <>
            <div className="w-px h-4 bg-border" />
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 px-1.5 py-1 rounded-lg text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
              title="Recent triggers"
            >
              <span className="text-[#D4A843] font-bold">
                {recentEvents.length}
              </span>
              {expanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronUp className="w-3 h-3" />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
