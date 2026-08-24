import { useEffect, useState } from "react";
import { useTimezone } from "@/contexts/TimezoneContext";
import { getSession, type SessionInfo } from "@/lib/indicators";

/** Sessions defined in UTC hours — the underlying logic always uses UTC */
const SESSIONS_UTC = [
  {
    name: "ASIAN",
    label: "Asian",
    start: 0,
    end: 8,
    color: "#EF4444",
    noTrade: true,
  },
  {
    name: "LONDON",
    label: "London",
    start: 8,
    end: 13.5,
    color: "#F59E0B",
    kzStart: 8,
    kzEnd: 9.5,
  },
  {
    name: "NEW_YORK",
    label: "New York",
    start: 13.5,
    end: 21,
    color: "#10B981",
    kzStart: 13.5,
    kzEnd: 15,
  },
  {
    name: "OFF_HOURS",
    label: "Off-Hours",
    start: 21,
    end: 24,
    color: "#6B7280",
  },
] as const;

/** Convert a UTC hour to the user's timezone offset (in hours) */
function utcToLocalHour(utcH: number, offsetMinutes: number): number {
  let local = utcH + offsetMinutes / 60;
  if (local < 0) local += 24;
  if (local >= 24) local -= 24;
  return local;
}

/** Get the offset in minutes from UTC for a given timezone */
function getTimezoneOffsetMinutes(tz: string): number {
  const now = new Date();
  const utcParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(now);

  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(now);

  const get = (parts: Intl.DateTimeFormatPart[], type: string) =>
    parseInt(parts.find(p => p.type === type)?.value || "0", 10);

  const utcMinutes =
    get(utcParts, "day") * 24 * 60 +
    get(utcParts, "hour") * 60 +
    get(utcParts, "minute");
  const tzMinutes =
    get(tzParts, "day") * 24 * 60 +
    get(tzParts, "hour") * 60 +
    get(tzParts, "minute");

  let diff = tzMinutes - utcMinutes;
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return diff;
}

/** Format hour decimal as HH:MM */
function fmtH(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h % 1) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function SessionBar() {
  const [session, setSession] = useState<SessionInfo>(getSession(Date.now()));
  const { timezone, formatShortTime, tzAbbrev } = useTimezone();

  useEffect(() => {
    const id = setInterval(() => setSession(getSession(Date.now())), 30000);
    return () => clearInterval(id);
  }, []);

  const now = new Date();
  const offsetMin = getTimezoneOffsetMinutes(timezone);

  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const localH = utcToLocalHour(utcH, offsetMin);
  const progress = (localH / 24) * 100;

  const localSessions = SESSIONS_UTC.map(s => {
    const start = utcToLocalHour(s.start, offsetMin);
    const end = utcToLocalHour(s.end, offsetMin);
    const kzStart =
      "kzStart" in s
        ? utcToLocalHour(s.kzStart as number, offsetMin)
        : undefined;
    const kzEnd =
      "kzEnd" in s ? utcToLocalHour(s.kzEnd as number, offsetMin) : undefined;
    return { ...s, start, end, kzStart, kzEnd };
  });

  const sortedSessions = [...localSessions].sort((a, b) => a.start - b.start);

  const segments = sortedSessions.map(s => {
    const duration = s.end >= s.start ? s.end - s.start : 24 - s.start + s.end;
    const left = (s.start / 24) * 100;
    const width = (duration / 24) * 100;
    return { ...s, left, width, duration };
  });

  const londonKz = localSessions.find(s => s.name === "LONDON");
  const nyKz = localSessions.find(s => s.name === "NEW_YORK");
  const asianSess = localSessions.find(s => s.name === "ASIAN");

  return (
    <div className="rounded-xl border border-border bg-card p-2 sm:p-3">
      {/* Header — stacks on very small screens */}
      <div className="flex flex-wrap items-center justify-between gap-1 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium text-muted-foreground tracking-wider uppercase">
            Kill Zones
          </span>
          {session.isNoTrade ? (
            <span className="text-xs font-bold font-mono px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/25 animate-pulse-dot">
              ⛔ NO TRADE — ASIAN
            </span>
          ) : (
            <span
              className="text-xs font-bold font-mono px-2 py-0.5 rounded"
              style={{
                color: session.isKillZone ? "#FFD600" : "var(--foreground)",
                backgroundColor: session.isKillZone
                  ? "rgba(255,214,0,0.12)"
                  : "rgba(255,255,255,0.05)",
              }}
            >
              {session.label}
            </span>
          )}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          {formatShortTime(now)} {tzAbbrev}
        </span>
      </div>

      {/* Session timeline bar */}
      <div className="relative h-5 rounded-lg overflow-hidden bg-secondary/20 border border-border/30">
        {segments.map(s => {
          const isActive = s.name === session.name;
          const bg =
            s.name === "ASIAN"
              ? `repeating-linear-gradient(45deg, ${s.color}33, ${s.color}33 3px, transparent 3px, transparent 7px)`
              : `${s.color}${isActive ? "30" : "12"}`;
          const labelColor =
            s.name === "ASIAN"
              ? "#F87171"
              : isActive
                ? s.color
                : `${s.color}80`;
          if (s.end < s.start) {
            const w1 = ((24 - s.start) / 24) * 100;
            const w2 = (s.end / 24) * 100;
            return (
              <div key={s.name}>
                <div
                  className="absolute top-0 h-full flex items-center justify-center transition-opacity"
                  style={{
                    left: `${(s.start / 24) * 100}%`,
                    width: `${w1}%`,
                    background: bg,
                    borderRight: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <span
                    className="text-[7px] sm:text-[8px] font-mono font-bold tracking-wider truncate px-0.5"
                    style={{ color: labelColor }}
                  >
                    {s.label}
                  </span>
                </div>
                <div
                  className="absolute top-0 h-full transition-opacity"
                  style={{
                    left: "0%",
                    width: `${w2}%`,
                    background: bg,
                    borderRight: "1px solid rgba(255,255,255,0.06)",
                  }}
                />
              </div>
            );
          }
          return (
            <div
              key={s.name}
              className="absolute top-0 h-full flex items-center justify-center transition-opacity"
              style={{
                left: `${s.left}%`,
                width: `${s.width}%`,
                background: bg,
                borderRight: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span
                className="text-[7px] sm:text-[8px] font-mono font-bold tracking-wider truncate px-0.5"
                style={{ color: labelColor }}
              >
                {s.label}
              </span>
            </div>
          );
        })}

        {/* Kill zone highlights */}
        {segments
          .filter(s => s.kzStart !== undefined && s.kzEnd !== undefined)
          .map(s => {
            const kzS = s.kzStart!;
            const kzE = s.kzEnd!;
            const kzDuration = kzE >= kzS ? kzE - kzS : 24 - kzS + kzE;
            return (
              <div
                key={`kz-${s.name}`}
                className="absolute top-0 h-full pointer-events-none"
                style={{
                  left: `${(kzS / 24) * 100}%`,
                  width: `${(kzDuration / 24) * 100}%`,
                  background: `repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,214,0,0.06) 2px, rgba(255,214,0,0.06) 4px)`,
                  borderTop: "2px solid rgba(255,214,0,0.4)",
                }}
              />
            );
          })}

        {/* Current time marker */}
        <div
          className="absolute top-0 h-full w-0.5 z-10"
          style={{ left: `${progress}%`, backgroundColor: "#00E5FF" }}
        >
          <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-[#00E5FF]" />
        </div>
      </div>

      {/* Kill zone legend — wraps on mobile */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
        <div className="flex items-center gap-1">
          <div
            className="w-2 h-2 rounded-sm"
            style={{
              background:
                "repeating-linear-gradient(45deg, rgba(239,68,68,0.5), rgba(239,68,68,0.5) 2px, transparent 2px, transparent 4px)",
            }}
          />
          <span className="text-[8px] text-muted-foreground">NO TRADE</span>
        </div>
        <div className="flex items-center gap-1">
          <div
            className="w-2 h-2 rounded-sm"
            style={{ backgroundColor: "rgba(255,214,0,0.4)" }}
          />
          <span className="text-[8px] text-muted-foreground">Kill Zone</span>
        </div>
        <span className="text-[8px] text-muted-foreground">
          Asian:{" "}
          {asianSess ? `${fmtH(asianSess.start)}–${fmtH(asianSess.end)}` : "—"}{" "}
          · London KZ:{" "}
          {londonKz
            ? `${fmtH(londonKz.kzStart!)}–${fmtH(londonKz.kzEnd!)}`
            : "—"}{" "}
          · NY KZ: {nyKz ? `${fmtH(nyKz.kzStart!)}–${fmtH(nyKz.kzEnd!)}` : "—"}{" "}
          UTC
        </span>
        {session.isNoTrade ? (
          <span className="text-[8px] text-red-400/80 sm:ml-auto">
            ⛔ Asian session — no-trade zone, wait for London open
          </span>
        ) : session.isKillZone ? (
          <span className="text-[8px] text-[#FFD600]/90 sm:ml-auto">
            ✓ {session.kzLabel} — prime entry window
          </span>
        ) : (
          <span className="text-[8px] text-yellow-500/70 sm:ml-auto">
            ⚠ Outside kill zone — best entries at London/NY open
          </span>
        )}
      </div>
    </div>
  );
}
