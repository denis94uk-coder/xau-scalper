/**
 * Tests for the exchange-history helpers used by research runs:
 * broker-symbol → venue-symbol mapping and paginated range fetching.
 */
import { describe, expect, test } from "bun:test";
import { exchangeSymbolFor, fetchCandleRange, fetchPrices } from "../market";

describe("exchangeSymbolFor", () => {
  test("maps the common gold spellings to the venue gold proxy", () => {
    expect(exchangeSymbolFor("XAUUSD")).toBe("PAXGUSDT");
    expect(exchangeSymbolFor("GOLD")).toBe("PAXGUSDT");
  });

  test("normalises broker suffixes before matching", () => {
    expect(exchangeSymbolFor("XAUUSD.x")).toBe("PAXGUSDT");
    expect(exchangeSymbolFor("XAUUSD-m")).toBe("PAXGUSDT");
    expect(exchangeSymbolFor("btcusd.r")).toBe("BTCUSDT");
  });

  test("maps crypto dollar pairs", () => {
    expect(exchangeSymbolFor("BTCUSD")).toBe("BTCUSDT");
    expect(exchangeSymbolFor("ETHUSD")).toBe("ETHUSDT");
  });

  test("leaves everything else unmapped", () => {
    // No silver spot on the venue; indices and forex have no proxy either.
    expect(exchangeSymbolFor("XAGUSD")).toBeNull();
    expect(exchangeSymbolFor("NAS100")).toBeNull();
    expect(exchangeSymbolFor("EURUSD")).toBeNull();
    expect(exchangeSymbolFor("GER40")).toBeNull();
  });
});

describe("fetchCandleRange", () => {
  /** A fake venue: at most `pageSize` rows per call, like Binance's 1000. */
  const BASE = 1_704_067_200;
  function fakeVenue(pageSize: number, total: number) {
    const calls: string[] = [];
    const fetcher = (async (input: URL | Request) => {
      const url = String(input);
      calls.push(url);
      const start = Number(url.match(/startTime=(\d+)/)?.[1] ?? 0);
      const end = Number(
        url.match(/endTime=(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER,
      );
      const stepSec = 900;
      // First index whose bar time is at or after `start`, in series space.
      let i = Math.ceil((start / 1000 - BASE) / stepSec);
      if (!Number.isFinite(i) || i < 0) i = 0;
      const rows: unknown[][] = [];
      for (; i < total; i++) {
        const t = (BASE + i * stepSec) * 1000;
        if (t >= end) break;
        if (t < start) continue;
        if (rows.length >= pageSize) break;
        rows.push([t, "1", "2", "0.5", "1.5", "10"]);
      }
      return new Response(JSON.stringify(rows));
    }) as unknown as typeof fetch;
    return { fetcher, calls };
  }

  test("pages forward until the window is covered", async () => {
    const { fetcher, calls } = fakeVenue(1000, 3500);
    const from = 1_704_067_200;
    const to = from + 3500 * 900;
    const candles = await fetchCandleRange("TEST", "15m", from, to, {
      fetcher,
    });
    expect(candles.length).toBe(3500);
    // Four pages: 1000 + 1000 + 1000 + 500.
    expect(calls.length).toBe(4);
    // Monotonic and inside bounds.
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].time).toBeGreaterThan(candles[i - 1].time);
    }
    expect(candles[0].time).toBeGreaterThanOrEqual(from);
    expect(candles.at(-1)?.time ?? 0).toBeLessThan(to);
  });

  test("stops after a short final page", async () => {
    const { fetcher, calls } = fakeVenue(1000, 1200);
    const from = 1_704_067_200;
    const to = from + 1200 * 900;
    const candles = await fetchCandleRange("TEST", "15m", from, to, {
      fetcher,
    });
    expect(candles.length).toBe(1200);
    expect(calls.length).toBe(2);
  });

  test("an empty window returns nothing rather than looping forever", async () => {
    const { fetcher } = fakeVenue(1000, 100);
    const candles = await fetchCandleRange(
      "TEST",
      "15m",
      2_000_000_000,
      2_000_100_000,
      { fetcher },
    );
    expect(candles).toEqual([]);
  });
});

describe("fetchPrices", () => {
  /** Batch fails (one poison symbol), singles succeed except the poison one. */
  function flakyVenue() {
    const calls: string[] = [];
    const fetcher = (async (input: URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("symbols=")) {
        return new Response(JSON.stringify({ code: -1100, msg: "bad symbol" }), {
          status: 400,
        });
      }
      const m = url.match(/symbol=([^&]+)/);
      const sym = m ? decodeURIComponent(m[1]) : "";
      if (sym === "DE30/EUR") {
        return new Response(JSON.stringify({ code: -1121, msg: "bad symbol" }), {
          status: 400,
        });
      }
      return new Response(JSON.stringify({ symbol: sym, price: "100.5" }));
    }) as unknown as typeof fetch;
    return { fetcher, calls };
  }

  test("a poison symbol costs one price, not the whole book", async () => {
    const { fetcher, calls } = flakyVenue();
    const prices = await fetchPrices(["BTCUSDT", "DE30/EUR"], { fetcher });
    // One batch attempt, then one retry per symbol.
    expect(calls.length).toBe(3);
    expect(prices.get("BTCUSDT")).toBe(100.5);
    expect(prices.has("DE30/EUR")).toBe(false);
  });

  test("an empty book makes no requests", async () => {
    const { fetcher, calls } = flakyVenue();
    const prices = await fetchPrices([], { fetcher });
    expect(prices.size).toBe(0);
    expect(calls.length).toBe(0);
  });
});
