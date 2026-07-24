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
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategy";

export type DataSource = "binance";
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
