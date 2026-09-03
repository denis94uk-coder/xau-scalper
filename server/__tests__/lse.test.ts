/**
 * Tests for the LSE vault client: candle mapping and pagination, COT report
 * shaping, calendar shaping. All network access goes through an injected
 * fetcher that replays canned vault responses.
 */
import { describe, expect, test } from "bun:test";
import {
  barTime,
  fetchLseCandles,
  fetchLseCalendar,
  fetchLseCot,
} from "../lse";

/** A fetcher that maps URL → canned JSON, recording each request URL. */
function mockFetch(
  routes: (url: string) => unknown,
): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify(routes(url)), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("barTime", () => {
  test("parses vault 'YYYY-MM-DD hh:mm:ss' as UTC", () => {
    expect(barTime("2024-03-05 14:30:00")).toBe(
      Date.parse("2024-03-05T14:30:00Z") / 1000,
    );
  });

  test("parses ISO strings with Z", () => {
    expect(barTime("2024-03-05T14:30:00Z")).toBe(
      Date.parse("2024-03-05T14:30:00Z") / 1000,
    );
  });
});

describe("fetchLseCandles", () => {
  test("maps vault rows to candles, defaulting FX volume to 0", async () => {
    const { fetcher } = mockFetch(() => [
      { ts: "2024-03-05 14:30:00", open: 1.1, high: 1.2, low: 1.0, close: 1.15 },
      { ts: "2024-03-05 14:45:00", open: 1.15, high: 1.25, low: 1.05, close: 1.2, volume: 0 },
    ]);
    const candles = await fetchLseCandles("XAU/USD", "1h", { fetcher });
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: barTime("2024-03-05 14:30:00"),
      open: 1.1,
      high: 1.2,
      low: 1.0,
      close: 1.15,
      volume: 0,
    });
  });

  test("drops malformed rows instead of fabricating bars", async () => {
    const { fetcher } = mockFetch(() => [
      { ts: "2024-03-05 14:30:00", open: 1, high: 2, low: 0.5, close: 1.5 },
      { high: 2, low: 0.5, close: 1.5 }, // no ts
      { ts: "bogus", open: 1, high: 2, low: 0.5, close: 1.5 }, // unparsable time
      { ts: "2024-03-05 15:00:00", open: -1, high: 2, low: 0.5, close: -1 }, // nonsense price
    ]);
    const candles = await fetchLseCandles("XAU/USD", "1h", { fetcher });
    expect(candles).toHaveLength(1);
  });

  test("paginates forward by date until a short page", async () => {
    // 15m bars: 96 per day. A full 5000-row page spans ~52 days of valid timestamps.
    const bars = (startDay: number, days: number) => {
      const rows: Array<Record<string, string>> = [];
      for (let d = 0; d < days; d++) {
        const date = new Date(Date.UTC(2024, 2, startDay + d));
        const day = date.toISOString().slice(0, 10);
        for (let i = 0; i < 96; i++) {
          const hh = String(Math.floor(i / 4)).padStart(2, "0");
          const mm = String((i % 4) * 15).padStart(2, "0");
          rows.push({
            ts: `${day} ${hh}:${mm}:00`,
            open: "1",
            high: "2",
            low: "0.5",
            close: "1.5",
          });
        }
      }
      return rows;
    };
    const page1 = bars(1, 53); // Mar 1 … Apr 22 — 5088 rows ≥ the 5000 cap
    const page2 = bars(54, 53); // Apr 23 … Jun 14
    const page3 = bars(107, 1);
    const calls: string[] = [];
    const pages = [page1, page2, page3];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const page = pages[Math.min(calls.length - 1, pages.length - 1)];
      return new Response(JSON.stringify(page), { status: 200 });
    }) as typeof fetch;

    const candles = await fetchLseCandles("XAU/USD", "15m", {
      fetcher,
      since: barTime("2024-03-01 00:00:00"),
    });
    expect(candles).toHaveLength(page1.length + page2.length + page3.length);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("start=2024-03-01");
    // The cursor lands on the last bar's date (inclusive `start` re-reads it;
    // upsert makes the overlap harmless) and then follows the data forward.
    expect(calls[1]).toContain(`start=${page1[page1.length - 1].ts.slice(0, 10)}`);
    expect(calls[2]).toContain(`start=${page2[page2.length - 1].ts.slice(0, 10)}`);
  });

  test("`since` starts the cursor on the stored bar's date to refresh it", async () => {
    const { fetcher, calls } = mockFetch(() => [
      { ts: "2024-03-05 15:00:00", open: 1, high: 2, low: 0.5, close: 1.5 },
    ]);
    await fetchLseCandles("XAU/USD", "1h", {
      fetcher,
      since: barTime("2024-03-05 14:00:00"),
    });
    expect(calls[0]).toContain("start=2024-03-05");
  });
});

describe("fetchLseCot", () => {
  test("maps snake_case vault columns", async () => {
    const { fetcher } = mockFetch(() => [
      {
        symbol: "GC",
        date: "2026-08-25",
        open_interest: 427957,
        noncomm_long: 277159,
        noncomm_short: 33825,
        pct_noncomm_long: 64.8,
        pct_noncomm_short: 7.9,
        change_open_interest: 21697,
        change_noncomm_long: 20257,
        change_noncomm_short: -888,
      },
    ]);
    const rows = await fetchLseCot("GC", { fetcher });
    expect(rows).toHaveLength(1);
    expect(rows[0].noncommLong).toBe(277159);
    expect(rows[0].openInterest).toBe(427957);
    expect(rows[0].changeNoncommShort).toBe(-888);
  });
});

describe("fetchLseCalendar", () => {
  test("maps events with epoch datetimes, dropping unparsable rows", async () => {
    const { fetcher } = mockFetch(() => [
      {
        event: "FOMC Rate Decision",
        region_code: "US",
        datetime: "2026-09-16 18:00:00",
        actual: null,
        forecast: "3.50%",
        previous: "3.75%",
      },
      { event: "Mystery", region_code: "US", datetime: null },
    ]);
    const events = await fetchLseCalendar({ fetcher });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("FOMC Rate Decision");
    expect(events[0].datetime).toBe(barTime("2026-09-16 18:00:00"));
    expect(events[0].forecast).toBe("3.50%");
  });
});
