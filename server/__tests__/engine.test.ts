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

describe("the portfolio gate", () => {
  /**
   * A slow grind up into a three-bar flush: oversold RSI and stochastic
   * against an intact uptrend, which is a grade-A long under the default
   * config. Confirmed at 94% confidence.
   */
  const capitulation: Candle[] = (() => {
    const p = [100];
    for (let i = 1; i < 77; i++) p.push(p[i - 1] * 1.0005);
    for (let i = 0; i < 3; i++) p.push(p[p.length - 1] * 0.995);
    return p.map((price, i) => ({
      time: 1_000_000 + i * 300_000,
      open: price,
      high: price * 1.002,
      low: price * 0.998,
      close: price,
      volume: 1,
    }));
  })();

  const feed = () => ({ db, fetcher: klineFetcher(capitulation) });

  test("the setup does fire when nothing else is open", async () => {
    // Establishes the baseline: everything below blocks THIS signal, so if it
    // never fired in the first place the gate tests would pass vacuously.
    const id = await generateForAsset(feed(), ASSET);
    expect(id).not.toBeNull();
  });

  test("refuses a signal that would push the book past its risk cap", async () => {
    db.createIdea({
      asset: "OTHERUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 95,
      tp1: 106,
      tp2: 112,
      spotPrice: 100,
    });

    // One open position at an assumed ρ of 0.8 already sits near a cap of 1.
    const id = await generateForAsset(
      { ...feed(), limits: { maxRisk: 1 } },
      ASSET,
    );
    expect(id).toBeNull();
    expect(db.listIdeas()).toHaveLength(1); // only the pre-existing one
  });

  test("a refusal is recorded with the reason, not swallowed", async () => {
    db.createIdea({
      asset: "OTHERUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 95,
      tp1: 106,
      tp2: 112,
      spotPrice: 100,
    });
    await generateForAsset({ ...feed(), limits: { maxRisk: 1 } }, ASSET);

    const blocked = db
      .listJournal()
      .filter(r => r.event_type === "SIGNAL_BLOCKED");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].asset).toBe(ASSET.id);
    expect(blocked[0].details).toContain("over the");
    // The correlation that caused it must be inspectable after the fact.
    expect(blocked[0].details).toContain("OTHERUSDT");
  });

  test("the same book passes under a cap that has room for it", async () => {
    db.createIdea({
      asset: "OTHERUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 95,
      tp1: 106,
      tp2: 112,
      spotPrice: 100,
    });
    const id = await generateForAsset(
      { ...feed(), limits: { maxRisk: 10 } },
      ASSET,
    );
    expect(id).not.toBeNull();
  });

  test("a closed position no longer occupies risk budget", async () => {
    const stale = db.createIdea({
      asset: "OTHERUSDT",
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 95,
      tp1: 106,
      tp2: 112,
      spotPrice: 100,
    });
    db.updateIdea(stale, { status: "TP2_HIT", pnl_points: 12 });

    const id = await generateForAsset(
      { ...feed(), limits: { maxRisk: 1 } },
      ASSET,
    );
    expect(id).not.toBeNull();
  });

  test("an admitted signal records what it did to portfolio risk", async () => {
    const id = await generateForAsset(feed(), ASSET);
    const row = db
      .listJournal()
      .find(r => r.event_type === "SIGNAL_GENERATED" && r.idea_id === id);
    expect(row?.details).toContain("portfolio risk");
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

describe("regime overlay", () => {
  // Same bullish setup as the portfolio gate: a grade-A long fires with no
  // regime in play. Each scenario gets a fresh in-memory db so the per-asset
  // cooldown from one call never blocks the next.
  const capitulation: Candle[] = (() => {
    const p = [100];
    for (let i = 1; i < 77; i++) p.push(p[i - 1] * 1.0005);
    for (let i = 0; i < 3; i++) p.push(p[p.length - 1] * 0.995);
    return p.map((price, i) => ({
      time: 1_000_000 + i * 300_000,
      open: price,
      high: price * 1.002,
      low: price * 0.998,
      close: price,
      volume: 1,
    }));
  })();

  function freshFeed() {
    const localDb = new Db(":memory:");
    return { db: localDb, fetcher: klineFetcher(capitulation) };
  }

  const VOLATILE = {
    timestamp: Date.now(),
    regime: "VOLATILE" as const,
    confidence: 80,
    atrRatio: 2,
    adxProxy: 10,
    trendStrength: 0,
    priceVsEma50: 0,
    priceVsEma200: 0,
    bbWidth: 3,
    rangeHighLow: 2,
    recommendedStrategy: "widen",
    description: "volatile",
    slMultiplier: 1.5,
    tpMultiplier: 1.3,
    positionSizeMultiplier: 0.5,
    minGrade: "B" as const,
    favorDirection: "BOTH" as const,
  };

  const BEARISH = {
    timestamp: Date.now(),
    regime: "TRENDING_DOWN" as const,
    confidence: 80,
    atrRatio: 1,
    adxProxy: 40,
    trendStrength: -30,
    priceVsEma50: 0,
    priceVsEma200: 0,
    bbWidth: 1,
    rangeHighLow: 1,
    recommendedStrategy: "short",
    description: "bearish",
    slMultiplier: 1,
    tpMultiplier: 1,
    positionSizeMultiplier: 1,
    minGrade: "B" as const,
    favorDirection: "SHORT" as const,
  };

  test("no regime: SL/TP taken verbatim from the strategy", async () => {
    const feed = freshFeed();
    const id = await generateForAsset(feed, ASSET);
    expect(id).not.toBeNull();
    const idea = feed.db.getIdea(id!)!;
    // The strategy derives SL/TP from the candles, not constants.
    expect(idea.stop_loss).toBeGreaterThan(0);
    expect(idea.tp1).toBeGreaterThan(idea.stop_loss);
    expect(idea.tp2).toBeGreaterThan(idea.tp1);
  });

  test("volatile regime widens SL and TP via multipliers, still fires", async () => {
    // Baseline levels with no regime on a fresh db.
    const baseDb = new Db(":memory:");
    const baseId = await generateForAsset(
      { db: baseDb, fetcher: klineFetcher(capitulation) },
      ASSET,
    );
    expect(baseId).not.toBeNull();
    const base = baseDb.getIdea(baseId!)!;

    const feed = freshFeed();
    feed.db.setSetting("marketRegime", VOLATILE);
    const id = await generateForAsset(feed, ASSET);
    expect(id).not.toBeNull();
    const idea = feed.db.getIdea(id!)!;
    expect(idea.stop_loss).toBeCloseTo(base.stop_loss * 1.5);
    expect(idea.tp1).toBeCloseTo(base.tp1 * 1.3);
    expect(idea.tp2).toBeCloseTo(base.tp2 * 1.3);
    expect(idea.reason).toContain("regime VOLATILE");
  });

  test("regime favoring the opposite direction vetoes the signal", async () => {
    const feed = freshFeed();
    feed.db.setSetting("marketRegime", BEARISH);
    const id = await generateForAsset(feed, ASSET);
    expect(id).toBeNull();
    expect(feed.db.listIdeas()).toHaveLength(0);
  });
});
