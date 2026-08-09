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

function call(path: string, method = "GET", body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return handleApi(db, new Request(url.toString(), init), url);
}

async function body<T = Record<string, unknown>>(
  res: Promise<Response | null> | Response | null,
): Promise<T> {
  const r = await res;
  if (!r) throw new Error("route returned null");
  return (await r.json()) as T;
}

/** Await a route and assert it produced a response. */
async function status(res: Promise<Response | null>): Promise<number | null> {
  return (await res)?.status ?? null;
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
  test("returns null for non-API paths so static serving can take over", async () => {
    expect(await call("/")).toBeNull();
    expect(await call("/dashboard")).toBeNull();
    expect(await call("/assets.js")).toBeNull();
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
    expect(await status(call("/api/ideas?asset=NOTREAL"))).toBe(404);
  });

  test("a single idea can be fetched and deleted", async () => {
    const id = idea();
    expect(await status(call(`/api/ideas/${id}`))).toBe(200);
    expect(await status(call(`/api/ideas/${id}`, "DELETE"))).toBe(200);
    expect(await status(call(`/api/ideas/${id}`))).toBe(404);
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
    expect(await status(call("/api/ideas?limit=999999"))).toBe(200);
    expect(await status(call("/api/ideas?limit=-1"))).toBe(200);
    expect(await status(call("/api/ideas?limit=abc"))).toBe(200);
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
      byAsset: Array<{ asset: string; totalPnlPoints: number }>;
    }>(call("/api/performance"));
    const map = Object.fromEntries(
      b.byAsset.map(r => [r.asset, r.totalPnlPoints]),
    );
    expect(map.PAXGUSDT).toBe(75);
    expect(map.BTCUSDT).toBe(1200);
    // No aggregate field exists to accidentally render.
    expect(b).not.toHaveProperty("total");
  });

  test("every asset carries a significance verdict, not just a win rate", async () => {
    // Two wins out of two looks like a 100% win rate. The endpoint must not let
    // that be served without saying it means nothing.
    for (const _ of [0, 1]) {
      db.updateIdea(idea({ asset: "PAXGUSDT" }), {
        status: "TP2_HIT",
        pnl_points: 50,
      });
    }

    const b = await body<{
      byAsset: Array<{
        asset: string;
        winRate: number;
        significance: { verdict: string; trades: number; summary: string };
      }>;
    }>(call("/api/performance?asset=PAXGUSDT"));

    const row = b.byAsset[0];
    expect(row.winRate).toBe(100);
    expect(row.significance.trades).toBe(2);
    expect(row.significance.verdict).toBe("insufficient_data");
    expect(row.significance.summary).toContain("too few");
  });

  test("an asset with no trades still reports a verdict rather than omitting it", async () => {
    const b = await body<{
      byAsset: Array<{ significance: { verdict: string } }>;
    }>(call("/api/performance?asset=BTCUSDT"));
    expect(b.byAsset[0].significance.verdict).toBe("insufficient_data");
  });
});

describe("candles", () => {
  test("requires an asset", async () => {
    expect(await status(call("/api/candles"))).toBe(400);
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
    expect(await status(call("/api/state/regime"))).toBe(404);
    db.setSetting("regime", { regime: "RANGING" });
    expect(await body<{ regime: string }>(call("/api/state/regime"))).toEqual({
      regime: "RANGING",
    });
  });
});

describe("manual trades", () => {
  const open = () =>
    call("/api/trades", "POST", {
      asset: "PAXGUSDT",
      direction: "LONG",
      entryPrice: 3450,
      stopLoss: 3420,
      takeProfit: 3500,
      lotSize: 2,
    });

  test("opens, lists and reports stats", async () => {
    expect(await status(open())).toBe(200);
    const list = await body<{ trades: unknown[] }>(call("/api/trades"));
    expect(list.trades).toHaveLength(1);
    const stats = await body<{ openTrades: number; totalTrades: number }>(
      call("/api/trades/stats"),
    );
    expect(stats.openTrades).toBe(1);
    expect(stats.totalTrades).toBe(1);
  });

  test("closing derives P&L from the stored entry, not the caller", async () => {
    // A journal whose numbers can be supplied independently of its prices
    // cannot be audited, so the client does not get to state the result.
    const { id } = await body<{ id: number }>(open());
    await call(`/api/trades/${id}`, "POST", {
      exitPrice: 3470,
      pnlDollars: 99999,
    });
    const stats = await body<{ wins: number; netDollars: number }>(
      call("/api/trades/stats"),
    );
    expect(stats.wins).toBe(1);
    expect(stats.netDollars).toBeCloseTo(40); // (3470-3450) * 2 lots
  });

  test("a losing close is classified as a loss", async () => {
    const { id } = await body<{ id: number }>(open());
    await call(`/api/trades/${id}`, "POST", { exitPrice: 3430 });
    const stats = await body<{ losses: number }>(call("/api/trades/stats"));
    expect(stats.losses).toBe(1);
  });

  test("rejects a bad direction and a non-numeric price", async () => {
    expect(
      await status(
        call("/api/trades", "POST", {
          direction: "SIDEWAYS",
          entryPrice: 1,
          stopLoss: 1,
          takeProfit: 1,
          lotSize: 1,
        }),
      ),
    ).toBe(400);
    expect(
      await status(
        call("/api/trades", "POST", {
          direction: "LONG",
          entryPrice: "cheap",
          stopLoss: 1,
          takeProfit: 1,
          lotSize: 1,
        }),
      ),
    ).toBe(400);
  });

  test("rejects a malformed body rather than throwing", async () => {
    expect(await status(call("/api/trades", "POST", "not json{"))).toBe(400);
    expect(await status(call("/api/trades", "POST", [1, 2, 3]))).toBe(400);
  });

  test("deletes", async () => {
    const { id } = await body<{ id: number }>(open());
    expect(await status(call(`/api/trades/${id}`, "DELETE"))).toBe(200);
    expect(
      (await body<{ trades: unknown[] }>(call("/api/trades"))).trades,
    ).toHaveLength(0);
  });
});

describe("logging an idea by hand", () => {
  test("creates a dashboard-sourced idea", async () => {
    const res = await body<{ id: number }>(
      call("/api/ideas", "POST", {
        asset: "BTCUSDT",
        direction: "SHORT",
        entryPrice: 95000,
        stopLoss: 96000,
        tp1: 94000,
        tp2: 92000,
      }),
    );
    const idea = db.getIdea(res.id)!;
    expect(idea.source).toBe("dashboard");
    expect(idea.asset).toBe("BTCUSDT");
  });

  test("rejects an unknown asset", async () => {
    expect(
      await status(
        call("/api/ideas", "POST", {
          asset: "NOPE",
          direction: "LONG",
          entryPrice: 1,
          stopLoss: 1,
          tp1: 1,
          tp2: 1,
        }),
      ),
    ).toBe(404);
  });
});
