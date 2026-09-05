/**
 * Volatility-targeted trend on 1h gold — independent backtest.
 *
 * Faithful port of the pasted pandas strategy (day-based horizons converted
 * with the dataset's own bar spacing, EMA cross entries, next-bar-open
 * fills, constant-annualised-vol sizing, long-only), measured the way this
 * repo measures everything:
 *
 *   * LSE XAUUSD costs on notional (market entry + market exit, pessimistic)
 *   * train 50% / validation 25% / TEST 25% — selection never touches test
 *   * 4 walk-forward folds, profitableFolds >= 3 required
 *   * binomial significance on the TEST window only (stricter than the
 *     discovery gate, which tests overall), Šidák-corrected over the grid
 *
 * Usage:
 *   bun scripts/voltrend-bt.ts [--days 3650]
 *
 * No adoption here: a new family needs engine support first. This script
 * answers "is it real?" — wiring it live is a separate decision.
 */
import { lseAsset } from "../core/assets";
import { adjustPValue } from "../core/discovery";
import { assessSignificance } from "../core/significance";
import type { Candle } from "../core/strategy";
import { Db } from "../server/db";

const CAPITAL = 100_000;
const LEV_CAP = 3.0;
const BPS = 1 / 10_000;

interface VolTrade {
  entryPx: number;
  exitPx: number;
  qty: number;
  net: number;
}

interface WindowMetrics {
  trades: number;
  wins: number;
  net: number;
  gross: number;
  profitFactor: number | null;
  winRate: number;
  breakeven: number;
}

function ema(values: number[], span: number): number[] {
  const k = 2 / (span + 1);
  const out = new Array<number>(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Rolling sample std (pandas default ddof=1), causal. */
function rollingStd(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
    if (i >= n) {
      const old = values[i - n];
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= n - 1) {
      const mean = sum / n;
      const variance = (sumSq - n * mean * mean) / (n - 1);
      out[i] = Math.sqrt(Math.max(0, variance));
    }
  }
  return out;
}

function metrics(trades: VolTrade[]): WindowMetrics {
  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net <= 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.net, 0);
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  return {
    trades: trades.length,
    wins: wins.length,
    net: trades.reduce((s, t) => s + t.net, 0),
    gross: grossWin - grossLoss,
    profitFactor:
      trades.length === 0
        ? null
        : grossLoss === 0
          ? null
          : grossWin / grossLoss,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    breakeven: avgWin + avgLoss > 0 ? (avgLoss / (avgWin + avgLoss)) * 100 : 50,
  };
}

interface VolParams {
  fastDays: number;
  slowDays: number;
  volDays: number;
  targetVol: number;
}

/** Full replay; slice the returned trades by bar index for windows/folds. */
function replay(
  candles: Candle[],
  p: VolParams,
  costs: { halfSpreadBps: number; takerBps: number; slipBps: number },
): Array<VolTrade & { entryBar: number; exitBar: number }> {
  const n = candles.length;
  const ts = candles.map(c => c.time);
  const close = candles.map(c => c.close);
  const open = candles.map(c => c.open);
  const barS =
    ts.length > 2
      ? median(
          ts
            .slice(0, Math.min(20000, ts.length))
            .map((t, i, a) => (i === 0 ? NaN : t - a[i - 1]))
            .slice(1),
        )
      : 3600;
  const bpd = Math.max(1, 86400 / Math.max(barS, 1));
  const bars = (days: number, floor = 3) =>
    Math.max(floor, Math.round(days * bpd));
  const fast = bars(p.fastDays);
  const slow = bars(p.slowDays);
  const volN = bars(p.volDays);

  const emaF = ema(close, fast);
  const emaS = ema(close, slow);
  const ret = close.map((c, i) => (i === 0 ? NaN : c / close[i - 1] - 1));
  const barVol = rollingStd(
    ret.map(v => (Number.isFinite(v) ? v : 0)),
    volN,
  );
  const t0 = ts[0];
  const lev: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const elapsedYears = (ts[i] - t0) / (365.25 * 86400);
    const bpy = (i + 1) / Math.max(elapsedYears, 1e-9);
    const annVol = barVol[i] * Math.sqrt(bpy);
    lev[i] =
      Number.isFinite(annVol) && annVol > 0
        ? Math.min(p.targetVol / annVol, LEV_CAP)
        : NaN;
  }
  const up = close.map((_, i) => emaF[i] > emaS[i]);
  const warmup = Math.max(slow, volN) + 1;

  const out: Array<VolTrade & { entryBar: number; exitBar: number }> = [];
  let inPos = false;
  let entryBar = 0;
  let qty = 0;
  let entryPx = 0;
  let entryLev = 0;
  for (let i = warmup; i < n - 1; i++) {
    if (!inPos) {
      if (up[i] && Number.isFinite(lev[i]) && lev[i] > 0) {
        inPos = true;
        entryBar = i + 1;
        entryPx = open[i + 1];
        entryLev = lev[i];
        qty = (CAPITAL * entryLev) / entryPx;
      }
    } else if (!up[i]) {
      const exitPx = open[i + 1];
      const notional = qty * entryPx;
      const cost =
        notional * (costs.halfSpreadBps + costs.takerBps) * BPS +
        qty *
          exitPx *
          (costs.halfSpreadBps + costs.takerBps + costs.slipBps) *
          BPS;
      out.push({
        entryPx,
        exitPx,
        qty,
        net: qty * (exitPx - entryPx) - cost,
        entryBar,
        exitBar: i + 1,
      });
      inPos = false;
    }
  }
  if (inPos && entryBar < n - 1) {
    const exitPx = close[n - 1];
    const notional = qty * entryPx;
    const cost =
      notional * (costs.halfSpreadBps + costs.takerBps) * BPS +
      qty *
        exitPx *
        (costs.halfSpreadBps + costs.takerBps + costs.slipBps) *
        BPS;
    out.push({
      entryPx,
      exitPx,
      qty,
      net: qty * (exitPx - entryPx) - cost,
      entryBar,
      exitBar: n - 1,
    });
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : undefined;
}

function main() {
  const days = Number(flag("days") ?? 3650);
  const db = new Db();
  const meta = db.getSetting<{
    symbol: string;
    digits: number;
    assetId: string;
    spreadBps: number;
  }>("lse:XAUUSD");
  if (!meta) throw new Error("no lse:XAUUSD spec — cannot price costs");
  const asset = lseAsset(meta);
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const candles = db.getCandleRange("XAUUSD", "1h", from, to);
  console.log(
    `Vol-targeted trend · XAUUSD 1h · ${candles.length} bars · ${days}d · costs ${asset.costs.halfSpreadBps}/${asset.costs.takerFeeBps}/${asset.costs.stopSlippageBps}bps`,
  );
  if (candles.length < 5000) throw new Error("too little history");

  const grid: VolParams[] = [];
  for (const fastDays of [3, 5, 8])
    for (const slowDays of [15, 20, 40])
      for (const volDays of [15, 20, 30])
        for (const targetVol of [0.1, 0.15, 0.2])
          grid.push({ fastDays, slowDays, volDays, targetVol });
  console.log(`Grid: ${grid.length} configs (Šidák n=${grid.length})\n`);

  const n = candles.length;
  const trainEnd = Math.floor(n * 0.5);
  const valEnd = Math.floor(n * 0.75);
  const costs = {
    halfSpreadBps: asset.costs.halfSpreadBps,
    takerBps: asset.costs.takerFeeBps,
    slipBps: asset.costs.stopSlippageBps,
  };

  type Row = {
    p: VolParams;
    train: WindowMetrics;
    val: WindowMetrics;
    test: WindowMetrics;
    wfFolds: number[];
    wfGood: number;
    adjP: number;
    verdict: string;
  };
  const rows: Row[] = [];
  for (const p of grid) {
    const all = replay(candles, p, costs);
    const inWin = (t: (typeof all)[number], a: number, b: number) =>
      t.entryBar >= a && t.entryBar < b;
    const train = metrics(all.filter(t => inWin(t, 0, trainEnd)));
    const val = metrics(all.filter(t => inWin(t, trainEnd, valEnd)));
    const test = metrics(all.filter(t => inWin(t, valEnd, n)));
    // Walk-forward: 4 equal folds over the post-warmup history.
    const warmup = 60;
    const width = Math.floor((n - warmup) / 4);
    const wfFolds: number[] = [];
    for (let f = 0; f < 4; f++) {
      const a = warmup + f * width;
      const b = f === 3 ? n : a + width;
      wfFolds.push(
        all.filter(t => inWin(t, a, b)).reduce((s, t) => s + t.net, 0),
      );
    }
    const wfGood = wfFolds.filter(x => x > 0).length;
    const sig = assessSignificance(test.wins, test.trades, test.breakeven);
    const adjP = adjustPValue(sig.pValue, grid.length);
    let verdict = "qualified";
    if (train.net <= 0) verdict = "failed_train";
    else if (val.net <= 0) verdict = "failed_validation";
    else if (test.net <= 0) verdict = "failed_test";
    else if (test.winRate <= test.breakeven) verdict = "below_breakeven";
    else if (wfGood < 3) verdict = "failed_walk_forward";
    else if (adjP > 0.05) verdict = "not_significant";
    rows.push({ p, train, val, test, wfFolds, wfGood, adjP, verdict });
  }

  const q = rows.filter(r => r.verdict === "qualified");
  console.log(`Qualified: ${q.length}/${grid.length}\n`);
  const show = [...rows].sort(
    (a, b) =>
      (a.verdict === "qualified" ? 0 : 1) -
        (b.verdict === "qualified" ? 0 : 1) || b.test.net - a.test.net,
  );
  for (const r of show.slice(0, 12)) {
    const t = r.test;
    console.log(
      `${r.verdict.padEnd(18)} fast=${r.p.fastDays}d slow=${r.p.slowDays}d vol=${r.p.volDays}d tgt=${r.p.targetVol} | ` +
        `test PF ${t.profitFactor?.toFixed(2) ?? "—"} WR ${t.winRate.toFixed(1)}% ` +
        `${t.trades}tr net $${t.net.toFixed(0)} | train $${r.train.net.toFixed(0)} val $${r.val.net.toFixed(0)} | ` +
        `folds ${r.wfGood}/4 p=${r.adjP.toExponential(1)}`,
    );
  }
  console.log("\nFull-history net per verdict:");
  const byV = new Map<string, number[]>();
  for (const r of rows) {
    const net = r.train.net + r.val.net + r.test.net;
    byV.set(r.verdict, [...(byV.get(r.verdict) ?? []), net]);
  }
  for (const [v, nets] of byV) {
    console.log(
      `  ${v}: ${nets.length} configs, median net $${median(nets).toFixed(0)}`,
    );
  }
  db.close();
}

main();
