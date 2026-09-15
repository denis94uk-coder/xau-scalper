import { Activity } from "lucide-react";
import { useMemo } from "react";
import { useLive } from "@/hooks/useLive";
import { api, type Idea, type JournalEntry } from "@/lib/api";

const SOURCES = [
  { id: "engine", label: "Crypto" },
  { id: "top10", label: "Top 10" },
  { id: "lse", label: "LSE" },
  { id: "experimental", label: "Exp" },
] as const;

function ago(ts: number | null | undefined): string {
  if (!ts) return "—";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * "Why no trade?" strip — every engine's last evaluation, last signal, and
 * last block reason. A quiet book with a fresh heartbeat is discipline, not
 * a freeze; this is what tells the two apart at a glance.
 */
export function EngineHeartbeat() {
  const health = useLive(() => api.systemHealth(), ["hello"]);
  const cfg = useLive(() => api.config().catch(() => null), ["config"]);
  const journal = useLive(
    () => api.journal({ limit: 150 }).then(r => r.entries),
    ["journal"],
  );
  const books = useLive(
    () =>
      Promise.all(
        SOURCES.map(s =>
          api.ideas({ limit: 3, source: s.id }).then(r => ({ id: s.id, ideas: r.ideas as Idea[] })),
        ),
      ),
    ["ideas"],
  );

  const rows = useMemo(() => {
    const entries: JournalEntry[] = [...(journal ?? [])].sort((a, b) => b.timestamp - a.timestamp);
    return SOURCES.map(s => {
      const runs = entries.filter(e => e.source === s.id && e.eventType === "ENGINE_RUN");
      const blocks = entries.filter(e => e.source === s.id && e.eventType === "SIGNAL_BLOCKED");
      const lastRun = runs.length ? runs[0] : null; // journal returns newest-first
      const lastBlock = blocks.length ? blocks[0] : null;
      const fresh = lastRun ? Date.now() - lastRun.timestamp < 10 * 60000 : false;
      const book = (books ?? []).find(b => b.id === s.id);
      const lastSignal = book?.ideas.length ? book.ideas[0].createdAt : null;
      return { ...s, lastRun, lastBlock, fresh, lastSignal };
    });
  }, [journal, books]);

  if (!journal || !books) {
    return (
      <div className="rounded-lg border border-white/5 bg-[#12141A] px-3 py-2 text-[11px] text-muted-foreground animate-pulse">
        Checking engine heartbeats…
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/5 bg-[#12141A] px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <Activity className="w-3.5 h-3.5 text-[#D4A843]" />
        <span className="text-xs font-semibold">Engine Heartbeat</span>
        {cfg && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${
              cfg.risk.liveArmed
                ? "bg-red-500/15 text-red-300"
                : "bg-amber-500/15 text-amber-300"
            }`}
            title={
              cfg.risk.liveArmed
                ? "Risk limits enforced — signals can be refused"
                : "Paper-collect mode — risk gates log RISK_WOULD_BLOCK but never refuse"
            }
          >
            {cfg.risk.liveArmed ? "LIVE ARMED" : "PAPER"}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          monitor {health?.lastMonitorRun ? ago(health.lastMonitorRun) : "—"} · signals{" "}
          {health?.lastSignalRun ? ago(health.lastSignalRun) : "—"} · {health?.openIdeas ?? "—"} open
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-1.5">
        {rows.map(r => (
          <div
            key={r.id}
            className="rounded-md border border-white/5 bg-white/[0.02] px-2 py-1.5"
            title={
              r.lastBlock
                ? `Blocked: ${r.lastBlock.details ?? r.lastBlock.eventType}`
                : (r.lastRun?.details ?? "No recent run logged")
            }
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${r.fresh ? "bg-emerald-400" : "bg-red-400"}`}
              />
              <span className="text-[11px] font-semibold">{r.label}</span>
              <span className="text-[10px] font-mono text-muted-foreground ml-auto">
                run {ago(r.lastRun?.timestamp)}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground truncate mt-0.5">
              {(r.lastRun?.details ?? "—").replace(/^\[.*?\] /, "")}
            </div>
            <div className="flex justify-between text-[10px] font-mono mt-0.5">
              <span className="text-muted-foreground">signal {ago(r.lastSignal)}</span>
              {r.lastBlock && (
                <span className="text-yellow-300/90 truncate ml-2 max-w-[60%]">
                  ⛔ {ago(r.lastBlock.timestamp)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
