/**
 * Asset registry for the multi-asset signal engine.
 *
 * Framework-agnostic (no Convex imports) so it is shared between the Convex
 * engine and the standalone backtest script. Each asset carries its own
 * StrategyConfig; today every asset uses DEFAULT_STRATEGY_CONFIG, but the
 * per-asset config is the hook for a future self-healing / auto-tuning loop.
 *
 * To add a new asset: append an AssetDefinition below with a unique `id`, the
 * Binance `dataSourceSymbol`, an appropriate `pricePrecision`, and (optionally)
 * a customised `config`. Nothing else needs to change — the crons and backtest
 * iterate the registry automatically.
 */
import type { CostModel } from "./costs";
import type { StrategyFamily } from "./families";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategy";

/** Which half of the evidence a signal is scored on. See core/families.ts. */
export type ScoringModel = "combined" | StrategyFamily | "quiet-trend";

/**
 * Where an asset's bars come from.
 *
 * "mt5" assets are not fetched at all: the sync loop loads them from the
 * terminal's export directory, so the engine reads them out of the database
 * rather than off the network.
 */
export type DataSource = "binance" | "mt5";
export type SessionType = "24_7";

export interface AssetDefinition {
  /** Stable internal identifier stored on records (`asset` field). */
  id: string;
  /** Human-facing symbol shown in the UI. */
  displaySymbol: string;
  /** Symbol used when querying the data source. */
  dataSourceSymbol: string;
  /** Which market data feed this asset uses (all keyless/free today). */
  dataSource: DataSource;
  /** Trading session model — all current assets trade 24/7 on Binance. */
  sessionType: SessionType;
  /** Number of decimal places used when rounding entry/SL/TP. */
  pricePrecision: number;
  /** Strategy knobs for this asset. */
  config: StrategyConfig;
  /**
   * What it costs to trade this instrument.
   *
   * Not uniform: a thin altcoin has a wider spread and slips further on a stop
   * than BTC does. Using one blended number across the registry flatters the
   * illiquid assets, which are exactly the ones where costs decide the outcome.
   */
  costs: CostModel;
  /**
   * Which scoring model the live engine and the self-heal sweep use.
   *
   * "combined" sums trend-following and mean-reversion evidence into one
   * bull/bear pair; they fire in opposite conditions and cancel. It remains the
   * default only so the pre-refactor parity fixtures on the Binance assets keep
   * asserting the behaviour they were recorded against. New assets should name
   * a family.
   */
  model?: ScoringModel;
  /** Whether the crons should generate/monitor signals for this asset. */
  enabled: boolean;
}

/**
 * Cost tiers for the expanded crypto registry.
 *
 * Not uniform: a thin altcoin has a wider spread and slips further on a stop
 * than BTC does. Using one blended number across the registry flatters the
 * illiquid assets, which are exactly the ones where costs decide the outcome.
 * Tiers follow Binance book depth by market-cap band, not per-symbol quotes —
 * pessimism is the cheap mistake here.
 */
const COST_TIERS = {
  mega: {
    halfSpreadBps: 0.8,
    takerFeeBps: 4,
    makerFeeBps: 2,
    stopSlippageBps: 2.5,
  },
  large: {
    halfSpreadBps: 2,
    takerFeeBps: 4,
    makerFeeBps: 2,
    stopSlippageBps: 6,
  },
} as const;

type CostTier = keyof typeof COST_TIERS;

interface AssetSeed {
  id: string;
  base: string;
  pricePrecision: number;
  tier: CostTier;
}

/**
 * Liquid Binance USDT majors beyond the hand-tuned originals above.
 *
 * The project's focus is crypto (BTC, ETH and the top-100 liquid pairs);
 * these seeds keep a fresh install useful without hand-writing every entry.
 * `scripts/top-assets.ts` extends coverage to the live top-N by volume,
 * deriving precision from the venue's tick size rather than this table.
 */
const ASSET_SEEDS: AssetSeed[] = [
  // Mega caps — books deep enough that costs barely move a scalp.
  { id: "SOLUSDT", base: "SOL", pricePrecision: 2, tier: "mega" },
  { id: "XRPUSDT", base: "XRP", pricePrecision: 4, tier: "mega" },
  { id: "DOGEUSDT", base: "DOGE", pricePrecision: 5, tier: "mega" },
  { id: "ADAUSDT", base: "ADA", pricePrecision: 4, tier: "mega" },
  { id: "TRXUSDT", base: "TRX", pricePrecision: 5, tier: "mega" },
  { id: "AVAXUSDT", base: "AVAX", pricePrecision: 3, tier: "mega" },
  { id: "DOTUSDT", base: "DOT", pricePrecision: 3, tier: "mega" },
  { id: "LTCUSDT", base: "LTC", pricePrecision: 2, tier: "mega" },
  { id: "BCHUSDT", base: "BCH", pricePrecision: 2, tier: "mega" },
  { id: "SHIBUSDT", base: "SHIB", pricePrecision: 8, tier: "mega" },
  { id: "PEPEUSDT", base: "PEPE", pricePrecision: 8, tier: "mega" },

  // Large caps — tradeable, but the spread starts to matter on short holds.
  { id: "NEARUSDT", base: "NEAR", pricePrecision: 3, tier: "large" },
  { id: "APTUSDT", base: "APT", pricePrecision: 3, tier: "large" },
  { id: "ARBUSDT", base: "ARB", pricePrecision: 4, tier: "large" },
  { id: "OPUSDT", base: "OP", pricePrecision: 4, tier: "large" },
  { id: "SUIUSDT", base: "SUI", pricePrecision: 4, tier: "large" },
  { id: "SEIUSDT", base: "SEI", pricePrecision: 4, tier: "large" },
  { id: "TIAUSDT", base: "TIA", pricePrecision: 3, tier: "large" },
  { id: "INJUSDT", base: "INJ", pricePrecision: 3, tier: "large" },
  { id: "RUNEUSDT", base: "RUNE", pricePrecision: 3, tier: "large" },
  { id: "FILUSDT", base: "FIL", pricePrecision: 3, tier: "large" },
  { id: "ATOMUSDT", base: "ATOM", pricePrecision: 3, tier: "large" },
  { id: "UNIUSDT", base: "UNI", pricePrecision: 2, tier: "large" },
  { id: "FETUSDT", base: "FET", pricePrecision: 5, tier: "large" },
  { id: "ICPUSDT", base: "ICP", pricePrecision: 3, tier: "large" },
  { id: "HBARUSDT", base: "HBAR", pricePrecision: 4, tier: "large" },
  { id: "ETCUSDT", base: "ETC", pricePrecision: 2, tier: "large" },
  { id: "XLMUSDT", base: "XLM", pricePrecision: 5, tier: "large" },
  { id: "ALGOUSDT", base: "ALGO", pricePrecision: 4, tier: "large" },
  { id: "VETUSDT", base: "VET", pricePrecision: 5, tier: "large" },
  { id: "GRTUSDT", base: "GRT", pricePrecision: 4, tier: "large" },
  { id: "STXUSDT", base: "STX", pricePrecision: 3, tier: "large" },
  { id: "IMXUSDT", base: "IMX", pricePrecision: 4, tier: "large" },
  { id: "WIFUSDT", base: "WIF", pricePrecision: 5, tier: "large" },
  { id: "ARUSDT", base: "AR", pricePrecision: 2, tier: "large" },
  { id: "JUPUSDT", base: "JUP", pricePrecision: 4, tier: "large" },
  { id: "LDOUSDT", base: "LDO", pricePrecision: 4, tier: "large" },
];

function seedAsset(seed: AssetSeed): AssetDefinition {
  return {
    id: seed.id,
    displaySymbol: `${seed.base}/USD`,
    dataSourceSymbol: seed.id,
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: seed.pricePrecision,
    config: DEFAULT_STRATEGY_CONFIG,
    costs: { ...COST_TIERS[seed.tier] },
    enabled: true,
  };
}

/**
 * Tier-1 assets — all on the FREE keyless Binance feed.
 *
 * Gold (PAXGUSDT) keeps pricePrecision 2 and the default config so its live
 * behaviour is byte-for-byte identical to before this refactor.
 */
export const ASSETS: AssetDefinition[] = [
  {
    id: "PAXGUSDT",
    displaySymbol: "XAU/USD",
    dataSourceSymbol: "PAXGUSDT",
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: 2,
    config: DEFAULT_STRATEGY_CONFIG,
    // Gold on Binance is thinner than the majors and quotes wider.
    costs: {
      halfSpreadBps: 4,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 8,
    },
    enabled: true,
  },
  {
    id: "BTCUSDT",
    displaySymbol: "BTC/USD",
    dataSourceSymbol: "BTCUSDT",
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: 2,
    config: DEFAULT_STRATEGY_CONFIG,
    // Deepest book in the registry.
    costs: {
      halfSpreadBps: 0.5,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 2,
    },
    enabled: true,
  },
  {
    id: "ETHUSDT",
    displaySymbol: "ETH/USD",
    dataSourceSymbol: "ETHUSDT",
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: 2,
    config: DEFAULT_STRATEGY_CONFIG,
    costs: {
      halfSpreadBps: 0.7,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 2.5,
    },
    enabled: true,
  },
  {
    id: "BNBUSDT",
    displaySymbol: "BNB/USD",
    dataSourceSymbol: "BNBUSDT",
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: 2,
    config: DEFAULT_STRATEGY_CONFIG,
    costs: {
      halfSpreadBps: 1,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 3,
    },
    enabled: true,
  },
  {
    id: "LINKUSDT",
    displaySymbol: "LINK/USD",
    dataSourceSymbol: "LINKUSDT",
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: 3,
    config: DEFAULT_STRATEGY_CONFIG,
    costs: {
      halfSpreadBps: 2,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 5,
    },
    enabled: true,
  },
  {
    id: "AAVEUSDT",
    displaySymbol: "AAVE/USD",
    dataSourceSymbol: "AAVEUSDT",
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: 2,
    config: DEFAULT_STRATEGY_CONFIG,
    costs: {
      halfSpreadBps: 2.5,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 6,
    },
    enabled: true,
  },
  {
    id: "TAOUSDT",
    displaySymbol: "TAO/USD",
    dataSourceSymbol: "TAOUSDT",
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: 2,
    config: DEFAULT_STRATEGY_CONFIG,
    // Thinnest book here — costs dominate any short-horizon edge.
    costs: {
      halfSpreadBps: 5,
      takerFeeBps: 4,
      makerFeeBps: 2,
      stopSlippageBps: 12,
    },
    enabled: true,
  },
  ...ASSET_SEEDS.map(seedAsset),
];

/** The default/legacy asset — gold. Used as the fallback for records that
 * predate the multi-asset `asset` field. */
export const DEFAULT_ASSET_ID = "PAXGUSDT";

/**
 * A stand-in definition for an exchange symbol nobody has configured yet.
 *
 * Research is how an instrument earns its place in the configuration, so the
 * search must be able to score one that has no entry. Costs use the
 * pessimistic "large" tier: discovering an edge under assumed wide costs and
 * then measuring real ones later can only improve the result, while the
 * opposite order flatters first and disappoints with money.
 */
export function unconfiguredExchangeAsset(symbol: string): AssetDefinition {
  const base = symbol.replace(/USDT$/, "");
  return {
    id: symbol,
    displaySymbol: `${base}/USD`,
    dataSourceSymbol: symbol,
    dataSource: "binance",
    sessionType: "24_7",
    pricePrecision: 4,
    config: DEFAULT_STRATEGY_CONFIG,
    costs: { ...COST_TIERS.large },
    enabled: true,
  };
}

export function getAsset(id: string): AssetDefinition | undefined {
  return ASSETS.find(a => a.id === id);
}

export function getEnabledAssets(): AssetDefinition[] {
  return ASSETS.filter(a => a.enabled);
}

/**
 * Build an AssetDefinition from stored MT5 export metadata.
 *
 * mt5:sync stores the broker's symbol specs under `mt5:<symbol>` in the
 * settings table. This turns that into something the backtest and sweep can
 * consume — with the broker's measured costs, not the registry estimates.
 */
export function mt5Asset(
  meta: {
    symbol: string;
    digits: number;
    assetId: string;
    spreadBps: number;
  },
  configOverride?: StrategyConfig,
  model: ScoringModel = "quiet-trend",
): AssetDefinition {
  return {
    model,
    id: meta.assetId,
    displaySymbol: meta.symbol,
    dataSourceSymbol: meta.symbol,
    dataSource: "mt5",
    sessionType: "24_7",
    pricePrecision: meta.digits,
    config: configOverride ?? DEFAULT_STRATEGY_CONFIG,
    costs: {
      halfSpreadBps: meta.spreadBps / 2,
      takerFeeBps: 0,
      makerFeeBps: 0,
      stopSlippageBps: meta.spreadBps,
    },
    enabled: true,
  };
}
