/**
 * Import MetaTrader 5 CSV exports into the candle database.
 *
 * Usage:
 *   bun run scripts/import-csv.ts <file.csv> [--asset XAUUSD] [--interval 5m]
 *
 * The interval is inferred from the filename if it contains M5, M15, M30, or H1.
 * Timestamps in the CSV are assumed UTC (MT5 export with server-time already
 * converted by the user or matching UTC).
 */

import { readFileSync } from "fs";
import { basename } from "path";
import type { Candle } from "../core/strategy";
import { db as openDb } from "../server/db";

const INTERVAL_MAP: Record<string, string> = {
  M1: "1m",
  M5: "5m",
  M15: "15m",
  M30: "30m",
  H1: "1h",
  H4: "4h",
  D1: "1d",
};

function inferInterval(filename: string): string | null {
  for (const [mt5, interval] of Object.entries(INTERVAL_MAP)) {
    if (filename.includes(`_${mt5}_`) || filename.includes(`_${mt5}.`)) {
      return interval;
    }
  }
  return null;
}

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let asset = "XAUUSD";
  let interval: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--asset" && argv[i + 1]) {
      asset = argv[++i];
    } else if (argv[i] === "--interval" && argv[i + 1]) {
      interval = argv[++i];
    } else if (!argv[i].startsWith("--")) {
      files.push(argv[i]);
    }
  }
  return { files, asset, interval };
}

function parseCsv(text: string): Candle[] {
  const lines = text.split("\n");
  const candles: Candle[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("Date"))
      continue;

    const parts = trimmed.split("\t");
    if (parts.length < 6) continue;

    const [dateStr, timeStr, open, high, low, close, tickvol] = parts;
    const dt = `${dateStr.replace(/\./g, "-")}T${timeStr}Z`;
    const time = Math.floor(new Date(dt).getTime() / 1000);
    if (Number.isNaN(time)) continue;

    candles.push({
      time,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(tickvol) || 0,
    });
  }
  return candles;
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.files.length === 0) {
    console.error("Usage: bun run scripts/import-csv.ts <file.csv> [...]");
    process.exit(1);
  }

  const database = openDb();

  for (const file of cli.files) {
    const interval = cli.interval ?? inferInterval(basename(file)) ?? "5m";
    const text = readFileSync(file, "utf-8");
    const candles = parseCsv(text);

    if (candles.length === 0) {
      console.error(`No candles parsed from ${file}`);
      continue;
    }

    const assetId = `mt5:${cli.asset}`;
    database.saveCandles(assetId, interval, candles);
    console.log(
      `${basename(file)}: ${candles.length} bars → ${assetId} ${interval}` +
        ` (${new Date(candles[0].time * 1000).toISOString().slice(0, 10)}` +
        ` to ${new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)})`,
    );
  }
}

main();
