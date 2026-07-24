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

import {
  type AssetDefinition,
  DEFAULT_ASSET_ID,
  getAsset,
} from "../convex/lib/assets";
import {
  analyzeCandles,
  type Candle,
  calcATR,
  roundTo,
} from "../convex/lib/strategy";

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

// ─── Simulated open position (mirrors a live tradingIdeas record) ───
interface OpenTrade {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  status: "ACTIVE" | "TP1_HIT";
  trailingSL?: number;
  createdAtMs: number;
}

interface ClosedTrade {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  pnlPoints: number;
  outcome: "TP1_TP2" | "SL" | "TRAIL_SL";
}

// ─── Metrics ───
interface Metrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPoints: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  profitFactor: number;
}

function computeMetrics(trades: ClosedTrade[]): Metrics {
  const wins = trades.filter(t => t.pnlPoints > 0);
  const losses = trades.filter(t => t.pnlPoints <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlPoints, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnlPoints), 0);
  const netPoints = trades.reduce((s, t) => s + t.pnlPoints, 0);

  // Max drawdown on cumulative equity curve (in points).
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    equity += t.pnlPoints;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    netPoints,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    maxDrawdown,
    profitFactor:
      grossLoss === 0
        ? grossWin > 0
          ? Number.POSITIVE_INFINITY
          : 0
        : grossWin / grossLoss,
  };
}

// ─── Replay ───
function runBacktest(candles: Candle[], asset: AssetDefinition): ClosedTrade[] {
  const { config, pricePrecision } = asset;
  const r = (n: number) => roundTo(n, pricePrecision);
  const closed: ClosedTrade[] = [];
  let open: OpenTrade | null = null;
  // Track the last entry time per direction to enforce the per-asset cooldown,
  // matching the live _createSignal cooldown guard.
  const lastEntryMs: Record<"LONG" | "SHORT", number> = {
    LONG: Number.NEGATIVE_INFINITY,
    SHORT: Number.NEGATIVE_INFINITY,
  };

  // Precompute ATR over the full series so trailing uses the same values the
  // live monitorIdeas cron would see at each bar.
  const atrSeries = calcATR(candles, config.atrPeriod);

  // Warm-up: analyzeCandles needs >= 60 candles of history.
  for (let i = 60; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const bar = candles[i];
    const currentATR = atrSeries[i] ?? 0;

    // ── Manage the open trade against this bar (mirror monitorIdeas) ──
    if (open) {
      const isLong = open.direction === "LONG";
      const effectiveSL = open.trailingSL ?? open.stopLoss;

      // SL first (use trailing SL if set). Use bar extremes for the touch.
      const slHit = isLong ? bar.low <= effectiveSL : bar.high >= effectiveSL;
      if (slHit) {
        const pnl = r(
          isLong
            ? effectiveSL - open.entryPrice
            : open.entryPrice - effectiveSL,
        );
        closed.push({
          direction: open.direction,
          entryPrice: open.entryPrice,
          exitPrice: effectiveSL,
          pnlPoints: pnl,
          outcome: open.trailingSL ? "TRAIL_SL" : "SL",
        });
        open = null;
      } else if (open.status === "TP1_HIT") {
        // TP2 full close.
        const tp2Hit = isLong ? bar.high >= open.tp2 : bar.low <= open.tp2;
        if (tp2Hit) {
          const pnl = r(
            isLong ? open.tp2 - open.entryPrice : open.entryPrice - open.tp2,
          );
          closed.push({
            direction: open.direction,
            entryPrice: open.entryPrice,
            exitPrice: open.tp2,
            pnlPoints: pnl,
            outcome: "TP1_TP2",
          });
          open = null;
        } else if (currentATR > 0) {
          // ATR trailing stop (only after TP1).
          const trailDistance = currentATR * config.atrTrailMultiplier;
          const newTrailSL = isLong
            ? r(bar.close - trailDistance)
            : r(bar.close + trailDistance);
          const currentTrailSL = open.trailingSL ?? open.entryPrice;
          const shouldUpdate = isLong
            ? newTrailSL > currentTrailSL
            : newTrailSL < currentTrailSL;
          if (shouldUpdate) open.trailingSL = newTrailSL;
        }
      } else if (open.status === "ACTIVE") {
        // TP1 partial → move SL to breakeven.
        const tp1Hit = isLong ? bar.high >= open.tp1 : bar.low <= open.tp1;
        if (tp1Hit) {
          open.status = "TP1_HIT";
          open.trailingSL = open.entryPrice; // move to breakeven
        } else {
          // TP2 directly on a gap (rare but possible).
          const tp2Hit = isLong ? bar.high >= open.tp2 : bar.low <= open.tp2;
          if (tp2Hit) {
            const pnl = r(
              isLong ? open.tp2 - open.entryPrice : open.entryPrice - open.tp2,
            );
            closed.push({
              direction: open.direction,
              entryPrice: open.entryPrice,
              exitPrice: open.tp2,
              pnlPoints: pnl,
              outcome: "TP1_TP2",
            });
            open = null;
          }
        }
      }
    }

    // ── Look for a new entry when flat (mirror generateSignals) ──
    if (!open) {
      const analysis = analyzeCandles(window, config, pricePrecision);
      if (analysis && (analysis.grade === "A" || analysis.grade === "B")) {
        const barMs = bar.time * 1000;
        // Respect the per-asset same-direction cooldown, matching the live
        // _createSignal guard.
        const cooled =
          barMs - lastEntryMs[analysis.direction] >= config.cooldownMs;
        if (cooled) {
          lastEntryMs[analysis.direction] = barMs;
          open = {
            direction: analysis.direction,
            entryPrice: analysis.entryPrice,
            stopLoss: analysis.stopLoss,
            tp1: analysis.tp1,
            tp2: analysis.tp2,
            status: "ACTIVE",
            createdAtMs: barMs,
          };
        }
      }
    }
  }

  return closed;
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

  const trades = runBacktest(candles, asset);
  const m = computeMetrics(trades);

  console.log("─── Results ───");
  console.log(`Total trades:   ${m.totalTrades}`);
  console.log(
    `Win rate:       ${fmt(m.winRate)}%  (${m.wins}W / ${m.losses}L)`,
  );
  console.log(`Net points:     ${fmt(m.netPoints)}`);
  console.log(`Avg win:        ${fmt(m.avgWin)} pts`);
  console.log(`Avg loss:       ${fmt(m.avgLoss)} pts`);
  console.log(`Max drawdown:   ${fmt(m.maxDrawdown)} pts`);
  console.log(`Profit factor:  ${fmt(m.profitFactor)}`);
  console.log("");
}

main().catch(err => {
  console.error("Backtest error:", err);
  process.exit(1);
});
