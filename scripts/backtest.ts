/**
 * Backtest harness for the XAU Scalper multi-asset engine.
 *
 * Fetches historical klines from the FREE keyless Binance endpoint (paginated,
 * 1000 candles per call) and replays them through the SHARED strategy core in
 * convex/lib/strategy.ts. The entry + exit simulation mirrors the live
 * monitorIdeas cron EXACTLY (entry on signal, TP1 partial + move-to-BE, ATR
 * trailing to TP2, SL / trailing-SL) so the backtester and live engine can
 * never diverge — there is NO duplicated strategy re-implementation here.
 *
 * Usage:
 *   bun run backtest -- --asset BTCUSDT --from 2024-01-01 --to 2024-06-01 --interval 5m
 */

import { DEFAULT_ASSET_ID, getAsset } from "../convex/lib/assets";
import { computeMetrics, runBacktest } from "../convex/lib/backtest";
import type { Candle } from "../convex/lib/strategy";

const BINANCE_API = "https://data-api.binance.vision/api/v3";

// ─── CLI parsing ───
interface CliArgs {
  asset: string;
  from: string;
  to: string;
  interval: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith("--")) {
        args[key] = val;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return {
    asset: args.asset ?? DEFAULT_ASSET_ID,
    from: args.from ?? "2024-01-01",
    to: args.to ?? "2024-06-01",
    interval: args.interval ?? "5m",
  };
}

// ─── Paginated kline fetch ───
async function fetchKlines(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = startMs;
  // Binance returns at most 1000 candles per request; page with startTime.
  while (cursor < endMs) {
    const url =
      `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API ${res.status} for ${symbol}`);
    const data = (await res.json()) as unknown[][];
    if (data.length === 0) break;
    for (const k of data) {
      candles.push({
        time: Math.floor(Number(k[0]) / 1000),
        open: Number.parseFloat(k[1] as string),
        high: Number.parseFloat(k[2] as string),
        low: Number.parseFloat(k[3] as string),
        close: Number.parseFloat(k[4] as string),
        volume: Number.parseFloat(k[5] as string),
      });
    }
    const lastOpen = Number(data[data.length - 1][0]);
    // Advance past the last candle's open time to avoid duplicates.
    cursor = lastOpen + 1;
    if (data.length < 1000) break;
  }
  return candles;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  return n.toFixed(2);
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const asset = getAsset(cli.asset);
  if (!asset) {
    console.error(
      `Unknown asset "${cli.asset}". Known assets: see convex/lib/assets.ts`,
    );
    process.exit(1);
  }

  const startMs = Date.parse(`${cli.from}T00:00:00Z`);
  const endMs = Date.parse(`${cli.to}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    console.error("Invalid --from/--to range (use YYYY-MM-DD).");
    process.exit(1);
  }

  console.log(
    `\nBacktest ${asset.displaySymbol} (${asset.dataSourceSymbol}) ` +
      `${cli.interval} | ${cli.from} → ${cli.to}\n`,
  );

  console.log("Fetching historical klines (free Binance feed)...");
  const candles = await fetchKlines(
    asset.dataSourceSymbol,
    cli.interval,
    startMs,
    endMs,
  );
  console.log(`Fetched ${candles.length} candles.\n`);

  if (candles.length < 61) {
    console.error("Not enough candles to backtest (need > 60).");
    process.exit(1);
  }

  const trades = runBacktest(candles, asset.config, asset.pricePrecision);
  const m = computeMetrics(trades);

  console.log("─── Results ───");
  console.log(`Total trades:   ${m.trades}`);
  console.log(
    `Win rate:       ${fmt(m.winRate)}%  (${m.wins}W / ${m.losses}L)`,
  );
  console.log(`Net points:     ${fmt(m.netPoints)}`);
  console.log(`Avg win:        ${fmt(m.avgWin)} pts`);
  console.log(`Avg loss:       ${fmt(m.avgLoss)} pts`);
  console.log(`Max drawdown:   ${fmt(m.maxDrawdown)} pts`);
  console.log(
    `Profit factor:  ${m.profitFactor === null ? "n/a (no losing trades)" : fmt(m.profitFactor)}`,
  );
  console.log("");
}

main().catch(err => {
  console.error("Backtest error:", err);
  process.exit(1);
});
