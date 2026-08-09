/**
 * Statistical validation — is a result distinguishable from luck?
 *
 * Every other number in this system describes what happened. These describe how
 * much of it you are entitled to believe.
 *
 * The failure this exists to prevent is specific and common: a strategy runs for
 * a few weeks, shows a 58% win rate against a 48% breakeven, and the operator
 * concludes it works. With 30 trades that gap is well inside what a coin-flip
 * produces. Scaling up on it is how a sample-size error becomes a loss.
 *
 * Nothing here needs market data — it operates on completed trades, so it can be
 * exercised and trusted before any live account is involved.
 */

/**
 * ln(n!), computed by summing logarithms and cached.
 *
 * Logs rather than n! directly because 171! overflows to Infinity, and a
 * strategy can easily accumulate more trades than that. Summed rather than
 * approximated with Stirling because Stirling is not exact at small n, and
 * being wrong about a 4-trade probability is precisely the case this module
 * exists to get right. The table grows to the largest n seen and is O(1)
 * thereafter.
 */
const LOG_FACTORIAL: number[] = [0, 0];

function logFactorial(n: number): number {
  if (n < 0 || !Number.isFinite(n)) return Number.NaN;
  const k = Math.floor(n);
  for (let i = LOG_FACTORIAL.length; i <= k; i++) {
    LOG_FACTORIAL[i] = LOG_FACTORIAL[i - 1] + Math.log(i);
  }
  return LOG_FACTORIAL[k];
}

/** P(exactly k successes in n trials at probability p). */
export function binomialPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  const logC = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/** P(at least k successes in n trials at probability p) — a one-sided test. */
export function binomialTailProbability(
  k: number,
  n: number,
  p: number,
): number {
  if (n <= 0) return 1;
  if (k <= 0) return 1;
  if (k > n) return 0;
  let total = 0;
  for (let i = k; i <= n; i++) total += binomialPmf(i, n, p);
  return Math.min(1, Math.max(0, total));
}

export interface WilsonInterval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a proportion, as percentages.
 *
 * Used rather than the textbook normal approximation because that one is
 * badly wrong at the sample sizes this system will actually have — with 20
 * trades it can produce bounds below 0 or above 100.
 */
export function wilsonInterval(
  wins: number,
  n: number,
  z = 1.96,
): WilsonInterval {
  if (n <= 0) return { low: 0, high: 100 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: Math.max(0, (centre - spread) * 100),
    high: Math.min(100, (centre + spread) * 100),
  };
}

export type Verdict =
  | "insufficient_data"
  | "indistinguishable_from_chance"
  | "significant";

export interface SignificanceReport {
  trades: number;
  wins: number;
  winRate: number;
  /** The rate that must be beaten to break even after costs. */
  breakevenRate: number;
  /** Probability of a result this good if the true edge were zero. */
  pValue: number;
  /** 95% Wilson interval on the true win rate. */
  interval: WilsonInterval;
  verdict: Verdict;
  /** Trades needed to resolve an edge of the observed size, at 95%/80% power. */
  tradesNeeded: number | null;
  /** One sentence a human can act on. */
  summary: string;
}

/**
 * Trades required to distinguish `observedRate` from `breakevenRate`.
 *
 * Standard two-proportion sizing at 95% confidence and 80% power. Returns null
 * when the observed rate is at or below breakeven — there is no positive edge to
 * size for, and quoting a number would imply there were.
 */
export function requiredSampleSize(
  observedRate: number,
  breakevenRate: number,
): number | null {
  const p1 = observedRate / 100;
  const p0 = breakevenRate / 100;
  if (!(p1 > p0) || p1 >= 1 || p0 <= 0) return null;

  const zAlpha = 1.645; // one-sided 95%
  const zBeta = 0.84; // 80% power
  const effect = p1 - p0;
  const n =
    ((zAlpha * Math.sqrt(p0 * (1 - p0)) + zBeta * Math.sqrt(p1 * (1 - p1))) /
      effect) **
    2;
  return Math.ceil(n);
}

/**
 * Assess whether a win rate beats its breakeven by more than chance explains.
 *
 * `minTrades` is the point below which no verdict is offered at all. Reporting
 * a p-value on eight trades invites exactly the over-reading this is meant to
 * prevent.
 */
export function assessSignificance(
  wins: number,
  trades: number,
  breakevenRate: number,
  opts: { minTrades?: number; alpha?: number } = {},
): SignificanceReport {
  const minTrades = opts.minTrades ?? 30;
  const alpha = opts.alpha ?? 0.05;
  const winRate = trades > 0 ? (wins / trades) * 100 : 0;
  const interval = wilsonInterval(wins, trades);
  const pValue = binomialTailProbability(wins, trades, breakevenRate / 100);
  const tradesNeeded = requiredSampleSize(winRate, breakevenRate);

  if (trades < minTrades) {
    return {
      trades,
      wins,
      winRate,
      breakevenRate,
      pValue,
      interval,
      verdict: "insufficient_data",
      tradesNeeded,
      summary:
        `${trades} trades is too few to judge (need at least ${minTrades}). ` +
        `The true win rate could plausibly be anywhere from ` +
        `${interval.low.toFixed(0)}% to ${interval.high.toFixed(0)}%.`,
    };
  }

  if (pValue > alpha) {
    return {
      trades,
      wins,
      winRate,
      breakevenRate,
      pValue,
      interval,
      verdict: "indistinguishable_from_chance",
      tradesNeeded,
      summary:
        `${winRate.toFixed(1)}% over ${trades} trades against a ${breakevenRate.toFixed(1)}% ` +
        `breakeven is not distinguishable from chance (p = ${pValue.toFixed(3)}). ` +
        (tradesNeeded
          ? `About ${tradesNeeded} trades would settle it.`
          : `The observed rate is at or below breakeven.`),
    };
  }

  return {
    trades,
    wins,
    winRate,
    breakevenRate,
    pValue,
    interval,
    verdict: "significant",
    tradesNeeded,
    summary:
      `${winRate.toFixed(1)}% over ${trades} trades beats the ${breakevenRate.toFixed(1)}% ` +
      `breakeven with p = ${pValue.toFixed(4)}. 95% interval: ` +
      `${interval.low.toFixed(1)}%–${interval.high.toFixed(1)}%.`,
  };
}

/**
 * Effective sample size, discounted for positions held at the same time.
 *
 * Six of the seven registered assets are crypto that move together. Seven
 * simultaneous longs are close to one bet repeated, not seven independent
 * results — but every statistic above counts them as seven, which overstates
 * confidence exactly when a correlated drawdown is most likely.
 *
 * `avgConcurrent` is the mean number of positions open at once; `correlation`
 * is the typical pairwise correlation between them. At correlation 0 the count
 * is unchanged; at 1 a cohort of k concurrent positions counts as one.
 */
export function effectiveSampleSize(
  trades: number,
  avgConcurrent: number,
  correlation: number,
): number {
  if (trades <= 0) return 0;
  const k = Math.max(1, avgConcurrent);
  const rho = Math.min(1, Math.max(0, correlation));
  // Variance of a mean of k equicorrelated variables is (1 + (k-1)ρ)/k of the
  // independent case; the inflation factor is what discounts the count.
  const inflation = 1 + (k - 1) * rho;
  return Math.max(1, Math.round(trades / inflation));
}
