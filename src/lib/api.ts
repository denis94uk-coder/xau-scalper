/**
 * Client for the local server.
 *
 * Replaces the generated Convex client. Same origin as the page — the server
 * serves both the UI and the API — so there is no URL to configure, no
 * deployment key, and no CORS.
 */

const BASE = "";

export class ApiError extends Error {
  // Declared as a field rather than a parameter property: the app's tsconfig
  // sets erasableSyntaxOnly, which forbids the constructor-parameter shorthand.
  status: number;
  /**
   * Per-field objections, when the server rejected a document rather than a
   * request. Carried on the error because a settings form has to mark the
   * offending inputs, and a flattened message string cannot say which they are.
   */
  issues: ValidationIssue[];

  constructor(message: string, status: number, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", ...init?.headers }
      : init?.headers,
  });

  if (!res.ok) {
    // Surface the server's own message where it gave one; a bare status code
    // tells the user nothing about what went wrong.
    let detail = res.statusText;
    let issues: ValidationIssue[] = [];
    try {
      const body = (await res.json()) as {
        error?: string;
        issues?: ValidationIssue[];
      };
      if (body?.error) detail = body.error;
      if (Array.isArray(body?.issues)) issues = body.issues;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(detail, res.status, issues);
  }

  return (await res.json()) as T;
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
export const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

// ─── Shapes returned by the server ───

export interface IdeaEvent {
  event: string;
  price: number;
  timestamp: number;
}

export interface Idea {
  id: number;
  asset: string;
  direction: "LONG" | "SHORT";
  status: "ACTIVE" | "TP1_HIT" | "TP2_HIT" | "STOPPED" | "EXPIRED";
  source: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  trailingSl: number | null;
  confidence: number;
  grade: string | null;
  reason: string;
  timeframe: string;
  bias: string;
  biasStrength: number;
  spotPrice: number;
  teoScore: number | null;
  teoRegime: string | null;
  pnlPoints: number | null;
  createdAt: number;
  resolvedAt: number | null;
  events?: IdeaEvent[];
}

export interface JournalEntry {
  id: number;
  eventType: string;
  asset: string;
  source: string;
  ideaId: number | null;
  direction: "LONG" | "SHORT" | null;
  price: number | null;
  details: string;
  metadata: string | null;
  timestamp: number;
}

export type SignificanceVerdict =
  | "insufficient_data"
  | "indistinguishable_from_chance"
  | "significant";

/**
 * How much of a win rate is real, and how much could be luck.
 *
 * Served alongside the performance numbers rather than on its own endpoint, so
 * a win rate is never rendered without the sample size that qualifies it.
 */
export interface Significance {
  trades: number;
  wins: number;
  winRate: number;
  /** The rate that must be beaten to break even after costs. */
  breakevenRate: number;
  /** Probability of a result this good if the true edge were zero. */
  pValue: number;
  /** 95% Wilson interval on the true win rate. */
  interval: { low: number; high: number };
  verdict: SignificanceVerdict;
  /** Trades needed to resolve an edge of the observed size. null if none. */
  tradesNeeded: number | null;
  summary: string;
}

export interface PortfolioPosition {
  asset: string;
  direction: "LONG" | "SHORT";
  weight?: number;
}

export interface PairCorrelation {
  a: string;
  b: string;
  value: number;
  /** Overlapping bars behind the estimate. null when it was assumed. */
  samples: number | null;
  assumed: boolean;
}

/**
 * What the open positions are worth together.
 *
 * The per-asset view cannot see that five crypto longs are one bet at five
 * times the size; this is the view that can.
 */
export interface Portfolio {
  positions: PortfolioPosition[];
  /** Net signed exposure. Large magnitude = a directional bet, not a book. */
  netExposure: number;
  /** Sum of position sizes, blind to how they interact. */
  grossRisk: number;
  /** Risk in units of one independent position. */
  portfolioRisk: number;
  /** portfolioRisk / grossRisk. Near 1 = one bet in several costumes. */
  concentration: number;
  maxRisk: number;
  headroom: number;
  averageCorrelation: number;
  /** False when any pair fell back to an assumed correlation. */
  correlationsMeasured: boolean;
  summary: string;
  correlations: PairCorrelation[];
  evidence: {
    trades: number;
    wins: number;
    averageConcurrency: number;
    averageCorrelation: number;
    /** Trades discounted for having been held at the same time. */
    effectiveTrades: number;
    significance: Significance;
  };
}

export interface AssetPerformance {
  asset: string;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number;
  /** Net points for THIS asset. Points are not comparable across instruments. */
  totalPnlPoints: number;
  avgWinPoints: number;
  avgLossPoints: number;
  /** Average win divided by average loss. null when there are no losses. */
  avgRR: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
  /** Positive = consecutive wins, negative = consecutive losses. */
  currentStreak: number;
  /** null when there were no losing trades — the ratio is undefined, not zero. */
  profitFactor: number | null;
  significance: Significance;
}

export interface ManualTrade {
  id: number;
  asset: string;
  direction: "LONG" | "SHORT";
  status: "OPEN" | "WIN" | "LOSS" | "BREAKEVEN";
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  lotSize: number;
  riskAmount: number | null;
  pnlPoints: number | null;
  pnlDollars: number | null;
  notes: string | null;
  openedAt: number;
  closedAt: number | null;
}

export interface TradeStats {
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  netDollars: number;
  totalPnlPoints: number;
  avgWinDollars: number;
  avgLossDollars: number;
  /** null when there were no losing trades — the ratio is undefined, not zero. */
  profitFactor: number | null;
}

export interface AssetInfo {
  id: string;
  symbol: string;
  precision: number;
  enabled: boolean;
  dataSource: "binance" | "mt5";
}

// ─── Configuration ───
//
// These mirror core/config.ts. Duplicated rather than imported because the UI
// builds against tsconfig.app.json, which does not include the server tree —
// and the shapes are the wire format, which is allowed to outlive an internal
// refactor of the server's own types.

export interface StrategyConfig {
  emaFast: number;
  emaMid: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  atrPeriod: number;
  atrSlMultiplier: number;
  atrTrailMultiplier: number;
  stochPeriod: number;
  stochOversold: number;
  stochOverbought: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
  tp1R: number;
  tp2R: number;
  gradeAExtreme: number;
  gradeAStrength: number;
  gradeBExtreme: number;
  gradeBStrength: number;
  gradeCStrength: number;
  confidenceMultiplier: number;
  confidenceCap: number;
  biasNeutralThreshold: number;
  cooldownMs: number;
}

export interface CostModel {
  halfSpreadBps: number;
  takerFeeBps: number;
  makerFeeBps: number;
  stopSlippageBps: number;
}

export interface AssetConfig {
  id: string;
  displaySymbol: string;
  dataSourceSymbol: string;
  dataSource: "binance" | "mt5";
  pricePrecision: number;
  enabled: boolean;
  config: StrategyConfig;
  costs: CostModel;
  useMt5Costs: boolean;
}

export interface AppConfig {
  version: number;
  assets: AssetConfig[];
  risk: {
    maxRisk: number;
    assumedCorrelation: number;
    minCorrelationSamples: number;
  };
  engine: {
    monitorSeconds: number;
    signalSeconds: number;
    intelSeconds: number;
    journalRetentionDays: number;
    autoTradingEnabled: boolean;
  };
  mt5: {
    enabled: boolean;
    directory: string;
    syncSeconds: number;
    executionEnabled: boolean;
    lotSize: number;
    maxOpenPositions: number;
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface Mt5SymbolStatus {
  symbol: string;
  interval: string;
  bars: number;
  ageSeconds: number;
  spreadBps: number;
  bid: number;
  ask: number;
  assetId: string;
}

export interface Mt5Status {
  enabled: boolean;
  directory: string | null;
  found: boolean;
  /** Fresh data, not merely a directory that exists. */
  connected: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  symbols: Mt5SymbolStatus[];
  execution: {
    enabled: boolean;
    pending: number;
    lastAck: {
      id: string;
      ok: boolean;
      ticket: number | null;
      price: number | null;
      error: string | null;
      at: number;
    } | null;
  };
}

export interface Mt5SyncOutcome {
  ok: boolean;
  directory: string | null;
  ingested: number;
  symbols: string[];
  errors: string[];
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Endpoints ───

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : "";
};

/** Metrics for one backtest window. Mirrors core/backtest.ts. */
export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPoints: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  profitFactor: number | null;
  grossPoints: number;
  costPoints: number;
  expectancyPerTrade: number;
  breakevenWinRate: number | null;
}

export type CandidateVerdict =
  | "qualified"
  | "too_few_trades"
  | "unprofitable_in_sample"
  | "failed_validation"
  | "failed_test"
  | "not_significant"
  | "below_breakeven";

export interface DiscoveryCandidate {
  config: StrategyConfig;
  train: BacktestMetrics;
  validation: BacktestMetrics;
  test: BacktestMetrics;
  overall: BacktestMetrics;
  score: number;
  adjustedPValue: number;
  verdict: CandidateVerdict;
  summary: string;
}

export interface DiscoveryReport {
  asset: string;
  interval: string;
  bars: number;
  from: number;
  to: number;
  iterations: number;
  evaluated: number;
  seed: number;
  split: { train: number; validation: number; test: number };
  candidates: DiscoveryCandidate[];
  best: DiscoveryCandidate | null;
  conclusion: string;
}

export type RunStatus =
  | "requesting"
  | "downloading"
  | "searching"
  | "done"
  | "failed"
  | "cancelled";

export interface ResearchRun {
  id: string;
  assetId: string;
  symbol: string;
  interval: string;
  from: number;
  to: number;
  iterations: number;
  status: RunStatus;
  progress: number;
  message: string;
  startedAt: number;
  finishedAt: number | null;
  bars: number;
  report: DiscoveryReport | null;
  error: string | null;
}

export interface StartRunInput {
  assetId?: string;
  symbol: string;
  interval: string;
  /** UTC seconds. */
  from: number;
  to: number;
  iterations: number;
  seed?: number;
  minTrades?: number;
}

export const api = {
  assets: () => get<{ assets: AssetInfo[] }>("/api/assets"),

  ideas: (opts: { asset?: string; limit?: number } = {}) =>
    get<{ ideas: Idea[] }>(`/api/ideas${q(opts)}`),
  openIdeas: (opts: { asset?: string } = {}) =>
    get<{ ideas: Idea[] }>(`/api/ideas/open${q(opts)}`),
  logIdea: (body: Record<string, unknown>) =>
    post<{ ok: true; id: number }>("/api/ideas", body),
  deleteIdea: (id: number) => del<{ ok: true }>(`/api/ideas/${id}`),

  journal: (opts: { asset?: string; limit?: number } = {}) =>
    get<{ entries: JournalEntry[] }>(`/api/journal${q(opts)}`),
  journalCounts: () => get<Record<string, number>>("/api/journal/counts"),

  performance: (opts: { asset?: string } = {}) =>
    get<{ byAsset: AssetPerformance[] }>(`/api/performance${q(opts)}`),

  portfolio: () => get<Portfolio>("/api/portfolio"),

  candles: (asset: string, interval = "5m", limit = 200) =>
    get<{ asset: string; interval: string; candles: Candle[] }>(
      `/api/candles${q({ asset, interval, limit })}`,
    ),

  trades: (opts: { limit?: number } = {}) =>
    get<{ trades: ManualTrade[] }>(`/api/trades${q(opts)}`),
  tradeStats: () => get<TradeStats>("/api/trades/stats"),
  logTrade: (body: Record<string, unknown>) =>
    post<{ ok: true; id: number }>("/api/trades", body),
  closeTrade: (id: number, exitPrice: number) =>
    post<{ ok: true }>(`/api/trades/${id}`, { exitPrice }),
  deleteTrade: (id: number) => del<{ ok: true }>(`/api/trades/${id}`),

  /** Intel state written by the engines: regime, macro, news, sweeps. */
  state: <T>(key: string) => get<T>(`/api/state/${key}`),

  config: () => get<AppConfig>("/api/config"),
  saveConfig: (cfg: AppConfig) => put<AppConfig>("/api/config", cfg),
  defaultConfig: () => get<AppConfig>("/api/config/defaults"),
  resetConfig: () => post<AppConfig>("/api/config/reset"),

  mt5Status: () => get<Mt5Status>("/api/mt5/status"),
  mt5Discover: () =>
    get<{ directory: string | null; found: boolean }>("/api/mt5/discover"),
  mt5Sync: () => post<Mt5SyncOutcome>("/api/mt5/sync"),

  researchRuns: () => get<{ runs: ResearchRun[] }>("/api/research/runs"),
  startResearch: (input: StartRunInput) =>
    post<ResearchRun>("/api/research/runs", input),
  research: (id: string) =>
    get<ResearchRun>(`/api/research/runs/${encodeURIComponent(id)}`),
  cancelResearch: (id: string) =>
    post<{ cancelled: boolean }>(
      `/api/research/runs/${encodeURIComponent(id)}/cancel`,
    ),
  /**
   * Apply a discovered strategy to an instrument. Omit `assetId` to apply it to
   * the instrument the run was about, adding it to the configuration (disabled)
   * if it is not there yet.
   */
  adoptStrategy: (id: string, assetId?: string) =>
    post<{ adopted: boolean; assetId: string; added: boolean }>(
      `/api/research/runs/${encodeURIComponent(id)}/adopt`,
      { assetId },
    ),

  health: () =>
    get<{
      ok: boolean;
      openIdeas: number;
      lastSignalRun: number | null;
      lastMonitorRun: number | null;
    }>("/api/health"),
};
