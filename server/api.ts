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
import type { Db } from "./db";
import { type AppEvent, publish, subscribe } from "./events";

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
    return json({ byAsset: assets.map(a => db.performance(a)) });
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
