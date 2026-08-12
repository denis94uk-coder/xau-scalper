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
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategy";

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
  /** Whether the crons should generate/monitor signals for this asset. */
  enabled: boolean;
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
];

/** The default/legacy asset — gold. Used as the fallback for records that
 * predate the multi-asset `asset` field. */
export const DEFAULT_ASSET_ID = "PAXGUSDT";

export function getAsset(id: string): AssetDefinition | undefined {
  return ASSETS.find(a => a.id === id);
}

export function getEnabledAssets(): AssetDefinition[] {
  return ASSETS.filter(a => a.enabled);
}
