/**
 * Candle-replay backtest over the SHARED strategy core.
 *
 * Framework-agnostic (no Convex imports) so it can be consumed by the CLI
 * harness (scripts/backtest.ts), the Teo scoring bridge (scripts/score.ts) and
 * unit tests alike. Extracted from scripts/backtest.ts so that Teo's parameter
 * sweep scores THE REAL STRATEGY — analyzeCandles from ./strategy — instead of
 * a Python re-implementation that could drift from it.
 *
 * The exit simulation mirrors the live monitorIdeas cron: entry on signal, TP1
 * partial + move-to-breakeven, ATR trailing, then TP2 / SL.
 *
 * KNOWN DIVERGENCE from the live engine (tracked, not yet closed): the live
 * generateSignals cron additionally requires 15m confluence before entering and
 * does not restrict itself to one open idea per asset. This replay is
 * single-position and single-timeframe, so it is a consistent scoring harness
 * rather than a tick-exact live replica. Treat its output as a comparison
 * between configs, not as a P&L forecast.
 */

import {
  breakevenWinRate,
  type CostModel,
  DEFAULT_COST_MODEL,
  expectancy,
  netPoints as netOf,
} from "./costs";
import {
  analyzeCandles,
  type Candle,
  calcATR,
  roundTo,
  type StrategyConfig,
} from "./strategy";

export interface ClosedTrade {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  /** Level difference the strategy aimed at, before any cost. */
  grossPoints: number;
  /** What would actually have landed in the account. This is the real result. */
  pnlPoints: number;
  outcome: "TP1_TP2" | "SL" | "TRAIL_SL";
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPoints: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  /** null when there were no losing trades — the ratio is undefined, not zero. */
  profitFactor: number | null;
  /** Sum of gross results, so the cost drag is visible rather than hidden. */
  grossPoints: number;
  /** Total paid away in spread, fees and slippage. */
  costPoints: number;
  /** Average points won or lost per trade, net. Edge is expectancy > 0. */
  expectancyPerTrade: number;
  /** Win rate this strategy must beat to break even after costs. */
  breakevenWinRate: number | null;
}

interface OpenTrade {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  status: "ACTIVE" | "TP1_HIT";
  trailingSL?: number;
}

/**
 * Aggregate closed trades into performance metrics.
 *
 * `profitFactor` is null — not 0 — when there were no losing trades. Zero reads
 * as "worst possible" to any downstream comparison, which would rank a flawless
 * config below a mediocre one and (in the self-heal path) classify it as
 * degraded. Null forces callers to handle "undefined ratio" explicitly.
 */
export function computeMetrics(trades: ClosedTrade[]): BacktestMetrics {
  // Classification is on NET result. A trade that reached its target but did
  // not cover its costs is a loss, however the chart looked.
  const wins = trades.filter(t => t.pnlPoints > 0);
  const losses = trades.filter(t => t.pnlPoints <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlPoints, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnlPoints), 0);
  const netPoints = trades.reduce((s, t) => s + t.pnlPoints, 0);
  const grossTotal = trades.reduce((s, t) => s + t.grossPoints, 0);

  // Max drawdown on the cumulative equity curve (in points).
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    equity += t.pnlPoints;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    netPoints,
    avgWin,
    avgLoss,
    maxDrawdown,
    profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    grossPoints: grossTotal,
    costPoints: grossTotal - netPoints,
    expectancyPerTrade: trades.length
      ? expectancy(winRate, avgWin, avgLoss)
      : 0,
    breakevenWinRate: breakevenWinRate(avgWin, avgLoss),
  };
}

/**
 * Replay `candles` through the shared strategy and return every closed trade.
 *
 * `startIndex` lets a caller score a sub-window (used by the out-of-sample
 * split) while still giving analyzeCandles the full preceding history it needs
 * for indicator warm-up — indicators are computed from index 0 regardless, so a
 * held-out slice is scored with the same indicator state the live engine would
 * have had at that moment.
 */
export function runBacktest(
  candles: Candle[],
  config: StrategyConfig,
  pricePrecision = 2,
  startIndex = 60,
  costs: CostModel = DEFAULT_COST_MODEL,
): ClosedTrade[] {
  const r = (n: number) => roundTo(n, pricePrecision);

  /** Build a closed trade with costs applied for the given exit type. */
  const close = (
    o: OpenTrade,
    exitPrice: number,
    outcome: ClosedTrade["outcome"],
  ): ClosedTrade => {
    const gross =
      o.direction === "LONG"
        ? exitPrice - o.entryPrice
        : o.entryPrice - exitPrice;
    const kind = outcome === "TP1_TP2" ? "TP" : outcome;
    return {
      direction: o.direction,
      entryPrice: o.entryPrice,
      exitPrice,
      grossPoints: r(gross),
      pnlPoints: r(netOf(gross, o.entryPrice, exitPrice, kind, costs)),
      outcome,
    };
  };
  const closed: ClosedTrade[] = [];
  let open: OpenTrade | null = null;
  const lastEntryMs: Record<"LONG" | "SHORT", number> = {
    LONG: Number.NEGATIVE_INFINITY,
    SHORT: Number.NEGATIVE_INFINITY,
  };

  // ATR is causal (Wilder recursion from index 0), so precomputing over the
  // full series gives each bar the same value the live cron would have seen.
  const atrSeries = calcATR(candles, config.atrPeriod);

  // analyzeCandles needs >= 60 candles of history.
  const from = Math.max(60, startIndex);

  for (let i = from; i < candles.length; i++) {
    const bar = candles[i];
    const currentATR = atrSeries[i] ?? 0;

    // ── Manage the open trade against this bar (mirrors monitorIdeas) ──
    if (open) {
      const isLong = open.direction === "LONG";
      const effectiveSL = open.trailingSL ?? open.stopLoss;

      // SL first, using bar extremes for the touch (conservative).
      const slHit = isLong ? bar.low <= effectiveSL : bar.high >= effectiveSL;
      if (slHit) {
        closed.push(
          close(open, effectiveSL, open.trailingSL ? "TRAIL_SL" : "SL"),
        );
        open = null;
      } else if (open.status === "TP1_HIT") {
        const tp2Hit = isLong ? bar.high >= open.tp2 : bar.low <= open.tp2;
        if (tp2Hit) {
          closed.push(close(open, open.tp2, "TP1_TP2"));
          open = null;
        } else if (currentATR > 0) {
          // ATR trailing stop, only after TP1.
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
        const tp1Hit = isLong ? bar.high >= open.tp1 : bar.low <= open.tp1;
        if (tp1Hit) {
          // A bar wide enough to reach TP1 may also have reached TP2. This must
          // be checked here, not as an `else` to the TP1 test: for a long,
          // high >= tp2 implies high >= tp1, so a TP2-only branch after a TP1
          // check can never execute, and the position would take an extra bar
          // to resolve a move it already completed.
          const tp2Hit = isLong ? bar.high >= open.tp2 : bar.low <= open.tp2;
          if (tp2Hit) {
            closed.push(close(open, open.tp2, "TP1_TP2"));
            open = null;
          } else {
            open.status = "TP1_HIT";
            open.trailingSL = open.entryPrice; // move to breakeven
          }
        }
      }
    }

    // ── Look for a new entry when flat (mirrors generateSignals) ──
    if (!open) {
      const analysis = analyzeCandles(
        candles.slice(0, i + 1),
        config,
        pricePrecision,
      );
      if (analysis && (analysis.grade === "A" || analysis.grade === "B")) {
        const barMs = bar.time * 1000;
        // Same-direction cooldown, matching the live _createSignal guard.
        if (barMs - lastEntryMs[analysis.direction] >= config.cooldownMs) {
          lastEntryMs[analysis.direction] = barMs;
          open = {
            direction: analysis.direction,
            entryPrice: analysis.entryPrice,
            stopLoss: analysis.stopLoss,
            tp1: analysis.tp1,
            tp2: analysis.tp2,
            status: "ACTIVE",
          };
        }
      }
    }
  }

  return closed;
}
