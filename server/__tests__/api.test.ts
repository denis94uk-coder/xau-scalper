/**
 * Route tests. handleApi is a pure function of (db, request, url), so these run
 * without binding a port.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppConfig } from "../../core/config";
import { defaultConfig, validateConfig } from "../../core/config";
import { handleApi } from "../api";
import { Db, type NewIdea } from "../db";
import { putRun } from "../research";

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

describe("selfheal", () => {
  type Feed = {
    outcomes: Array<{ asset: string; action: string; reason: string }>;
    byAsset: Array<{
      asset: string;
      regimes: Array<{ regime: string; records: number; proposals: number }>;
      latest: { action: string } | null;
    }>;
    lastRunAt: number | null;
  };

  const outcome = (over: Record<string, unknown> = {}) =>
    db.recordOutcome({
      asset: "BTCUSDT",
      regime: "trend_up/normal_vol",
      action: "hold",
      status: "healthy",
      score: 1.5,
      config: { atrSlMultiplier: 1.5 },
      reason: "profit factor fine",
      ...over,
    });

  test("an untouched database reports nothing rather than erroring", async () => {
    const b = await body<Feed>(call("/api/selfheal"));
    expect(b.outcomes).toEqual([]);
    expect(b.byAsset).toEqual([]);
    expect(b.lastRunAt).toBeNull();
  });

  test("holds are served, not only proposals", async () => {
    // A feed that shows only the times the loop wanted to change something
    // reads as though it were changing things constantly.
    outcome({ action: "hold" });
    outcome({ action: "propose_swap", status: "degraded" });
    const b = await body<Feed>(call("/api/selfheal"));
    expect(b.outcomes).toHaveLength(2);
    expect(b.outcomes.map(o => o.action).sort()).toEqual([
      "hold",
      "propose_swap",
    ]);
  });

  test("newest first, and the latest is the newest", async () => {
    outcome({ reason: "older", at: 1_000 });
    outcome({ reason: "newer", at: 9_000 });
    const b = await body<Feed>(call("/api/selfheal"));
    expect(b.outcomes[0].reason).toBe("newer");
    expect(b.byAsset[0].latest).not.toBeNull();
  });

  test("summarises what the loop has learned per regime", async () => {
    outcome({ regime: "chop/high_vol", score: 1 });
    outcome({ regime: "chop/high_vol", score: 3, action: "propose_swap" });
    outcome({ regime: "trend_up/low_vol", score: 9 });

    const b = await body<Feed>(call("/api/selfheal"));
    const btc = b.byAsset.find(a => a.asset === "BTCUSDT")!;
    const chop = btc.regimes.find(r => r.regime === "chop/high_vol")!;
    expect(chop.records).toBe(2);
    expect(chop.proposals).toBe(1);
    expect(btc.regimes).toHaveLength(2);
  });

  test("filters by asset", async () => {
    outcome({ asset: "BTCUSDT" });
    outcome({ asset: "ETHUSDT" });
    const b = await body<Feed>(call("/api/selfheal?asset=ETHUSDT"));
    expect(b.outcomes).toHaveLength(1);
    expect(b.outcomes[0].asset).toBe("ETHUSDT");
  });

  test("an unknown asset is a 404, not an empty history", async () => {
    expect(await status(call("/api/selfheal?asset=NOPE"))).toBe(404);
  });

  test("the stored config round-trips through JSON intact", async () => {
    outcome({ config: { atrSlMultiplier: 2.5, tp2R: 3.5 } });
    const rows = db.outcomes();
    expect(rows[0].config).toEqual({
      atrSlMultiplier: 2.5,
      tp2R: 3.5,
    } as never);
  });
});

describe("portfolio", () => {
  type Portfolio = {
    positions: unknown[];
    grossRisk: number;
    portfolioRisk: number;
    concentration: number;
    netExposure: number;
    headroom: number;
    maxRisk: number;
    correlationsMeasured: boolean;
    summary: string;
    correlations: Array<{
      a: string;
      b: string;
      value: number;
      samples: number | null;
      assumed: boolean;
    }>;
    evidence: {
      trades: number;
      wins: number;
      effectiveTrades: number;
      averageConcurrency: number;
      significance: { verdict: string };
    };
  };

  test("an empty book reports no risk rather than dividing by zero", async () => {
    const b = await body<Portfolio>(call("/api/portfolio"));
    expect(b.portfolioRisk).toBe(0);
    expect(b.concentration).toBe(0);
    expect(b.summary).toBe("No open positions.");
    expect(b.headroom).toBe(b.maxRisk);
  });

  test("several same-direction positions read as more risk than one", async () => {
    idea({ asset: "PAXGUSDT" });
    const before = await body<Portfolio>(call("/api/portfolio"));
    idea({ asset: "BTCUSDT" });
    idea({ asset: "ETHUSDT" });
    const after = await body<Portfolio>(call("/api/portfolio"));

    expect(after.portfolioRisk).toBeGreaterThan(before.portfolioRisk);
    // But by less than gross size, which is the whole point of measuring it.
    expect(after.portfolioRisk).toBeLessThan(after.grossRisk);
    expect(after.netExposure).toBe(3);
  });

  test("an opposing position lowers risk instead of raising it", async () => {
    idea({ asset: "PAXGUSDT" });
    idea({ asset: "BTCUSDT" });
    const longOnly = await body<Portfolio>(call("/api/portfolio"));

    idea({ asset: "ETHUSDT", direction: "SHORT" });
    const hedged = await body<Portfolio>(call("/api/portfolio"));

    expect(hedged.portfolioRisk).toBeLessThan(longOnly.portfolioRisk);
    // Gross size went up while risk went down — a distinction a position count
    // cannot make.
    expect(hedged.grossRisk).toBeGreaterThan(longOnly.grossRisk);
  });

  test("closed positions do not occupy the book", async () => {
    const id = idea();
    db.updateIdea(id, { status: "TP2_HIT", pnl_points: 30 });
    expect((await body<Portfolio>(call("/api/portfolio"))).positions).toEqual(
      [],
    );
  });

  test("every pair is listed, and flagged when it is a guess", async () => {
    const b = await body<Portfolio>(call("/api/portfolio"));
    // No stored candles in this database, so nothing can be measured — and the
    // response must admit that rather than serving 0 as if it were a finding.
    expect(b.correlations.length).toBeGreaterThan(0);
    expect(b.correlations.every(c => c.assumed)).toBe(true);
    expect(
      b.correlations.every(c => c.samples === null || c.samples === 0),
    ).toBe(true);
    expect(b.correlationsMeasured).toBe(false);
  });

  test("measures correlation from stored candles when there is history", async () => {
    // BTC and ETH move together; gold moves against them. 60 aligned bars is
    // past the 30 an estimate needs.
    const bars = 60;
    for (let i = 0; i < bars; i++) {
      const wave = Math.sin(i / 3);
      const at = 1_000_000 + i * 300_000;
      const bar = (close: number) => ({
        time: at,
        open: close,
        high: close * 1.001,
        low: close * 0.999,
        close,
        volume: 1,
      });
      db.saveCandles("BTCUSDT", "5m", [bar(50_000 * (1 + wave * 0.01))]);
      db.saveCandles("ETHUSDT", "5m", [bar(3_000 * (1 + wave * 0.01))]);
      db.saveCandles("PAXGUSDT", "5m", [bar(3_400 / (1 + wave * 0.01))]);
    }

    const b = await body<Portfolio>(call("/api/portfolio"));
    const find = (x: string, y: string) =>
      b.correlations.find(
        c => (c.a === x && c.b === y) || (c.a === y && c.b === x),
      )!;

    const together = find("BTCUSDT", "ETHUSDT");
    expect(together.assumed).toBe(false);
    expect(together.samples).toBeGreaterThan(30);
    expect(together.value).toBeCloseTo(1, 3);

    const opposed = find("BTCUSDT", "PAXGUSDT");
    expect(opposed.assumed).toBe(false);
    expect(opposed.value).toBeCloseTo(-1, 3);

    // Assets with no stored candles still fall back rather than erroring.
    expect(find("BTCUSDT", "TAOUSDT").assumed).toBe(true);
    expect(b.correlationsMeasured).toBe(false);
  });

  test("a measured hedge beats an assumed one", async () => {
    // Same two positions, opposite directions. Without history the pair is
    // assumed to move together; with history showing they move apart, the
    // short is worth more as a hedge.
    const assumedBook = await (async () => {
      idea({ asset: "BTCUSDT" });
      idea({ asset: "PAXGUSDT", direction: "SHORT" });
      return body<Portfolio>(call("/api/portfolio"));
    })();

    for (let i = 0; i < 60; i++) {
      const wave = Math.sin(i / 3);
      const at = 1_000_000 + i * 300_000;
      const bar = (close: number) => ({
        time: at,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
      });
      db.saveCandles("BTCUSDT", "5m", [bar(50_000 * (1 + wave * 0.01))]);
      db.saveCandles("PAXGUSDT", "5m", [bar(3_400 / (1 + wave * 0.01))]);
    }
    const measuredBook = await body<Portfolio>(call("/api/portfolio"));

    // Anti-correlated + opposite direction = additive, not offsetting. The
    // measured book is therefore riskier than the assumption suggested — the
    // point being that the number changes when it stops being a guess.
    expect(measuredBook.portfolioRisk).not.toBeCloseTo(
      assumedBook.portfolioRisk,
      3,
    );
    expect(measuredBook.portfolioRisk).toBeGreaterThan(
      assumedBook.portfolioRisk,
    );
  });

  test("evidence is discounted for positions that were held together", async () => {
    // Ten wins, all open over the same window: one result, not ten.
    for (let i = 0; i < 10; i++) {
      const id = idea({ asset: "BTCUSDT" });
      db.updateIdea(id, { status: "TP2_HIT", pnl_points: 10 });
      db.raw
        .prepare(
          "UPDATE trading_ideas SET created_at = 1000, resolved_at = 9000 WHERE id = ?",
        )
        .run(id);
    }

    const b = await body<Portfolio>(call("/api/portfolio"));
    expect(b.evidence.trades).toBe(10);
    expect(b.evidence.wins).toBe(10);
    expect(b.evidence.averageConcurrency).toBeCloseTo(10, 6);
    expect(b.evidence.effectiveTrades).toBeLessThan(10);
    // A 100% win rate that survives no scrutiny must not read as an edge.
    expect(b.evidence.significance.verdict).toBe("insufficient_data");
  });

  test("sequential trades are not discounted", async () => {
    for (let i = 0; i < 6; i++) {
      const id = idea({ asset: "BTCUSDT" });
      db.updateIdea(id, { status: "TP2_HIT", pnl_points: 10 });
      db.raw
        .prepare(
          "UPDATE trading_ideas SET created_at = ?, resolved_at = ? WHERE id = ?",
        )
        .run(i * 1000, i * 1000 + 500, id);
    }
    const b = await body<Portfolio>(call("/api/portfolio"));
    expect(b.evidence.averageConcurrency).toBeCloseTo(1, 6);
    expect(b.evidence.effectiveTrades).toBe(6);
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

/**
 * Settings routes.
 *
 * The contract the Settings page depends on: a valid document is stored and
 * read back, an invalid one is refused as a whole with a per-field list, and
 * nothing partial is ever persisted. A form that could half-save would leave
 * the engine running a configuration no one chose.
 */
describe("GET/PUT /api/config", () => {
  test("serves a valid document on a fresh install", async () => {
    const cfg = await body<Record<string, unknown>>(call("/api/config"));
    expect(Array.isArray(cfg.assets)).toBe(true);
    expect(validateConfig(cfg)).toEqual([]);
  });

  test("saves a change and reads it back", async () => {
    const cfg = await body<AppConfig>(call("/api/config"));
    const next = {
      ...cfg,
      engine: { ...cfg.engine, autoTradingEnabled: false },
    };

    expect(await status(call("/api/config", "PUT", next))).toBe(200);

    const stored = await body<AppConfig>(call("/api/config"));
    expect(stored.engine.autoTradingEnabled).toBe(false);
  });

  test("refuses an invalid document with 422 and a per-field list", async () => {
    const cfg = await body<AppConfig>(call("/api/config"));
    const broken = { ...cfg, engine: { ...cfg.engine, monitorSeconds: -5 } };

    const res = call("/api/config", "PUT", broken);
    expect(await status(res)).toBe(422);

    const payload = await body<{ issues: Array<{ path: string }> }>(
      call("/api/config", "PUT", broken),
    );
    expect(payload.issues.length).toBeGreaterThan(0);
    expect(payload.issues[0].path).toContain("monitorSeconds");
  });

  test("a refused save changes nothing", async () => {
    const before = await body<AppConfig>(call("/api/config"));
    await call("/api/config", "PUT", { ...before, assets: [] });
    const after = await body<AppConfig>(call("/api/config"));
    expect(after).toEqual(before);
  });

  test("exposes the defaults separately, for a reset preview", async () => {
    const defaults = await body<Record<string, unknown>>(
      call("/api/config/defaults"),
    );
    expect(validateConfig(defaults)).toEqual([]);
  });

  test("the defaults are the SHIPPED ones, not the live document", async () => {
    // Returning the live config here would make a reset preview show the very
    // values it is meant to be compared against, so the preview would agree
    // with whatever is currently saved and always look like a no-op.
    const cfg = await body<AppConfig>(call("/api/config"));
    await call("/api/config", "PUT", {
      ...cfg,
      engine: { ...cfg.engine, monitorSeconds: 123 },
    });

    const defaults = await body<AppConfig>(call("/api/config/defaults"));
    expect(defaults.engine.monitorSeconds).not.toBe(123);
    expect(defaults).toEqual(defaultConfig());
  });

  test("reset restores the defaults", async () => {
    const cfg = await body<AppConfig>(call("/api/config"));
    await call("/api/config", "PUT", {
      ...cfg,
      engine: { ...cfg.engine, monitorSeconds: 99 },
    });

    await call("/api/config/reset", "POST");

    const after = await body<AppConfig>(call("/api/config"));
    expect(after.engine.monitorSeconds).not.toBe(99);
  });
});

describe("MT5 routes", () => {
  // Pointed at a directory that cannot exist, so the result describes the code
  // rather than whether the machine running the tests happens to have a
  // MetaTrader terminal installed.
  beforeEach(() => {
    process.env.TEO_MT5_DIR = "/nonexistent/teo-test-terminal";
  });
  afterEach(() => {
    delete process.env.TEO_MT5_DIR;
  });

  test("status reports disconnected rather than failing when no terminal exists", async () => {
    const res = await body<{ connected: boolean; symbols: unknown[] }>(
      call("/api/mt5/status"),
    );
    expect(res.connected).toBe(false);
    expect(res.symbols).toEqual([]);
  });

  test("discover answers even when it finds nothing", async () => {
    const res = await body<{ found: boolean }>(call("/api/mt5/discover"));
    expect(typeof res.found).toBe("boolean");
  });

  test("a sync with no terminal reports the reason instead of throwing", async () => {
    const res = call("/api/mt5/sync", "POST");
    expect(await status(res)).toBe(502);
  });
});

/**
 * Research routes.
 *
 * These start real work, so the tests stay on the request contract: bad input
 * is refused before anything is scheduled, and a started run is addressable.
 */
/** A finished run carrying one qualified candidate, for the adopt route. */
function qualifiedRun(
  id: string,
  assetId: string,
  config: unknown,
  symbol = assetId,
) {
  const metrics = {
    trades: 120,
    wins: 70,
    losses: 50,
    breakeven: 0,
    winRate: 58.3,
    netPoints: 420,
    grossPoints: 500,
    costPoints: 80,
    expectancy: 3.5,
    profitFactor: 1.6,
    maxDrawdown: 90,
    breakevenWinRate: 52,
  };
  return {
    id,
    assetId,
    symbol,
    interval: "15m",
    from: 1_700_000_000,
    to: 1_705_000_000,
    iterations: 100,
    status: "done",
    progress: 1,
    message: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    bars: 5000,
    error: null,
    report: {
      asset: assetId,
      interval: "15m",
      bars: 5000,
      from: 1_700_000_000,
      to: 1_705_000_000,
      iterations: 100,
      evaluated: 100,
      seed: 1,
      split: { train: 2500, validation: 1250, test: 1250 },
      candidates: [],
      best: {
        config,
        train: metrics,
        validation: metrics,
        test: metrics,
        overall: metrics,
        score: 1,
        significance: { pValue: 0.001, significant: true },
        adjustedPValue: 0.01,
        verdict: "qualified",
        summary: "survived",
      },
      conclusion: "1 of 100 configurations survived.",
    },
  } as never;
}

describe("research routes", () => {
  // Never point at a real terminal: a test run must not drop request files
  // into whatever MetaTrader install happens to exist on this machine.
  beforeEach(() => {
    process.env.TEO_MT5_DIR = "/nonexistent/teo-test-terminal";
  });
  afterEach(() => {
    delete process.env.TEO_MT5_DIR;
  });

  test("requires a symbol", async () => {
    expect(
      await status(
        call("/api/research/runs", "POST", {
          interval: "15m",
          from: 1,
          to: 2,
        }),
      ),
    ).toBe(400);
  });

  test("requires the end to be after the start", async () => {
    expect(
      await status(
        call("/api/research/runs", "POST", {
          symbol: "NAS100",
          interval: "15m",
          from: 2000,
          to: 1000,
        }),
      ),
    ).toBe(400);
  });

  test("caps the number of configurations", async () => {
    // Unbounded iterations would let one request occupy the process for hours
    // while the live engine's timers starve.
    expect(
      await status(
        call("/api/research/runs", "POST", {
          symbol: "NAS100",
          interval: "15m",
          from: 1_700_000_000,
          to: 1_705_000_000,
          iterations: 10_000_000,
        }),
      ),
    ).toBe(400);
  });

  test("a started run is accepted and addressable", async () => {
    // 202, not 200: the work is still going when the response is written, and
    // the client polls. A success code that claimed completion would be a lie.
    expect(
      await status(
        call("/api/research/runs", "POST", {
          symbol: "NOSUCHSYMBOL2",
          interval: "15m",
          from: 1_700_000_000,
          to: 1_705_000_000,
          iterations: 10,
        }),
      ),
    ).toBe(202);

    const run = await body<{ id: string; status: string }>(
      call("/api/research/runs", "POST", {
        symbol: "NOSUCHSYMBOL",
        interval: "15m",
        from: 1_700_000_000,
        to: 1_705_000_000,
        iterations: 10,
      }),
    );
    expect(run.id).toBeTruthy();

    const fetched = await body<{ id: string }>(
      call(`/api/research/runs/${encodeURIComponent(run.id)}`),
    );
    expect(fetched.id).toBe(run.id);
  });

  test("an unknown run is a 404, not an empty run", async () => {
    expect(await status(call("/api/research/runs/nope"))).toBe(404);
  });

  test("adopting a qualified strategy writes it into the configuration", async () => {
    // The success path a search rarely reaches on real data, and the only route
    // that rewrites the live configuration from a research result.
    const cfg = await body<AppConfig>(call("/api/config"));
    const target = cfg.assets[0];
    const tuned = { ...target.config, emaFast: 7, emaMid: 19, emaSlow: 44 };

    putRun(qualifiedRun("adopt-known", target.id, tuned));

    const res = await body<{ adopted: boolean; added: boolean }>(
      call("/api/research/runs/adopt-known/adopt", "POST"),
    );
    expect(res.adopted).toBe(true);
    expect(res.added).toBe(false);

    const after = await body<AppConfig>(call("/api/config"));
    const updated = after.assets.find(a => a.id === target.id)!;
    expect(updated.config.emaFast).toBe(7);
    expect(updated.config.emaSlow).toBe(44);
  });

  test("adopting for an unconfigured instrument adds it, disabled", async () => {
    // Discovering a strategy and trading it are separate decisions: a new
    // instrument must not join the live engine on one click.
    const cfg = await body<AppConfig>(call("/api/config"));
    const tuned = cfg.assets[0].config;

    putRun(qualifiedRun("adopt-new", "MT5:NEWSYM", tuned, "NEWSYM"));

    const res = await body<{ added: boolean }>(
      call("/api/research/runs/adopt-new/adopt", "POST"),
    );
    expect(res.added).toBe(true);

    const after = await body<AppConfig>(call("/api/config"));
    const added = after.assets.find(a => a.id === "MT5:NEWSYM")!;
    expect(added).toBeDefined();
    expect(added.enabled).toBe(false);
    expect(validateConfig(after)).toEqual([]);
  });

  test("adopting from a run that does not exist is a 404", async () => {
    // A separate guard from the GET-run 404, and the one a stale browser tab
    // hits after a restart drops the in-memory runs.
    expect(
      await status(call("/api/research/runs/ghost-run/adopt", "POST")),
    ).toBe(404);
  });

  test("cancelling a run that does not exist is a 404", async () => {
    expect(
      await status(call("/api/research/runs/ghost-run/cancel", "POST")),
    ).toBe(404);
  });

  test("adopting from a run with no result is refused", async () => {
    const run = await body<{ id: string }>(
      call("/api/research/runs", "POST", {
        symbol: "NOSUCHSYMBOL",
        interval: "15m",
        from: 1_700_000_000,
        to: 1_705_000_000,
        iterations: 10,
      }),
    );
    expect(
      await status(
        call(`/api/research/runs/${encodeURIComponent(run.id)}/adopt`, "POST"),
      ),
    ).toBe(409);
  });
});
