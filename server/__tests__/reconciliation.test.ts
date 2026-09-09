/**
 * Ghost-trade reconciliation: force-closes positions the monitor can no
 * longer see (long downtime), covers the LSE book via vault bars, and treats
 * price-exactly-at-level as breached.
 */
import { describe, expect, test } from "bun:test";
import { getAsset, lseAsset } from "../../core/assets";
import type { Candle } from "../../core/strategy";
import { Db } from "../db";
import { reconcileState } from "../reconciliation";

/** Ticker-price fetcher stub in Binance's symbols shape. */
function priceFetcher(prices: Record<string, number>): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify(
        Object.entries(prices).map(([symbol, price]) => ({
          symbol,
          price: String(price),
        })),
      ),
      { status: 200 },
    )) as unknown as typeof fetch;
}

const BTC = getAsset("BTCUSDT")!;

function longIdea(db: Db, over: Record<string, unknown> = {}) {
  return db.createIdea({
    asset: "BTCUSDT",
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 90,
    tp1: 110,
    tp2: 120,
    spotPrice: 100,
    ...over,
  } as never);
}

describe("reconcileState", () => {
  test("force-closes a ghost below its stop", async () => {
    const db = new Db(":memory:");
    const id = longIdea(db);
    const n = await reconcileState({
      db,
      assets: [BTC],
      fetcher: priceFetcher({ BTCUSDT: 80 }),
    });
    expect(n).toBe(1);
    expect(db.getIdea(id)?.status).toBe("STOPPED");
    db.close();
  });

  test("price exactly at the stop counts as breached", async () => {
    const db = new Db(":memory:");
    const id = longIdea(db);
    const n = await reconcileState({
      db,
      assets: [BTC],
      fetcher: priceFetcher({ BTCUSDT: 90 }),
    });
    expect(n).toBe(1);
    expect(db.getIdea(id)?.status).toBe("STOPPED");
    db.close();
  });

  test("a position inside its range is left alone", async () => {
    const db = new Db(":memory:");
    const id = longIdea(db);
    const n = await reconcileState({
      db,
      assets: [BTC],
      fetcher: priceFetcher({ BTCUSDT: 105 }),
    });
    expect(n).toBe(0);
    expect(db.getIdea(id)?.status).toBe("ACTIVE");
    db.close();
  });

  test("LSE ghosts resolve off vault bars when the venue has no quote", async () => {
    const db = new Db(":memory:");
    const xau = lseAsset({
      symbol: "XAU/USD",
      digits: 2,
      assetId: "XAUUSD",
      spreadBps: 4,
    });
    const id = db.createIdea({
      asset: "XAUUSD",
      direction: "LONG",
      source: "lse",
      entryPrice: 4400,
      stopLoss: 4350,
      tp1: 4450,
      tp2: 4500,
      spotPrice: 4400,
    } as never);
    const now = Math.floor(Date.now() / 1000);
    const bar: Candle = {
      time: now - 60,
      open: 4340,
      high: 4345,
      low: 4335,
      close: 4340,
      volume: 1,
    };
    db.saveCandles("XAUUSD", "1m", [bar]);
    // Venue knows nothing about XAU/USD — empty quote map.
    const n = await reconcileState({
      db,
      assets: [xau],
      fetcher: priceFetcher({}),
    });
    expect(n).toBe(1);
    expect(db.getIdea(id)?.status).toBe("STOPPED");
    db.close();
  });
});
