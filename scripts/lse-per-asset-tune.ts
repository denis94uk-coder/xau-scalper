/**
 * Per-asset LSE tune for NAS100 / FTSE / GER.
 *
 * Each asset gets its OWN discovery (no sharing) across 15m/30m/1h.
 * Stage A: 800 random configs per interval (models breakout/trend/reversion/momentum).
 * Stage B: 400-iteration local refinement around the best qualified config (tight radius).
 *
 * Writes per-asset winner to lse:strategies (isolated from main engine) when --adopt.
 * Also pins every qualified candidate to discovered_strategies for the Strategy Carpet.
 *
 * Usage:
 *   bun run scripts/lse-per-asset-tune.ts                  # 15m+30m+1h, 800 each
 *   bun run scripts/lse-per-asset-tune.ts --only NAS100    # single asset
 *   bun run scripts/lse-per-asset-tune.ts --adopt          # promote winners
 *   bun run scripts/lse-per-asset-tune.ts --iterations 400 --refine 0  # no refine
 */
import { LSE_UNIVERSE, lseAsset } from "../core/assets";
import type { BacktestModel } from "../core/backtest";
import {
  DEFAULT_SEARCH_SPACE,
  discover,
  type DiscoveryReport,
  sampleConfig,
} from "../core/discovery";
import { Db } from "../server/db";
import { confirmFor } from "../server/lse-engine";
import { computeMetrics, runBacktest } from "../core/backtest";

const STRATEGIES_KEY = "lse:strategies";
const MODELS: BacktestModel[] = ["breakout", "trend", "reversion", "momentum"];

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

function daysFlag(): number {
  return Number(flag("days") ?? 8000);
}
function iterationsFlag(): number {
  return Number(flag("iterations") ?? 800);
}
function refineFlag(): number {
  return Number(flag("refine") ?? 400);
}

async function discoverOne(
  db: Db,
  id: string,
  interval: string,
  days: number,
  iterations: number,
  seedBase: number,
): Promise<DiscoveryReport | null> {
  const inst = LSE_UNIVERSE.find(u => u.id === id);
  if (!inst) return null;
  const meta = db.getSetting<{ symbol: string; digits: number; assetId: string; spreadBps: number }>(`lse:${id}`);
  if (!meta) {
    console.log(`  ${id} no lse: spec — skip`);
    return null;
  }
  const asset = lseAsset(meta);
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const candles = db.getCandleRange(id, interval, from, to);
  if (candles.length < 800) {
    console.log(`  ${id}@${interval} ${candles.length} bars — skip`);
    return null;
  }
  const t0 = Date.now();
  const report = discover(candles, asset, {
    iterations,
    space: DEFAULT_SEARCH_SPACE,
    seed: seedBase,
    models: MODELS,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const q = report.candidates.filter(c => c.verdict === "qualified").length;
  console.log(`  ${id}@${interval} ${report.evaluated} tried in ${secs}s — ${q} qualified  bars=${candles.length}`);

  // pin qualified to carpet
  for (const c of report.candidates.filter(c => c.verdict === "qualified")) {
    try {
      db.pinDiscovered({
        assetId: id,
        symbol: meta.symbol,
        interval,
        config: c.config,
        model: c.model,
        testMetrics: c.test,
        overallMetrics: c.overall,
        adjustedP: c.adjustedPValue,
        walkForward: c.walkForward,
        runId: `lse-tune-${id}-${interval}-${to}`,
      });
    } catch {}
  }
  return report;
}

function localRefine(
  db: Db,
  id: string,
  interval: string,
  base: DiscoveryReport["candidates"][number],
  days: number,
  iterations: number,
): typeof base | null {
  const inst = LSE_UNIVERSE.find(u => u.id === id)!;
  const meta = db.getSetting<any>(`lse:${id}`);
  const asset = lseAsset(meta);
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const candles = db.getCandleRange(id, interval, from, to);
  // tight radius: ±12% numeric, keep family same
  const tight: typeof DEFAULT_SEARCH_SPACE = {};
  for (const [k, bound] of Object.entries(DEFAULT_SEARCH_SPACE)) {
    if (!bound) continue;
    const v = (base.config as any)[k] as number;
    if (v === undefined) { tight[k] = bound; continue; }
    const span = (bound.max - bound.min) * 0.12;
    // clamp to global bounds
    const lo = Math.max(bound.min, v - span);
    const hi = Math.min(bound.max, v + span);
    tight[k] = { min: lo, max: hi, integer: bound.integer } as any;
  }

  // reuse discover machinery but with tight space and single model
  const report = discover(candles, asset, {
    iterations,
    space: tight,
    seed: 9999 + base.config.emaFast,
    models: [base.model as BacktestModel],
  });
  const best = report.best;
  if (!best || best.verdict !== "qualified") return null;
  // is it better on test netPoints than base?
  if (best.test.netPoints > base.test.netPoints) {
    console.log(`    refine: ${base.test.netPoints.toFixed(1)} → ${best.test.netPoints.toFixed(1)} netPoints (${iterations} tries)`);
    // pin refinement winner too
    try {
      db.pinDiscovered({
        assetId: id,
        symbol: meta.symbol,
        interval,
        config: best.config,
        model: best.model,
        testMetrics: best.test,
        overallMetrics: best.overall,
        adjustedP: best.adjustedPValue,
        walkForward: best.walkForward,
        runId: `lse-tune-refine-${id}-${interval}-${to}`,
      });
    } catch {}
    return best;
  }
  console.log(`    refine: no gain (best ${base.test.netPoints.toFixed(1)} vs refine-best ${best.test.netPoints.toFixed(1)})`);
  return null;
}

async function main() {
  const only = flag("only")?.split(",").map(s => s.trim().toUpperCase());
  const intervals = (flag("intervals") ?? "15m,30m,1h").split(",").map(s => s.trim());
  const days = daysFlag();
  const iterations = iterationsFlag();
  const refineIters = refineFlag();
  const adopt = !!flag("adopt");
  const seedBase = Number(flag("seed") ?? 42);

  const db = new Db();
  const universe = ["NAS100", "FTSE", "GER"];
  const targets = only ? universe.filter(u => only.includes(u)) : universe;

  console.log(`Per-asset LSE tune · assets=${targets.join(",")} · intervals=${intervals.join(",")} · ${iterations}+${refineIters} iters · ${days}d ${adopt ? "· ADOPTING" : ""}\n`);

  const store = adopt ? (db.getSetting<Record<string, any>>(STRATEGIES_KEY) ?? {}) : {} as Record<string, any>;
  const summary: Array<{ id: string; interval: string; best: any; report: DiscoveryReport }> = [];

  let seed = seedBase;
  for (const id of targets) {
    const perAssetReports: Array<{ interval: string; report: DiscoveryReport }> = [];
    for (const iv of intervals) {
      seed += 17;
      const report = await discoverOne(db, id, iv, days, iterations, seed);
      if (report) perAssetReports.push({ interval: iv, report });
    }
    if (perAssetReports.length === 0) continue;

    // pick overall best qualified across intervals for this asset
    let bestOverall: { interval: string; cand: any } | null = null;
    for (const { interval, report } of perAssetReports) {
      if (!report.best) continue;
      if (!bestOverall || report.best.test.netPoints > bestOverall.cand.test.netPoints) {
        bestOverall = { interval, cand: report.best };
      }
    }

    if (!bestOverall) {
      console.log(`${id}: nothing qualified across all intervals — correct null result`);
      continue;
    }

    console.log(`${id} winner raw: ${bestOverall.cand.model}@${bestOverall.interval} PF ${bestOverall.cand.test.profitFactor?.toFixed(2) ?? "?"} WR ${(bestOverall.cand.test.winRate).toFixed(1)}% ${bestOverall.cand.test.trades}tr p=${bestOverall.cand.adjustedPValue.toExponential(1)} | ${bestOverall.cand.summary}`);

    // stage B refinement
    let winner = bestOverall.cand;
    let winnerInterval = bestOverall.interval;
    if (refineIters > 0) {
      const refined = localRefine(db, id, winnerInterval, winner, days, refineIters);
      if (refined) winner = refined;
    }

    summary.push({ id, interval: winnerInterval, best: winner, report: perAssetReports.find(r => r.interval === winnerInterval)!.report });

    if (adopt) {
      store[id] = {
        family: winner.model,
        config: winner.config,
        interval: winnerInterval,
        confirm: confirmFor(winnerInterval),
        adjustedP: winner.adjustedPValue,
        adoptedAt: Date.now(),
      };
      console.log(`  → ADOPTED ${id}: ${winner.model}@${winnerInterval} confirm=${confirmFor(winnerInterval) ?? "none"}`);
    }
  }

  if (adopt && Object.keys(store).length) {
    // also mirror FTSE→UK100 and GER→DE30 aliases so both ids trade identically
    if (store["FTSE"] && !store["UK100"]) store["UK100"] = { ...store["FTSE"] };
    if (store["UK100"] && !store["FTSE"]) store["FTSE"] = { ...store["UK100"] };
    if (store["GER"] && !store["DE30"]) store["DE30"] = { ...store["GER"] };
    if (store["DE30"] && !store["GER"]) store["GER"] = { ...store["DE30"] };
    db.setSetting(STRATEGIES_KEY, store);
    console.log(`\nAdopted ${Object.keys(store).length} entries to ${STRATEGIES_KEY}`);
  }

  console.log("\n" + "─".repeat(78));
  console.log("SUMMARY");
  for (const s of summary) {
    const b = s.best;
    console.log(`${s.id.padEnd(6)} ${b.model.padEnd(10)} @${s.interval.padEnd(4)}  PF ${b.test.profitFactor?.toFixed(2) ?? " - "}  WR ${(b.test.winRate).toFixed(1).padStart(5)}%  trades ${String(b.test.trades).padStart(4)}  net ${b.test.netPoints.toFixed(0).padStart(6)}  p=${b.adjustedPValue.toExponential(1)}  folds ${b.walkForward?.profitableFolds ?? "?"}/${b.walkForward?.foldNetPoints.length ?? "?"}`);
    console.log(`       train ${b.train.netPoints.toFixed(0)} / val ${b.validation.netPoints.toFixed(0)} / test ${b.test.netPoints.toFixed(0)}  cost ${b.overall.costPoints.toFixed(0)}  breakeven ${(b.overall.breakevenWinRate ?? 50).toFixed(1)}%`);
  }

  // final backtest table per adopted strategy over full history
  if (summary.length) {
    console.log("\nFull-history verify (net/gross/winRate after costs):");
    for (const s of summary) {
      const meta = db.getSetting<any>(`lse:${s.id}`);
      const asset = lseAsset(meta, s.best.config, s.best.model as any);
      const candles = db.getCandleRange(s.id, s.interval, Math.floor(Date.now()/1000)-8000*86400, Math.floor(Date.now()/1000));
      const trades = runBacktest(candles, s.best.config, asset.pricePrecision, 60, asset.costs, s.best.model as any);
      const m = computeMetrics(trades);
      console.log(`${s.id}@${s.interval} full: ${m.trades} trades PF ${m.profitFactor?.toFixed(2) ?? "-"} WR ${m.winRate.toFixed(1)}% net ${m.netPoints.toFixed(0)} gross ${m.grossPoints.toFixed(0)} cost ${m.costPoints.toFixed(0)}`);
    }
  }

  db.close();
}

main();
