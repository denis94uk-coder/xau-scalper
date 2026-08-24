/**
 * Edge scan over the positioning catalogue: price hypotheses plus claims
 * built from perp funding and open interest.
 *
 *   bun run edgescan:positioning -- --asset BTCUSDT --interval 1h --days 400
 *
 * The full fixed catalogue runs here — gold mechanisms, crypto mechanisms,
 * and the three positioning hypotheses — because every question asked in one
 * process shares one family error rate. Data coverage is printed up front:
 * open interest history is venue-capped at roughly thirty days, so its rows
 * will honestly report "too few" on most timeframes rather than pretend.
 */

import { getAsset, unconfiguredExchangeAsset } from "../core/assets";
import type { CostModel } from "../core/costs";
import type { Hypothesis } from "../core/edgescan";
import { MIN_OCCURRENCES, scanEdges, survives } from "../core/edgescan";
import { HYPOTHESES } from "../core/hypotheses";
import { CRYPTO_HYPOTHESES } from "../core/hypotheses-crypto";
import {
  fundingExtreme,
  oiConfirmedBreakout,
  oiWashout,
} from "../core/hypotheses-positioning";
import { exchangeSymbolFor, fetchCandleRange } from "../server/market";
import {
  fetchFundingRates,
  fetchOpenInterestHistory,
} from "../server/market-futures";

function parseArgs(argv: string[]) {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        a[k] = v;
        i++;
      } else a[k] = "true";
    }
  }
  return {
    asset: a.asset ?? "BTCUSDT",
    interval: a.interval ?? "1h",
    horizon: a.horizon ? Number(a.horizon) : 12,
    windows: a.windows ? Number(a.windows) : 6,
    days: a.days ? Number(a.days) : 400,
    oiPeriod: a.oiPeriod ?? "5m",
    pageDelayMs: Number(a["page-delay-ms"] ?? 450),
  };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  const venue = exchangeSymbolFor(cli.asset.toUpperCase());
  if (!venue) {
    console.error(
      `"${cli.asset}" does not map to a Binance feed symbol. Use a USDT pair.`,
    );
    process.exit(1);
  }
  const configured = getAsset(venue);
  const asset = configured ?? unconfiguredExchangeAsset(venue);

  const to = Math.floor(Date.now() / 1000);
  const from = to - cli.days * 86_400;

  console.log(`Fetching ${venue} ${cli.interval} spot candles (${cli.days}d)…`);
  const candles = await fetchCandleRange(venue, cli.interval, from, to, {
    pageDelayMs: cli.pageDelayMs,
  });
  if (candles.length < 500) {
    console.error(`Only ${candles.length} bars — not enough to measure.`);
    process.exit(1);
  }

  console.log("Fetching perp funding settlements…");
  const funding = await fetchFundingRates(venue, from, to, {
    pageDelayMs: cli.pageDelayMs,
  });

  console.log(
    "Fetching open-interest history (venue serves only the last ~30 days)…",
  );
  const oi = await fetchOpenInterestHistory(
    venue,
    cli.oiPeriod,
    Math.max(from, to - 30 * 86_400),
    to,
    { pageDelayMs: cli.pageDelayMs },
  );

  const positioning: Hypothesis[] = [
    fundingExtreme(funding),
    oiConfirmedBreakout(oi, 24),
    oiWashout(oi),
  ];
  const all = [...HYPOTHESES, ...CRYPTO_HYPOTHESES, ...positioning];

  const costs: CostModel = asset.costs;
  const report = scanEdges(candles, all, costs, {
    horizonBars: cli.horizon,
    windows: cli.windows,
  });

  const c = costs;
  const roundTripBps =
    2 * c.halfSpreadBps + c.takerFeeBps + c.makerFeeBps + c.stopSlippageBps;

  console.log(
    `\nPositioning edge scan: ${venue} ${cli.interval} | ${candles.length} bars | hold ${cli.horizon}`,
  );
  console.log(
    `≈${roundTripBps.toFixed(1)} bps round trip · ` +
      `funding prints ${funding.length} ` +
      `(first ${funding.length ? new Date(funding[0].time * 1000).toISOString().slice(0, 10) : "—"}, last ${funding.length ? new Date(funding[funding.length - 1].time * 1000).toISOString().slice(0, 10) : "—"}) · ` +
      `OI points ${oi.length}` +
      `\n${report.hypothesesTested} hypotheses · each must beat p < ` +
      `${report.adjustedAlpha.toExponential(3)} for the set to hold\n`,
  );

  console.log(
    "hypothesis              n      mean net   worst10%   hit%       t       p        windows",
  );
  console.log("─".repeat(92));

  for (const r of report.results) {
    const flag = survives(r, report) ? "  ← survives" : "";
    const stats = r.measured
      ? `${r.tStat.toFixed(2).padStart(6)}  ${r.pValue.toFixed(4).padStart(7)}`
      : `${"—".padStart(6)}  ${"too few".padStart(7)}`;
    console.log(
      `${r.name.padEnd(22)} ` +
        `${String(r.n).padStart(5)}  ` +
        `${r.meanNet.toFixed(3).padStart(10)}  ` +
        `${r.worstDecile.toFixed(2).padStart(8)}  ` +
        `${r.hitRate.toFixed(1).padStart(5)}  ` +
        `${stats}  ` +
        `${`${r.windowsPositive}/${r.windowsJudged}`.padStart(7)}` +
        flag,
    );
  }

  const unmeasured = report.results.filter(r => !r.measured);
  if (unmeasured.length > 0) {
    console.log("");
    console.log(
      `${unmeasured.length} of ${report.results.length} fired fewer than ` +
        `${MIN_OCCURRENCES} times and are not judged either way.`,
    );
  }

  const found = report.results.filter(r => survives(r, report));
  console.log("");
  if (found.length === 0) {
    console.log(
      "Nothing survived. With positioning data now in play that says the\n" +
        "crowding claims carried no exploitable information either — at this\n" +
        "horizon, these costs, this much history.",
    );
  } else {
    for (const r of found) {
      console.log(`${r.name}: ${r.claim}`);
      console.log(
        `  ${r.meanNet.toFixed(3)} pts per occurrence over ${r.n}, positive in ` +
          `${r.windowsPositive}/${r.windowsJudged} windows.`,
      );
    }
    console.log("");
    console.log(
      "Surviving means the ENTRY carries information, not that it is tradeable\n" +
        "yet: no stop, fixed-bar exit. Next step is a real exit in runBacktest.",
    );
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
