/**
 * Scan macro-conditioned hypotheses (DXY, Treasury yields) against H1 XAUUSD.
 *
 * Fetches daily DXY and yield data from the FMP API, aligns them with the
 * broker's H1 gold bars, and runs the edge scanner with Šidák correction.
 *
 * Usage:
 *   FINANCIAL_MODELING_PREP_API_KEY=<key> bun run scripts/macro-edgescan.ts
 *
 * The scanner operates on H1 bars (not M5) because macro data is daily:
 * within a single day there is no additional yield or DXY reading, so testing
 * on M5 would produce artificially inflated N by reusing the same macro
 * reading 288 times. H1 is the finest granularity that still has a one-to-many
 * relationship with the daily macro input.
 */

import { mt5Asset } from "../core/assets";
import { MIN_OCCURRENCES, scanEdges, survives } from "../core/edgescan";
import {
  buildSeries,
  dxyAligned,
  dxyContrarian,
  largeYieldMove,
  realYieldProxy,
  yieldCurveSlope,
  yieldDirectionGold,
} from "../core/macro-hypotheses";
import { db as openDb } from "../server/db";

const FMP_BASE = "https://financialmodelingprep.com/api/v3";
const API_KEY = process.env.FINANCIAL_MODELING_PREP_API_KEY ?? "";

interface FmpTreasuryRecord {
  date: string;
  month1: number | null;
  month2: number | null;
  month3: number | null;
  month6: number | null;
  year1: number | null;
  year2: number | null;
  year3: number | null;
  year5: number | null;
  year7: number | null;
  year10: number | null;
  year20: number | null;
  year30: number | null;
}

interface FmpHistoricalRecord {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
}

async function fetchTreasury(): Promise<FmpTreasuryRecord[]> {
  const url = `${FMP_BASE}/treasury?apikey=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP treasury fetch failed: ${res.status}`);
  return res.json() as Promise<FmpTreasuryRecord[]>;
}

async function fetchHistorical(
  symbol: string,
  from?: string,
): Promise<FmpHistoricalRecord[]> {
  let url = `${FMP_BASE}/historical-price-full/${symbol}?apikey=${API_KEY}`;
  if (from) url += `&from=${from}`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`FMP historical fetch for ${symbol} failed: ${res.status}`);
  const json = (await res.json()) as { historical?: FmpHistoricalRecord[] };
  return json.historical ?? [];
}

async function main() {
  if (!API_KEY) {
    console.error("Set FINANCIAL_MODELING_PREP_API_KEY in your environment.");
    process.exit(1);
  }

  const database = openDb();
  const meta = database.getSetting<{
    symbol: string;
    digits: number;
    assetId: string;
    spreadBps: number;
  }>("mt5:XAUUSD");

  if (!meta) {
    console.error("No MT5 XAUUSD data. Run 'bun run mt5:sync' first.");
    process.exit(1);
  }

  const asset = mt5Asset(meta);
  const candles = database.getCandles(meta.assetId, "1h", 100_000);

  if (candles.length < 200) {
    console.error(
      `Only ${candles.length} H1 bars. Import the H1 CSV first (bun run scripts/import-csv.ts).`,
    );
    process.exit(1);
  }

  const firstDate = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
  console.log(
    `H1 bars: ${candles.length} (${firstDate} → ${new Date(candles.at(-1)!.time * 1000).toISOString().slice(0, 10)})`,
  );

  console.log("\nFetching macro data from FMP...");

  // Fetch in parallel
  const [treasury, dxyHist] = await Promise.all([
    fetchTreasury().catch((e: Error) => {
      console.error("Treasury fetch failed:", e.message);
      return [] as FmpTreasuryRecord[];
    }),
    fetchHistorical("DX-Y.NYB", firstDate).catch((e: Error) => {
      console.error("DXY fetch failed (trying USDX):", e.message);
      return [] as FmpHistoricalRecord[];
    }),
  ]);

  // Build macro series
  const yield10 = buildSeries(
    treasury.map(r => ({ date: r.date, value: r.year10 })),
  );
  const yield2 = buildSeries(
    treasury.map(r => ({ date: r.date, value: r.year2 })),
  );
  const yield1 = buildSeries(
    treasury.map(r => ({ date: r.date, value: r.year1 })),
  );
  const dxy = buildSeries(dxyHist.map(r => ({ date: r.date, value: r.close })));

  console.log(
    `Treasury records: ${treasury.length}  (10yr: ${yield10.size} dates, 2yr: ${yield2.size}, 1yr: ${yield1.size})`,
  );
  console.log(`DXY records: ${dxy.size} dates`);

  // If DXY fetch failed or returned nothing, try EURUSD as inverse proxy
  if (dxy.size === 0) {
    console.log("DXY unavailable — skipping DXY hypotheses.");
  }

  if (yield10.size === 0) {
    console.error("No Treasury data. Cannot run yield hypotheses.");
    process.exit(1);
  }

  // Build hypotheses (only include ones where we have data)
  const hypotheses = [
    ...(dxy.size > 0 ? [dxyAligned(dxy), dxyContrarian(dxy)] : []),
    yieldDirectionGold(yield10),
    largeYieldMove(yield10, 0.05),
    largeYieldMove(yield10, 0.1),
    ...(yield2.size > 0 ? [yieldCurveSlope(yield10, yield2)] : []),
    ...(yield1.size > 0 ? [realYieldProxy(yield10, yield1)] : []),
  ];

  const HORIZON = 8; // 8 H1 bars = next trading day

  console.log(
    `\nScanning ${hypotheses.length} macro hypotheses with H=${HORIZON}h horizon...\n`,
  );

  const report = scanEdges(candles, hypotheses, asset.costs, {
    horizonBars: HORIZON,
    windows: 6,
  });

  console.log(
    `Šidák-adjusted α for ${hypotheses.length} tests: ${report.adjustedAlpha.toFixed(5)}\n`,
  );
  console.log("─".repeat(90));
  console.log(
    `${"Hypothesis".padEnd(28)} ${"N".padStart(5)} ${"Mean".padStart(8)} ${"p-value".padStart(10)} ${"WF wins".padStart(8)}  Survives?`,
  );
  console.log("─".repeat(90));

  for (const r of report.results) {
    if (r.n < MIN_OCCURRENCES) {
      console.log(
        `${r.name.padEnd(28)} ${"<30".padStart(5)}  (not enough occurrences to measure)`,
      );
      continue;
    }

    const passes = survives(r, report);
    const star = passes ? " ✓ SURVIVES" : "";
    console.log(
      `${r.name.padEnd(28)} ${String(r.n).padStart(5)} ${r.meanNet >= 0 ? "+" : ""}${r.meanNet.toFixed(3).padStart(7)} ${r.pValue.toFixed(4).padStart(10)} ${`${r.windowsPositive}/6`.padStart(8)}${star}`,
    );
  }

  console.log("─".repeat(90));

  const survivors = report.results.filter(
    r => r.n >= MIN_OCCURRENCES && survives(r, report),
  );
  if (survivors.length === 0) {
    console.log(
      "\nNo macro hypothesis survives correction. The textbook relationships may not be strong enough at H1 resolution to gate this strategy.",
    );
  } else {
    console.log(`\n${survivors.length} macro hypothesis/ses survive:`);
    for (const s of survivors) {
      console.log(
        `  • ${s.name}: +${s.meanNet.toFixed(3)} pts/trade, p=${s.pValue.toFixed(4)}, ${s.windowsPositive}/6 windows`,
      );
    }
    console.log(
      "\nNext step: wrap surviving hypotheses as additional filters in the engine.",
    );
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
