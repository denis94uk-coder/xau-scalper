/**
 * REST + SSE routes.
 *
 * Replaces the Convex function surface. Everything reads from local SQLite, so
 * there is no deploy step, no generated client, and no per-call network hop.
 *
 * Auth: none, by design. The server binds to 127.0.0.1 (see index.ts), so the
 * only callers are processes on this machine. That is a stronger boundary than
 * the Convex deployment had, where every function was reachable by anyone who
 * knew the URL. If you ever bind to 0.0.0.0 to reach it from a phone, put a
 * token check here first — see the README.
 */

import { DEFAULT_ASSET_ID } from "../core/assets";
import type { AssetConfig } from "../core/config";
import {
  defaultConfig,
  enabledAssets,
  newAsset,
  toAssetDefinition,
} from "../core/config";
import { summariseByRegime } from "../core/memory";
import { averageConcurrency, summarise } from "../core/portfolio";
import { assessSignificance, effectiveSampleSize } from "../core/significance";
import { ConfigError, ConfigStore } from "./config";
import type { Db } from "./db";
import { correlationsFrom, openExposures } from "./engine";
import { type AppEvent, publish, subscribe } from "./events";
import { fetchCandles, fetchTickers } from "./market";
import { findExportDir } from "./mt5";
import { status as mt5Status, syncOnce } from "./mt5bridge";
import { cancelRun, getRun, listRuns, startRun } from "./research";
import type { RiskManager } from "./risk-manager";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const bad = (message: string, status = 400) => json({ error: message }, status);

/** Parse a positive integer query param, clamped, with a default. */
function intParam(
  url: URL,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Parse a JSON object body, or return an error Response. */
/** Like `readBody`, but an absent body is an empty object rather than an error. */
async function readOptionalBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  const raw = await req.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return bad("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return bad("invalid JSON body");
  }
}

async function readBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  try {
    const raw = await req.json();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return bad("body must be a JSON object");
    }
    return raw as Record<string, unknown>;
  } catch {
    return bad("invalid JSON body");
  }
}

/** Require a finite number field. */
function num(body: Record<string, unknown>, key: string): number | Response {
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return bad(`${key} must be a finite number`);
  }
  return v;
}

/**
 * snake_case rows → camelCase for the wire.
 *
 * Column names are a storage detail; leaking them into the API would make every
 * consumer depend on the schema's spelling. Shallow by design — no nested row
 * shapes are returned.
 */
function camel(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

function camelAll(rows: object[]): Record<string, unknown>[] {
  return rows.map(camel);
}

/**
 * Per-request config stores, keyed by database.
 *
 * handleApi is called as `(db, req, url)` by the tests, which construct a fresh
 * in-memory database each time. Caching the store per database keeps that
 * signature working while still giving every request the same live snapshot the
 * server's own store holds, rather than re-reading SQLite on each call.
 */
const storesByDb = new WeakMap<Db, ConfigStore>();

function storeFor(db: Db, provided?: ConfigStore): ConfigStore {
  if (provided) return provided;
  let store = storesByDb.get(db);
  if (!store) {
    store = new ConfigStore(db);
    storesByDb.set(db, store);
  }
  return store;
}

export async function handleApi(
  db: Db,
  req: Request,
  url: URL,
  configStore?: ConfigStore,
  risk?: RiskManager,
): Promise<Response | null> {
  const path = url.pathname;
  const store = storeFor(db, configStore);
  const cfg = store.get();

  /** Look up a configured asset by id. Replaces the compiled-in registry. */
  const findAsset = (id: string): AssetConfig | undefined =>
    cfg.assets.find(a => a.id === id);

  /**
   * Validate an asset id from the query string, against the live config.
   *
   * Unknown is a 404 rather than an empty list, for the same reason as before:
   * `[]` is indistinguishable from "no activity yet" and hides a typo.
   */
  const assetParam = (u: URL): string | undefined | Response => {
    const asset = u.searchParams.get("asset");
    if (asset === null) return undefined;
    if (!findAsset(asset)) return bad(`unknown asset "${asset}"`, 404);
    return asset;
  };

  // ─── Assets ───
  if (path === "/api/assets") {
    return json({
      assets: cfg.assets.map(a => ({
        id: a.id,
        symbol: a.displaySymbol,
        precision: a.pricePrecision,
        enabled: a.enabled,
        dataSource: a.dataSource,
      })),
    });
  }

  // ─── Ideas ───
  // Method-guarded: without this the POST handler further down is unreachable,
  // because a POST would match here first and be answered with the list.
  if (path === "/api/ideas" && req.method === "GET") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    const ideas = db.listIdeas({
      asset,
      limit: intParam(url, "limit", 100, 500),
    });
    return json({
      ideas: ideas.map(i => ({ ...camel(i), events: db.ideaEvents(i.id) })),
    });
  }

  if (path === "/api/ideas/open") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    return json({ ideas: camelAll(db.openIdeas(asset)) });
  }

  const ideaMatch = path.match(/^\/api\/ideas\/(\d+)$/);
  if (ideaMatch) {
    const id = Number(ideaMatch[1]);
    if (req.method === "DELETE") {
      db.deleteIdea(id);
      publish("ideas");
      return json({ ok: true });
    }
    const idea = db.getIdea(id);
    if (!idea) return bad("not found", 404);
    return json({ ...camel(idea), events: db.ideaEvents(id) });
  }

  // ─── Journal ───
  if (path === "/api/journal") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    return json({
      entries: camelAll(
        db.listJournal({ asset, limit: intParam(url, "limit", 200, 1000) }),
      ),
    });
  }

  if (path === "/api/journal/counts") {
    return json(db.journalCounts());
  }

  // ─── Performance ───
  if (path === "/api/performance") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    // Per asset always. A combined total would sum points across instruments,
    // which is not a meaningful quantity.
    const assets = asset ? [asset] : enabledAssets(cfg).map(a => a.id);
    return json({
      byAsset: assets.map(a => {
        const perf = db.performance(a);
        // Attach the verdict to the numbers it qualifies, rather than offering
        // it separately: a win rate shown without its sample size is the exact
        // thing that gets over-read.
        const decided = perf.wins + perf.losses;
        const breakeven =
          perf.avgWinPoints + perf.avgLossPoints > 0
            ? (perf.avgLossPoints / (perf.avgWinPoints + perf.avgLossPoints)) *
              100
            : 50;
        return {
          ...perf,
          significance: assessSignificance(perf.wins, decided, breakeven),
        };
      }),
    });
  }

  // ─── Self-heal ───
  if (path === "/api/selfheal") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    const limit = intParam(url, "limit", 50, 500);
    const rows = db.outcomes({ asset: asset ?? undefined, limit });

    // Regime summaries per asset, so the page can show what the loop has
    // learned rather than only what it last did.
    const assets = asset ? [asset] : [...new Set(rows.map(r => r.asset))];
    const memory = db.outcomes({ asset: asset ?? undefined, limit: 1000 });
    const records = memory.map(r => ({
      asset: r.asset,
      regime: r.regime,
      score: r.score,
      config: r.config,
      action: r.action,
      at: r.at,
    }));

    return json({
      outcomes: rows,
      byAsset: assets.map(a => ({
        asset: a,
        regimes: summariseByRegime(records, a),
        latest: rows.find(r => r.asset === a) ?? null,
      })),
      lastRunAt: db.lastRun("selfheal"),
    });
  }

  // ─── Portfolio ───
  if (path === "/api/portfolio") {
    const assets = enabledAssets(cfg).map(toAssetDefinition);
    const matrix = correlationsFrom(db, assets, {
      prior: cfg.risk.assumedCorrelation,
      minSamples: cfg.risk.minCorrelationSamples,
    });
    const open = openExposures(db);
    const book = summarise(open, matrix, { maxRisk: cfg.risk.maxRisk });

    // Every distinct pair, so a refusal in the journal can be traced to the
    // correlation that caused it.
    const ids = assets.map(a => a.id);
    const correlations = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const e = matrix.get(ids[i], ids[j]);
        correlations.push({
          a: ids[i],
          b: ids[j],
          value: e.value,
          samples: Number.isFinite(e.samples) ? e.samples : null,
          assumed: e.assumed,
        });
      }
    }

    // How much independent evidence the whole record actually carries. The
    // per-asset verdicts on /api/performance count every trade as its own
    // result; across a correlated book, many of them are the same result.
    const periods = db.holdingPeriods();
    const wins = periods.filter(p => p.won).length;
    const concurrency = averageConcurrency(periods);
    const rho = Math.max(0, matrix.average());
    const effective = effectiveSampleSize(periods.length, concurrency, rho);
    // Hold the win rate fixed and shrink the sample — the rate is what was
    // observed; only the confidence it supports is being discounted.
    const effectiveWins =
      periods.length > 0 ? Math.round((wins / periods.length) * effective) : 0;

    return json({
      ...book,
      correlations,
      evidence: {
        trades: periods.length,
        wins,
        averageConcurrency: concurrency,
        averageCorrelation: rho,
        effectiveTrades: effective,
        // Breakeven is unknown at portfolio level (points are not comparable
        // across instruments), so this asks the weaker but answerable
        // question: is the win rate itself distinguishable from a coin flip?
        significance: assessSignificance(effectiveWins, effective, 50),
      },
    });
  }

  // ─── Candles ───
  if (path === "/api/candles") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    if (!asset) return bad("asset is required");
    const interval = url.searchParams.get("interval") ?? "5m";
    return json({
      asset,
      interval,
      candles: db.getCandles(
        asset,
        interval,
        intParam(url, "limit", 200, 1000),
      ),
    });
  }

  // ─── Intel state (regime, macro, news, sweeps) ───
  const stateMatch = path.match(/^\/api\/state\/([a-zA-Z0-9_-]+)$/);
  if (stateMatch) {
    const value = db.getSetting(stateMatch[1]);
    return value === null ? bad("not set", 404) : json(value);
  }

  // ─── Health ───
  if (path === "/api/health") {
    return json({
      ok: true,
      openIdeas: db.openIdeas().length,
      lastSignalRun: db.lastRun("signals"),
      lastMonitorRun: db.lastRun("monitor"),
    });
  }

  // ─── Manual trades (Risk Manager) ───
  if (path === "/api/trades") {
    if (req.method === "POST") {
      const body = await readBody(req);
      if (body instanceof Response) return body;

      const entryPrice = num(body, "entryPrice");
      if (entryPrice instanceof Response) return entryPrice;
      const stopLoss = num(body, "stopLoss");
      if (stopLoss instanceof Response) return stopLoss;
      const takeProfit = num(body, "takeProfit");
      if (takeProfit instanceof Response) return takeProfit;
      const lotSize = num(body, "lotSize");
      if (lotSize instanceof Response) return lotSize;
      if (body.direction !== "LONG" && body.direction !== "SHORT") {
        return bad("direction must be LONG or SHORT");
      }
      const asset = (body.asset as string) ?? DEFAULT_ASSET_ID;
      if (!findAsset(asset)) return bad(`unknown asset "${asset}"`, 404);

      const id = db.createManualTrade({
        asset,
        direction: body.direction,
        entryPrice,
        stopLoss,
        takeProfit,
        lotSize,
        riskAmount: (body.riskAmount as number) ?? null,
        notes: (body.notes as string) ?? null,
      });
      publish("trades");
      return json({ ok: true, id });
    }
    return json({
      trades: camelAll(db.listManualTrades(intParam(url, "limit", 100, 500))),
    });
  }

  if (path === "/api/trades/stats") return json(db.manualTradeStats());

  const tradeMatch = path.match(/^\/api\/trades\/(\d+)$/);
  if (tradeMatch) {
    const id = Number(tradeMatch[1]);
    if (req.method === "DELETE") {
      db.deleteManualTrade(id);
      publish("trades");
      return json({ ok: true });
    }
    if (req.method === "POST" || req.method === "PATCH") {
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const exitPrice = num(body, "exitPrice");
      if (exitPrice instanceof Response) return exitPrice;
      // P&L is derived server-side from the stored entry — see db.closeManualTrade.
      db.closeManualTrade(id, exitPrice);
      publish("trades");
      return json({ ok: true });
    }
  }

  // ─── Manual idea logging (dashboard / experimental sources) ───
  if (path === "/api/ideas" && req.method === "POST") {
    const body = await readBody(req);
    if (body instanceof Response) return body;

    for (const k of ["entryPrice", "stopLoss", "tp1", "tp2"]) {
      const v = num(body, k);
      if (v instanceof Response) return v;
    }
    if (body.direction !== "LONG" && body.direction !== "SHORT") {
      return bad("direction must be LONG or SHORT");
    }
    const asset = (body.asset as string) ?? DEFAULT_ASSET_ID;
    if (!findAsset(asset)) return bad(`unknown asset "${asset}"`, 404);

    const entryPrice = body.entryPrice as number;
    const id = db.createIdea({
      asset,
      direction: body.direction,
      source: (body.source as "dashboard" | "experimental") ?? "dashboard",
      entryPrice,
      stopLoss: body.stopLoss as number,
      tp1: body.tp1 as number,
      tp2: body.tp2 as number,
      confidence: (body.confidence as number) ?? 0,
      grade: (body.grade as string) ?? null,
      reason: (body.reason as string) ?? "",
      timeframe: (body.timeframe as string) ?? "5m",
      bias: (body.bias as string) ?? "NEUTRAL",
      biasStrength: (body.biasStrength as number) ?? 0,
      spotPrice: (body.spotPrice as number) ?? entryPrice,
    });
    publish("ideas");
    return json({ ok: true, id });
  }

  // ─── Market data proxy ───
  // The browser cannot call the venue directly (CORS), and these are the
  // endpoints the dashboard's chart and ticker read. Stored candles come from
  // /api/candles; these serve intervals the engine does not persist (1m, 3m)
  // and the live spot price.
  if (path === "/api/klines") {
    const symbol = url.searchParams.get("symbol") ?? DEFAULT_ASSET_ID;
    const asset = findAsset(symbol);
    if (!asset) return bad(`unknown asset "${symbol}"`, 404);
    const interval = url.searchParams.get("interval") ?? "5m";
    const limit = intParam(url, "limit", 200, 1000);

    // An MT5 instrument has no venue to proxy: its bars arrive from the
    // terminal. Serving the stored series keeps the chart working instead of
    // asking an exchange for a broker-specific symbol it has never heard of.
    if (asset.dataSource === "mt5") {
      return json(db.getCandles(asset.id, interval, limit));
    }
    try {
      const candles = await fetchCandles(asset.dataSourceSymbol, interval, {
        limit,
      });
      return json(candles);
    } catch (e) {
      return bad(e instanceof Error ? e.message : "upstream failed", 502);
    }
  }

  if (path === "/api/prices") {
    const requested = url.searchParams.get("symbols");
    const wanted = requested
      ? (requested
          .split(",")
          .map(sym => findAsset(sym))
          .filter(Boolean) as AssetConfig[])
      : enabledAssets(cfg);
    // Only exchange-fed assets have a ticker endpoint behind them.
    const venue = wanted.filter(a => a.dataSource === "binance");
    if (wanted.length === 0) return bad("no known symbols requested", 404);
    try {
      const tickers =
        venue.length > 0
          ? await fetchTickers(venue.map(a => a.dataSourceSymbol))
          : [];
      return json({ tickers });
    } catch (e) {
      return bad(e instanceof Error ? e.message : "upstream failed", 502);
    }
  }

  // ─── Configuration ───
  //
  // This is what makes the app configurable without touching code. GET hands
  // the UI the live document; PUT validates and replaces it wholesale.
  //
  // Wholesale rather than per-field patching because the rules that matter are
  // cross-field — TP1 inside TP2, MACD fast under slow, execution requiring the
  // bridge — and a patch API would let a client satisfy each field in isolation
  // while leaving the document as a whole incoherent.
  if (path === "/api/config") {
    if (req.method === "GET") {
      return json(cfg);
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = await readBody(req);
      if (body instanceof Response) return body;
      try {
        const saved = store.save(body);
        publish("config");
        return json(saved);
      } catch (e) {
        if (e instanceof ConfigError) {
          // 422, not 400: the request was well-formed JSON and the objection is
          // to its contents, which is what the form needs to render per field.
          return json({ error: e.message, issues: e.issues }, 422);
        }
        throw e;
      }
    }
    return bad("GET or PUT", 405);
  }

  if (path === "/api/config/defaults") {
    return json(defaultConfig());
  }

  if (path === "/api/config/reset" && req.method === "POST") {
    const saved = store.reset();
    publish("config");
    return json(saved);
  }

  // ─── MetaTrader 5 ───
  if (path === "/api/mt5/status") {
    return json(mt5Status(db, cfg));
  }

  if (path === "/api/mt5/discover") {
    // Offered as a button in the UI, so the operator never has to know that
    // MT5 hides its files under a hashed directory inside a Wine bottle.
    const dir = findExportDir();
    return json({ directory: dir, found: dir !== null });
  }

  // ─── Strategy discovery ───
  //
  // A run is a resource rather than a request: pulling two years of bars from a
  // broker and searching thousands of configurations both outlast any sensible
  // HTTP timeout, so the browser starts one and then polls it.
  if (path === "/api/research/runs" && req.method === "GET") {
    return json({ runs: listRuns() });
  }

  if (path === "/api/research/runs" && req.method === "POST") {
    const body = await readBody(req);
    if (body instanceof Response) return body;

    const symbol = String(body.symbol ?? "").trim();
    const interval = String(body.interval ?? "15m");
    const from = Number(body.from);
    const to = Number(body.to);
    const iterations = Number(body.iterations ?? 500);

    if (!symbol) return bad("symbol is required");
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return bad("from and to must be UTC seconds with to after from");
    }
    // Bounded because each iteration is three backtests over the whole window,
    // and an unbounded number would let one request occupy the process for
    // hours while the live engine's timers starve.
    if (!Number.isFinite(iterations) || iterations < 10 || iterations > 20000) {
      return bad("iterations must be between 10 and 20000");
    }

    const assetId = String(body.assetId ?? `MT5:${symbol}`);
    const run = startRun(db, cfg, {
      assetId,
      symbol,
      interval,
      from: Math.floor(from),
      to: Math.floor(to),
      iterations: Math.floor(iterations),
      seed: Number(body.seed ?? 1),
      minTrades:
        body.minTrades === undefined ? undefined : Number(body.minTrades),
    });
    return json(run, 202);
  }

  if (path.startsWith("/api/research/runs/")) {
    const id = decodeURIComponent(path.slice("/api/research/runs/".length));

    if (id.endsWith("/cancel") && req.method === "POST") {
      const runId = id.slice(0, -"/cancel".length);
      // A run that never existed is a 404, matching the other run routes.
      // Answering 200 with cancelled:false made a typo or a stale tab after a
      // restart look identical to a run that had simply already finished.
      if (!getRun(runId)) return bad("no such run", 404);
      return json({ cancelled: cancelRun(runId) });
    }

    if (id.endsWith("/adopt") && req.method === "POST") {
      // Adopting a discovered configuration is the point of the whole feature:
      // a report you cannot act on without retyping twenty numbers is a report
      // nobody acts on.
      const runId = id.slice(0, -"/adopt".length);
      const run = getRun(runId);
      if (!run) return bad("no such run", 404);
      if (!run.report?.best) {
        return bad("that run has no qualified strategy to adopt", 409);
      }

      // The instrument is optional: adopting onto the one that was researched
      // is the common case, so a bodyless POST must work rather than fail as
      // malformed JSON.
      const body = await readOptionalBody(req);
      if (body instanceof Response) return body;
      const targetId = String(body.assetId || run.assetId);

      const strategy = run.report.best.config;
      const target = cfg.assets.find(a => a.id === targetId);

      // Researching an instrument you have not configured yet is the normal
      // way to meet one, so adopting its strategy ADDS it rather than
      // refusing. It arrives disabled: discovering a strategy and trading it
      // are separate decisions, and collapsing them would put an untested
      // instrument into the live engine on one click.
      const assets = target
        ? cfg.assets.map(a =>
            a.id === targetId ? { ...a, config: strategy } : a,
          )
        : [
            ...cfg.assets,
            {
              ...newAsset(targetId, {
                displaySymbol: run.symbol,
                dataSourceSymbol: run.symbol,
                dataSource: "mt5",
                enabled: false,
                config: strategy,
              }),
            },
          ];

      try {
        store.save({ ...cfg, assets });
      } catch (e) {
        if (e instanceof ConfigError) {
          return json({ error: e.message, issues: e.issues }, 422);
        }
        throw e;
      }
      return json({
        adopted: true,
        assetId: targetId,
        added: target === undefined,
      });
    }

    const run = getRun(id);
    if (!run) return bad("no such run", 404);
    return json(run);
  }

  if (path === "/api/mt5/sync" && req.method === "POST") {
    const outcome = syncOnce(db, cfg, updater => {
      store.save({ ...cfg, assets: updater(cfg.assets) });
    });
    publish("mt5");
    return json(outcome, outcome.ok ? 200 : 502);
  }

  // ─── Teo sidecar ───
  //
  // These WRITE the forward-test record, which is only evidence if it cannot be
  // backfilled. The server binds to 127.0.0.1, so a local process is already
  // the only possible caller; setting TEO_SHARED_SECRET additionally requires a
  // matching x-teo-secret header, which is what you want if you ever bind wider.
  if (path === "/teo/propose" || path === "/teo/decision") {
    const expected = process.env.TEO_SHARED_SECRET;
    if (expected && req.headers.get("x-teo-secret") !== expected) {
      return bad("unauthorized", 401);
    }
    if (req.method !== "POST") return bad("POST required", 405);

    const body = await readBody(req);
    if (body instanceof Response) return body;

    if (path === "/teo/propose") {
      for (const k of ["entryPrice", "stopLoss", "tp1", "tp2"]) {
        const v = num(body, k);
        if (v instanceof Response) return v;
      }
      if (body.direction !== "LONG" && body.direction !== "SHORT") {
        return bad("direction must be LONG or SHORT");
      }
      const asset = (body.asset as string) ?? DEFAULT_ASSET_ID;
      // Reject symbols the engine does not track: a forward-test row for an
      // asset nothing monitors could never be resolved.
      if (!findAsset(asset)) return bad(`unknown asset "${asset}"`, 404);

      const entryPrice = body.entryPrice as number;
      const id = db.createIdea({
        asset,
        direction: body.direction,
        source: "teo",
        entryPrice,
        stopLoss: body.stopLoss as number,
        tp1: body.tp1 as number,
        tp2: body.tp2 as number,
        confidence: (body.confidence as number) ?? 0,
        reason: (body.reason as string) ?? "Teo proposal",
        timeframe: (body.timeframe as string) ?? "15m",
        bias: (body.bias as string) ?? "NEUTRAL",
        biasStrength: (body.biasStrength as number) ?? 0,
        spotPrice: (body.spotPrice as number) ?? entryPrice,
        teoScore: (body.teoScore as number) ?? null,
        teoRegime: (body.teoRegime as string) ?? null,
      });
      db.logJournal({
        eventType: "SIGNAL_GENERATED",
        asset,
        source: "teo",
        ideaId: id,
        direction: body.direction,
        price: entryPrice,
        details:
          `[Teo] ${body.direction} ${asset} @ ${entryPrice} | ` +
          `regime ${body.teoRegime ?? "unknown"} | score ${body.teoScore ?? "n/a"}`,
        metadata: { teoScore: body.teoScore, teoRegime: body.teoRegime },
      });
      publish("ideas");
      publish("journal");
      return json({ ok: true, id });
    }

    // /teo/decision — append-only. Records what Teo decided and why; it never
    // applies a configuration change.
    const required = [
      "asset",
      "strategyId",
      "regime",
      "status",
      "action",
      "reason",
    ];
    if (required.some(k => typeof body[k] !== "string")) {
      return bad("missing required decision fields");
    }
    db.logJournal({
      eventType: "TEO_DECISION",
      asset: body.asset as string,
      source: "teo",
      details: `[Teo/${body.strategyId}] ${body.action} ${body.asset} | ${body.reason}`,
      metadata: {
        strategyId: body.strategyId,
        regime: body.regime,
        status: body.status,
        action: body.action,
        currentScore: body.currentScore,
        proposedScore: body.proposedScore,
        improvement: body.improvement,
        extra: body.metadata,
      },
    });
    publish("journal");
    return json({ ok: true, timestamp: Date.now() });
  }

  // ─── Kill switch / risk manager ───
  if (path === "/api/risk") {
    if (!risk)
      return json({
        limitsActive: false,
        message: "Risk manager not configured.",
      });
    return json(risk.status());
  }

  if (path === "/api/risk/resume" && req.method === "POST") {
    if (!risk) return bad("Risk manager not configured.", 503);
    risk.resume();
    return json({ ok: true });
  }

  // Any other /api/* path is a mistake, not a client-side route. Falling
  // through to the SPA would hand the caller HTML where it expected JSON,
  // which surfaces as an opaque parse error rather than a 404.
  if (path.startsWith("/api/")) return bad("no such endpoint", 404);

  return null; // not an API route
}

/**
 * SSE stream. The browser holds this open and the server pushes on change,
 * which is what replaces Convex's reactive queries.
 */
export function handleEvents(): Response {
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (e: AppEvent) => {
        try {
          controller.enqueue(`data: ${JSON.stringify(e)}\n\n`);
        } catch {
          // Client vanished between the change and this write.
        }
      };
      send({ kind: "hello", at: Date.now() });
      unsubscribe = subscribe(send);

      // Comment frames keep intermediaries from timing the connection out.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(": keepalive\n\n");
        } catch {
          // ignore
        }
      }, 25_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
