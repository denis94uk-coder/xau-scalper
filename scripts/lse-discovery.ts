/**
 * Batch strategy discovery over the LSE research universe, from the local DB.
 *
 *   bun run scripts/lse-discovery.ts                                  # 15m, 2y, 300 tries
 *   bun run scripts/lse-discovery.ts -- --interval 1h --days 3650     # deep 1h
 *   bun run scripts/lse-discovery.ts -- --only XAUUSD,EURUSD
 *   bun run scripts/lse-discovery.ts -- --models reversion,trend
 *
 * WHAT IT DOES
 * For every LSE instrument it loads bars from the candle database (pulled by
 * scripts/import-lse.ts), runs `core/discovery` (three-window split,
 * walk-forward, Šidák correction), pins every QUALIFIED candidate to the
 * Strategy Carpet, and prints each asset's best.
 *
 * WHY A SEPARATE SCRIPT
 * scripts/batch-discovery.ts fetches from Binance and iterates the crypto
 * registry; this one reads the LSE backfill instead. The statistics are
 * identical — same discovery core, same honesty rules: a candidate reaches
 * the Carpet only by surviving data it never influenced, and costs are netted
 * throughout using the pessimistic spread assumptions in LSE_UNIVERSE.
 */

import { LSE_UNIVERSE, lseAsset } from "../core/assets";
import type { BacktestModel } from "../core/backtest";
import {
  type Candidate,
  DEFAULT_SEARCH_SPACE,
  discover,
} from "../core/discovery";
import type { Candle } from "../core/strategy";
import { Db } from "../server/db";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

async function main() {
  const interval = flag("interval") ?? "15m";
  const days = Number(flag("days") ?? 730);
  const iterations = Number(flag("iterations") ?? 300);
  const seed = Number(flag("seed") ?? 42);
  const models = (flag("models") ?? "reversion,trend,breakout,momentum")
    .split(",")
    .map(s => s.trim()) as BacktestModel[];
  const only = flag("only")
    ?.split(",")
    .map(s => s.trim().toUpperCase());

  const db = new Db();
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const startedAll = Date.now();

  let universe = LSE_UNIVERSE;
  if (only) universe = universe.filter(i => only.includes(i.id));
  if (universe.length === 0) {
    console.error(
      `No LSE instruments matched. Universe: ${LSE_UNIVERSE.map(i => i.id).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(
    `LSE discovery on ${universe.length} instruments · ${interval} · ${days}d · ` +
      `${iterations} configs each · models: ${models.join(",")}\n`,
  );

  let pinnedTotal = 0;
  const summary: Array<{
    id: string;
    best: Candidate | null;
    qualified: number;
    evaluated: number;
  }> = [];

  for (const [index, inst] of universe.entries()) {
    const label = `[${index + 1}/${universe.length}] ${inst.id.padEnd(8)}`;
    const meta = db.getSetting<{
      symbol: string;
      digits: number;
      assetId: string;
      spreadBps: number;
    }>(`lse:${inst.id}`);
    if (!meta) {
      console.log(`${label} no lse: spec — run scripts/import-lse.ts first`);
      continue;
    }
    const asset = lseAsset(meta);
    const candles: Candle[] = db.getCandleRange(inst.id, interval, from, to);
    if (candles.length < 800) {
      console.log(`${label} ${candles.length} bars — not enough, skipped`);
      continue;
    }

    const started = Date.now();
    const report = discover(candles, asset, {
      iterations,
      space: DEFAULT_SEARCH_SPACE,
      seed,
      models,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(0);

    const qualified = report.candidates.filter(c => c.verdict === "qualified");
    console.log(
      `${label} ${report.evaluated} tried in ${secs}s — ${qualified.length} qualified`,
    );

    for (const c of qualified) {
      try {
        db.pinDiscovered({
          assetId: inst.id,
          symbol: meta.symbol,
          interval,
          config: c.config,
          model: c.model,
          testMetrics: c.test,
          overallMetrics: c.overall,
          adjustedP: c.adjustedPValue,
          walkForward: c.walkForward,
          runId: `lse-${inst.id}-${interval}-${to}`,
        });
        pinnedTotal++;
      } catch {
        // A pin failure must not fail the sweep; the summary still reports.
      }
    }

    summary.push({
      id: inst.id,
      best: report.best,
      qualified: qualified.length,
      evaluated: report.evaluated,
    });
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(
    `SUMMARY · ${pinnedTotal} candidates pinned to the Carpet · ` +
      `${((Date.now() - startedAll) / 60000).toFixed(1)} min\n`,
  );
  for (const s of summary) {
    const b = s.best;
    if (!b) {
      console.log(
        `${s.id.padEnd(8)} — nothing survived (correct answer for most)`,
      );
      continue;
    }
    console.log(
      `${s.id.padEnd(8)} best: ${b.model.padEnd(9)} PF ${b.test.profitFactor?.toFixed(2) ?? "?"} ` +
        `WR ${(b.test.winRate * 100).toFixed(1)}% · ${b.test.trades} trades · ` +
        `p(adj) ${b.adjustedPValue.toExponential(1)} · ${s.qualified}/${s.evaluated} qualified`,
    );
  }
  db.close();
}

main();
