/**
 * MT5 history protocol tests.
 *
 * The bridge is two processes sharing a directory with no lock between them,
 * so the tests concentrate on the failure that would actually happen in the
 * wild: reading a file the other side is still writing. Every such moment must
 * report "still working", never "failed" and never a truncated answer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearHistory,
  completedHistories,
  historyId,
  historyState,
  INTERVAL_TO_TIMEFRAME,
  readHistory,
  requestHistory,
} from "../mt5history";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teo-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Stand in for the EA answering a request. */
function terminalAnswers(
  id: string,
  bars: Array<[number, number, number, number, number, number]>,
  gmtOffsetSeconds = 0,
): void {
  mkdirSync(join(dir, "history"), { recursive: true });
  writeFileSync(
    join(dir, "history", `${id}.json`),
    JSON.stringify({ id, gmtOffsetSeconds, bars }),
  );
}

describe("request ids", () => {
  test("the same question produces the same id", () => {
    expect(historyId("NAS100", "M15", 100, 200)).toBe(
      historyId("NAS100", "M15", 100, 200),
    );
  });

  test("a different range is a different id", () => {
    expect(historyId("NAS100", "M15", 100, 200)).not.toBe(
      historyId("NAS100", "M15", 100, 300),
    );
  });

  test("broker suffixes cannot escape into the filename", () => {
    // "XAUUSD.r" and "XAUUSD/x" are both real broker spellings; neither may
    // produce a path separator or an extension the reader would misparse.
    const id = historyId("XAUUSD.r/x", "M5", 1, 2);
    expect(id).not.toContain("/");
    expect(id).not.toContain(".");
  });
});

describe("interval mapping", () => {
  test("covers every timeframe the exporter understands", () => {
    for (const i of ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]) {
      expect(INTERVAL_TO_TIMEFRAME[i]).toBeTruthy();
    }
  });

  test("an unknown interval maps to nothing rather than a wrong guess", () => {
    expect(INTERVAL_TO_TIMEFRAME["7m"]).toBeUndefined();
  });
});

describe("the request lifecycle", () => {
  test("a fresh request is pending", () => {
    const req = requestHistory(dir, "NAS100", "M15", 1000, 2000);
    const state = historyState(dir, req.id);
    expect(state.status).toBe("pending");
    expect(state.progress).toBe(0);
  });

  test("a status file reports progress while the terminal works", () => {
    const req = requestHistory(dir, "NAS100", "M15", 1000, 2000);
    writeFileSync(
      join(dir, "history", `${req.id}.status`),
      JSON.stringify({ progress: 0.5, message: "Downloading…" }),
    );
    const state = historyState(dir, req.id);
    expect(state.status).toBe("working");
    expect(state.progress).toBeCloseTo(0.5);
    expect(state.message).toBe("Downloading…");
  });

  test("progress never reaches 1 before the bars are actually there", () => {
    // Otherwise a full bar would sit on screen while the terminal is still
    // writing, and the operator would think the app had stalled at the end.
    const req = requestHistory(dir, "NAS100", "M15", 1000, 2000);
    writeFileSync(
      join(dir, "history", `${req.id}.status`),
      JSON.stringify({ progress: 5, message: "nearly" }),
    );
    expect(historyState(dir, req.id).progress).toBeLessThan(1);
  });

  test("a delivered answer is ready, with its bar count", () => {
    const req = requestHistory(dir, "NAS100", "M15", 1000, 2000);
    terminalAnswers(req.id, [[1000, 1, 2, 0.5, 1.5, 10]]);
    const state = historyState(dir, req.id);
    expect(state.status).toBe("ready");
    expect(state).toMatchObject({ bars: 1 });
  });

  test("an error from the terminal is surfaced verbatim", () => {
    const req = requestHistory(dir, "NAS100", "M15", 1000, 2000);
    mkdirSync(join(dir, "history"), { recursive: true });
    writeFileSync(
      join(dir, "history", `${req.id}.json`),
      JSON.stringify({
        error: "symbol NAS100 is not available at this broker",
      }),
    );
    const state = historyState(dir, req.id);
    expect(state.status).toBe("failed");
    expect(state.message).toContain("not available");
  });

  test("a half-written answer reads as working, not failed", () => {
    const req = requestHistory(dir, "NAS100", "M15", 1000, 2000);
    mkdirSync(join(dir, "history"), { recursive: true });
    writeFileSync(join(dir, "history", `${req.id}.json`), '{"bars": [[100,1,2');
    expect(historyState(dir, req.id).status).toBe("working");
  });

  test("an id nobody asked about is failed rather than pending forever", () => {
    expect(historyState(dir, "never-requested").status).toBe("failed");
  });
});

describe("reading the bars", () => {
  test("normalises server time to UTC using the exported offset", () => {
    const req = requestHistory(dir, "NAS100", "M15", 0, 10_000);
    // A broker on UTC+3 stamps a bar three hours ahead of the real moment.
    terminalAnswers(req.id, [[10_800, 1, 2, 0.5, 1.5, 10]], 10_800);
    expect(readHistory(dir, req.id)[0].time).toBe(0);
  });

  test("returns bars oldest first whatever order they arrived in", () => {
    const req = requestHistory(dir, "NAS100", "M15", 0, 10_000);
    terminalAnswers(req.id, [
      [900, 3, 3, 3, 3, 1],
      [0, 1, 1, 1, 1, 1],
      [1800, 2, 2, 2, 2, 1],
    ]);
    expect(readHistory(dir, req.id).map(c => c.time)).toEqual([0, 900, 1800]);
  });

  test("maps OHLCV positionally as the exporter writes them", () => {
    const req = requestHistory(dir, "NAS100", "M15", 0, 10_000);
    terminalAnswers(req.id, [[0, 10, 12, 9, 11, 500]]);
    expect(readHistory(dir, req.id)[0]).toEqual({
      time: 0,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 500,
    });
  });

  test("an error answer throws rather than returning nothing", () => {
    const req = requestHistory(dir, "NAS100", "M15", 0, 10_000);
    mkdirSync(join(dir, "history"), { recursive: true });
    writeFileSync(
      join(dir, "history", `${req.id}.json`),
      JSON.stringify({ error: "no bars" }),
    );
    // Silently returning [] would be indistinguishable from a dead market and
    // would send the caller looking for a data problem instead of reading it.
    expect(() => readHistory(dir, req.id)).toThrow("no bars");
  });
});

describe("cleanup", () => {
  test("completed answers are listed by id", () => {
    const req = requestHistory(dir, "NAS100", "M15", 0, 10_000);
    terminalAnswers(req.id, [[0, 1, 1, 1, 1, 1]]);
    expect(completedHistories(dir)).toContain(req.id);
  });

  test("clearing removes the request, the answer and the status", () => {
    const req = requestHistory(dir, "NAS100", "M15", 0, 10_000);
    terminalAnswers(req.id, [[0, 1, 1, 1, 1, 1]]);
    writeFileSync(join(dir, "history", `${req.id}.status`), "{}");

    clearHistory(dir, req.id);

    expect(completedHistories(dir)).not.toContain(req.id);
    expect(historyState(dir, req.id).status).toBe("failed");
  });

  test("clearing something already gone is not an error", () => {
    expect(() => clearHistory(dir, "nothing-here")).not.toThrow();
  });
});
