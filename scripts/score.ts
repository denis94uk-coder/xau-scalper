/**
 * Batch config scorer — the bridge Teo's parameter sweep calls.
 *
 * Reads a JSON job from stdin, replays the SHARED strategy core over one
 * fetched candle window for every supplied config, and writes the metrics to
 * stdout as JSON. Teo therefore scores the real strategy (analyzeCandles)
 * rather than a Python re-implementation of it.
 *
 * Batching matters: a default sweep is 36 configs. Spawning a process per
 * config would mean 36 Binance fetches of the same window. One job = one fetch,
 * N replays.
 *
 * Input (stdin):
 *   {
 *     "symbol": "BTCUSDT",          // asset registry id
 *     "interval": "5m",
 *     "lookback": 1000,             // bars, when from/to omitted
 *     "from": "2024-01-01",         // optional explicit range (YYYY-MM-DD)
 *     "to":   "2024-06-01",
 *     "splitRatio": 0.7,            // optional; when set, also score out-of-sample
 *     "candles": [ {time,open,high,low,close,volume}, ... ],  // optional
 *     "configs": [ { "atrSlMultiplier": 2.0, "tp2R": 3.5 }, ... ]
 *   }
 *
 * Supplying `candles` skips the fetch entirely — the caller already holds the
 * window (Teo fetches it for regime detection anyway), so re-fetching it here
 * would double the requests against the feed. It also makes this script
 * testable offline.
 *
 * Each entry in `configs` is a PARTIAL override merged onto the asset's own
 * StrategyConfig, so callers only send the knobs they are sweeping and unknown
 * keys are rejected rather than silently ignored.
 *
 * Output (stdout): { "symbol", "interval", "bars", "splitIndex", "results": [...] }
 * On failure: { "error": "..." } with exit code 1.
 */

import { DEFAULT_ASSET_ID, getAsset } from "../convex/lib/assets";
import {
  type BacktestMetrics,
  computeMetrics,
  runBacktest,
} from "../convex/lib/backtest";
import {
  type Candle,
  DEFAULT_STRATEGY_CONFIG,
  type StrategyConfig,
} from "../convex/lib/strategy";

const BINANCE_API = "https://data-api.binance.vision/api/v3";
const CONFIG_KEYS = new Set(Object.keys(DEFAULT_STRATEGY_CONFIG));

interface ScoreJob {
  symbol?: string;
  interval?: string;
  lookback?: number;
  from?: string;
  to?: string;
  splitRatio?: number;
  candles?: Candle[];
  configs?: Array<Record<string, number>>;
}

interface ScoredConfig {
  config: Record<string, number>;
  metrics: BacktestMetrics;
  /** Present only when splitRatio was supplied. */
  outOfSample?: BacktestMetrics;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString("utf8");
}

/** Most-recent `limit` candles. */
async function fetchRecent(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  // Binance caps a single response at 1000 rows; page backwards when asked for more.
  let endTime: number | undefined;
  while (out.length < limit) {
    const want = Math.min(1000, limit - out.length);
    const url =
      `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${want}` +
      (endTime ? `&endTime=${endTime}` : "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API ${res.status} for ${symbol}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    out.unshift(...rows.map(toCandle));
    endTime = Number(rows[0][0]) - 1;
    if (rows.length < want) break;
  }
  return out;
}

/** Explicit [start, end) range, paginated forwards. */
async function fetchRange(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url =
      `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API ${res.status} for ${symbol}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    out.push(...rows.map(toCandle));
    cursor = Number(rows[rows.length - 1][0]) + 1;
    if (rows.length < 1000) break;
  }
  return out;
}

function toCandle(k: unknown[]): Candle {
  return {
    time: Math.floor(Number(k[0]) / 1000),
    open: Number.parseFloat(k[1] as string),
    high: Number.parseFloat(k[2] as string),
    low: Number.parseFloat(k[3] as string),
    close: Number.parseFloat(k[4] as string),
    volume: Number.parseFloat(k[5] as string),
  };
}

/**
 * Merge a partial override onto a base config.
 *
 * Unknown keys are a hard error: silently dropping them is how a sweep ends up
 * reporting that it tuned a knob it never actually applied.
 */
function mergeConfig(
  base: StrategyConfig,
  override: Record<string, number>,
): StrategyConfig {
  const unknown = Object.keys(override).filter(k => !CONFIG_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`unknown StrategyConfig key(s): ${unknown.join(", ")}`);
  }
  for (const [k, val] of Object.entries(override)) {
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new Error(`config key ${k} must be a finite number`);
    }
  }
  return { ...base, ...override };
}

async function main() {
  const raw = await readStdin();
  const job: ScoreJob = raw.trim() ? JSON.parse(raw) : {};

  const assetId = job.symbol ?? DEFAULT_ASSET_ID;
  const asset = getAsset(assetId);
  if (!asset) throw new Error(`unknown asset "${assetId}"`);

  const interval = job.interval ?? "5m";
  const configs = job.configs?.length ? job.configs : [{}];

  let candles: Candle[];
  if (job.candles?.length) {
    candles = job.candles;
  } else if (job.from && job.to) {
    const startMs = Date.parse(`${job.from}T00:00:00Z`);
    const endMs = Date.parse(`${job.to}T00:00:00Z`);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
      throw new Error("invalid from/to range (use YYYY-MM-DD)");
    }
    candles = await fetchRange(
      asset.dataSourceSymbol,
      interval,
      startMs,
      endMs,
    );
  } else {
    candles = await fetchRecent(
      asset.dataSourceSymbol,
      interval,
      job.lookback ?? 1000,
    );
  }

  if (candles.length < 61) {
    throw new Error(`not enough candles (${candles.length}); need > 60`);
  }

  // Out-of-sample split: optimize on the first slice, validate on the held-out
  // tail. The tail is replayed with full preceding history so its indicators
  // match what the live engine would have computed at that moment.
  let splitIndex: number | null = null;
  if (job.splitRatio !== undefined) {
    if (job.splitRatio <= 0 || job.splitRatio >= 1) {
      throw new Error("splitRatio must be strictly between 0 and 1");
    }
    splitIndex = Math.floor(candles.length * job.splitRatio);
    if (splitIndex < 61 || candles.length - splitIndex < 30) {
      throw new Error(
        `splitRatio ${job.splitRatio} leaves too few bars on one side ` +
          `(${splitIndex} / ${candles.length - splitIndex})`,
      );
    }
  }

  const results: ScoredConfig[] = configs.map(override => {
    const config = mergeConfig(asset.config, override);
    const inSampleEnd = splitIndex ?? candles.length;
    const metrics = computeMetrics(
      runBacktest(
        candles.slice(0, inSampleEnd),
        config,
        asset.pricePrecision,
        60,
        asset.costs,
      ),
    );
    const scored: ScoredConfig = { config: override, metrics };
    if (splitIndex !== null) {
      scored.outOfSample = computeMetrics(
        runBacktest(
          candles,
          config,
          asset.pricePrecision,
          splitIndex,
          asset.costs,
        ),
      );
    }
    return scored;
  });

  process.stdout.write(
    `${JSON.stringify({
      symbol: assetId,
      interval,
      bars: candles.length,
      splitIndex,
      results,
    })}\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
});
