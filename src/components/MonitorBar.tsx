/**
 * Engine status bar — bottom-right.
 *
 * Reports what the SERVER is doing, rather than running a second monitor in the
 * browser as the previous version did. The server checks open positions every
 * minute whether or not a tab is open, so a client-side loop was both redundant
 * and misleading: it made monitoring look dependent on the page being visible.
 *
 * Recent exits come from the journal, which is the same record the engine
 * writes — so what is shown here is what actually happened, not a parallel
 * client-side reconstruction of it.
 */

import { Activity, ChevronDown, ChevronUp, WifiOff, X } from "lucide-react";
import { useState } from "react";
import { useConnection, useLive } from "@/hooks/useLive";
import { api } from "@/lib/api";

const EXIT_EVENTS = new Set(["TP1_HIT", "TP2_HIT", "SL_HIT"]);

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function MonitorBar() {
  const [expanded, setExpanded] = useState(false);
  const connected = useConnection();

  const health = useLive(() => api.health(), ["engine", "ideas"]);
  const journal = useLive(
    () => api.journal({ limit: 50 }).then(r => r.entries),
    ["journal", "ideas"],
  );

  const recentExits = (journal ?? [])
    .filter(e => EXIT_EVENTS.has(e.eventType))
    .slice(0, 12);

  const lastCheck = health?.lastMonitorRun;
  const activeCount = health?.openIdeas ?? 0;

  // The engine is only "live" if the stream is up AND it has actually run
  // recently — a connected socket alone says nothing about the loop.
  const stale =
    lastCheck !== null && lastCheck !== undefined
      ? Date.now() - lastCheck > 3 * 60_000
      : true;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {expanded && recentExits.length > 0 && (
        <div className="w-80 max-h-60 overflow-y-auto rounded-xl bg-[#0D1117] border border-border shadow-2xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-[10px] font-mono text-muted-foreground tracking-wider uppercase">
              Recent exits
            </span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="flex flex-col">
            {recentExits.map(ev => {
              const isWin =
                ev.eventType === "TP1_HIT" || ev.eventType === "TP2_HIT";
              return (
                <div
                  key={ev.id}
                  className="flex items-start gap-2 px-3 py-2 border-b border-border/50 last:border-0"
                >
                  <span
                    className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                      isWin ? "bg-emerald-500" : "bg-rose-500"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] font-mono font-medium">
                        {ev.asset} {ev.eventType.replace("_", " ")}
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                        {timeOf(ev.timestamp)}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {ev.details}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-full bg-[#0D1117] border border-border px-3 py-1.5 shadow-2xl">
        {connected && !stale ? (
          <Activity className="w-3.5 h-3.5 text-emerald-500" />
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-amber-500" />
        )}

        <span className="text-[10px] font-mono text-muted-foreground">
          {!connected
            ? "disconnected"
            : stale
              ? "engine idle"
              : `${activeCount} open`}
        </span>

        {lastCheck ? (
          <span className="text-[10px] font-mono text-muted-foreground/60">
            {timeOf(lastCheck)}
          </span>
        ) : null}

        {recentExits.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? "Collapse exits" : "Expand exits"}
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronUp className="w-3 h-3" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
