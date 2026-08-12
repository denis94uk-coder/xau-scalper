/**
 * Runtime configuration — the whole app, editable without touching code.
 *
 * WHY THIS EXISTS
 * Every knob used to live in a TypeScript literal: the asset registry in
 * core/assets.ts, the risk cap in core/portfolio.ts, the timer cadences and
 * MT5 directory in environment variables. That is fine for a repository and
 * useless for an application — "change the strategy" meant editing source and
 * rebuilding, which is exactly what an operator cannot do.
 *
 * So the registry becomes a DEFAULT rather than the truth. The truth is one
 * JSON document in the settings table, edited from the Settings page, and
 * every consumer reads it through `loadConfig`.
 *
 * TWO RULES THIS MODULE ENFORCES
 *
 * 1. Validation is exhaustive and returns *messages*, not booleans. A rejected
 *    config with no explanation is indistinguishable from a broken app, and the
 *    UI has to render the reason next to the field.
 *
 * 2. Unknown keys are rejected, never ignored. A silently dropped key is how a
 *    user ends up believing they tuned a knob that was never applied — the same
 *    failure the batch scorer already guards against.
 *
 * Nothing here imports a framework or touches the filesystem, so the server,
 * the CLI tools and the tests all share one definition of "valid".
 */

import type { AssetDefinition } from "./assets";
import { ASSETS } from "./assets";
import type { CostModel } from "./costs";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategy";

/** Where an asset's bars and specifications come from. */
export type DataSourceKind = "binance" | "mt5";

/**
 * One tradeable instrument, as configured rather than as compiled in.
 *
 * Mirrors AssetDefinition, plus the fields that only mean something once a
 * human is choosing them: which feed to use, and whether MT5's measured costs
 * should override the estimates.
 */
export interface AssetConfig {
  id: string;
  displaySymbol: string;
  dataSourceSymbol: string;
  dataSource: DataSourceKind;
  pricePrecision: number;
  enabled: boolean;
  config: StrategyConfig;
  costs: CostModel;
  /**
   * Replace `costs` with the broker's measured spread when an MT5 export for
   * this symbol is present.
   *
   * Defaults true because a measured spread beats an estimate every time, and
   * the estimates are deliberately pessimistic — leaving them in place after a
   * sync would keep reporting a breakeven rate the account does not face.
   */
  useMt5Costs: boolean;
}

/** Portfolio-level limits. Mirrors PortfolioLimits, exposed for editing. */
export interface RiskConfig {
  /** Cap on sqrt(wᵀΣw), in units of one independent position. */
  maxRisk: number;
  /** Correlation assumed when too few bars overlap to measure one. */
  assumedCorrelation: number;
  /** Bars of overlap required before a measured correlation is trusted. */
  minCorrelationSamples: number;
}

/** Timer cadences and retention, in the units an operator thinks in. */
export interface EngineConfig {
  /** Seconds between position-monitor ticks. */
  monitorSeconds: number;
  /** Seconds between signal generations. */
  signalSeconds: number;
  /** Seconds between regime/macro/news/sweep runs. */
  intelSeconds: number;
  /** Days of journal history kept. */
  journalRetentionDays: number;
  /**
   * Master switch. When false the timers still run housekeeping but no new
   * signal is ever recorded — the app becomes read-only over its own history.
   */
  autoTradingEnabled: boolean;
}

/** The MetaTrader 5 bridge. */
export interface Mt5Config {
  /** Pull bars and specifications from a running terminal. */
  enabled: boolean;
  /**
   * The exporter's output directory. Empty means "discover it", which is what
   * the Settings page offers as a button rather than a thing to type.
   */
  directory: string;
  /** Seconds between automatic ingests. */
  syncSeconds: number;
  /**
   * Write order files the EA executes.
   *
   * Off by default, and deliberately separate from `enabled`: reading bars is
   * harmless, placing orders is not, and one switch for both would arm live
   * trading as a side effect of asking for better spread data.
   */
  executionEnabled: boolean;
  /** Lots per order when execution is armed. */
  lotSize: number;
  /** Refuse to send orders while more than this many EA positions are open. */
  maxOpenPositions: number;
}

export interface AppConfig {
  /** Schema version, so a future migration can recognise this document. */
  version: number;
  assets: AssetConfig[];
  risk: RiskConfig;
  engine: EngineConfig;
  mt5: Mt5Config;
}

export const CONFIG_VERSION = 1;
/** Settings key holding the whole document. */
export const CONFIG_KEY = "appConfig";

/**
 * The shipped defaults: the existing registry, unchanged.
 *
 * A fresh install therefore behaves exactly as the pre-config app did, which
 * is the only way to be sure this layer changed nothing on its own.
 */
export function defaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    assets: ASSETS.map(assetToConfig),
    risk: {
      maxRisk: 3,
      assumedCorrelation: 0.8,
      minCorrelationSamples: 30,
    },
    engine: {
      monitorSeconds: 60,
      signalSeconds: 300,
      intelSeconds: 900,
      journalRetentionDays: 90,
      autoTradingEnabled: true,
    },
    mt5: {
      enabled: false,
      directory: "",
      syncSeconds: 60,
      executionEnabled: false,
      lotSize: 0.01,
      maxOpenPositions: 3,
    },
  };
}

function assetToConfig(a: AssetDefinition): AssetConfig {
  return {
    id: a.id,
    displaySymbol: a.displaySymbol,
    dataSourceSymbol: a.dataSourceSymbol,
    dataSource: "binance",
    pricePrecision: a.pricePrecision,
    enabled: a.enabled,
    config: { ...a.config },
    costs: { ...a.costs },
    useMt5Costs: true,
  };
}

/**
 * An AssetConfig as the strategy core wants it.
 *
 * The engine, backtest and scorer all take AssetDefinition; converting here
 * keeps every one of them ignorant of where the numbers came from.
 */
export function toAssetDefinition(a: AssetConfig): AssetDefinition {
  return {
    id: a.id,
    displaySymbol: a.displaySymbol,
    dataSourceSymbol: a.dataSourceSymbol,
    dataSource: a.dataSource,
    sessionType: "24_7",
    pricePrecision: a.pricePrecision,
    config: a.config,
    costs: a.costs,
    enabled: a.enabled,
  };
}

// ─── Validation ───

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `assets[2].config.tp1R`. */
  path: string;
  message: string;
}

interface Bound {
  min: number;
  max: number;
  integer?: boolean;
}

/**
 * Permitted range for every strategy knob.
 *
 * These are guards against nonsense, not opinions about what trades well: an
 * EMA period of 0 divides by zero, a tp1R above tp2R inverts the exit ladder,
 * and a cooldown of a millisecond restacks the same idea every bar. Anything
 * inside these bounds is the operator's business.
 */
const STRATEGY_BOUNDS: Record<keyof StrategyConfig, Bound> = {
  emaFast: { min: 1, max: 400, integer: true },
  emaMid: { min: 1, max: 400, integer: true },
  emaSlow: { min: 1, max: 400, integer: true },
  rsiPeriod: { min: 2, max: 200, integer: true },
  rsiOversold: { min: 1, max: 49 },
  rsiOverbought: { min: 51, max: 99 },
  macdFast: { min: 1, max: 200, integer: true },
  macdSlow: { min: 2, max: 400, integer: true },
  macdSignal: { min: 1, max: 200, integer: true },
  atrPeriod: { min: 2, max: 200, integer: true },
  atrSlMultiplier: { min: 0.1, max: 10 },
  atrTrailMultiplier: { min: 0.1, max: 10 },
  stochPeriod: { min: 2, max: 200, integer: true },
  stochOversold: { min: 1, max: 49 },
  stochOverbought: { min: 51, max: 99 },
  bollingerPeriod: { min: 2, max: 200, integer: true },
  bollingerStdDev: { min: 0.1, max: 5 },
  tp1R: { min: 0.1, max: 20 },
  tp2R: { min: 0.1, max: 50 },
  gradeAExtreme: { min: 0, max: 6, integer: true },
  gradeAStrength: { min: 0, max: 100 },
  gradeBExtreme: { min: 0, max: 6, integer: true },
  gradeBStrength: { min: 0, max: 100 },
  gradeCStrength: { min: 0, max: 100 },
  confidenceMultiplier: { min: 0.1, max: 5 },
  confidenceCap: { min: 1, max: 100 },
  biasNeutralThreshold: { min: 0, max: 100 },
  cooldownMs: { min: 0, max: 86_400_000, integer: true },
};

const COST_BOUNDS: Record<keyof CostModel, Bound> = {
  halfSpreadBps: { min: 0, max: 1000 },
  takerFeeBps: { min: 0, max: 1000 },
  makerFeeBps: { min: 0, max: 1000 },
  stopSlippageBps: { min: 0, max: 1000 },
};

function checkNumber(
  value: unknown,
  path: string,
  bound: Bound,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "must be a finite number" });
    return;
  }
  if (bound.integer && !Number.isInteger(value)) {
    issues.push({ path, message: "must be a whole number" });
    return;
  }
  if (value < bound.min || value > bound.max) {
    issues.push({
      path,
      message: `must be between ${bound.min} and ${bound.max}`,
    });
  }
}

function checkSection(
  value: unknown,
  path: string,
  bounds: Record<string, Bound>,
  issues: ValidationIssue[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  const record = value as Record<string, unknown>;

  for (const [key, bound] of Object.entries(bounds)) {
    if (!(key in record)) {
      issues.push({ path: `${path}.${key}`, message: "is required" });
      continue;
    }
    checkNumber(record[key], `${path}.${key}`, bound, issues);
  }
  // Unknown keys are an error rather than a shrug: a misspelled knob that is
  // quietly discarded looks exactly like a knob that had no effect.
  for (const key of Object.keys(record)) {
    if (!(key in bounds)) {
      issues.push({
        path: `${path}.${key}`,
        message: "is not a known setting",
      });
    }
  }
}

/**
 * Check a whole config document.
 *
 * Returns every problem found rather than stopping at the first, so a form can
 * mark all of its bad fields in one pass.
 */
export function validateConfig(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [{ path: "", message: "config must be an object" }];
  }
  const cfg = input as Record<string, unknown>;

  // ── unknown top-level sections ──
  //
  // Same reasoning as the per-field check below: a document with a misspelled
  // section that is accepted and ignored is worse than a rejection, because
  // the operator sees their settings saved and the engine never reads them.
  for (const key of Object.keys(cfg)) {
    if (!["version", "assets", "risk", "engine", "mt5"].includes(key)) {
      issues.push({ path: key, message: "is not a known section" });
    }
  }

  if (cfg.version !== undefined && typeof cfg.version !== "number") {
    issues.push({ path: "version", message: "must be a number" });
  }

  // ── assets ──
  if (!Array.isArray(cfg.assets)) {
    issues.push({ path: "assets", message: "must be an array" });
  } else {
    if (cfg.assets.length === 0) {
      issues.push({
        path: "assets",
        message: "at least one asset is required",
      });
    }
    const seen = new Set<string>();
    cfg.assets.forEach((raw, i) => {
      const p = `assets[${i}]`;
      if (raw === null || typeof raw !== "object") {
        issues.push({ path: p, message: "must be an object" });
        return;
      }
      const a = raw as Record<string, unknown>;

      for (const key of ["id", "displaySymbol", "dataSourceSymbol"]) {
        const v = a[key];
        if (typeof v !== "string" || v.trim() === "") {
          issues.push({ path: `${p}.${key}`, message: "is required" });
        }
      }
      if (typeof a.id === "string") {
        // A duplicate id is not cosmetic: candles, ideas and journal rows are
        // all keyed by it, so two assets sharing one would interleave their
        // histories into a single unusable series.
        if (seen.has(a.id)) {
          issues.push({ path: `${p}.id`, message: `duplicate id "${a.id}"` });
        }
        seen.add(a.id);
      }
      if (a.dataSource !== "binance" && a.dataSource !== "mt5") {
        issues.push({
          path: `${p}.dataSource`,
          message: 'must be "binance" or "mt5"',
        });
      }
      checkNumber(
        a.pricePrecision,
        `${p}.pricePrecision`,
        { min: 0, max: 8, integer: true },
        issues,
      );
      if (typeof a.enabled !== "boolean") {
        issues.push({ path: `${p}.enabled`, message: "must be true or false" });
      }
      if (typeof a.useMt5Costs !== "boolean") {
        issues.push({
          path: `${p}.useMt5Costs`,
          message: "must be true or false",
        });
      }

      checkSection(a.config, `${p}.config`, STRATEGY_BOUNDS, issues);
      checkSection(a.costs, `${p}.costs`, COST_BOUNDS, issues);

      // Cross-field rules. Each of these is individually in range and jointly
      // incoherent, which is why they cannot be expressed as bounds.
      const sc = a.config as Partial<StrategyConfig> | undefined;
      if (sc && typeof sc === "object") {
        if (
          typeof sc.tp1R === "number" &&
          typeof sc.tp2R === "number" &&
          sc.tp1R >= sc.tp2R
        ) {
          issues.push({
            path: `${p}.config.tp1R`,
            message: "TP1 must be closer than TP2",
          });
        }
        if (
          typeof sc.macdFast === "number" &&
          typeof sc.macdSlow === "number" &&
          sc.macdFast >= sc.macdSlow
        ) {
          issues.push({
            path: `${p}.config.macdFast`,
            message: "MACD fast period must be shorter than slow",
          });
        }
        if (
          typeof sc.emaFast === "number" &&
          typeof sc.emaMid === "number" &&
          typeof sc.emaSlow === "number" &&
          !(sc.emaFast < sc.emaMid && sc.emaMid < sc.emaSlow)
        ) {
          issues.push({
            path: `${p}.config.emaFast`,
            message: "EMA periods must increase: fast < mid < slow",
          });
        }
        if (
          typeof sc.rsiOversold === "number" &&
          typeof sc.rsiOverbought === "number" &&
          sc.rsiOversold >= sc.rsiOverbought
        ) {
          issues.push({
            path: `${p}.config.rsiOversold`,
            message: "oversold must be below overbought",
          });
        }
      }
    });
  }

  // ── risk ──
  const risk = cfg.risk as Record<string, unknown> | undefined;
  if (!risk || typeof risk !== "object") {
    issues.push({ path: "risk", message: "must be an object" });
  } else {
    checkNumber(risk.maxRisk, "risk.maxRisk", { min: 0.1, max: 100 }, issues);
    checkNumber(
      risk.assumedCorrelation,
      "risk.assumedCorrelation",
      { min: -1, max: 1 },
      issues,
    );
    checkNumber(
      risk.minCorrelationSamples,
      "risk.minCorrelationSamples",
      { min: 2, max: 10_000, integer: true },
      issues,
    );
  }

  // ── engine ──
  const engine = cfg.engine as Record<string, unknown> | undefined;
  if (!engine || typeof engine !== "object") {
    issues.push({ path: "engine", message: "must be an object" });
  } else {
    // Ten seconds is the floor on every loop: below that the app spends its
    // time re-asking the venue a question whose answer has not changed, and a
    // rate limit costs you the monitor loop that must not stop.
    checkNumber(
      engine.monitorSeconds,
      "engine.monitorSeconds",
      { min: 10, max: 3600, integer: true },
      issues,
    );
    checkNumber(
      engine.signalSeconds,
      "engine.signalSeconds",
      { min: 30, max: 86_400, integer: true },
      issues,
    );
    checkNumber(
      engine.intelSeconds,
      "engine.intelSeconds",
      { min: 60, max: 86_400, integer: true },
      issues,
    );
    checkNumber(
      engine.journalRetentionDays,
      "engine.journalRetentionDays",
      { min: 1, max: 3650, integer: true },
      issues,
    );
    if (typeof engine.autoTradingEnabled !== "boolean") {
      issues.push({
        path: "engine.autoTradingEnabled",
        message: "must be true or false",
      });
    }
  }

  // ── mt5 ──
  const mt5 = cfg.mt5 as Record<string, unknown> | undefined;
  if (!mt5 || typeof mt5 !== "object") {
    issues.push({ path: "mt5", message: "must be an object" });
  } else {
    for (const key of ["enabled", "executionEnabled"]) {
      if (typeof mt5[key] !== "boolean") {
        issues.push({ path: `mt5.${key}`, message: "must be true or false" });
      }
    }
    if (typeof mt5.directory !== "string") {
      issues.push({ path: "mt5.directory", message: "must be a string" });
    }
    checkNumber(
      mt5.syncSeconds,
      "mt5.syncSeconds",
      { min: 10, max: 3600, integer: true },
      issues,
    );
    checkNumber(mt5.lotSize, "mt5.lotSize", { min: 0.01, max: 100 }, issues);
    checkNumber(
      mt5.maxOpenPositions,
      "mt5.maxOpenPositions",
      { min: 1, max: 100, integer: true },
      issues,
    );
    // Arming execution against a bridge that is switched off would write order
    // files nothing reads, which looks identical to orders being rejected.
    if (mt5.executionEnabled === true && mt5.enabled !== true) {
      issues.push({
        path: "mt5.executionEnabled",
        message: "requires the MT5 bridge to be enabled",
      });
    }
  }

  return issues;
}

/**
 * Fill a partial document from the defaults, one section at a time.
 *
 * Used when loading a config written by an older version: a section added
 * since then is absent rather than wrong, and defaulting it is better than
 * refusing to start. Field-level merging is deliberate — `assets` is replaced
 * wholesale, because merging arrays by index would resurrect a deleted asset.
 */
export function withDefaults(partial: Partial<AppConfig>): AppConfig {
  const base = defaultConfig();
  return {
    version: CONFIG_VERSION,
    assets: partial.assets ?? base.assets,
    risk: { ...base.risk, ...partial.risk },
    engine: { ...base.engine, ...partial.engine },
    mt5: { ...base.mt5, ...partial.mt5 },
  };
}

/** Enabled assets, in configuration order. */
export function enabledAssets(cfg: AppConfig): AssetConfig[] {
  return cfg.assets.filter(a => a.enabled);
}

/**
 * A blank asset, ready to be edited in the UI.
 *
 * Inherits the default strategy and a deliberately pessimistic cost estimate:
 * a new instrument whose costs default to zero would report an edge it does
 * not have, and being wrong in the expensive direction is the cheap mistake.
 */
export function newAsset(
  id: string,
  overrides: Partial<AssetConfig> = {},
): AssetConfig {
  return {
    id,
    displaySymbol: id,
    dataSourceSymbol: id,
    dataSource: "binance",
    pricePrecision: 2,
    enabled: false,
    config: { ...DEFAULT_STRATEGY_CONFIG },
    costs: {
      halfSpreadBps: 4,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 8,
    },
    useMt5Costs: true,
    ...overrides,
  };
}
