/**
 * Settings — the page that makes this an application rather than a repository.
 *
 * Everything the engine reads is editable here: which instruments are traded,
 * the strategy behind each one, the cost model, the portfolio risk cap, the
 * timer cadences and the MetaTrader 5 link. Nothing on this page requires
 * touching a file or restarting the process.
 *
 * THREE DECISIONS WORTH KNOWING
 *
 * 1. The form edits a DRAFT and saves the whole document. Live-saving each
 *    keystroke would push half-typed numbers into a running engine, and a
 *    per-field API could not enforce the cross-field rules (TP1 inside TP2,
 *    MACD fast under slow) that make a configuration coherent.
 *
 * 2. Server rejections are rendered against the field that caused them. The
 *    server returns a path per issue precisely so this page never has to say
 *    "invalid configuration" and leave the operator hunting.
 *
 * 3. Danger is separated from convenience. Arming MT5 execution sits apart from
 *    every other switch, states plainly what it does, and cannot be turned on
 *    while the bridge that would carry the orders is off.
 */

import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLive } from "@/hooks/useLive";
import {
  ApiError,
  type AppConfig,
  type AssetConfig,
  api,
  type Mt5Status,
  type StrategyConfig,
  type ValidationIssue,
} from "@/lib/api";

// ─── Field metadata ───

/**
 * A label and an explanation for every strategy knob.
 *
 * The explanation is the point. A field called `atrSlMultiplier` with a number
 * beside it is a thing to be afraid of; "stop distance, in ATRs — 1.5 means a
 * stop one and a half times the recent range away" is a thing to have an
 * opinion about, and the whole purpose of this page is to let someone without
 * the source code form one.
 */
const STRATEGY_FIELDS: Array<{
  key: keyof StrategyConfig;
  label: string;
  help: string;
  step?: number;
  group: "trend" | "oscillators" | "exits" | "grading";
}> = [
  {
    key: "emaFast",
    label: "Fast EMA",
    help: "Shortest moving average. Reacts first; lower is twitchier.",
    group: "trend",
  },
  {
    key: "emaMid",
    label: "Mid EMA",
    help: "The reference the entry price is judged against.",
    group: "trend",
  },
  {
    key: "emaSlow",
    label: "Slow EMA",
    help: "The trend backdrop. All three aligned is the strongest trend vote.",
    group: "trend",
  },
  {
    key: "macdFast",
    label: "MACD fast",
    help: "Must be shorter than the slow period.",
    group: "trend",
  },
  {
    key: "macdSlow",
    label: "MACD slow",
    help: "The longer arm of the MACD.",
    group: "trend",
  },
  {
    key: "macdSignal",
    label: "MACD signal",
    help: "Smoothing on the histogram, which is what the cross is read from.",
    group: "trend",
  },
  {
    key: "rsiPeriod",
    label: "RSI period",
    help: "Lookback for the RSI. 14 is the convention.",
    group: "oscillators",
  },
  {
    key: "rsiOversold",
    label: "RSI oversold",
    help: "Below this counts as an extreme for a long.",
    group: "oscillators",
  },
  {
    key: "rsiOverbought",
    label: "RSI overbought",
    help: "Above this counts as an extreme for a short.",
    group: "oscillators",
  },
  {
    key: "stochPeriod",
    label: "Stochastic period",
    help: "Lookback for %K.",
    group: "oscillators",
  },
  {
    key: "stochOversold",
    label: "Stochastic oversold",
    help: "Below this is an extreme.",
    group: "oscillators",
  },
  {
    key: "stochOverbought",
    label: "Stochastic overbought",
    help: "Above this is an extreme.",
    group: "oscillators",
  },
  {
    key: "bollingerPeriod",
    label: "Bollinger period",
    help: "Lookback for the bands.",
    group: "oscillators",
  },
  {
    key: "bollingerStdDev",
    label: "Bollinger width",
    help: "Standard deviations from the mean. Wider bands touch less often.",
    step: 0.1,
    group: "oscillators",
  },
  {
    key: "atrPeriod",
    label: "ATR period",
    help: "Lookback for the range that sizes every stop and target.",
    group: "exits",
  },
  {
    key: "atrSlMultiplier",
    label: "Stop distance (ATR)",
    help: "1.5 places the stop one and a half average ranges away. Tighter stops are hit by noise; wider ones cost more when wrong.",
    step: 0.1,
    group: "exits",
  },
  {
    key: "atrTrailMultiplier",
    label: "Trail distance (ATR)",
    help: "How far behind price the stop trails once TP1 is booked.",
    step: 0.1,
    group: "exits",
  },
  {
    key: "tp1R",
    label: "TP1 (R multiple)",
    help: "First target, as a multiple of the risked distance. Books a partial and moves the stop to breakeven.",
    step: 0.1,
    group: "exits",
  },
  {
    key: "tp2R",
    label: "TP2 (R multiple)",
    help: "Final target. Must be further out than TP1.",
    step: 0.1,
    group: "exits",
  },
  {
    key: "cooldownMs",
    label: "Cooldown (ms)",
    help: "Minimum gap between two same-direction signals on one asset. Stops the engine restacking one idea.",
    step: 60_000,
    group: "exits",
  },
  {
    key: "gradeAExtreme",
    label: "Grade A: extremes",
    help: "Indicators at an extreme required for an A.",
    group: "grading",
  },
  {
    key: "gradeAStrength",
    label: "Grade A: strength",
    help: "Bias strength required for an A.",
    group: "grading",
  },
  {
    key: "gradeBExtreme",
    label: "Grade B: extremes",
    help: "Extremes required for a B. Only A and B are traded.",
    group: "grading",
  },
  {
    key: "gradeBStrength",
    label: "Grade B: strength",
    help: "Bias strength required for a B.",
    group: "grading",
  },
  {
    key: "gradeCStrength",
    label: "Grade C: strength",
    help: "Everything above this but below B is a C, which is recorded and not traded.",
    group: "grading",
  },
  {
    key: "confidenceMultiplier",
    label: "Confidence scaling",
    help: "Bias strength is multiplied by this to produce the reported confidence.",
    step: 0.1,
    group: "grading",
  },
  {
    key: "confidenceCap",
    label: "Confidence cap",
    help: "Ceiling on reported confidence. Nothing here is ever certain.",
    group: "grading",
  },
  {
    key: "biasNeutralThreshold",
    label: "Neutral threshold",
    help: "Below this bias strength the read is NEUTRAL and nothing is taken.",
    group: "grading",
  },
];

const GROUP_LABELS: Record<string, string> = {
  trend: "Trend",
  oscillators: "Oscillators",
  exits: "Stops and targets",
  grading: "Grading",
};

const COST_FIELDS: Array<{
  key: keyof AssetConfig["costs"];
  label: string;
  help: string;
}> = [
  {
    key: "halfSpreadBps",
    label: "Half spread (bps)",
    help: "Half the quoted spread. Paid on entry and again on a stop.",
  },
  {
    key: "takerFeeBps",
    label: "Taker fee (bps)",
    help: "Charged on market orders — entries and stops. Zero on most CFD accounts.",
  },
  {
    key: "makerFeeBps",
    label: "Maker fee (bps)",
    help: "Charged on resting limit orders, which is what a take-profit is.",
  },
  {
    key: "stopSlippageBps",
    label: "Stop slippage (bps)",
    help: "Extra adverse fill past the stop trigger. This is why a loss costs more than the chart shows.",
  },
];

// ─── Small building blocks ───

function issueFor(issues: ValidationIssue[], path: string): string | undefined {
  return issues.find(i => i.path === path)?.message;
}

function NumberField({
  label,
  help,
  value,
  onChange,
  step = 1,
  error,
}: {
  label: string;
  help?: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  error?: string;
}) {
  // The raw string is held separately so a half-typed "1." or an emptied box
  // does not immediately become NaN and get bounced by validation mid-keystroke.
  const [raw, setRaw] = useState(String(value));
  useEffect(() => {
    setRaw(String(value));
  }, [value]);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <Input
        type="number"
        step={step}
        value={raw}
        onChange={e => {
          setRaw(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n)) onChange(n);
        }}
        className={error ? "border-destructive" : undefined}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : help ? (
        <p className="text-xs text-muted-foreground leading-snug">{help}</p>
      ) : null}
    </div>
  );
}

function TextField({
  label,
  help,
  value,
  onChange,
  placeholder,
  error,
}: {
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={error ? "border-destructive" : undefined}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : help ? (
        <p className="text-xs text-muted-foreground leading-snug">{help}</p>
      ) : null}
    </div>
  );
}

function ToggleRow({
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground leading-snug">{help}</p>
      </div>
      {/* Named for assistive tech. Without this the control announces only
          "switch", which for a row like "Let the app place orders in MT5" is
          the difference between arming trading and toggling something unknown. */}
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

// ─── The page ───

export function SettingsPage() {
  const saved = useLive(() => api.config(), ["config"]);
  const mt5 = useLive<Mt5Status>(() => api.mt5Status(), ["mt5", "config"]);

  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);

  // Adopt the server's document once, and again whenever it changes underneath
  // an unedited form. An in-progress edit is never overwritten: losing typed
  // input to a background refresh is the fastest way to make a page untrusted.
  useEffect(() => {
    if (saved && draft === null) setDraft(structuredClone(saved));
  }, [saved, draft]);

  const dirty = useMemo(() => {
    if (!saved || !draft) return false;
    return JSON.stringify(saved) !== JSON.stringify(draft);
  }, [saved, draft]);

  const update = useCallback((fn: (d: AppConfig) => void) => {
    setDraft(prev => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }, []);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.saveConfig(draft);
      setIssues([]);
      toast.success("Settings saved. The engine picked them up immediately.");
    } catch (e) {
      if (e instanceof ApiError && e.issues.length > 0) {
        setIssues(e.issues);
        toast.error(
          `${e.issues.length} setting(s) need attention — see the highlighted fields.`,
        );
      } else {
        toast.error(e instanceof Error ? e.message : "Could not save settings");
      }
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setBusy("reset");
    try {
      const fresh = await api.resetConfig();
      setDraft(structuredClone(fresh));
      setIssues([]);
      toast.success("Restored the shipped defaults.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reset");
    } finally {
      setBusy(null);
    }
  };

  const discover = async () => {
    setBusy("discover");
    try {
      const { directory, found } = await api.mt5Discover();
      if (found && directory) {
        update(d => {
          d.mt5.directory = directory;
        });
        toast.success(`Found a terminal at ${directory}`);
      } else {
        toast.error(
          "No MetaTrader 5 export directory found. Is the terminal open with TeoExporter on a chart?",
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    try {
      const out = await api.mt5Sync();
      if (out.ok) {
        toast.success(
          `Pulled ${out.ingested} bars for ${out.symbols.join(", ") || "no symbols"}.`,
        );
      } else {
        toast.error(out.errors[0] ?? "Nothing was ingested.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(null);
    }
  };

  if (!draft) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground p-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading settings…
      </div>
    );
  }

  const asset =
    draft.assets.find(a => a.id === selectedAsset) ?? draft.assets[0] ?? null;
  const assetIndex = asset
    ? draft.assets.findIndex(a => a.id === asset.id)
    : -1;

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Everything the engine reads. No files, no restart.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Badge
              variant="outline"
              className="text-amber-500 border-amber-500/40"
            >
              Unsaved changes
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={reset}
            disabled={busy === "reset"}
          >
            <RotateCcw className="h-4 w-4" />
            Defaults
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      </div>

      {issues.length > 0 && (
        <Card className="border-destructive/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              These settings were rejected
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-1">
            {issues.map(i => (
              <p key={`${i.path}-${i.message}`}>
                <span className="font-mono">{i.path || "config"}</span> —{" "}
                {i.message}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="engine">
        <TabsList>
          <TabsTrigger value="engine">Engine</TabsTrigger>
          <TabsTrigger value="assets">Instruments</TabsTrigger>
          <TabsTrigger value="strategy">Strategy</TabsTrigger>
          <TabsTrigger value="risk">Risk</TabsTrigger>
          <TabsTrigger value="mt5">MetaTrader 5</TabsTrigger>
        </TabsList>

        {/* ── Engine ── */}
        <TabsContent value="engine" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Automation</CardTitle>
              <CardDescription>
                Pausing stops new signals only. Positions already open keep
                being monitored to their exits — abandoning them would be far
                more dangerous than it looks.
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-y">
              <ToggleRow
                label="Generate new signals"
                help="When off, the engine still tracks open positions and records intel, but takes nothing new."
                checked={draft.engine.autoTradingEnabled}
                onChange={v =>
                  update(d => {
                    d.engine.autoTradingEnabled = v;
                  })
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timing</CardTitle>
              <CardDescription>
                Changes take effect on save; the timers are rescheduled rather
                than waiting for a restart.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Monitor every (seconds)"
                help="How often open positions are checked against price. The tight loop."
                value={draft.engine.monitorSeconds}
                onChange={v =>
                  update(d => {
                    d.engine.monitorSeconds = v;
                  })
                }
                error={issueFor(issues, "engine.monitorSeconds")}
              />
              <NumberField
                label="Look for signals every (seconds)"
                help="The strategy runs on 5-minute bars, so anything under 300 re-reads the same bar."
                value={draft.engine.signalSeconds}
                onChange={v =>
                  update(d => {
                    d.engine.signalSeconds = v;
                  })
                }
                error={issueFor(issues, "engine.signalSeconds")}
              />
              <NumberField
                label="Refresh intel every (seconds)"
                help="Regime, macro correlation, news and liquidity sweeps. These move slowly."
                value={draft.engine.intelSeconds}
                onChange={v =>
                  update(d => {
                    d.engine.intelSeconds = v;
                  })
                }
                error={issueFor(issues, "engine.intelSeconds")}
              />
              <NumberField
                label="Keep journal for (days)"
                help="The audit trail is what makes performance a record rather than a reconstruction."
                value={draft.engine.journalRetentionDays}
                onChange={v =>
                  update(d => {
                    d.engine.journalRetentionDays = v;
                  })
                }
                error={issueFor(issues, "engine.journalRetentionDays")}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Instruments ── */}
        <TabsContent value="assets" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">Instruments</CardTitle>
                <CardDescription>
                  What the engine watches. An MT5 instrument is fed by your
                  terminal; a market one comes from the public exchange feed.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  update(d => {
                    // Named after the count so two clicks never collide on an
                    // id, which would interleave two instruments' candles.
                    const id = `NEW${d.assets.length + 1}`;
                    d.assets.push({
                      id,
                      displaySymbol: id,
                      dataSourceSymbol: id,
                      dataSource: "binance",
                      pricePrecision: 2,
                      enabled: false,
                      config: structuredClone(
                        d.assets[0]?.config ?? ({} as StrategyConfig),
                      ),
                      costs: {
                        halfSpreadBps: 4,
                        takerFeeBps: 4,
                        makerFeeBps: 2,
                        stopSlippageBps: 8,
                      },
                      useMt5Costs: true,
                    });
                  })
                }
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft.assets.map((a, i) => (
                <div
                  key={a.id}
                  className="rounded-lg border p-3 space-y-3 bg-card/50"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={a.enabled}
                        onCheckedChange={v =>
                          update(d => {
                            d.assets[i].enabled = v;
                          })
                        }
                      />
                      <span className="font-medium text-sm">
                        {a.displaySymbol}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {a.dataSource === "mt5" ? "MT5" : "Exchange"}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        update(d => {
                          d.assets.splice(i, 1);
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <TextField
                      label="Internal id"
                      help="Stored on every candle, signal and journal row. Changing it orphans existing history."
                      value={a.id}
                      onChange={v =>
                        update(d => {
                          d.assets[i].id = v;
                        })
                      }
                      error={issueFor(issues, `assets[${i}].id`)}
                    />
                    <TextField
                      label="Display name"
                      value={a.displaySymbol}
                      onChange={v =>
                        update(d => {
                          d.assets[i].displaySymbol = v;
                        })
                      }
                      error={issueFor(issues, `assets[${i}].displaySymbol`)}
                    />
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Data source</Label>
                      <Select
                        value={a.dataSource}
                        onValueChange={v =>
                          update(d => {
                            d.assets[i].dataSource = v as "binance" | "mt5";
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="binance">
                            Public exchange feed
                          </SelectItem>
                          <SelectItem value="mt5">
                            MetaTrader 5 terminal
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground leading-snug">
                        MT5 bars arrive from your broker, with their real
                        spread.
                      </p>
                    </div>
                    <TextField
                      label={
                        a.dataSource === "mt5"
                          ? "Broker symbol"
                          : "Exchange symbol"
                      }
                      help={
                        a.dataSource === "mt5"
                          ? "Exactly as your broker spells it: XAUUSD, GOLD, XAUUSD.r."
                          : "The venue's ticker, e.g. BTCUSDT."
                      }
                      value={a.dataSourceSymbol}
                      onChange={v =>
                        update(d => {
                          d.assets[i].dataSourceSymbol = v;
                        })
                      }
                      error={issueFor(issues, `assets[${i}].dataSourceSymbol`)}
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <NumberField
                      label="Price decimals"
                      help="Used when rounding entry, stop and targets."
                      value={a.pricePrecision}
                      onChange={v =>
                        update(d => {
                          d.assets[i].pricePrecision = v;
                        })
                      }
                      error={issueFor(issues, `assets[${i}].pricePrecision`)}
                    />
                    {COST_FIELDS.map(f => (
                      <NumberField
                        key={f.key}
                        label={f.label}
                        help={f.help}
                        step={0.1}
                        value={a.costs[f.key]}
                        onChange={v =>
                          update(d => {
                            d.assets[i].costs[f.key] = v;
                          })
                        }
                        error={issueFor(issues, `assets[${i}].costs.${f.key}`)}
                      />
                    ))}
                  </div>

                  {a.dataSource === "mt5" && (
                    <div className="border-t pt-1">
                      <ToggleRow
                        label="Use my broker's measured spread"
                        help="Replaces the estimate above with the spread the terminal reports on every sync. Fees and slippage stay as you set them, because a quote cannot reveal them."
                        checked={a.useMt5Costs}
                        onChange={v =>
                          update(d => {
                            d.assets[i].useMt5Costs = v;
                          })
                        }
                      />
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Strategy ── */}
        <TabsContent value="strategy" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Strategy</CardTitle>
              <CardDescription>
                Each instrument carries its own settings. Six indicators vote;
                the winning side's score becomes the bias strength that grading
                reads.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5 min-w-56">
                  <Label className="text-xs font-medium">Editing</Label>
                  <Select
                    value={asset?.id ?? ""}
                    onValueChange={v => setSelectedAsset(v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick an instrument" />
                    </SelectTrigger>
                    <SelectContent>
                      {draft.assets.map(a => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.displaySymbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {asset && draft.assets.length > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      update(d => {
                        const source = d.assets[assetIndex].config;
                        for (const other of d.assets) {
                          other.config = structuredClone(source);
                        }
                      })
                    }
                  >
                    Copy to every instrument
                  </Button>
                )}
              </div>

              {asset &&
                (["trend", "oscillators", "exits", "grading"] as const).map(
                  group => (
                    <div key={group} className="space-y-3">
                      <Separator />
                      <p className="text-sm font-medium">
                        {GROUP_LABELS[group]}
                      </p>
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {STRATEGY_FIELDS.filter(f => f.group === group).map(
                          f => (
                            <NumberField
                              key={f.key}
                              label={f.label}
                              help={f.help}
                              step={f.step}
                              value={asset.config[f.key]}
                              onChange={v =>
                                update(d => {
                                  d.assets[assetIndex].config[f.key] = v;
                                })
                              }
                              error={issueFor(
                                issues,
                                `assets[${assetIndex}].config.${f.key}`,
                              )}
                            />
                          ),
                        )}
                      </div>
                    </div>
                  ),
                )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Risk ── */}
        <TabsContent value="risk" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Portfolio risk</CardTitle>
              <CardDescription>
                The cap is on risk, not on position count: it admits nine
                genuinely uncorrelated positions or three that move together. A
                trade that lowers portfolio risk is always allowed, even over
                the cap.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Maximum portfolio risk"
                help="In units of one independent position. 3 is the default."
                step={0.1}
                value={draft.risk.maxRisk}
                onChange={v =>
                  update(d => {
                    d.risk.maxRisk = v;
                  })
                }
                error={issueFor(issues, "risk.maxRisk")}
              />
              <NumberField
                label="Assumed correlation"
                help="Used when two instruments share too little history to measure one. 0.8, not 0 — assuming independence would wave through exactly the cluster the cap exists to catch."
                step={0.05}
                value={draft.risk.assumedCorrelation}
                onChange={v =>
                  update(d => {
                    d.risk.assumedCorrelation = v;
                  })
                }
                error={issueFor(issues, "risk.assumedCorrelation")}
              />
              <NumberField
                label="Bars needed to measure correlation"
                help="Below this many overlapping bars the assumption above is used instead."
                value={draft.risk.minCorrelationSamples}
                onChange={v =>
                  update(d => {
                    d.risk.minCorrelationSamples = v;
                  })
                }
                error={issueFor(issues, "risk.minCorrelationSamples")}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── MetaTrader 5 ── */}
        <TabsContent value="mt5" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                Connection
                {mt5?.connected ? (
                  <Badge className="bg-emerald-600/15 text-emerald-500 border-emerald-600/30">
                    <Check className="h-3 w-3" /> Live
                  </Badge>
                ) : mt5?.found ? (
                  <Badge
                    variant="outline"
                    className="text-amber-500 border-amber-500/40"
                  >
                    Stale
                  </Badge>
                ) : (
                  <Badge variant="outline">Not connected</Badge>
                )}
              </CardTitle>
              <CardDescription>
                Copy <code>mt5/TeoExporter.mq5</code> into MT5 → File → Open
                Data Folder → MQL5/Experts, compile it with F7, drag it onto a
                chart, then press Find terminal below.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ToggleRow
                label="Read from MetaTrader 5"
                help="Pulls bars and your broker's real symbol specifications on a timer. Read-only."
                checked={draft.mt5.enabled}
                onChange={v =>
                  update(d => {
                    d.mt5.enabled = v;
                    // Turning the bridge off must disarm execution too:
                    // orders written for a bridge nothing reads would look
                    // exactly like orders the broker rejected.
                    if (!v) d.mt5.executionEnabled = false;
                  })
                }
              />

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-64">
                  <TextField
                    label="Export directory"
                    help="Leave empty to find the running terminal automatically."
                    placeholder="auto-detect"
                    value={draft.mt5.directory}
                    onChange={v =>
                      update(d => {
                        d.mt5.directory = v;
                      })
                    }
                    error={issueFor(issues, "mt5.directory")}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={discover}
                  disabled={busy === "discover"}
                >
                  <Search className="h-4 w-4" />
                  Find terminal
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={syncNow}
                  disabled={busy === "sync"}
                >
                  {busy === "sync" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Sync now
                </Button>
              </div>

              <NumberField
                label="Sync every (seconds)"
                help="The exporter rewrites its files on its own timer; this is how often they are read."
                value={draft.mt5.syncSeconds}
                onChange={v =>
                  update(d => {
                    d.mt5.syncSeconds = v;
                  })
                }
                error={issueFor(issues, "mt5.syncSeconds")}
              />

              {mt5?.directory && (
                <p className="text-xs text-muted-foreground font-mono break-all">
                  {mt5.directory}
                </p>
              )}
              {mt5?.lastError && (
                <p className="text-xs text-destructive">{mt5.lastError}</p>
              )}

              {mt5 && mt5.symbols.length > 0 && (
                <div className="rounded-lg border divide-y text-xs">
                  {mt5.symbols.map(s => (
                    <div
                      key={`${s.symbol}-${s.interval}`}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="font-medium">
                        {s.symbol} {s.interval}
                      </span>
                      <span className="text-muted-foreground">
                        {s.bars} bars · spread {s.spreadBps.toFixed(2)} bps ·{" "}
                        {s.ageSeconds < 0
                          ? "age unknown"
                          : `${s.ageSeconds}s old`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-amber-600/40">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                Live execution
              </CardTitle>
              <CardDescription>
                Off by default, and deliberately separate from reading data:
                reading bars cannot lose money, placing orders can. When armed,
                every accepted signal is written as an order file for the
                exporter to place on your account.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ToggleRow
                label="Let the app place orders in MT5"
                help="Requires the bridge above to be on. Test on a demo account first — nothing in this app has a forward-tested record."
                checked={draft.mt5.executionEnabled}
                disabled={!draft.mt5.enabled}
                onChange={v =>
                  update(d => {
                    d.mt5.executionEnabled = v;
                  })
                }
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="Lots per order"
                  help="Fixed size. The strategy sizes its stop, not its position."
                  step={0.01}
                  value={draft.mt5.lotSize}
                  onChange={v =>
                    update(d => {
                      d.mt5.lotSize = v;
                    })
                  }
                  error={issueFor(issues, "mt5.lotSize")}
                />
                <NumberField
                  label="Maximum orders in flight"
                  help="Refuses to send more while this many are still unacknowledged by the terminal."
                  value={draft.mt5.maxOpenPositions}
                  onChange={v =>
                    update(d => {
                      d.mt5.maxOpenPositions = v;
                    })
                  }
                  error={issueFor(issues, "mt5.maxOpenPositions")}
                />
              </div>
              {mt5?.execution && (
                <p className="text-xs text-muted-foreground">
                  {mt5.execution.pending} order(s) waiting for the terminal
                  {mt5.execution.lastAck
                    ? mt5.execution.lastAck.ok
                      ? ` · last fill at ${mt5.execution.lastAck.price} (ticket ${mt5.execution.lastAck.ticket})`
                      : ` · last order rejected: ${mt5.execution.lastAck.error}`
                    : ""}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default SettingsPage;
