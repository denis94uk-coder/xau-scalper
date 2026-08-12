import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

interface TimezoneContextValue {
  timezone: string;
  setTimezone: (tz: string) => void;
  /** Format a Date or timestamp to the user's timezone */
  formatTime: (
    date: Date | number,
    opts?: Intl.DateTimeFormatOptions,
  ) => string;
  /** Format a Date or timestamp to short time HH:MM */
  formatShortTime: (date: Date | number) => string;
  /** Format a Date or timestamp to full date+time */
  formatDateTime: (date: Date | number) => string;
  /** Get the timezone abbreviation (e.g. "GMT", "EST") */
  tzAbbrev: string;
  /** Get current hours as decimal in user timezone */
  getCurrentHourDecimal: () => number;
}

const STORAGE_KEY = "xau-vf-timezone";

function detectDefaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

const TimezoneContext = createContext<TimezoneContextValue | null>(null);

export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezoneState] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return stored;
    } catch {}
    return detectDefaultTimezone();
  });

  const setTimezone = (tz: string) => {
    setTimezoneState(tz);
    try {
      localStorage.setItem(STORAGE_KEY, tz);
    } catch {}
  };

  // Get abbreviation
  const [tzAbbrev, setTzAbbrev] = useState("");
  useEffect(() => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        timeZoneName: "short",
      }).formatToParts(new Date());
      const tzPart = parts.find(p => p.type === "timeZoneName");
      setTzAbbrev(tzPart?.value || timezone);
    } catch {
      setTzAbbrev(timezone);
    }
  }, [timezone]);

  const formatTime = (
    date: Date | number,
    opts?: Intl.DateTimeFormatOptions,
  ) => {
    const d = typeof date === "number" ? new Date(date) : date;
    return d.toLocaleTimeString("en-GB", { timeZone: timezone, ...opts });
  };

  const formatShortTime = (date: Date | number) => {
    const d = typeof date === "number" ? new Date(date) : date;
    return d.toLocaleTimeString("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDateTime = (date: Date | number) => {
    const d = typeof date === "number" ? new Date(date) : date;
    return d.toLocaleString("en-GB", {
      timeZone: timezone,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getCurrentHourDecimal = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const h = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
    const m = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
    return h + m / 60;
  };

  return (
    <TimezoneContext.Provider
      value={{
        timezone,
        setTimezone,
        formatTime,
        formatShortTime,
        formatDateTime,
        tzAbbrev,
        getCurrentHourDecimal,
      }}
    >
      {children}
    </TimezoneContext.Provider>
  );
}

export function useTimezone() {
  const ctx = useContext(TimezoneContext);
  if (!ctx) throw new Error("useTimezone must be used within TimezoneProvider");
  return ctx;
}

/** Common timezone options for trading */
export const TRADING_TIMEZONES = [
  { value: "UTC", label: "UTC", group: "Standard" },
  { value: "Europe/London", label: "London (GMT/BST)", group: "Europe" },
  { value: "Europe/Paris", label: "Paris (CET/CEST)", group: "Europe" },
  { value: "Europe/Berlin", label: "Berlin (CET/CEST)", group: "Europe" },
  { value: "Europe/Zurich", label: "Zurich (CET/CEST)", group: "Europe" },
  { value: "Europe/Moscow", label: "Moscow (MSK)", group: "Europe" },
  { value: "America/New_York", label: "New York (EST/EDT)", group: "Americas" },
  { value: "America/Chicago", label: "Chicago (CST/CDT)", group: "Americas" },
  { value: "America/Denver", label: "Denver (MST/MDT)", group: "Americas" },
  {
    value: "America/Los_Angeles",
    label: "Los Angeles (PST/PDT)",
    group: "Americas",
  },
  { value: "America/Toronto", label: "Toronto (EST/EDT)", group: "Americas" },
  { value: "America/Sao_Paulo", label: "São Paulo (BRT)", group: "Americas" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)", group: "Asia/Pacific" },
  { value: "Asia/Shanghai", label: "Shanghai (CST)", group: "Asia/Pacific" },
  { value: "Asia/Hong_Kong", label: "Hong Kong (HKT)", group: "Asia/Pacific" },
  { value: "Asia/Singapore", label: "Singapore (SGT)", group: "Asia/Pacific" },
  { value: "Asia/Dubai", label: "Dubai (GST)", group: "Asia/Pacific" },
  { value: "Asia/Kolkata", label: "Mumbai (IST)", group: "Asia/Pacific" },
  {
    value: "Australia/Sydney",
    label: "Sydney (AEST/AEDT)",
    group: "Asia/Pacific",
  },
  {
    value: "Pacific/Auckland",
    label: "Auckland (NZST/NZDT)",
    group: "Asia/Pacific",
  },
  { value: "Africa/Lagos", label: "Lagos (WAT)", group: "Africa" },
  {
    value: "Africa/Johannesburg",
    label: "Johannesburg (SAST)",
    group: "Africa",
  },
  { value: "Africa/Cairo", label: "Cairo (EET)", group: "Africa" },
] as const;
