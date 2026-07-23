import { useEffect, useState } from "react";

/** Simple open/closed status for each major forex session (UTC-based) */
const SESSIONS = [
  { name: "Sydney", short: "SYD", open: 21, close: 6, color: "#AB47BC" },
  { name: "Tokyo", short: "TKY", open: 0, close: 9, color: "#29B6F6" },
  { name: "London", short: "LDN", open: 7, close: 16, color: "#D4A843" },
  { name: "New York", short: "NY", open: 13, close: 22, color: "#00E676" },
];

function isActive(
  open: number,
  close: number,
  utcHour: number,
  isWeekend: boolean,
) {
  if (isWeekend) return false;
  if (open < close) return utcHour >= open && utcHour < close;
  return utcHour >= open || utcHour < close;
}

export function MarketSessionBar() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay();

  const isWeekendClosed = (() => {
    if (utcDay === 6) return true;
    if (utcDay === 0 && utcHour < 21) return true;
    if (utcDay === 5 && utcHour >= 22) return true;
    return false;
  })();

  return (
    <div className="flex items-center gap-2 sm:gap-4 md:gap-6 px-2 sm:px-3 py-1.5 rounded-lg bg-card/60 border border-border/50 overflow-x-auto min-w-0">
      {SESSIONS.map(s => {
        const active = isActive(s.open, s.close, utcHour, isWeekendClosed);
        return (
          <div
            key={s.name}
            className="flex items-center gap-1 sm:gap-1.5 shrink-0"
          >
            <div
              className={`w-1.5 h-1.5 rounded-full ${active ? "animate-pulse-dot" : "opacity-25"}`}
              style={{ backgroundColor: s.color }}
            />
            {/* Full name on sm+, short name on mobile */}
            <span
              className={`text-[10px] sm:text-[11px] font-medium ${active ? "text-foreground" : "text-muted-foreground/50"}`}
            >
              <span className="hidden sm:inline">{s.name}</span>
              <span className="sm:hidden">{s.short}</span>
            </span>
            <span
              className={`text-[9px] sm:text-[10px] font-mono ${active ? "text-[#00E676]" : "text-muted-foreground/30"}`}
            >
              {active ? "OPEN" : "CLOSED"}
            </span>
          </div>
        );
      })}

      <div className="ml-auto shrink-0">
        <span className="text-[10px] sm:text-[11px] font-mono tabular-nums text-muted-foreground/60">
          {now.getUTCHours().toString().padStart(2, "0")}:
          {now.getUTCMinutes().toString().padStart(2, "0")}:
          {now.getUTCSeconds().toString().padStart(2, "0")} UTC
        </span>
      </div>
    </div>
  );
}
