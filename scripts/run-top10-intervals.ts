import { getAsset, unconfiguredExchangeAsset } from "../core/assets";
import type { BacktestModel } from "../core/backtest";
import { DEFAULT_SEARCH_SPACE, discover } from "../core/discovery";
import { Db } from "../server/db";
import { fetchCandleRange } from "../server/market";

const TOP10 = [
  "JSTUSDT",
  "ONGUSDT",
  "PAXGUSDT",
  "SPKUSDT",
  "FFUSDT",
  "POLUSDT",
  "QQQBUSDT",
  "SPCXBUSDT",
  "SPYBUSDT",
  "TRXUSDT",
];

const INTERVALS: Array<{ interval: string; days: number }> = [
  { interval: "5m", days: 120 },
  { interval: "15m", days: 180 },
  { interval: "30m", days: 180 },
  { interval: "1h", days: 365 },
];

const ITERATIONS = 150;
const SEED = 42;
const MODELS: BacktestModel[] = [
  "combined",
  "trend",
  "reversion",
  "breakout",
  "momentum",
];
const PAGE_DELAY_MS = 350;

async function runOne(assetId: string, interval: string, days: number, db: Db) {
  const asset = getAsset(assetId) ?? unconfiguredExchangeAsset(assetId);
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  let candles;
  try {
    candles = await fetchCandleRange(
      asset.dataSourceSymbol,
      interval,
      from,
      to,
      { pageDelayMs: PAGE_DELAY_MS },
    );
  } catch (e) {
    console.log(
      `  ${assetId} ${interval} fetch failed: ${e instanceof Error ? e.message : e}`,
    );
    return { qualified: 0, total: 0, skipped: "fetch" };
  }
  if (candles.length < 600) {
    console.log(
      `  ${assetId} ${interval} only ${candles.length} bars — skipped`,
    );
    return { qualified: 0, total: 0, skipped: "bars" };
  }
  const report = discover(candles, asset, {
    iterations: ITERATIONS,
    space: DEFAULT_SEARCH_SPACE,
    seed: SEED,
    models: MODELS,
  });
  const qualified = report.candidates.filter(c => c.verdict === "qualified");
  for (const c of qualified) {
    try {
      db.pinDiscovered({
        assetId: asset.id,
        symbol: asset.dataSourceSymbol,
        interval,
        config: c.config,
        model: c.model,
        testMetrics: c.test,
        overallMetrics: c.overall,
        adjustedP: c.adjustedPValue,
        walkForward: c.walkForward,
        runId: `top10-${asset.id}-${interval}-${to}`,
      });
    } catch {}
  }
  if (qualified.length > 0) {
    for (const c of qualified) {
      console.log(
        `    -> qualified [${c.model}] test ${c.test.netPoints.toFixed(1)} pts ${c.test.trades} trades p=${c.adjustedPValue.toFixed(4)} ${c.summary.slice(0, 120)}`,
      );
    }
  }
  return {
    qualified: qualified.length,
    total: report.evaluated,
    best: report.best,
  };
}

async function main() {
  const db = new Db();
  let grandQualified = 0;
  let grandTried = 0;
  for (const { interval, days } of INTERVALS) {
    console.log(
      `\n=== INTERVAL ${interval} ${days}d ${ITERATIONS} configs each × ${TOP10.length} assets ===`,
    );
    let intervalQualified = 0;
    let intervalTried = 0;
    for (const assetId of TOP10) {
      const res = await runOne(assetId, interval, days, db);
      intervalTried += res.total;
      intervalQualified += res.qualified;
      const tag = res.skipped
        ? `(${res.skipped})`
        : `${res.total} tried — ${res.qualified} qualified`;
      if (!res.qualified) console.log(`  ${assetId.padEnd(12)} ${tag}`);
      else console.log(`  ${assetId.padEnd(12)} ${tag} ★`);
    }
    console.log(
      `=> ${interval}: ${intervalQualified} qualified / ${intervalTried} tried`,
    );
    grandQualified += intervalQualified;
    grandTried += intervalTried;
  }
  console.log(
    `\nDONE all intervals: ${grandQualified} qualified / ${grandTried} tried across ${TOP10.length} × ${INTERVALS.length} runs`,
  );
  db.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
