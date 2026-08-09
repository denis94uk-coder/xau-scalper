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

import { ASSETS, getAsset, getEnabledAssets } from "../convex/lib/assets";
import type { Db } from "./db";
import { type AppEvent, subscribe } from "./events";

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

export function handleApi(db: Db, req: Request, url: URL): Response | null {
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
  if (path === "/api/ideas") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    const ideas = db.listIdeas({
      asset,
      limit: intParam(url, "limit", 100, 500),
    });
    return json({
      ideas: ideas.map(i => ({ ...i, events: db.ideaEvents(i.id) })),
    });
  }

  if (path === "/api/ideas/open") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    return json({ ideas: db.openIdeas(asset) });
  }

  const ideaMatch = path.match(/^\/api\/ideas\/(\d+)$/);
  if (ideaMatch) {
    const id = Number(ideaMatch[1]);
    if (req.method === "DELETE") {
      db.deleteIdea(id);
      return json({ ok: true });
    }
    const idea = db.getIdea(id);
    if (!idea) return bad("not found", 404);
    return json({ ...idea, events: db.ideaEvents(id) });
  }

  // ─── Journal ───
  if (path === "/api/journal") {
    const asset = assetParam(url);
    if (asset instanceof Response) return asset;
    return json({
      entries: db.listJournal({
        asset,
        limit: intParam(url, "limit", 200, 1000),
      }),
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
