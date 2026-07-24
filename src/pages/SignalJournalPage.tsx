import { useQuery } from "convex/react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  ScrollText,
} from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

const EVENT_CONFIG: Record<
  string,
  { color: string; bg: string; icon: typeof Bot }
> = {
  SIGNAL_GENERATED: { color: "text-cyan-400", bg: "bg-cyan-500/10", icon: Bot },
  ENTRY_TRIGGERED: {
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    icon: ArrowUpRight,
  },
  TP1_HIT: {
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    icon: ArrowUpRight,
  },
  TP2_HIT: {
    color: "text-green-300",
    bg: "bg-green-500/10",
    icon: ArrowUpRight,
  },
  SL_HIT: { color: "text-red-400", bg: "bg-red-500/10", icon: AlertTriangle },
  EXPIRED: { color: "text-gray-400", bg: "bg-gray-500/10", icon: Activity },
  ENGINE_RUN: {
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    icon: Activity,
  },
  MONITOR_CHECK: {
    color: "text-purple-400",
    bg: "bg-purple-500/10",
    icon: Activity,
  },
};

export function SignalJournalPage() {
  const journal = useQuery(api.signalJournal.list, { limit: 500 });
  const counts = useQuery(api.signalJournal.countByType, {});
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [showEngine, setShowEngine] = useState(false);

  if (!journal) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading journal...
      </div>
    );
  }

  let filtered = journal;
  if (typeFilter !== "ALL") {
    filtered = filtered.filter(e => e.eventType === typeFilter);
  }
  if (!showEngine) {
    filtered = filtered.filter(
      e => e.eventType !== "ENGINE_RUN" && e.eventType !== "MONITOR_CHECK",
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <ScrollText className="w-5 h-5 text-[#D4A843]" />
          Signal Journal
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Full audit trail of every signal the engine generates
        </p>
      </div>

      {/* Stats */}
      {counts && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <JStatCard
            label="Signals Generated"
            value={counts.SIGNAL_GENERATED ?? 0}
            color="text-cyan-400"
          />
          <JStatCard
            label="TP Hits"
            value={(counts.TP1_HIT ?? 0) + (counts.TP2_HIT ?? 0)}
            color="text-emerald-400"
          />
          <JStatCard
            label="SL Hits"
            value={counts.SL_HIT ?? 0}
            color="text-red-400"
          />
          <JStatCard
            label="Engine Runs"
            value={counts.ENGINE_RUN ?? 0}
            color="text-yellow-400"
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex gap-1 bg-[#12141A] rounded-lg p-0.5 border border-white/5">
          {[
            "ALL",
            "SIGNAL_GENERATED",
            "TP1_HIT",
            "TP2_HIT",
            "SL_HIT",
            "ENGINE_RUN",
          ].map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                typeFilter === t
                  ? "bg-white/10 text-white font-medium"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              {t === "ALL" ? "All" : t.replace(/_/g, " ")}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto cursor-pointer">
          <input
            type="checkbox"
            checked={showEngine}
            onChange={e => setShowEngine(e.target.checked)}
            className="rounded border-white/20"
          />
          Show engine runs
        </label>
      </div>

      {/* Journal Entries */}
      <div className="space-y-0.5">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <ScrollText className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>No journal entries yet</p>
            <p className="text-xs mt-1">
              The engine generates entries every 15 minutes during market hours
            </p>
          </div>
        ) : (
          filtered.map(entry => {
            const cfg =
              EVENT_CONFIG[entry.eventType] ?? EVENT_CONFIG.ENGINE_RUN;
            const EventIcon = cfg.icon;

            return (
              <div
                key={entry._id}
                className={`flex items-start gap-3 px-3 py-2 rounded-lg ${cfg.bg} border border-white/5`}
              >
                {/* Icon */}
                <div className="mt-0.5">
                  <EventIcon className={`w-4 h-4 ${cfg.color}`} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${cfg.color}`}>
                      {entry.eventType.replace(/_/g, " ")}
                    </span>
                    {entry.direction && (
                      <span
                        className={`text-[10px] px-1.5 py-0 rounded ${
                          entry.direction === "LONG"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {entry.direction}
                      </span>
                    )}
                    {entry.price && (
                      <span className="text-xs font-mono text-muted-foreground">
                        @ {entry.price.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">
                    {entry.details}
                  </div>
                </div>

                {/* Timestamp */}
                <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                  {new Date(entry.timestamp).toLocaleString()}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function JStatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
    </div>
  );
}
