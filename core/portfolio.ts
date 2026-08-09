/**
 * Portfolio-level risk: what the positions are worth *together*.
 *
 * The engine decides one asset at a time. Six of the seven registered assets
 * are crypto that move as a block, so "one signal per asset, each risking 1R"
 * routinely produces five simultaneous longs that are one bet at five times the
 * size — and nothing in a per-asset view can see that. The first correlated
 * drawdown is where it becomes visible, which is too late.
 *
 * Two things follow from measuring it:
 *
 *   - A cap that counts correlated positions as the single position they
 *     effectively are, so the fifth crypto long is refused while a fifth
 *     genuinely uncorrelated one is not.
 *   - A real hedge. Direction is carried as a sign, so a short on a correlated
 *     asset *subtracts* from portfolio risk rather than adding to it. That
 *     falls out of the arithmetic; it does not need a special case.
 *
 * Correlation is measured from stored candles, not assumed. Where there is not
 * enough overlapping history to measure it, the estimate says so rather than
 * quietly reporting zero — an unmeasured correlation defaulting to "independent"
 * is the most expensive possible default.
 */

import type { Candle } from "./strategy";

export type Direction = "LONG" | "SHORT";

/**
 * Log returns keyed by bar open time.
 *
 * Keyed rather than positional because two assets' stored history rarely lines
 * up bar-for-bar — one may have been added later, or have a gap where a fetch
 * failed. Correlating index 0 of one against index 0 of another when the series
 * start on different days produces a number that means nothing at all.
 */
export function returnSeries(candles: Candle[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const cur = candles[i].close;
    if (prev > 0 && cur > 0) out.set(candles[i].time, Math.log(cur / prev));
  }
  return out;
}

export interface CorrelationEstimate {
  /** Pearson correlation in [-1, 1]. */
  value: number;
  /** Overlapping bars the estimate is built from. */
  samples: number;
  /** True when `value` is a prior because there was not enough history. */
  assumed: boolean;
}

/**
 * Pearson correlation over the bars the two series share.
 *
 * Returns null when there is too little overlap or when either series is flat
 * — a zero-variance series has no correlation with anything, and reporting 0
 * would read as "independent" when the truth is "unknown".
 */
export function pearson(
  a: Map<number, number>,
  b: Map<number, number>,
  minSamples = 30,
): { value: number; samples: number } | null {
  // Iterate the smaller map; the shared keys are the same either way.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [time, v] of small) {
    const other = large.get(time);
    if (other !== undefined) {
      xs.push(v);
      ys.push(other);
    }
  }

  const n = xs.length;
  if (n < minSamples) return null;

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;

  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;

  const r = cov / Math.sqrt(vx * vy);
  // Clamp: floating error can push a perfect correlation a hair past 1.
  return { value: Math.min(1, Math.max(-1, r)), samples: n };
}

export interface CorrelationOptions {
  /**
   * What to assume when correlation cannot be measured.
   *
   * Defaults to 0.8, not 0. The registry is six crypto assets and a gold token;
   * assuming independence would let the cap wave through exactly the cluster it
   * exists to catch. A pessimistic prior errs toward refusing a trade, which is
   * the cheap direction to be wrong in.
   */
  prior?: number;
  /** Overlapping bars required before an estimate is believed. */
  minSamples?: number;
}

export interface CorrelationMatrix {
  assets: string[];
  /** Correlation between two assets. Self-correlation is exactly 1. */
  get(a: string, b: string): CorrelationEstimate;
  /** Mean off-diagonal correlation — the input `effectiveSampleSize` wants. */
  average(): number;
  /** True when every off-diagonal entry was measured rather than assumed. */
  fullyMeasured(): boolean;
}

export function buildCorrelationMatrix(
  series: Record<string, Candle[] | Map<number, number>>,
  opts: CorrelationOptions = {},
): CorrelationMatrix {
  const prior = opts.prior ?? 0.8;
  const minSamples = opts.minSamples ?? 30;

  const assets = Object.keys(series).sort();
  const returns = new Map<string, Map<number, number>>();
  for (const id of assets) {
    const s = series[id];
    returns.set(id, s instanceof Map ? s : returnSeries(s));
  }

  const cache = new Map<string, CorrelationEstimate>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const get = (a: string, b: string): CorrelationEstimate => {
    if (a === b) return { value: 1, samples: Number.POSITIVE_INFINITY, assumed: false };
    const k = key(a, b);
    const hit = cache.get(k);
    if (hit) return hit;

    const ra = returns.get(a);
    const rb = returns.get(b);
    const measured = ra && rb ? pearson(ra, rb, minSamples) : null;
    const est: CorrelationEstimate = measured
      ? { value: measured.value, samples: measured.samples, assumed: false }
      : { value: prior, samples: 0, assumed: true };
    cache.set(k, est);
    return est;
  };

  const pairs = () => {
    const out: CorrelationEstimate[] = [];
    for (let i = 0; i < assets.length; i++) {
      for (let j = i + 1; j < assets.length; j++) {
        out.push(get(assets[i], assets[j]));
      }
    }
    return out;
  };

  return {
    assets,
    get,
    average() {
      const all = pairs();
      if (all.length === 0) return 0;
      return all.reduce((s, e) => s + e.value, 0) / all.length;
    },
    fullyMeasured() {
      return pairs().every(e => !e.assumed);
    },
  };
}

/** One position's contribution to portfolio risk. */
export interface Exposure {
  asset: string;
  direction: Direction;
  /** Risk in units of "one full position". Defaults to 1 where omitted. */
  weight?: number;
}

const signed = (e: Exposure) =>
  (e.weight ?? 1) * (e.direction === "LONG" ? 1 : -1);

/**
 * Portfolio risk, in units of one independent position.
 *
 * sqrt(wᵀΣw) with signed weights. Reads directly:
 *
 *   - 4 uncorrelated longs → 2.00. Four bets' worth of diversification.
 *   - 4 longs at ρ = 0.85  → 3.77. Barely better than four times one bet.
 *   - 2 longs + 2 shorts at ρ = 0.85 → 0.77. The shorts hedge the longs.
 *
 * The middle case is what the engine produces today and what the cap is for.
 */
export function portfolioRisk(
  positions: Exposure[],
  m: CorrelationMatrix,
): number {
  let total = 0;
  for (const p of positions) {
    for (const q of positions) {
      total += signed(p) * signed(q) * m.get(p.asset, q.asset).value;
    }
  }
  // A correlation matrix estimated pairwise from finite samples need not be
  // positive semi-definite, so the quadratic form can come out slightly
  // negative. Zero risk is wrong but bounded; NaN from sqrt is neither.
  return Math.sqrt(Math.max(0, total));
}

/** Sum of position sizes, ignoring how they interact. What a naive view sees. */
export function grossRisk(positions: Exposure[]): number {
  return positions.reduce((s, p) => s + Math.abs(p.weight ?? 1), 0);
}

/**
 * Portfolio risk as a fraction of gross risk.
 *
 * 1.0 means the positions are one bet wearing several hats. Near 0 means they
 * offset. 1/sqrt(n) is what n independent positions give.
 */
export function concentration(
  positions: Exposure[],
  m: CorrelationMatrix,
): number {
  const gross = grossRisk(positions);
  return gross > 0 ? portfolioRisk(positions, m) / gross : 0;
}

export interface PortfolioLimits {
  /**
   * Cap on portfolio risk, in independent-position units.
   *
   * 3 allows nine genuinely uncorrelated positions, or three that move
   * together. That asymmetry is the entire point of expressing the limit this
   * way rather than as a position count.
   */
  maxRisk?: number;
}

export interface AdmissionDecision {
  allowed: boolean;
  riskBefore: number;
  riskAfter: number;
  /** riskAfter − riskBefore. Negative when the candidate hedges. */
  marginalRisk: number;
  /** True when the candidate reduces portfolio risk instead of adding to it. */
  hedge: boolean;
  /** Highest correlation between the candidate and anything already open. */
  closest: { asset: string; correlation: number; assumed: boolean } | null;
  reason: string;
}

const CAP_DEFAULT = 3;

/**
 * Should this signal be taken, given what is already open?
 *
 * A trade that lowers portfolio risk is admitted unconditionally, including
 * when the book is already over its cap — refusing the one trade that reduces
 * exposure because exposure is too high would be exactly backwards.
 */
export function admit(
  open: Exposure[],
  candidate: Exposure,
  m: CorrelationMatrix,
  limits: PortfolioLimits = {},
): AdmissionDecision {
  const maxRisk = limits.maxRisk ?? CAP_DEFAULT;
  const riskBefore = portfolioRisk(open, m);
  const riskAfter = portfolioRisk([...open, candidate], m);
  const marginalRisk = riskAfter - riskBefore;
  const hedge = marginalRisk < 0;

  let closest: AdmissionDecision["closest"] = null;
  for (const p of open) {
    if (p.asset === candidate.asset) continue;
    const e = m.get(p.asset, candidate.asset);
    if (!closest || Math.abs(e.value) > Math.abs(closest.correlation)) {
      closest = { asset: p.asset, correlation: e.value, assumed: e.assumed };
    }
  }

  const near = closest
    ? ` Closest open position is ${closest.asset} at ρ = ${closest.correlation.toFixed(2)}` +
      `${closest.assumed ? " (assumed — not enough overlapping history)" : ""}.`
    : "";

  if (hedge) {
    return {
      allowed: true,
      riskBefore,
      riskAfter,
      marginalRisk,
      hedge: true,
      closest,
      reason:
        `Hedge: portfolio risk falls from ${riskBefore.toFixed(2)} to ` +
        `${riskAfter.toFixed(2)}.${near}`,
    };
  }

  if (riskAfter > maxRisk) {
    return {
      allowed: false,
      riskBefore,
      riskAfter,
      marginalRisk,
      hedge: false,
      closest,
      reason:
        `Refused: would take portfolio risk to ${riskAfter.toFixed(2)}, over the ` +
        `${maxRisk.toFixed(2)} cap, on ${open.length} open position(s).${near}`,
    };
  }

  return {
    allowed: true,
    riskBefore,
    riskAfter,
    marginalRisk,
    hedge: false,
    closest,
    reason:
      `Portfolio risk ${riskBefore.toFixed(2)} → ${riskAfter.toFixed(2)}, ` +
      `within the ${maxRisk.toFixed(2)} cap.${near}`,
  };
}

export interface PortfolioSummary {
  positions: Exposure[];
  /** Net signed exposure. Large magnitude = a directional bet, not a book. */
  netExposure: number;
  grossRisk: number;
  portfolioRisk: number;
  concentration: number;
  maxRisk: number;
  /** How much more risk can be taken before the cap bites. */
  headroom: number;
  averageCorrelation: number;
  correlationsMeasured: boolean;
  /** One sentence describing the shape of the book. */
  summary: string;
}

export function summarise(
  open: Exposure[],
  m: CorrelationMatrix,
  limits: PortfolioLimits = {},
): PortfolioSummary {
  const maxRisk = limits.maxRisk ?? CAP_DEFAULT;
  const risk = portfolioRisk(open, m);
  const gross = grossRisk(open);
  const net = open.reduce((s, p) => s + signed(p), 0);
  const conc = gross > 0 ? risk / gross : 0;
  const avg = m.average();

  let summary: string;
  if (open.length === 0) {
    summary = "No open positions.";
  } else if (conc > 0.85) {
    summary =
      `${open.length} positions behaving as ${risk.toFixed(1)} — they move together, ` +
      `so this is close to one bet at ${gross.toFixed(0)}× size.`;
  } else if (conc < 0.4) {
    summary =
      `${open.length} positions behaving as ${risk.toFixed(1)} — largely offsetting, ` +
      `so gross size overstates what is actually at risk.`;
  } else {
    summary =
      `${open.length} positions behaving as ${risk.toFixed(1)} independent ones ` +
      `(${gross.toFixed(0)} gross).`;
  }

  return {
    positions: open,
    netExposure: net,
    grossRisk: gross,
    portfolioRisk: risk,
    concentration: conc,
    maxRisk,
    headroom: Math.max(0, maxRisk - risk),
    averageCorrelation: avg,
    correlationsMeasured: m.fullyMeasured(),
    summary,
  };
}

/**
 * Mean number of positions open at the same time, over a set of intervals.
 *
 * Feeds `effectiveSampleSize`: a win rate built from trades that were mostly
 * held simultaneously carries far less evidence than the raw count suggests.
 * Weighted by each position's own lifetime, so a long-held position is not
 * given the same say as one that lasted a single bar.
 */
export function averageConcurrency(
  intervals: Array<{ start: number; end: number }>,
): number {
  const spans = intervals.filter(i => i.end > i.start);
  if (spans.length === 0) return intervals.length > 0 ? 1 : 0;

  // Time-weighted, by a sweep over open/close events. Asking merely *whether*
  // two positions overlapped would score a one-second brush the same as a
  // week held side by side, which is the opposite of what this measures.
  const events: Array<[number, number]> = [];
  for (const s of spans) {
    events.push([s.start, 1], [s.end, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || y[1] - x[1]);

  let open = 0;
  let prev = events[0][0];
  let positionTime = 0; // ∫ n(t) dt
  let coveredTime = 0; // time with at least one position open

  for (const [at, delta] of events) {
    if (at > prev && open > 0) {
      positionTime += open * (at - prev);
      coveredTime += at - prev;
    }
    open += delta;
    prev = at;
  }

  return coveredTime > 0 ? positionTime / coveredTime : 1;
}
