/**
 * Binance USDⓈ-M futures positioning data: funding rates and open interest.
 *
 * WHY THIS EXISTS
 * The batch scans of 2026-08-24 measured price-only entry claims on liquid
 * crypto majors to exhaustion and found nothing after costs. What price does
 * not record is positioning — who is crowded, who is being liquidated — and
 * these two series are the venue's own measurement of exactly that. Both are
 * keyless public endpoints on the futures host.
 *
 * TWO CAVEATS WORTH STATING BEFORE ANY RESULT IS TRUSTED
 * 1. Candles come from the spot feed while this data describes the perpetual
 *    futures market. On liquid majors the spot-perp basis is small but real;
 *    a hypothesis keyed to funding is really a claim about perp positioning.
 * 2. The venue serves open-interest history for roughly the LAST 30 DAYS only
 *    (older startTime returns -1130). Funding history reaches back years.
 *    An open-interest hypothesis can therefore only ever accumulate a month
 *    of occurrences per run — many will honestly fail the MIN_OCCURRENCES
 *    bar rather than the mechanism.
 */

/** One funding settlement: when, and what perps longs paid shorts (or vice versa). */
export interface FundingEvent {
  /** Epoch SECONDS of the settlement (candles use seconds; venue sends ms). */
  time: number;
  /** Positive: longs pay shorts (crowded long book). Negative: the reverse. */
  rate: number;
}

/** One open-interest observation over all perp contracts of a symbol. */
export interface OpenInterestPoint {
  /** Epoch SECONDS. */
  time: number;
  /** Contracts outstanding. */
  contracts: number;
  /** Same, valued in quote currency. */
  notional: number;
}

export interface FuturesFetchOptions {
  fetcher?: typeof fetch;
  /** Milliseconds between pages, for sweeps that must respect rate budgets. */
  pageDelayMs?: number;
}

const FAPI_BASE =
  process.env.TEO_BINANCE_FAPI_BASE_URL ?? "https://fapi.binance.com";

async function getJson<T>(doFetch: typeof fetch, url: string): Promise<T> {
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`Binance futures ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

/**
 * Funding settlements between two bounds, oldest first, paginated.
 *
 * The venue returns at most 1000 settlements per call — about 333 days at the
 * usual 8-hour cadence — so multi-year windows page forward like klines do.
 */
export async function fetchFundingRates(
  symbol: string,
  from: number,
  to: number,
  opts: FuturesFetchOptions = {},
): Promise<FundingEvent[]> {
  const doFetch = opts.fetcher ?? fetch;
  const out: FundingEvent[] = [];
  let cursor = from * 1000;
  const endMs = to * 1000;

  while (cursor < endMs) {
    if (out.length > 0 && opts.pageDelayMs && opts.pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
    const url =
      `${FAPI_BASE}/fapi/v1/fundingRate?symbol=${symbol}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await getJson<
      Array<{ fundingTime: number; fundingRate: string }>
    >(doFetch, url);
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        time: Math.floor(r.fundingTime / 1000),
        rate: Number.parseFloat(r.fundingRate),
      });
    }
    const lastTime = rows[rows.length - 1].fundingTime;
    cursor = lastTime + 1;
    if (rows.length < 1000) break;
  }

  return out;
}

/**
 * Open-interest observations at the venue's fixed periods
 * (5m/15m/30m/1h/2h/4h/6h/12h/1d), oldest first.
 *
 * The venue refuses any window older than about thirty days, so `from` is
 * clamped rather than trusted — asking further back is not an error here,
 * it silently becomes "the recent month", and a caller that did not know
 * that would mislabel its sample.
 */
export async function fetchOpenInterestHistory(
  symbol: string,
  period: string,
  from: number,
  to: number,
  opts: FuturesFetchOptions = {},
): Promise<OpenInterestPoint[]> {
  const doFetch = opts.fetcher ?? fetch;
  const OI_WINDOW_MS = 30 * 86_400_000;
  const clampedFrom = Math.max(from * 1000, Date.now() - OI_WINDOW_MS);
  const endMs = Math.min(to * 1000, Date.now());
  const out: OpenInterestPoint[] = [];
  let cursor = clampedFrom;

  while (cursor < endMs) {
    if (out.length > 0 && opts.pageDelayMs && opts.pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
    const url =
      `${FAPI_BASE}/futures/data/openInterestHist?symbol=${symbol}` +
      `&period=${period}&startTime=${cursor}&endTime=${endMs}&limit=500`;
    const rows = await getJson<
      Array<{
        sumOpenInterest: string;
        sumOpenInterestValue: string;
        timestamp: number;
      }>
    >(doFetch, url);
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        time: Math.floor(r.timestamp / 1000),
        contracts: Number.parseFloat(r.sumOpenInterest),
        notional: Number.parseFloat(r.sumOpenInterestValue),
      });
    }
    const lastTime = rows[rows.length - 1].timestamp;
    cursor = lastTime + 1;
    if (rows.length < 500) break;
  }

  return out;
}

/**
 * Union two open-interest series, oldest-first, one point per timestamp.
 *
 * The positioning scanner combines the local archive (which grows without
 * limit) with a live venue fetch (which cannot see past thirty days). Where
 * both describe the same observation, `b` wins — callers pass the fresher
 * series second, since a re-read of a still-forming bucket supersedes the
 * archived one.
 */
export function mergeOpenInterest(
  a: OpenInterestPoint[],
  b: OpenInterestPoint[],
): OpenInterestPoint[] {
  const byTime = new Map<number, OpenInterestPoint>();
  for (const p of a) byTime.set(p.time, p);
  for (const p of b) byTime.set(p.time, p);
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}
