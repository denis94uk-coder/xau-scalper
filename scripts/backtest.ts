/**
 * Backtest harness for the XAU Scalper multi-asset engine.
 *
 * Fetches historical klines from Binance OR reads broker bars already stored
 * in the local database (ingested by mt5:sync), then replays them through the
 * SHARED strategy core in core/strategy.ts.
 *
 * Usage:
 *   bun run backtest -- --asset BTCUSDT --from 2024-01-01 --to 2024-06-01 --interval 5m
 *   bun run backtest -- --source db --asset MT5:XAUUSD --interval 5m
 *   bun run backtest -- --source db --asset MT5:XAUUSD --sweep
 */

import { DEFAULT_ASSET_ID, getAsset, mt5Asset } from "../core/assets";
import {
  type BacktestModel,
  computeMetrics,
  runBacktest,
} from "../core/backtest";
import type { Candle } from "../core/strategy";
import { isScored, runSweep } from "../core/sweep";
import { db as openDb } from "../server/db";

const BINANCE_API = "https://data-api.binance.vision/api/v3";

// ─── CLI parsing ───
interface CliArgs {
  asset: string;
  from: string;
  to: string;
  interval: string;
  source: "binance" | "db";
  sweep: boolean;
  model: BacktestModel;
}

/**
 * Defaults to `trend`, not `combined`. The combined model scores trend and
 * mean-reversion evidence into one pair and they cancel — it is reachable with
 * `--model combined` for comparison, but it is not a sensible default to
 * measure a broker's data with.
 */
function parseModel(v: string | undefined): BacktestModel {
  if (
    v === "trend" ||
    v === "reversion" ||
    v === "breakout" ||
    v === "momentum" ||
    v === "combined"
  ) {
    return v;
  }
  return "trend";
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
    source: args.source === "db" ? "db" : "binance",
    sweep: args.sweep === "true",
    model: parseModel(args.model),
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

/**
 * A config that did not trade enough carries a large negative sentinel, not a
 * score. Printing the sentinel would read as a catastrophic result rather than
 * the absence of one.
 */
function oosLabel(score: number | undefined): string {
  if (score === undefined) return "n/a";
  return isScored(score) ? fmt(score) : "too few";
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.source === "db") {
    // ─── DB source: MT5 bars from the local database ───
    const database = openDb();

    const mt5Symbol = cli.asset.startsWith("MT5:")
      ? cli.asset.replace("MT5:", "")
      : cli.asset;
    const settingsKey = `mt5:${mt5Symbol}`;
    const meta = database.getSetting<{
      symbol: string;
      digits: number;
      assetId: string;
      spreadBps: number;
    }>(settingsKey);

    if (!meta) {
      console.error(
        `No MT5 data for "${mt5Symbol}". Run 'bun run mt5:sync' first.`,
      );
      process.exit(1);
    }

    // The sweep scores candidates with the asset's own model, so --model has to
    // reach it here as well as the single backtest below.
    const asset = mt5Asset(meta, undefined, cli.model);
    const candles = database.getCandles(meta.assetId, cli.interval, 10_000);

    if (candles.length < 61) {
      console.error(
        `Only ${candles.length} bars for ${meta.assetId} ${cli.interval} — need > 60.`,
      );
      process.exit(1);
    }

    console.log(
      `\nBacktest ${asset.displaySymbol} (MT5 broker data) [${cli.model}] ` +
        `${cli.interval} | ${candles.length} bars\n`,
    );
    console.log(
      `  Spread: ${meta.spreadBps.toFixed(2)} bps (measured from your broker)\n`,
    );

    if (cli.sweep) {
      // ─── Parameter sweep on broker data ───
      console.log("Running parameter sweep...\n");
      const ranked = runSweep(candles, asset, {
        base: asset.config,
        splitRatio: 0.7,
        minTrades: 5,
        topK: 10,
      });

      if (ranked.length === 0) {
        console.log("No configs produced enough trades to be scored.");
        process.exit(0);
      }

      console.log(
        "Rank  WinRate  PF      Net pts  Trades  OOS score  atrSl  tp2R  emaF  emaM",
      );
      console.log("─".repeat(85));
      for (let i = 0; i < ranked.length; i++) {
        const r = ranked[i];
        const m = computeMetrics(
          runBacktest(
            candles,
            r.config,
            asset.pricePrecision,
            60,
            asset.costs,
            cli.model,
          ),
        );
        console.log(
          `  ${String(i + 1).padStart(2)}   ` +
            `${fmt(m.winRate).padStart(6)}%  ` +
            `${(m.profitFactor === null ? "∞" : fmt(m.profitFactor)).padStart(5)}   ` +
            `${fmt(m.netPoints).padStart(8)}  ` +
            `${String(m.trades).padStart(6)}  ` +
            `${oosLabel(r.outOfSampleScore).padStart(9)}  ` +
            `${fmt(r.config.atrSlMultiplier).padStart(5)}  ` +
            `${fmt(r.config.tp2R).padStart(4)}  ` +
            `${String(r.config.emaFast).padStart(4)}  ` +
            `${String(r.config.emaMid).padStart(4)}`,
        );
      }
      console.log("");
      console.log(
        "OOS score = out-of-sample (held-out 30%). Pick a config where OOS is positive.",
      );
      console.log(
        "The sweep proposes; it does not apply. Paste the config you want into core/assets.ts.\n",
      );
      process.exit(0);
    }

    // ─── Single backtest on broker data ───
    const trades = runBacktest(
      candles,
      asset.config,
      asset.pricePrecision,
      60,
      asset.costs,
      cli.model,
    );
    const m = computeMetrics(trades);

    console.log("─── Results (net of spread + slippage) ───");
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
    console.log("─── Edge ───");
    console.log(`Gross points:   ${fmt(m.grossPoints)}`);
    console.log(`Cost paid:      ${fmt(m.costPoints)} pts`);
    console.log(`Expectancy:     ${fmt(m.expectancyPerTrade)} pts/trade`);
    console.log(
      `Breakeven WR:   ${m.breakevenWinRate === null ? "n/a" : `${fmt(m.breakevenWinRate)}%`}` +
        `   (actual ${fmt(m.winRate)}%)`,
    );
    console.log(
      m.expectancyPerTrade > 0
        ? "  → positive expectancy after costs on this window"
        : "  → NO edge after costs on this window",
    );
    console.log("");
    process.exit(0);
  }

  // ─── Binance source (original path) ───
  const asset = getAsset(cli.asset);
  if (!asset) {
    console.error(
      `Unknown asset "${cli.asset}". Known assets: see core/assets.ts`,
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
      `${cli.interval} [${cli.model}] | ${cli.from} → ${cli.to}\n`,
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

  const trades = runBacktest(
    candles,
    asset.config,
    asset.pricePrecision,
    60,
    asset.costs,
    cli.model,
  );
  const m = computeMetrics(trades);

  console.log("─── Results (net of spread, fees and slippage) ───");
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
  console.log("─── Edge ───");
  console.log(`Gross points:   ${fmt(m.grossPoints)}`);
  console.log(`Cost paid:      ${fmt(m.costPoints)} pts`);
  console.log(`Expectancy:     ${fmt(m.expectancyPerTrade)} pts/trade`);
  console.log(
    `Breakeven WR:   ${m.breakevenWinRate === null ? "n/a" : `${fmt(m.breakevenWinRate)}%`}` +
      `   (actual ${fmt(m.winRate)}%)`,
  );
  console.log(
    m.expectancyPerTrade > 0
      ? "  → positive expectancy after costs on this window"
      : "  → NO edge after costs on this window",
  );
  console.log("");
}

main().catch(err => {
  console.error("Backtest error:", err);
  process.exit(1);
});
