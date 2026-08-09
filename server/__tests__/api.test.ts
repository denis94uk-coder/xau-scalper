/**
 * Route tests. handleApi is a pure function of (db, request, url), so these run
 * without binding a port.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleApi } from "../api";
import { Db, type NewIdea } from "../db";

let db: Db;

beforeEach(() => {
  db = new Db(":memory:");
});

function call(path: string, method = "GET") {
  const url = new URL(`http://localhost${path}`);
  return handleApi(db, new Request(url.toString(), { method }), url);
}

async function body<T = Record<string, unknown>>(
  res: Response | null,
): Promise<T> {
  if (!res) throw new Error("route returned null");
  return (await res.json()) as T;
}

function idea(over: Partial<NewIdea> = {}) {
  return db.createIdea({
    asset: "PAXGUSDT",
    direction: "LONG",
    entryPrice: 3450,
    stopLoss: 3420,
    tp1: 3486,
    tp2: 3525,
    spotPrice: 3450,
    ...over,
  });
}

describe("routing", () => {
  test("returns null for non-API paths so static serving can take over", () => {
    expect(call("/")).toBeNull();
    expect(call("/dashboard")).toBeNull();
    expect(call("/assets.js")).toBeNull();
  });

  test("health reports engine liveness", async () => {
    idea();
    const b = await body(call("/api/health"));
    expect(b.ok).toBe(true);
    expect(b.openIdeas).toBe(1);
    expect(b.lastMonitorRun).toBeNull();
  });
});

describe("assets", () => {
  test("lists the registry", async () => {
    const b = await body<{ assets: Array<{ id: string }> }>(
      call("/api/assets"),
    );
    expect(b.assets.length).toBeGreaterThan(0);
    expect(b.assets.map(a => a.id)).toContain("PAXGUSDT");
  });
});

describe("ideas", () => {
  test("includes the journey events inline", async () => {
    idea();
    const b = await body<{ ideas: Array<{ events: unknown[] }> }>(
      call("/api/ideas"),
    );
    expect(b.ideas).toHaveLength(1);
    expect(b.ideas[0].events).toHaveLength(2);
  });

  test("filters by asset", async () => {
    idea({ asset: "PAXGUSDT" });
    idea({ asset: "BTCUSDT" });
    const b = await body<{ ideas: unknown[] }>(
      call("/api/ideas?asset=BTCUSDT"),
    );
    expect(b.ideas).toHaveLength(1);
  });

  test("an unknown asset is a 404, not an empty list", async () => {
    // Silently returning [] would be indistinguishable from "no activity yet",
    // which hides typos in a filter.
    const res = call("/api/ideas?asset=NOTREAL");
    expect(res?.status).toBe(404);
  });

  test("a single idea can be fetched and deleted", async () => {
    const id = idea();
    expect(call(`/api/ideas/${id}`)?.status).toBe(200);
    expect(call(`/api/ideas/${id}`, "DELETE")?.status).toBe(200);
    expect(call(`/api/ideas/${id}`)?.status).toBe(404);
  });

  test("open ideas exclude resolved ones", async () => {
    const a = idea();
    const b2 = idea();
    db.updateIdea(b2, { status: "STOPPED" });
    const b = await body<{ ideas: Array<{ id: number }> }>(
      call("/api/ideas/open"),
    );
    expect(b.ideas.map(i => i.id)).toEqual([a]);
  });

  test("limit is clamped rather than trusted", async () => {
    for (let i = 0; i < 5; i++) idea();
    const b = await body<{ ideas: unknown[] }>(call("/api/ideas?limit=2"));
    expect(b.ideas).toHaveLength(2);
    // Absurd values fall back to the cap instead of trying to allocate them.
    expect(call("/api/ideas?limit=999999")?.status).toBe(200);
    expect(call("/api/ideas?limit=-1")?.status).toBe(200);
    expect(call("/api/ideas?limit=abc")?.status).toBe(200);
  });
});

describe("journal", () => {
  test("lists entries and counts by type", async () => {
    db.logJournal({ eventType: "ENGINE_RUN", asset: "PAXGUSDT" });
    db.logJournal({ eventType: "SL_HIT", asset: "PAXGUSDT" });
    expect(
      (await body<{ entries: unknown[] }>(call("/api/journal"))).entries,
    ).toHaveLength(2);
    expect(
      await body<Record<string, number>>(call("/api/journal/counts")),
    ).toEqual({
      ENGINE_RUN: 1,
      SL_HIT: 1,
    });
  });
});

describe("performance", () => {
  test("is reported per asset, never as a cross-asset total", async () => {
    const g = idea({ asset: "PAXGUSDT" });
    db.updateIdea(g, { status: "TP2_HIT", pnl_points: 75 });
    const btc = idea({ asset: "BTCUSDT" });
    db.updateIdea(btc, { status: "TP2_HIT", pnl_points: 1200 });

    const b = await body<{
      byAsset: Array<{ asset: string; netPoints: number }>;
    }>(call("/api/performance"));
    const map = Object.fromEntries(b.byAsset.map(r => [r.asset, r.netPoints]));
    expect(map.PAXGUSDT).toBe(75);
    expect(map.BTCUSDT).toBe(1200);
    // No aggregate field exists to accidentally render.
    expect(b).not.toHaveProperty("total");
  });
});

describe("candles", () => {
  test("requires an asset", () => {
    expect(call("/api/candles")?.status).toBe(400);
  });

  test("returns stored candles for an asset and interval", async () => {
    db.saveCandles("BTCUSDT", "5m", [
      { time: 300, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ]);
    const b = await body<{ candles: unknown[] }>(
      call("/api/candles?asset=BTCUSDT&interval=5m"),
    );
    expect(b.candles).toHaveLength(1);
  });
});

describe("intel state", () => {
  test("404s until an engine has written it", async () => {
    expect(call("/api/state/regime")?.status).toBe(404);
    db.setSetting("regime", { regime: "RANGING" });
    expect(await body<{ regime: string }>(call("/api/state/regime"))).toEqual({
      regime: "RANGING",
    });
  });
});
