/**
 * Research runs — "give me a strategy for NAS100 15m since January 2024" as a
 * single button.
 *
 * A run is a small state machine that owns the whole journey:
 *
 *   requesting → downloading → searching → done | failed
 *
 * WHY A JOB RATHER THAN A REQUEST HANDLER
 * Two of these stages are slow for reasons no HTTP timeout can accommodate. The
 * terminal may need minutes to pull two years of bars from the broker, and a
 * search of a few thousand configurations over 50,000 bars is minutes of CPU.
 * A request that blocks on either would time out in the browser while the work
 * carried on invisibly. So the run is a resource: you start it, poll it, and
 * read its report when it is finished.
 *
 * WHY IT IS INTERRUPTIBLE
 * The search runs in slices on the event loop rather than one blocking call.
 * Bun is single-threaded here, and a ten-minute synchronous loop would freeze
 * the live engine's timers and every other request with it — the dashboard
 * would appear to hang exactly when the operator most wants to watch progress.
 * Slicing costs a little throughput and keeps the application answering.
 */

import { existsSync } from "node:fs";
import type { AssetDefinition } from "../core/assets";
import type { AppConfig } from "../core/config";
import { toAssetDefinition } from "../core/config";
import {
  type Candidate,
  DEFAULT_SEARCH_SPACE,
  type DiscoveryReport,
  discover,
  type SearchSpace,
  sampleConfig,
} from "../core/discovery";
import type { Candle } from "../core/strategy";
import type { Db } from "./db";
import { publish } from "./events";
import { resolveDirectory } from "./mt5bridge";
import {
  clearHistory,
  historyId,
  historyState,
  INTERVAL_TO_TIMEFRAME,
  readHistory,
  requestHistory,
} from "./mt5history";

export type RunStatus =
  | "requesting"
  | "downloading"
  | "searching"
  | "done"
  | "failed"
  | "cancelled";

export interface ResearchRun {
  id: string;
  assetId: string;
  symbol: string;
  interval: string;
  from: number;
  to: number;
  iterations: number;
  status: RunStatus;
  /** 0..1 across the whole run, not per stage. */
  progress: number;
  /** What is happening, in words an operator can act on. */
  message: string;
  startedAt: number;
  finishedAt: number | null;
  bars: number;
  report: DiscoveryReport | null;
  error: string | null;
}

export interface StartRunInput {
  assetId: string;
  symbol: string;
  interval: string;
  from: number;
  to: number;
  iterations: number;
  seed?: number;
  space?: SearchSpace;
  minTrades?: number;
}

/** Live runs, newest first. In memory: a run is not worth surviving a restart. */
const runs = new Map<string, ResearchRun>();
const cancelled = new Set<string>();

/** How many configurations to evaluate before yielding to the event loop. */
const SLICE = 25;

export function getRun(id: string): ResearchRun | null {
  return runs.get(id) ?? null;
}

export function listRuns(): ResearchRun[] {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Insert a finished run directly.
 *
 * Exists so the adopt route can be tested against a qualified result. A search
 * only produces one when the data happens to contain a surviving edge, which
 * is exactly what real market data usually does not, and a route that writes
 * your live configuration should not go untested for that reason.
 */
export function putRun(run: ResearchRun): void {
  runs.set(run.id, run);
}

export function cancelRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.status === "done" || run.status === "failed") return false;
  cancelled.add(id);
  return true;
}

function update(run: ResearchRun, patch: Partial<ResearchRun>): void {
  Object.assign(run, patch);
  publish("research", { id: run.id, status: run.status });
}

/**
 * Start a run and return it immediately.
 *
 * The work continues on the event loop; the caller polls `getRun`.
 */
export function startRun(
  db: Db,
  cfg: AppConfig,
  input: StartRunInput,
): ResearchRun {
  const id = `${input.assetId}-${input.interval}-${Date.now()}`;
  const run: ResearchRun = {
    id,
    assetId: input.assetId,
    symbol: input.symbol,
    interval: input.interval,
    from: input.from,
    to: input.to,
    iterations: input.iterations,
    status: "requesting",
    progress: 0,
    message: "Preparing…",
    startedAt: Date.now(),
    finishedAt: null,
    bars: 0,
    report: null,
    error: null,
  };
  runs.set(id, run);

  void execute(db, cfg, run, input).catch(e => {
    update(run, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      message: "The run failed.",
      finishedAt: Date.now(),
    });
  });

  return run;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function execute(
  db: Db,
  cfg: AppConfig,
  run: ResearchRun,
  input: StartRunInput,
): Promise<void> {
  const asset = findAssetDefinition(cfg, input.assetId, input.symbol);

  const candles = await gatherCandles(db, cfg, run, input);
  // Cancellation is read from the set rather than run.status: the status field
  // is written through Object.assign, which the compiler cannot see, so it
  // would narrow this comparison away entirely.
  if (cancelled.has(run.id)) return;

  run.bars = candles.length;
  if (candles.length < 500) {
    update(run, {
      status: "failed",
      error:
        `Only ${candles.length} bars available for ${input.symbol} ${input.interval} in that range. ` +
        "Either the broker does not keep history that far back, or the symbol name does not match the broker's.",
      message: "Not enough data to search.",
      finishedAt: Date.now(),
    });
    return;
  }

  update(run, {
    status: "searching",
    progress: 0.45,
    message: `Searching ${input.iterations} configurations over ${candles.length} bars…`,
  });

  const report = await searchInSlices(candles, asset, run, input);
  if (cancelled.has(run.id)) return;

  report.interval = input.interval;

  update(run, {
    status: "done",
    progress: 1,
    report,
    message: report.conclusion,
    finishedAt: Date.now(),
  });
}

/**
 * Get the bars for the window, from the database if they are already there and
 * from the terminal if they are not.
 *
 * Checking the database first is what makes a second run on the same window
 * instant. Re-pulling would ask the terminal for megabytes it already gave us.
 */
async function gatherCandles(
  db: Db,
  cfg: AppConfig,
  run: ResearchRun,
  input: StartRunInput,
): Promise<Candle[]> {
  const stored = db.getCandleRange(
    input.assetId,
    input.interval,
    input.from,
    input.to,
  );

  // "Enough" rather than "any": a partial range from an earlier cancelled run
  // must not be mistaken for a complete one. Weekends, holidays and the broker's
  // own gaps mean the expected count is never exact, so two thirds of the
  // theoretical bar count is the threshold for treating a range as covered.
  const expected = expectedBars(input.interval, input.from, input.to);
  if (stored.length >= expected * 0.66 && stored.length > 500) {
    update(run, {
      progress: 0.4,
      message: `Using ${stored.length} bars already stored locally.`,
    });
    return stored;
  }

  const dir = resolveDirectory(cfg);
  if (!dir) {
    throw new Error(
      "No MetaTrader 5 terminal found. Open MT5 with TeoExporter on a chart, then set the directory in Settings.",
    );
  }
  // A configured path that does not exist must fail NOW. Writing a request into
  // a directory nothing is watching would otherwise spend the full ten-minute
  // wait before reporting a typo in the settings field.
  if (!existsSync(dir)) {
    throw new Error(
      `The MetaTrader 5 directory in Settings does not exist: ${dir}`,
    );
  }

  const timeframe = INTERVAL_TO_TIMEFRAME[input.interval];
  if (!timeframe) {
    throw new Error(`MetaTrader 5 has no timeframe matching ${input.interval}`);
  }

  const id = historyId(input.symbol, timeframe, input.from, input.to);
  requestHistory(dir, input.symbol, timeframe, input.from, input.to);

  update(run, {
    status: "downloading",
    progress: 0.05,
    message: `Asked MetaTrader 5 for ${input.symbol} ${timeframe}…`,
  });

  // Ten minutes: a cold two-year pull genuinely takes several on a slow broker
  // connection, and failing at one minute would send the operator to look for
  // a bug that is really a download.
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (cancelled.has(run.id)) {
      update(run, {
        status: "cancelled",
        message: "Cancelled.",
        finishedAt: Date.now(),
      });
      return [];
    }

    const state = historyState(dir, id);
    if (state.status === "ready") break;
    if (state.status === "failed") throw new Error(state.message);

    update(run, {
      status: "downloading",
      // The download occupies the first 40% of the bar; the search is the rest.
      progress: 0.05 + state.progress * 0.35,
      message: state.message,
    });
    await sleep(1000);
  }

  const finalState = historyState(dir, id);
  if (finalState.status !== "ready") {
    throw new Error(
      "MetaTrader 5 did not answer within ten minutes. Is the terminal still open, with TeoExporter attached and InpServeHistory true?",
    );
  }

  const candles = readHistory(dir, id);

  // Persist before returning: the bars are now the local record of that window,
  // so a second run, a chart or a later re-check never has to ask again.
  db.saveCandles(input.assetId, input.interval, candles);
  clearHistory(dir, id);
  publish("candles");

  update(run, {
    progress: 0.42,
    message: `Received ${candles.length} bars from your broker.`,
  });

  return candles;
}

/** Theoretical bar count for a range, ignoring market closures. */
function expectedBars(interval: string, from: number, to: number): number {
  const seconds: Record<string, number> = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
  };
  const step = seconds[interval] ?? 900;
  // Roughly 5/7 of calendar time has a market open, and CFDs pause daily too.
  return Math.floor(((to - from) / step) * 0.6);
}

/**
 * Run the search in slices, yielding between them.
 *
 * `discover` is given one slice's worth of iterations at a time with a
 * continuing seed, so the union of the slices explores the same space a single
 * long run would, and the event loop gets a turn in between.
 */
async function searchInSlices(
  candles: Candle[],
  asset: AssetDefinition,
  run: ResearchRun,
  input: StartRunInput,
): Promise<DiscoveryReport> {
  const total = input.iterations;
  const space = input.space ?? DEFAULT_SEARCH_SPACE;
  const baseSeed = input.seed ?? 1;

  let merged: DiscoveryReport | null = null;
  const all: Candidate[] = [];
  let done = 0;
  // Configurations actually backtested. Distinct from `all.length`, which only
  // holds the top few kept per slice: reporting the kept count as "evaluated"
  // understated a 300-configuration search as 120.
  let evaluated = 0;

  while (done < total) {
    if (cancelled.has(run.id)) {
      update(run, {
        status: "cancelled",
        message: `Cancelled after ${done} of ${total} configurations.`,
        finishedAt: Date.now(),
      });
      return (
        merged ??
        discover(candles, asset, { iterations: 0, space, seed: baseSeed })
      );
    }

    const slice = Math.min(SLICE, total - done);
    const part = discover(candles, asset, {
      iterations: slice,
      space,
      seed: baseSeed + done,
      minTrades: input.minTrades,
      base: asset.config,
      // Every slice must correct for the WHOLE search, not its own 25 tries.
      // Correcting per slice would make a 5,000-configuration search report the
      // significance of a 25-configuration one, which is the exact inflation
      // the correction exists to remove.
      topK: 10,
    });

    // A slice too small to split returns its refusal as the conclusion. That is
    // a property of the data, not of the slice, so it ends the whole run.
    if (part.bars > 0 && part.split.train < 200) return part;

    all.push(...part.candidates);
    evaluated += part.evaluated;
    merged = part;
    done += slice;

    update(run, {
      progress: 0.45 + 0.55 * (done / total),
      message: `Tested ${done} of ${total} configurations…`,
    });

    // Yield. setTimeout(0) rather than a microtask so timers and I/O actually
    // get to run: queueMicrotask would starve them exactly as a blocking loop does.
    await sleep(0);
  }

  return finalise(all, merged, candles, total, input, evaluated);
}

/**
 * Assemble the slices into one report.
 *
 * The per-slice p-values were corrected for a slice's worth of attempts, so
 * they are recomputed here against the real number tried. Reporting the slice
 * figure would understate the search size by a factor of the slice count.
 */
function finalise(
  all: Candidate[],
  last: DiscoveryReport | null,
  candles: Candle[],
  total: number,
  input: StartRunInput,
  evaluated: number,
): DiscoveryReport {
  const corrected = all.map(c => {
    const adjusted = 1 - (1 - c.significance.pValue) ** total;
    const verdict =
      c.verdict === "qualified" && adjusted > 0.05
        ? ("not_significant" as const)
        : c.verdict;
    return {
      ...c,
      adjustedPValue: adjusted,
      verdict,
      summary:
        verdict === "not_significant" && c.verdict === "qualified"
          ? `Profitable in all three windows, but across all ${total} attempts the record is still consistent with luck (p = ${adjusted.toFixed(3)}).`
          : c.summary,
    };
  });

  const rank = (c: Candidate) =>
    (c.verdict === "qualified" ? 1e9 : 0) + c.test.netPoints;
  corrected.sort((a, b) => rank(b) - rank(a));

  const best = corrected.find(c => c.verdict === "qualified") ?? null;
  const qualified = corrected.filter(c => c.verdict === "qualified").length;

  return {
    asset: input.assetId,
    interval: input.interval,
    bars: candles.length,
    from: candles[0]?.time ?? input.from,
    to: candles.at(-1)?.time ?? input.to,
    iterations: total,
    evaluated,
    seed: input.seed ?? 1,
    split: last?.split ?? { train: 0, validation: 0, test: 0 },
    candidates: corrected.slice(0, 10),
    best,
    conclusion: best
      ? `${qualified} of ${total} configurations survived all three windows and the correction for search size. ` +
        `The best made ${best.test.netPoints.toFixed(1)} points over ${best.test.trades} trades on the untouched test window. ` +
        "That is evidence on one instrument over one period, not a guarantee."
      : `None of ${total} configurations survived. That is a real result, and the usual one: ` +
        "most parameter sets that look good on a training window fail the next one, " +
        "which is what the three-way split exists to reveal before your money does.",
  };
}

/**
 * The asset definition to score against.
 *
 * A configured asset brings the operator's own precision and measured costs.
 * An unconfigured symbol — someone exploring NAS100 before adding it — gets a
 * default definition, because refusing to research anything not already
 * configured would put a chicken-and-egg step in front of the feature.
 */
function findAssetDefinition(
  cfg: AppConfig,
  assetId: string,
  symbol: string,
): AssetDefinition {
  const configured = cfg.assets.find(
    a => a.id === assetId || a.dataSourceSymbol === symbol,
  );
  if (configured) return toAssetDefinition(configured);

  const template = cfg.assets[0];
  return toAssetDefinition({
    ...template,
    id: assetId,
    displaySymbol: symbol,
    dataSourceSymbol: symbol,
    dataSource: "mt5",
  });
}

/** Exposed for tests: one sampled configuration from the default space. */
export function sampleOne(cfg: AppConfig, seed = 1) {
  const asset = toAssetDefinition(cfg.assets[0]);
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return sampleConfig(asset.config, DEFAULT_SEARCH_SPACE, rand);
}
