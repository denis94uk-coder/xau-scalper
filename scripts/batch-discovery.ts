/**
 * Batch strategy discovery across the whole crypto registry.
 *
 *   bun run discover                                  # 15m, 1y, 300 tries per asset
 *   bun run discover -- --interval 5m --days 120     # match the live 5m engine
 *   bun run discover -- --only BTCUSDT,SOLUSDT       # a few assets
 *   bun run discover -- --adopt                      # also install winners
 *
 * WHAT IT DOES
 * For every enabled binance asset it pulls the date range from the free feed,
 * runs `core/discovery` (three-window split, walk-forward, Šidák correction),
 * pins every QUALIFIED candidate to the Strategy Carpet, and — only with
 * --adopt — installs each asset's single best qualified config into the live
 * configuration.
 *
 * WHY A BATCH SCRIPT
 * The Find Strategies page searches one instrument at a time and someone has
 * to click. Fifty assets is a chore by hand and a cron job by nature. The
 * statistics are identical: most assets will correctly report that nothing
 * survived, and that null result is the machinery working, not failing.
 *
 * HONESTY RULES CARRIED OVER
 * A candidate reaches the Carpet only by surviving data it never influenced.
 --adopt touches a config ONLY when its asset produced a qualified best;
 * everything else keeps whatever it had. Costs are netted throughout.
 */

import { getEnabledAssets } from "../core/assets";
import type { BacktestModel } from "../core/backtest";
import {
  type Candidate,
  DEFAULT_SEARCH_SPACE,
  discover,
} from "../core/discovery";
import type { Candle } from "../core/strategy";
import { ConfigStore } from "../server/config";
import { Db } from "../server/db";
import { fetchCandleRange } from "../server/market";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

async function main() {
  const interval = flag("interval") ?? "15m";
  const days = Number(flag("days") ?? 365);
  const iterations = Number(flag("iterations") ?? 300);
  const seed = Number(flag("seed") ?? 42);
  const adopt = Boolean(flag("adopt"));
  const models = (
    flag("models") ?? "combined,trend,reversion,breakout,momentum"
  )
    .split(",")
    .map(s => s.trim()) as BacktestModel[];
  const only = flag("only")
    ?.split(",")
    .map(s => s.trim().toUpperCase());

  // ~450ms between pages keeps a multi-thousand-page sweep inside the free
  // feed's weight budget. Interactive single-asset runs barely notice it.
  const pageDelayMs = Number(flag("page-delay-ms") ?? 450);

  const db = new Db();
  const store = new ConfigStore(db);

  let assets = getEnabledAssets().filter(a => a.dataSource === "binance");
  if (only) assets = assets.filter(a => only.includes(a.id));

  if (assets.length === 0) {
    console.error(
      "No enabled binance assets matched. Check --only or the config.",
    );
    process.exit(1);
  }

  console.log(
    `Discovering on ${assets.length} assets · ${interval} · ${days}d · ` +
      `${iterations} configs each · models: ${models.join(",")}` +
      `${adopt ? " · adopting winners" : ""}\n`,
  );

  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const startedAll = Date.now();

  let pinnedTotal = 0;
  let qualifiedAssets = 0;
  const winners = new Map<
    string,
    {
      config: Candidate["config"];
      model: Candidate["model"];
      testNet: number;
      trades: number;
    }
  >();

  for (const [index, asset] of assets.entries()) {
    const label = `[${index + 1}/${assets.length}] ${asset.id.padEnd(12)}`;
    let candles: Candle[];
    try {
      candles = await fetchCandleRange(
        asset.dataSourceSymbol,
        interval,
        from,
        to,
        { pageDelayMs },
      );
    } catch (e) {
      console.log(
        `${label} fetch failed: ${e instanceof Error ? e.message : e}`,
      );
      continue;
    }

    if (candles.length < 800) {
      console.log(
        `${label} ${candles.length} bars — not enough history, skipped`,
      );
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
          assetId: asset.id,
          symbol: asset.dataSourceSymbol,
          interval,
          config: c.config,
          model: c.model,
          testMetrics: c.test,
          overallMetrics: c.overall,
          adjustedP: c.adjustedPValue,
          walkForward: c.walkForward,
          runId: `batch-${asset.id}-${interval}-${to}`,
        });
        pinnedTotal++;
      } catch {
        // A pin failure must not fail the sweep; the summary still reports.
      }
    }

    const best: Candidate | null = report.best;
    if (best) {
      qualifiedAssets++;
      console.log(
        `             winner [${best.model}]: ${best.test.netPoints.toFixed(1)} pts on test, ` +
          `${best.test.trades} trades, p=${best.adjustedPValue.toFixed(4)}`,
      );
      if (adopt) {
        winners.set(asset.id, {
          config: best.config,
          model: best.model,
          testNet: best.test.netPoints,
          trades: best.test.trades,
        });
      }
    } else {
      console.log(`             ${report.conclusion.split(".")[0]}.`);
    }
  }

  if (winners.size > 0) {
    const fresh = store.get();
    // Merged over the current config so an older report cannot un-set a knob
    // the validator now requires — same rule as the research adopt route.
    // The model travels with the config: a strategy must be traded under the
    // model it was measured with.
    const updated = fresh.assets.map(a => {
      const win = winners.get(a.id);
      return win
        ? {
            ...a,
            model: win.model === "combined" ? undefined : win.model,
            config: { ...a.config, ...win.config },
          }
        : a;
    });
    try {
      store.save({ ...fresh, assets: updated });
    } catch (e) {
      console.error(
        "Adoption failed to save — the Carpet still holds every result:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  console.log(
    `\nDone in ${((Date.now() - startedAll) / 60_000).toFixed(1)} min. ` +
      `${qualifiedAssets}/${assets.length} assets produced a qualified strategy; ` +
      `${pinnedTotal} candidate(s) pinned to the Strategy Carpet.` +
      (adopt ? ` ${winners.size} config(s) adopted.` : ""),
  );
  db.close();
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
