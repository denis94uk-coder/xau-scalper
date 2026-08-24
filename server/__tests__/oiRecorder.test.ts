/**
 * The open-interest archive: what the venue forgets after ~30 days must
 * survive locally. The recorder is idempotent (overlapping re-fetches upsert,
 * never duplicate), and the scanner's union prefers fresher reads.
 */

import { describe, expect, test } from "bun:test";
import { Db } from "../db";
import { recordOpenInterest } from "../intel/oiRecorder";
import type { OpenInterestPoint } from "../market-futures";
import { mergeOpenInterest } from "../market-futures";

function points(
  times: number[],
  contracts: (t: number) => number = t => t,
): OpenInterestPoint[] {
  return times.map(time => ({
    time,
    contracts: contracts(time),
    notional: contracts(time) * 30000,
  }));
}

describe("oi archive in the database", () => {
  test("round-trips and orders oldest-first", () => {
    const db = new Db(":memory:");
    db.saveOiSnapshots("BTCUSDT", points([300, 100, 200]));
    const got = db.getOiSnapshots("BTCUSDT", 0, 400);
    expect(got.map(p => p.time)).toEqual([100, 200, 300]);
    expect(got[2].contracts).toBe(300);
    db.close();
  });

  test("re-saving an overlapping window updates, never duplicates", () => {
    const db = new Db(":memory:");
    db.saveOiSnapshots(
      "BTCUSDT",
      points([100, 200], () => 5),
    );
    db.saveOiSnapshots(
      "BTCUSDT",
      points([200, 300], () => 7),
    );
    const got = db.getOiSnapshots("BTCUSDT", 0, 400);
    expect(got).toHaveLength(3);
    // The re-read of the still-forming bucket superseded the archived value.
    expect(got.find(p => p.time === 200)?.contracts).toBe(7);
    db.close();
  });

  test("symbols do not bleed into each other", () => {
    const db = new Db(":memory:");
    db.saveOiSnapshots("BTCUSDT", points([100]));
    db.saveOiSnapshots("ETHUSDT", points([150]));
    expect(db.getOiSnapshots("BTCUSDT", 0, 400)).toHaveLength(1);
    expect(db.getOiSnapshots("ETHUSDT", 0, 400)[0].time).toBe(150);
    db.close();
  });

  test("latestOiTime drives incremental fetches and is null when empty", () => {
    const db = new Db(":memory:");
    expect(db.latestOiTime("BTCUSDT")).toBeNull();
    db.saveOiSnapshots("BTCUSDT", points([100, 900]));
    expect(db.latestOiTime("BTCUSDT")).toBe(900);
    db.close();
  });

  test("range queries exclude what they say they exclude", () => {
    const db = new Db(":memory:");
    db.saveOiSnapshots("BTCUSDT", points([100, 200, 300]));
    expect(db.getOiSnapshots("BTCUSDT", 200, 300).map(p => p.time)).toEqual([
      200, 300,
    ]);
    db.close();
  });
});

describe("recordOpenInterest", () => {
  // Timestamps must sit inside the venue's real ~30-day serving window —
  // fetchOpenInterestHistory clamps against actual wall-clock, so a fixture
  // dated decades back would be silently outside every request.
  const HOUR = 3_600_000;
  const NOW_MS = Date.now();
  const VENUE_ROWS = [
    {
      sumOpenInterest: "10",
      sumOpenInterestValue: "300000",
      timestamp: NOW_MS - 2 * HOUR,
    },
    {
      sumOpenInterest: "11",
      sumOpenInterestValue: "330000",
      timestamp: NOW_MS - HOUR,
    },
  ];

  function fakeFetcher(calls: string[]): typeof fetch {
    return (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(VENUE_ROWS), { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("archives rows and is incremental on the second run", async () => {
    const db = new Db(":memory:");
    const calls: string[] = [];

    const first = await recordOpenInterest({
      db,
      symbols: ["BTCUSDT"],
      fetcher: fakeFetcher(calls),
    });
    expect(first).toBe(2);
    expect(db.getOiSnapshots("BTCUSDT", 0, NOW_MS)).toHaveLength(2);

    // Second run with the SAME data adds nothing — overlap upserts.
    const second = await recordOpenInterest({
      db,
      symbols: ["BTCUSDT"],
      fetcher: fakeFetcher(calls),
    });
    expect(second).toBe(0);

    // And the request carried an explicit start bound.
    expect(calls[0]).toContain("startTime=");
    db.close();
  });

  test("one failing symbol does not stop the others", async () => {
    const db = new Db(":memory:");
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).includes("BADUSDT")) {
        return new Response("nope", { status: 500 });
      }
      return new Response(JSON.stringify(VENUE_ROWS), { status: 200 });
    }) as unknown as typeof fetch;

    const added = await recordOpenInterest({
      db,
      symbols: ["BADUSDT", "BTCUSDT"],
      fetcher,
    });
    expect(added).toBe(2);
    expect(db.getOiSnapshots("BTCUSDT", 0, NOW_MS)).toHaveLength(2);
    expect(db.getOiSnapshots("BADUSDT", 0, NOW_MS)).toHaveLength(0);
    db.close();
  });
});

describe("mergeOpenInterest", () => {
  test("unions both series sorted by time", () => {
    const a = points([100, 300]);
    const b = points([200, 400]);
    expect(mergeOpenInterest(a, b).map(p => p.time)).toEqual([
      100, 200, 300, 400,
    ]);
  });

  test("the second series wins on shared timestamps", () => {
    const a = points([100], () => 1);
    const b = points([100], () => 9);
    expect(mergeOpenInterest(a, b)[0].contracts).toBe(9);
  });

  test("empty inputs degrade to the other series", () => {
    const p = points([100]);
    expect(mergeOpenInterest([], p)).toEqual(p);
    expect(mergeOpenInterest(p, [])).toEqual(p);
  });
});
