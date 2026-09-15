import { AlertTriangle, Plus, Shield, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PortfolioRisk } from "@/components/PortfolioRisk";
import { Switch } from "@/components/ui/switch";
import { useLive, useMutation } from "@/hooks/useLive";
import { ApiError, api, type RiskStatus } from "@/lib/api";

/**
 * The live-arm cockpit: enforcement switch, leverage cap, and kill-switch
 * state. Same fields as Settings → Risk — this is the tab an operator
 * watches, so the switch lives here too.
 */
function RiskArmPanel() {
  const [armed, setArmed] = useState<boolean | null>(null);
  const [maxLev, setMaxLev] = useState<string>("100");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const risk = useLive(() => api.riskStatus().catch(() => null), ["journal"]);

  useEffect(() => {
    let alive = true;
    api
      .config()
      .then(c => {
        if (!alive) return;
        setArmed(c.risk.liveArmed ?? false);
        setMaxLev(String(c.risk.maxLeverage ?? 100));
        setLoaded(true);
      })
      .catch(() => {
        if (alive) toast.error("Could not load risk settings");
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    const lev = Number.parseFloat(maxLev);
    if (!Number.isFinite(lev) || lev < 1 || lev > 500 || !Number.isInteger(lev)) {
      toast.error("Maximum leverage must be a whole number 1–500");
      return;
    }
    setSaving(true);
    try {
      const fresh = await api.config();
      fresh.risk.liveArmed = armed ?? false;
      fresh.risk.maxLeverage = lev;
      await api.saveConfig(fresh);
      toast.success(
        armed
          ? "Risk limits ARMED — gates now refuse signals."
          : "Paper mode — gates log RISK_WOULD_BLOCK but never refuse.",
      );
    } catch (e) {
      if (e instanceof ApiError && e.issues.length > 0) {
        toast.error(e.issues.map(i => `${i.path}: ${i.message}`).join("; "));
      } else {
        toast.error(e instanceof Error ? e.message : "Could not save");
      }
    } finally {
      setSaving(false);
    }
  };

  const resume = async () => {
    if (!window.confirm("Resume signals intraday? The halt reason stays in the journal.")) return;
    try {
      await api.riskResume();
      toast.success("Kill switch cleared — signals resume.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Resume failed");
    }
  };

  return (
    <div
      className={`rounded-lg border p-3 space-y-3 ${
        armed ? "border-red-500/40 bg-red-500/[0.04]" : "border-[#D4A843]/30 bg-[#D4A843]/[0.04]"
      }`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <Shield className={`w-5 h-5 ${armed ? "text-red-400" : "text-[#D4A843]"}`} />
        <div className="min-w-0">
          <div className="text-sm font-bold flex items-center gap-2">
            Risk Enforcement
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${
                armed ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300"
              }`}
            >
              {armed ? "LIVE ARMED" : "PAPER"}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {armed
              ? "Gates refuse signals. Disarm to return to data collection."
              : "Paper-collect mode: gates log RISK_WOULD_BLOCK but every setup is recorded."}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {armed === null || !loaded ? (
            <span className="text-xs text-muted-foreground">Loading…</span>
          ) : (
            <>
              <Switch
                aria-label="Enforce risk limits — live arm"
                checked={armed}
                onCheckedChange={setArmed}
              />
              <label className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Max lev</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  step={1}
                  value={maxLev}
                  onChange={e => setMaxLev(e.target.value)}
                  className="w-20 bg-[#0A0C10] border border-white/10 rounded-md px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[#D4A843]/60"
                />
              </label>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="px-3 py-1.5 rounded-lg bg-[#D4A843] text-[#0A0C10] text-sm font-medium hover:bg-[#E5B954] transition-colors disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>
      <KillSwitchRow risk={risk} onResume={resume} />
    </div>
  );
}

function KillSwitchRow({ risk, onResume }: { risk: RiskStatus | null | undefined; onResume: () => void }) {
  if (risk === undefined) {
    return <div className="text-[11px] text-muted-foreground animate-pulse">Checking kill switch…</div>;
  }
  if (risk === null) {
    return <div className="text-[11px] text-muted-foreground">Kill-switch status unavailable.</div>;
  }
  return (
    <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono border-t border-white/5 pt-2">
      {risk.halted ? (
        <>
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          <span className="text-red-300 font-bold">HALTED — {risk.haltReason ?? "kill switch tripped"}</span>
          <button
            type="button"
            onClick={onResume}
            className="ml-auto px-2 py-1 rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10"
          >
            Resume
          </button>
        </>
      ) : (
        <span className="text-muted-foreground">
          Kill switch clear · day P&amp;L {risk.dailyLossPts >= 0 ? "+" : ""}
          {risk.dailyLossPts.toFixed(1)} pts · {risk.openIdeas} open
          {risk.limitsActive ? "" : " · no limits configured (env)"}
        </span>
      )}
    </div>
  );
}

export function RiskManagerPage() {
  const trades = useLive(
    () => api.trades({ limit: 200 }).then(r => r.trades),
    ["trades"],
  );
  const stats = useLive(() => api.tradeStats(), ["trades"]);
  const [logTrade] = useMutation((t: Record<string, unknown>) =>
    api.logTrade(t),
  );
  const [closeTrade] = useMutation((a: { id: number; exitPrice: number }) =>
    api.closeTrade(a.id, a.exitPrice),
  );
  const [deleteTrade] = useMutation((id: number) => api.deleteTrade(id));

  const [showForm, setShowForm] = useState(false);
  const [closeModal, setCloseModal] = useState<number | null>(null);
  const [exitPrice, setExitPrice] = useState("");

  // Form state
  const [form, setForm] = useState({
    direction: "LONG" as "LONG" | "SHORT",
    entryPrice: "",
    stopLoss: "",
    takeProfit: "",
    lotSize: "0.01",
    riskAmount: "",
    notes: "",
  });

  const handleSubmit = async () => {
    const entry = parseFloat(form.entryPrice);
    const sl = parseFloat(form.stopLoss);
    const tp = parseFloat(form.takeProfit);
    const lot = parseFloat(form.lotSize);

    if (!entry || !sl || !tp || !lot) {
      toast.error("Please fill in all required fields");
      return;
    }

    await logTrade({
      direction: form.direction,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit: tp,
      lotSize: lot,
      riskAmount: form.riskAmount ? parseFloat(form.riskAmount) : undefined,
      notes: form.notes || undefined,
    });

    toast.success("Trade logged!");
    setForm({
      direction: "LONG",
      entryPrice: "",
      stopLoss: "",
      takeProfit: "",
      lotSize: "0.01",
      riskAmount: "",
      notes: "",
    });
    setShowForm(false);
  };

  const handleClose = async (id: number) => {
    const exit = Number.parseFloat(exitPrice);
    if (!Number.isFinite(exit) || exit <= 0) {
      toast.error("Enter a valid exit price");
      return;
    }
    // Outcome is derived server-side from entry vs exit rather than asserted
    // here, so the journal cannot record a result its own prices contradict.
    await closeTrade({ id, exitPrice: exit });
    toast.success("Trade closed");
    setCloseModal(null);
    setExitPrice("");
  };

  if (!trades || !stats) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading...
      </div>
    );
  }

  const openTrades = trades.filter(t => t.status === "OPEN");
  const closedTrades = trades.filter(t => t.status !== "OPEN");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Shield className="w-5 h-5 text-[#D4A843]" />
            Risk Manager
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manual trade logging with stats
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#D4A843] text-[#0A0C10] text-sm font-medium hover:bg-[#E5B954] transition-colors"
        >
          {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showForm ? "Cancel" : "Log Trade"}
        </button>
      </div>

      {/* Live-arm cockpit first — it governs everything below. */}
      <RiskArmPanel />

      {/* Concentration across the engine's open book. Above the manual-trade
          stats because it is the risk a per-trade view cannot show. */}
      <PortfolioRisk />

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        <RMCard label="Total" value={stats.totalTrades} color="text-white" />
        <RMCard label="Open" value={stats.openTrades} color="text-blue-400" />
        <RMCard
          label="Win Rate"
          value={`${stats.winRate}%`}
          color={stats.winRate >= 50 ? "text-emerald-400" : "text-red-400"}
        />
        <RMCard
          label="Profit Factor"
          // Server null means "no losses" (best), never 0.00 (worst).
          value={
            stats.totalTrades === 0
              ? "—"
              : stats.profitFactor === null
                ? "∞"
                : stats.profitFactor.toFixed(2)
          }
          color={
            stats.profitFactor === null || stats.profitFactor >= 1.5
              ? "text-emerald-400"
              : "text-yellow-400"
          }
        />
        <RMCard
          label="Total P&L"
          value={`${stats.totalPnlPoints >= 0 ? "+" : ""}${stats.totalPnlPoints.toFixed(1)}`}
          color={
            stats.totalPnlPoints >= 0 ? "text-emerald-400" : "text-red-400"
          }
        />
        <RMCard
          label="Avg Win $"
          value={`+$${stats.avgWinDollars.toFixed(1)}`}
          color="text-emerald-400"
        />
        <RMCard
          label="Avg Loss $"
          value={`-$${stats.avgLossDollars.toFixed(1)}`}
          color="text-red-400"
        />
      </div>

      {/* New Trade Form */}
      {showForm && (
        <div className="bg-[#12141A] border border-[#D4A843]/30 rounded-lg p-4 space-y-3">
          <div className="text-sm font-medium text-[#D4A843]">New Trade</div>

          <div className="grid grid-cols-2 gap-3">
            {/* Direction */}
            <div className="col-span-2 flex gap-2">
              {(["LONG", "SHORT"] as const).map(d => (
                <button
                  key={d}
                  onClick={() => setForm({ ...form, direction: d })}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                    form.direction === d
                      ? d === "LONG"
                        ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                        : "bg-red-500/20 text-red-400 border border-red-500/30"
                      : "bg-white/5 text-muted-foreground border border-white/10 hover:border-white/20"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>

            <FormField
              label="Entry Price *"
              value={form.entryPrice}
              onChange={v => setForm({ ...form, entryPrice: v })}
              placeholder="3250.00"
            />
            <FormField
              label="Stop Loss *"
              value={form.stopLoss}
              onChange={v => setForm({ ...form, stopLoss: v })}
              placeholder="3245.00"
            />
            <FormField
              label="Take Profit *"
              value={form.takeProfit}
              onChange={v => setForm({ ...form, takeProfit: v })}
              placeholder="3260.00"
            />
            <FormField
              label="Lot Size *"
              value={form.lotSize}
              onChange={v => setForm({ ...form, lotSize: v })}
              placeholder="0.01"
            />
            <FormField
              label="Risk Amount ($)"
              value={form.riskAmount}
              onChange={v => setForm({ ...form, riskAmount: v })}
              placeholder="100"
            />
            <div className="col-span-2">
              <span className="text-[10px] text-muted-foreground block mb-1">
                Notes
              </span>
              <input
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                placeholder="Trade reason..."
                className="w-full bg-[#0A0C10] border border-white/10 rounded-lg px-3 py-2 text-sm focus:border-[#D4A843]/50 focus:outline-none"
              />
            </div>
          </div>

          <button
            onClick={handleSubmit}
            className="w-full py-2 rounded-lg bg-[#D4A843] text-[#0A0C10] font-medium hover:bg-[#E5B954] transition-colors"
          >
            Log Trade
          </button>
        </div>
      )}

      {/* Open Trades */}
      {openTrades.length > 0 && (
        <div>
          <div className="text-sm font-medium mb-2 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            Open Trades ({openTrades.length})
          </div>
          <div className="space-y-1">
            {openTrades.map(trade => (
              <div
                key={trade.id}
                className="bg-[#12141A] border border-blue-500/20 rounded-lg px-3 py-2 flex items-center gap-3"
              >
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded ${
                    trade.direction === "LONG"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-red-500/20 text-red-400"
                  }`}
                >
                  {trade.direction}
                </span>
                <span className="text-sm font-mono">
                  {trade.entryPrice.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground">
                  SL: {trade.stopLoss.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground">
                  TP: {trade.takeProfit.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {trade.lotSize} lot
                </span>
                {trade.notes && (
                  <span className="text-[10px] text-muted-foreground truncate max-w-32">
                    {trade.notes}
                  </span>
                )}
                <div className="ml-auto flex gap-1">
                  {closeModal === trade.id ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        step="0.01"
                        value={exitPrice}
                        onChange={e => setExitPrice(e.target.value)}
                        placeholder="Exit price"
                        className="w-24 bg-[#0A0C10] border border-white/10 rounded px-2 py-1 text-xs font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => handleClose(trade.id)}
                        className="text-[10px] px-2 py-1 rounded bg-primary/20 text-primary hover:bg-primary/30"
                      >
                        Close
                      </button>
                      <button
                        onClick={() => {
                          setCloseModal(null);
                          setExitPrice("");
                        }}
                        className="text-muted-foreground hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => setCloseModal(trade.id)}
                        className="text-[10px] px-2 py-1 rounded bg-white/5 text-muted-foreground hover:text-white hover:bg-white/10"
                      >
                        Close
                      </button>
                      <button
                        onClick={() => {
                          deleteTrade(trade.id as number);
                          toast.success("Deleted");
                        }}
                        className="text-red-400/50 hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Closed Trades History */}
      <div>
        <div className="text-sm font-medium mb-2">
          Trade History ({closedTrades.length})
        </div>
        <div className="space-y-0.5 max-h-96 overflow-y-auto">
          {closedTrades.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-8">
              No closed trades yet. Log your first trade above!
            </div>
          ) : (
            closedTrades.map(trade => (
              <div
                key={trade.id}
                className="flex items-center gap-2 px-3 py-1.5 bg-[#12141A] rounded-lg text-xs border border-white/5"
              >
                <span
                  className={`font-medium px-1.5 rounded ${
                    trade.direction === "LONG"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-red-500/20 text-red-400"
                  }`}
                >
                  {trade.direction}
                </span>
                <span className="font-mono">{trade.entryPrice.toFixed(2)}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono">
                  {trade.exitPrice?.toFixed(2) ?? "—"}
                </span>
                <span
                  className={`px-1.5 rounded text-[10px] ${
                    trade.status === "WIN"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : trade.status === "LOSS"
                        ? "bg-red-500/20 text-red-400"
                        : "bg-yellow-500/20 text-yellow-400"
                  }`}
                >
                  {trade.status}
                </span>
                <span className="text-muted-foreground">
                  {trade.lotSize} lot
                </span>
                <span
                  className={`font-mono ml-auto ${
                    (trade.pnlPoints ?? 0) >= 0
                      ? "text-emerald-400"
                      : "text-red-400"
                  }`}
                >
                  {(trade.pnlPoints ?? 0) >= 0 ? "+" : ""}
                  {(trade.pnlPoints ?? 0).toFixed(1)} pts
                </span>
                {trade.pnlDollars !== undefined && (
                  <span
                    className={`font-mono text-[10px] ${(trade.pnlDollars ?? 0) >= 0 ? "text-emerald-400/60" : "text-red-400/60"}`}
                  >
                    ${(trade.pnlDollars ?? 0).toFixed(0)}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {new Date(
                    trade.closedAt ?? trade.openedAt,
                  ).toLocaleDateString()}
                </span>
                <button
                  onClick={() => {
                    deleteTrade(trade.id as number);
                    toast.success("Deleted");
                  }}
                  className="text-red-400/30 hover:text-red-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function RMCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div className="bg-[#12141A] border border-white/5 rounded-lg px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <span className="text-[10px] text-muted-foreground block mb-1">
        {label}
      </span>
      <input
        type="number"
        step="0.01"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#0A0C10] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:border-[#D4A843]/50 focus:outline-none"
      />
    </div>
  );
}
