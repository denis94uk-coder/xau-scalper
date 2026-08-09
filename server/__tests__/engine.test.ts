/**
 * Engine tests. Network is injected, so nothing here touches Binance.
 *
 * The exit logic is what turns a signal into a recorded win or loss, so it gets
 * the most attention — especially gap recovery, which exists because a local
 * process can be asleep when a stop is hit.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { AssetDefinition } from "../../core/assets";
import { ZERO_COST_MODEL } from "../../core/costs";
import { type Candle, DEFAULT_STRATEGY_CONFIG } from "../../core/strategy";
import { Db, type NewIdea } from "../db";
import {
  applyPrice,
  generateForAsset,
  recoverGap,
  syncCandles,
} from "../engine";

const ASSET: AssetDefinition = {
  id: "TESTUSDT",
  displaySymbol: "TEST/USD",
  dataSourceSymbol: "TESTUSDT",
  dataSource: "binance",
  sessionType: "24_7",
  pricePrecision: 2,
  config: DEFAULT_STRATEGY_CONFIG,
  // Zero costs here so the exit-logic assertions test levels, not arithmetic.
  // Cost behaviour has its own tests in convex/lib/__tests__/costs.test.ts.
  costs: ZERO_COST_MODEL,
  enabled: true,
};

let db: Db;

beforeEach(() => {
  db = new Db(":memory:");
});

function longIdea(over: Partial<NewIdea> = {}) {
  return db.createIdea({
    asset: ASSET.id,
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 95,
    tp1: 106,
    tp2: 112.5,
    spotPrice: 100,
    ...over,
  });
}

function shortIdea(over: Partial<NewIdea> = {}) {
  return db.createIdea({
    asset: ASSET.id,
    direction: "SHORT",
    entryPrice: 100,
    stopLoss: 105,
    tp1: 94,
    tp2: 87.5,
    spotPrice: 100,
    ...over,
  });
}

const tick = (p: number) => ({ high: p, low: p, close: p });

/** A fetcher returning fixed kline rows, in Binance's array-of-arrays shape. */
function klineFetcher(candles: Candle[]): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify(
        candles.map(c => [
          c.time * 1000,
          String(c.open),
          String(c.high),
          String(c.low),
          String(c.close),
          String(c.volume),
        ]),
      ),
      { status: 200 },
    )) as unknown as typeof fetch;
}

describe("applyPrice — long", () => {
  test("stop hit books the loss at the stop, not the observed price", () => {
    const id = longIdea();
    // Price gapped straight through 95 down to 90.
    const changed = applyPrice(db, ASSET, db.getIdea(id)!, tick(90), 0);
    expect(changed).toBe(true);
    const got = db.getIdea(id)!;
    expect(got.status).toBe("STOPPED");
    expect(got.pnl_points).toBeCloseTo(-5); // 95 - 100, not 90 - 100
  });

  test("TP1 moves to breakeven and keeps the idea open", () => {
    const id = longIdea();
    applyPrice(db, ASSET, db.getIdea(id)!, tick(106), 0);
    const got = db.getIdea(id)!;
    expect(got.status).toBe("TP1_HIT");
    expect(got.trailing_sl).toBe(100);
    expect(got.resolved_at).toBeNull();
    expect(db.openIdeas()).toHaveLength(1);
  });

  test("a bar reaching both targets resolves fully at TP2", () => {
    const id = longIdea();
    applyPrice(db, ASSET, db.getIdea(id)!, tick(115), 0);
    const got = db.getIdea(id)!;
    expect(got.status).toBe("TP2_HIT");
    expect(got.pnl_points).toBeCloseTo(12.5);
  });

  test("after TP1, the breakeven stop books a scratch rather than a loss", () => {
    const id = longIdea();
    applyPrice(db, ASSET, db.getIdea(id)!, tick(106), 0);
    applyPrice(db, ASSET, db.getIdea(id)!, tick(99), 0);
    const got = db.getIdea(id)!;
    expect(got.status).toBe("STOPPED");
    expect(got.pnl_points).toBeCloseTo(0);
  });

  test("trailing stop only ratchets upward", () => {
    const id = longIdea();
    applyPrice(db, ASSET, db.getIdea(id)!, tick(106), 0);

    applyPrice(db, ASSET, db.getIdea(id)!, tick(110), 2); // trail → 106
    expect(db.getIdea(id)!.trailing_sl).toBeCloseTo(106);

    applyPrice(db, ASSET, db.getIdea(id)!, tick(107), 2); // would be 103 — worse
    expect(db.getIdea(id)!.trailing_sl).toBeCloseTo(106);
  });

  test("a bar spanning both stop and target resolves as the stop", () => {
    const id = longIdea();
    const changed = applyPrice(
      db,
      ASSET,
      db.getIdea(id)!,
      { high: 113, low: 94, close: 100 },
      0,
    );
    expect(changed).toBe(true);
    expect(db.getIdea(id)!.status).toBe("STOPPED");
  });

  test("a quiet tick changes nothing", () => {
    const id = longIdea();
    expect(applyPrice(db, ASSET, db.getIdea(id)!, tick(101), 0)).toBe(false);
    expect(db.getIdea(id)!.status).toBe("ACTIVE");
  });
});

describe("applyPrice — short", () => {
  test("stop is above entry and books at the stop", () => {
    const id = shortIdea();
    applyPrice(db, ASSET, db.getIdea(id)!, tick(110), 0);
    const got = db.getIdea(id)!;
    expect(got.status).toBe("STOPPED");
    expect(got.pnl_points).toBeCloseTo(-5); // 100 - 105
  });

  test("TP1 is below entry", () => {
    const id = shortIdea();
    applyPrice(db, ASSET, db.getIdea(id)!, tick(94), 0);
    expect(db.getIdea(id)!.status).toBe("TP1_HIT");
    expect(db.getIdea(id)!.pnl_points).toBeCloseTo(6);
  });

  test("trailing stop only ratchets downward", () => {
    const id = shortIdea();
    applyPrice(db, ASSET, db.getIdea(id)!, tick(94), 0);
    applyPrice(db, ASSET, db.getIdea(id)!, tick(90), 2); // trail → 94
    expect(db.getIdea(id)!.trailing_sl).toBeCloseTo(94);
    applyPrice(db, ASSET, db.getIdea(id)!, tick(93), 2); // would be 97 — worse
    expect(db.getIdea(id)!.trailing_sl).toBeCloseTo(94);
  });
});

describe("journal tagging", () => {
  test("exit events carry their own asset, not the gold default", () => {
    // The Convex monitor omitted `asset` on every exit write, so TP/SL rows for
    // BTC and friends were silently filed under gold.
    const id = longIdea();
    applyPrice(db, ASSET, db.getIdea(id)!, tick(90), 0);
    const [row] = db.listJournal();
    expect(row.event_type).toBe("SL_HIT");
    expect(row.asset).toBe("TESTUSDT");
  });
});

describe("syncCandles", () => {
  const bars: Candle[] = Array.from({ length: 80 }, (_, i) => ({
    time: 1_000_000 + i * 300,
    open: 100,
    high: 101,
    low: 99,
    close: 100 + i * 0.01,
    volume: 5,
  }));

  test("stores fetched candles and returns them oldest-first", async () => {
    const got = await syncCandles(
      { db, fetcher: klineFetcher(bars) },
      ASSET,
      "5m",
    );
    expect(got).toHaveLength(80);
    expect(got[0].time).toBeLessThan(got.at(-1)!.time);
    expect(db.latestCandleTime(ASSET.id, "5m")).toBe(bars.at(-1)!.time);
  });

  test("re-syncing overlapping data does not duplicate rows", async () => {
    const deps = { db, fetcher: klineFetcher(bars) };
    await syncCandles(deps, ASSET, "5m");
    await syncCandles(deps, ASSET, "5m");
    expect(db.getCandles(ASSET.id, "5m", 500)).toHaveLength(80);
  });
});

describe("generateForAsset", () => {
  /** Flat series: no indicator extremes, so no tradeable grade. */
  const flat: Candle[] = Array.from({ length: 80 }, (_, i) => ({
    time: 1_000_000 + i * 300,
    open: 100,
    high: 100.1,
    low: 99.9,
    close: 100,
    volume: 1,
  }));

  test("records an ENGINE_RUN even when no signal fires", async () => {
    const id = await generateForAsset(
      { db, fetcher: klineFetcher(flat) },
      ASSET,
    );
    expect(id).toBeNull();
    expect(db.listJournal().some(r => r.event_type === "ENGINE_RUN")).toBe(
      true,
    );
  });

  test("does not invent a signal from featureless data", async () => {
    await generateForAsset({ db, fetcher: klineFetcher(flat) }, ASSET);
    expect(db.listIdeas()).toHaveLength(0);
  });
});

describe("gap recovery", () => {
  /** Bars that dip to 90 — through a long's stop at 95 — then recover to 101. */
  function dipThenRecover(startTime: number): Candle[] {
    const path = [100, 99, 97, 90, 96, 99, 101];
    return path.map((p, i) => ({
      time: startTime + i * 300,
      open: p,
      high: p + 0.5,
      low: p - 0.5,
      close: p,
      volume: 1,
    }));
  }

  test("resolves a stop that was hit while the process was down", async () => {
    const created = Date.now() - 60 * 60_000; // opened an hour ago
    const id = longIdea();
    db.raw
      .prepare(`UPDATE trading_ideas SET created_at = ? WHERE id = ?`)
      .run(created, id);
    db.recordRun("monitor", true);
    db.raw
      .prepare(`UPDATE job_runs SET last_run_at = ? WHERE job = 'monitor'`)
      .run(created);

    const bars = dipThenRecover(Math.floor(created / 1000) + 300);
    const changed = await recoverGap({
      db,
      fetcher: klineFetcher(bars),
      assets: [ASSET],
    });

    expect(changed).toBeGreaterThan(0);
    const got = db.getIdea(id)!;
    // Price is back at 101 now — a naive current-price check would have missed
    // this entirely and left the position open.
    expect(got.status).toBe("STOPPED");
    expect(got.pnl_points).toBeCloseTo(-5);
  });

  test("is a no-op when the process was only briefly away", async () => {
    longIdea();
    db.recordRun("monitor", true); // just now
    const changed = await recoverGap({
      db,
      fetcher: klineFetcher(dipThenRecover(1_000_000)),
      assets: [ASSET],
    });
    expect(changed).toBe(0);
  });

  test("is a no-op with nothing open", async () => {
    db.recordRun("monitor", true);
    db.raw
      .prepare(`UPDATE job_runs SET last_run_at = ? WHERE job = 'monitor'`)
      .run(Date.now() - 86_400_000);
    expect(
      await recoverGap({ db, fetcher: klineFetcher([]), assets: [ASSET] }),
    ).toBe(0);
  });

  test("ignores bars that predate the idea", async () => {
    // A dip that happened BEFORE the signal existed must not stop it out.
    const created = Date.now() - 30 * 60_000;
    const id = longIdea();
    db.raw
      .prepare(`UPDATE trading_ideas SET created_at = ? WHERE id = ?`)
      .run(created, id);
    db.recordRun("monitor", true);
    db.raw
      .prepare(`UPDATE job_runs SET last_run_at = ? WHERE job = 'monitor'`)
      .run(created);

    // All bars sit an hour before the idea was created.
    const stale = dipThenRecover(Math.floor(created / 1000) - 3600);
    const changed = await recoverGap({
      db,
      fetcher: klineFetcher(stale),
      assets: [ASSET],
    });

    expect(changed).toBe(0);
    expect(db.getIdea(id)!.status).toBe("ACTIVE");
  });
});
