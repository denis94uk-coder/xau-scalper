/**
 * Data-layer tests. Every case runs against an in-memory database, so the suite
 * needs no fixture files and leaves nothing behind.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Db, type NewIdea } from "../db";

let db: Db;

beforeEach(() => {
  db = new Db(":memory:");
});

function idea(over: Partial<NewIdea> = {}): NewIdea {
  return {
    asset: "PAXGUSDT",
    direction: "LONG",
    entryPrice: 3450,
    stopLoss: 3420,
    tp1: 3486,
    tp2: 3525,
    spotPrice: 3450,
    ...over,
  };
}

describe("schema", () => {
  test("migrate is idempotent", () => {
    expect(() => {
      db.migrate();
      db.migrate();
    }).not.toThrow();
  });

  test("rejects an invalid direction", () => {
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO trading_ideas
             (asset, direction, status, entry_price, stop_loss, tp1, tp2, spot_price, created_at)
           VALUES ('X', 'SIDEWAYS', 'ACTIVE', 1, 1, 1, 1, 1, 1)`,
        )
        .run(),
    ).toThrow();
  });

  test("rejects an unknown status", () => {
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO trading_ideas
             (asset, direction, status, entry_price, stop_loss, tp1, tp2, spot_price, created_at)
           VALUES ('X', 'LONG', 'MAYBE', 1, 1, 1, 1, 1, 1)`,
        )
        .run(),
    ).toThrow();
  });
});

describe("candles", () => {
  const c = (t: number, close: number) => ({
    time: t,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  });

  test("round-trips oldest-first", () => {
    db.saveCandles("BTCUSDT", "5m", [c(300, 100), c(600, 101), c(900, 102)]);
    const got = db.getCandles("BTCUSDT", "5m");
    expect(got.map(x => x.time)).toEqual([300, 600, 900]);
    expect(got.at(-1)!.close).toBe(102);
  });

  test("limit returns the NEWEST n, still oldest-first", () => {
    db.saveCandles(
      "BTCUSDT",
      "5m",
      [100, 200, 300, 400].map((t, i) => c(t, i)),
    );
    expect(db.getCandles("BTCUSDT", "5m", 2).map(x => x.time)).toEqual([
      300, 400,
    ]);
  });

  test("re-saving an overlapping window updates rather than duplicates", () => {
    db.saveCandles("BTCUSDT", "5m", [c(300, 100)]);
    db.saveCandles("BTCUSDT", "5m", [c(300, 999)]);
    const got = db.getCandles("BTCUSDT", "5m");
    expect(got).toHaveLength(1);
    expect(got[0].close).toBe(999);
  });

  test("assets and intervals are isolated", () => {
    db.saveCandles("BTCUSDT", "5m", [c(300, 1)]);
    db.saveCandles("ETHUSDT", "5m", [c(300, 2)]);
    db.saveCandles("BTCUSDT", "15m", [c(300, 3)]);
    expect(db.getCandles("BTCUSDT", "5m")[0].close).toBe(1);
    expect(db.getCandles("ETHUSDT", "5m")[0].close).toBe(2);
    expect(db.getCandles("BTCUSDT", "15m")[0].close).toBe(3);
  });

  test("latestCandleTime drives incremental fetch", () => {
    expect(db.latestCandleTime("BTCUSDT", "5m")).toBeNull();
    db.saveCandles("BTCUSDT", "5m", [c(300, 1), c(900, 2)]);
    expect(db.latestCandleTime("BTCUSDT", "5m")).toBe(900);
  });
});

describe("trading ideas", () => {
  test("creating an idea seeds its journey events", () => {
    const id = db.createIdea(idea());
    const events = db.ideaEvents(id).map(e => e.event);
    expect(events).toEqual(["SIGNAL_GENERATED", "ENTRY_TRIGGERED"]);
  });

  test("new ideas are open and appear in openIdeas", () => {
    db.createIdea(idea());
    db.createIdea(idea({ asset: "BTCUSDT" }));
    expect(db.openIdeas()).toHaveLength(2);
    expect(db.openIdeas("BTCUSDT")).toHaveLength(1);
  });

  test("TP1_HIT is still open; TP2_HIT and STOPPED are not", () => {
    const a = db.createIdea(idea());
    const b = db.createIdea(idea());
    const c = db.createIdea(idea());
    db.updateIdea(a, { status: "TP1_HIT" });
    db.updateIdea(b, { status: "TP2_HIT" });
    db.updateIdea(c, { status: "STOPPED" });
    expect(db.openIdeas().map(i => i.id)).toEqual([a]);
  });

  test("updateIdea patches only what it is given", () => {
    const id = db.createIdea(idea());
    db.updateIdea(id, { trailing_sl: 3455 });
    const got = db.getIdea(id)!;
    expect(got.trailing_sl).toBe(3455);
    expect(got.status).toBe("ACTIVE");
    expect(got.entry_price).toBe(3450);
  });

  test("cooldown lookup is per asset AND direction", () => {
    db.createIdea(idea({ asset: "PAXGUSDT", direction: "LONG" }));
    expect(db.lastIdeaAt("PAXGUSDT", "LONG")).toBeGreaterThan(0);
    expect(db.lastIdeaAt("PAXGUSDT", "SHORT")).toBeNull();
    expect(db.lastIdeaAt("BTCUSDT", "LONG")).toBeNull();
  });

  test("cooldown lookup is not limited by a scan window", () => {
    // The Convex version scanned the 50 newest ideas across all assets, so a
    // busy asset could push another asset's recent signal out of view and
    // silently defeat the cooldown. An indexed lookup has no such window.
    for (let i = 0; i < 200; i++) db.createIdea(idea({ asset: "BTCUSDT" }));
    db.createIdea(idea({ asset: "PAXGUSDT", direction: "SHORT" }));
    for (let i = 0; i < 200; i++) db.createIdea(idea({ asset: "ETHUSDT" }));
    expect(db.lastIdeaAt("PAXGUSDT", "SHORT")).not.toBeNull();
  });

  test("deleting an idea cascades to its events", () => {
    const id = db.createIdea(idea());
    expect(db.ideaEvents(id).length).toBeGreaterThan(0);
    db.deleteIdea(id);
    expect(db.getIdea(id)).toBeNull();
    expect(db.ideaEvents(id)).toHaveLength(0);
  });

  test("listIdeas is newest-first and filterable by asset", () => {
    db.createIdea(idea({ asset: "PAXGUSDT" }));
    db.createIdea(idea({ asset: "BTCUSDT" }));
    expect(db.listIdeas({ asset: "BTCUSDT" })).toHaveLength(1);
    expect(db.listIdeas({ limit: 1 })).toHaveLength(1);
  });
});

describe("journal", () => {
  test("stores and reads back metadata as JSON", () => {
    db.logJournal({
      eventType: "ENGINE_RUN",
      asset: "BTCUSDT",
      details: "ran",
      metadata: { grade: "B", confidence: 71 },
    });
    const [row] = db.listJournal();
    expect(row.event_type).toBe("ENGINE_RUN");
    expect(JSON.parse(row.metadata!)).toEqual({ grade: "B", confidence: 71 });
  });

  test("counts are an aggregate, not a table read", () => {
    db.logJournal({ eventType: "ENGINE_RUN", asset: "A" });
    db.logJournal({ eventType: "ENGINE_RUN", asset: "A" });
    db.logJournal({ eventType: "SL_HIT", asset: "A" });
    expect(db.journalCounts()).toEqual({ ENGINE_RUN: 2, SL_HIT: 1 });
  });

  test("filters by asset", () => {
    db.logJournal({ eventType: "ENGINE_RUN", asset: "A" });
    db.logJournal({ eventType: "ENGINE_RUN", asset: "B" });
    expect(db.listJournal({ asset: "B" })).toHaveLength(1);
  });

  test("prune drops only rows older than the cutoff", () => {
    db.logJournal({ eventType: "ENGINE_RUN", asset: "A" });
    db.raw
      .prepare(
        `INSERT INTO signal_journal (event_type, asset, timestamp) VALUES ('OLD', 'A', ?)`,
      )
      .run(Date.now() - 40 * 86_400_000);
    expect(db.pruneJournal(30)).toBe(1);
    expect(db.listJournal()).toHaveLength(1);
  });

  test("deleting an idea leaves its journal rows as orphans, not deletions", () => {
    // The audit trail must outlive the record it describes.
    const id = db.createIdea(idea());
    db.logJournal({
      eventType: "SIGNAL_GENERATED",
      asset: "PAXGUSDT",
      ideaId: id,
    });
    db.deleteIdea(id);
    const [row] = db.listJournal();
    expect(row.idea_id).toBeNull();
    expect(row.event_type).toBe("SIGNAL_GENERATED");
  });
});

describe("settings", () => {
  test("round-trips structured values and overwrites by key", () => {
    db.setSetting("regime", { regime: "TRENDING_UP", confidence: 71 });
    expect(
      db.getSetting<{ regime: string; confidence: number }>("regime"),
    ).toEqual({
      regime: "TRENDING_UP",
      confidence: 71,
    });
    db.setSetting("regime", { regime: "RANGING", confidence: 50 });
    expect(db.getSetting<{ regime: string }>("regime")!.regime).toBe("RANGING");
  });

  test("missing key is null", () => {
    expect(db.getSetting("nope")).toBeNull();
  });
});

describe("job runs", () => {
  test("records a run and reads it back", () => {
    expect(db.lastRun("monitor")).toBeNull();
    db.recordRun("monitor", true);
    expect(db.lastRun("monitor")).toBeGreaterThan(0);
  });

  test("a failed run still advances last_run_at but preserves last_ok_at", () => {
    db.recordRun("monitor", true);
    const okAt = db.raw
      .query<{ last_ok_at: number }, []>(
        `SELECT last_ok_at FROM job_runs WHERE job = 'monitor'`,
      )
      .get()!.last_ok_at;

    db.recordRun("monitor", false, "binance 503");
    const row = db.raw
      .query<{ last_ok_at: number; last_error: string }, []>(
        `SELECT last_ok_at, last_error FROM job_runs WHERE job = 'monitor'`,
      )
      .get()!;
    expect(row.last_ok_at).toBe(okAt);
    expect(row.last_error).toBe("binance 503");
  });
});

describe("performance", () => {
  test("is scoped to one asset — points are not comparable across assets", () => {
    const gold = db.createIdea(idea({ asset: "PAXGUSDT" }));
    db.updateIdea(gold, { status: "TP2_HIT", pnl_points: 75 });
    const btc = db.createIdea(idea({ asset: "BTCUSDT" }));
    db.updateIdea(btc, { status: "TP2_HIT", pnl_points: 1200 });

    expect(db.performance("PAXGUSDT").totalPnlPoints).toBe(75);
    expect(db.performance("BTCUSDT").totalPnlPoints).toBe(1200);
  });

  test("computes win rate and profit factor over resolved trades", () => {
    const mk = (pnl: number, status: "TP2_HIT" | "STOPPED") => {
      const id = db.createIdea(idea());
      db.updateIdea(id, { status, pnl_points: pnl });
    };
    mk(30, "TP2_HIT");
    mk(30, "TP2_HIT");
    mk(-20, "STOPPED");

    const p = db.performance("PAXGUSDT");
    expect(p.wins).toBe(2);
    expect(p.losses).toBe(1);
    expect(p.winRate).toBeCloseTo(66.67, 1);
    expect(p.totalPnlPoints).toBeCloseTo(40);
    expect(p.profitFactor).toBeCloseTo(3);
  });

  test("profit factor is null with no losses", () => {
    const id = db.createIdea(idea());
    db.updateIdea(id, { status: "TP2_HIT", pnl_points: 10 });
    expect(db.performance("PAXGUSDT").profitFactor).toBeNull();
  });

  test("an asset with no history is zeroed rather than NaN", () => {
    const p = db.performance("NOTHING");
    expect(p.closed).toBe(0);
    expect(p.winRate).toBe(0);
    expect(p.totalPnlPoints).toBe(0);
    expect(p.profitFactor).toBeNull();
  });

  test("a TP1_HIT is open and not a decided win", () => {
    // Hitting the first target books a positive pnl on the row, but the
    // remainder still trails — it must count as open, not as a resolved win.
    const id = db.createIdea(idea());
    db.updateIdea(id, { status: "TP1_HIT", pnl_points: 30 });

    const p = db.performance("PAXGUSDT");
    expect(p.open).toBe(1);
    expect(p.closed).toBe(0);
    expect(p.wins).toBe(0);
    expect(p.losses).toBe(0);
    expect(p.winRate).toBe(0);
    expect(p.totalPnlPoints).toBe(0);
  });

  test("win rate excludes a TP1_HIT that later stops at breakeven", () => {
    const id = db.createIdea(idea());
    db.updateIdea(id, { status: "TP1_HIT", pnl_points: 30 });
    db.updateIdea(id, { status: "STOPPED", pnl_points: -5 });

    const p = db.performance("PAXGUSDT");
    expect(p.open).toBe(0);
    expect(p.closed).toBe(1);
    expect(p.wins).toBe(0);
    expect(p.losses).toBe(1);
    expect(p.winRate).toBe(0);
    expect(p.totalPnlPoints).toBeCloseTo(-5);
  });
});
