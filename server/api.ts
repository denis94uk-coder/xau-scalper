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

import {
  ASSETS,
  DEFAULT_ASSET_ID,
  getAsset,
  getEnabledAssets,
} from "../core/assets";
import { summariseByRegime } from "../core/memory";
import { averageConcurrency, summarise } from "../core/portfolio";
import { assessSignificance, effectiveSampleSize } from "../core/significance";
import type { Db } from "./db";
import { correlationsFrom, openExposures } from "./engine";
import { type AppEvent, publish, subscribe } from "./events";
import { fetchCandles, fetchTickers } from "./market";
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

/**
 * Validate an asset id from the query string.
 *
 * Returns undefined when absent, an Error Response when present-but-unknown.
 * An unknown asset is rejected rather than silently returning an empty list,
 * which would look identical to "this asset has no activity".
 */
function assetParam(url: URL): string | undefined | Response {
  const asset = url.searchParams.get("asset");
  if (asset === null) return undefined;
  if (!getAsset(asset)) return bad(`unknown asset "${asset}"`, 404);
  return asset;
}

/** Parse a JSON object body, or return an error Response. */
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

export async function handleApi(
  db: Db,
  req: Request,
  url: URL,
  risk?: RiskManager,
): Promise<Response | null> {
  const path = url.pathname;

  // ─── Assets ───
  if (path === "/api/assets") {
    return json({
      assets: ASSETS.map(a => ({
        id: a.id,
        symbol: a.displaySymbol,
        precision: a.pricePrecision,
        enabled: a.enabled,
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
    const assets = asset ? [asset] : getEnabledAssets().map(a => a.id);
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
    const assets = getEnabledAssets();
    const matrix = correlationsFrom(db, assets);
    const open = openExposures(db);
    const book = summarise(open, matrix);

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
      if (!getAsset(asset)) return bad(`unknown asset "${asset}"`, 404);

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
    if (!getAsset(asset)) return bad(`unknown asset "${asset}"`, 404);

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
    if (!getAsset(symbol)) return bad(`unknown asset "${symbol}"`, 404);
    const interval = url.searchParams.get("interval") ?? "5m";
    const limit = intParam(url, "limit", 200, 1000);
    try {
      const candles = await fetchCandles(symbol, interval, { limit });
      return json(candles);
    } catch (e) {
      return bad(e instanceof Error ? e.message : "upstream failed", 502);
    }
  }

  if (path === "/api/prices") {
    const requested = url.searchParams.get("symbols");
    const ids = requested
      ? requested.split(",").filter(sym => getAsset(sym))
      : getEnabledAssets().map(a => a.id);
    if (ids.length === 0) return bad("no known symbols requested", 404);
    try {
      return json({ tickers: await fetchTickers(ids) });
    } catch (e) {
      return bad(e instanceof Error ? e.message : "upstream failed", 502);
    }
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
      if (!getAsset(asset)) return bad(`unknown asset "${asset}"`, 404);

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
    if (!risk) return json({ limitsActive: false, message: "Risk manager not configured." });
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
