/**
 * End-to-end research run, against a simulated MetaTrader 5 terminal.
 *
 * The fake terminal is a few lines that watch the requests directory and write
 * an answer, which is exactly the contract the real EA implements. That makes
 * this the closest thing to an acceptance test the feature can have without a
 * Windows VM: the run really does write a request, wait, ingest bars, search,
 * and produce a report, with only the broker replaced.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../core/config";
import { rng } from "../../core/discovery";
import { Db } from "../db";
import { getRun, startRun } from "../research";

let db: Db;
let dir: string;
let watcher: ReturnType<typeof setInterval> | null = null;

beforeEach(() => {
  db = new Db(":memory:");
  dir = mkdtempSync(join(tmpdir(), "teo-research-"));
  process.env.TEO_MT5_DIR = dir;
});

afterEach(() => {
  if (watcher) clearInterval(watcher);
  watcher = null;
  delete process.env.TEO_MT5_DIR;
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

function config() {
  const cfg = defaultConfig();
  return { ...cfg, mt5: { ...cfg.mt5, enabled: true, directory: dir } };
}

/** Bars a broker would return: a gently trending series with noise. */
function bars(n: number, startTime: number, step: number) {
  const rand = rng(17);
  const out: Array<[number, number, number, number, number, number]> = [];
  let price = 15_000;
  for (let i = 0; i < n; i++) {
    const move = (rand() - 0.48) * 30;
    const open = price;
    const close = price + move;
    out.push([
      startTime + i * step,
      Number(open.toFixed(2)),
      Number((Math.max(open, close) + rand() * 10).toFixed(2)),
      Number((Math.min(open, close) - rand() * 10).toFixed(2)),
      Number(close.toFixed(2)),
      100,
    ]);
    price = close;
  }
  return out;
}

/**
 * Stand in for TeoExporter: answer any request that appears.
 *
 * `answer` decides what the terminal says, so a test can simulate a broker
 * that has no such symbol as easily as one that delivers.
 */
function fakeTerminal(
  answer: (req: {
    id: string;
    symbol: string;
    from: number;
    to: number;
  }) =>
    | { bars: Array<[number, number, number, number, number, number]> }
    | { error: string },
): void {
  watcher = setInterval(() => {
    const reqDir = join(dir, "requests");
    if (!existsSync(reqDir)) return;
    for (const file of readdirSync(reqDir).filter(f => f.endsWith(".json"))) {
      let req: { id: string; symbol: string; from: number; to: number };
      try {
        req = JSON.parse(readFileSync(join(reqDir, file), "utf8"));
      } catch {
        continue;
      }
      mkdirSync(join(dir, "history"), { recursive: true });
      writeFileSync(
        join(dir, "history", `${req.id}.json`),
        JSON.stringify({ id: req.id, gmtOffsetSeconds: 0, ...answer(req) }),
      );
      rmSync(join(reqDir, file), { force: true });
    }
  }, 20);
}

/** Poll a run to completion, with a ceiling so a hang fails rather than hangs. */
async function settle(id: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = getRun(id);
    if (
      run &&
      (run.status === "done" ||
        run.status === "failed" ||
        run.status === "cancelled")
    ) {
      return run;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("run did not settle");
}

describe("a research run end to end", () => {
  test("pulls history from the terminal, searches, and reports", async () => {
    const from = 1_704_067_200; // 2024-01-01
    const step = 900; // 15m
    fakeTerminal(() => ({ bars: bars(3000, from, step) }));

    const started = startRun(db, config(), {
      assetId: "MT5:NAS100",
      symbol: "NAS100",
      interval: "15m",
      from,
      to: from + 3000 * step,
      iterations: 40,
      seed: 5,
    });

    const run = await settle(started.id);

    expect(run.status).toBe("done");
    expect(run.bars).toBe(3000);
    expect(run.report).not.toBeNull();
    expect(run.report?.iterations).toBe(40);
    expect(run.report?.conclusion.length).toBeGreaterThan(20);
  }, 40_000);

  test("stores the bars, so a second run needs no terminal at all", async () => {
    const from = 1_704_067_200;
    const step = 900;
    fakeTerminal(() => ({ bars: bars(3000, from, step) }));

    const first = startRun(db, config(), {
      assetId: "MT5:NAS100",
      symbol: "NAS100",
      interval: "15m",
      from,
      to: from + 3000 * step,
      iterations: 20,
    });
    await settle(first.id);

    // The terminal goes away entirely.
    if (watcher) clearInterval(watcher);
    watcher = null;
    rmSync(join(dir, "requests"), { recursive: true, force: true });

    const second = startRun(db, config(), {
      assetId: "MT5:NAS100",
      symbol: "NAS100",
      interval: "15m",
      from,
      to: from + 3000 * step,
      iterations: 20,
    });
    const run = await settle(second.id, 20_000);

    expect(run.status).toBe("done");
    expect(run.message).not.toContain("Asked MetaTrader");
  }, 40_000);

  test("reports how many configurations it really tested", async () => {
    // The search runs in slices and each slice returns only its best few. Adding
    // up what came back reported a 60-configuration search as 20, understating
    // the work AND disagreeing with the multiple-comparisons correction, which
    // was always applied to the full count.
    const from = 1_704_067_200;
    const step = 900;
    fakeTerminal(() => ({ bars: bars(3000, from, step) }));

    const run = await settle(
      startRun(db, config(), {
        assetId: "MT5:NAS100",
        symbol: "NAS100",
        interval: "15m",
        from,
        to: from + 3000 * step,
        iterations: 60,
      }).id,
      40_000,
    );

    expect(run.status).toBe("done");
    expect(run.report?.iterations).toBe(60);
    expect(run.report?.evaluated).toBe(60);
  }, 60_000);

  test("a broker that does not have the symbol fails with the broker's reason", async () => {
    fakeTerminal(() => ({
      error: "symbol NAS100 is not available at this broker",
    }));

    const started = startRun(db, config(), {
      assetId: "MT5:NAS100",
      symbol: "NAS100",
      interval: "15m",
      from: 1_704_067_200,
      to: 1_704_067_200 + 3000 * 900,
      iterations: 10,
    });
    const run = await settle(started.id);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("not available");
  }, 20_000);

  test("too little history is refused rather than searched", async () => {
    const from = 1_704_067_200;
    fakeTerminal(() => ({ bars: bars(120, from, 900) }));

    const started = startRun(db, config(), {
      assetId: "MT5:NAS100",
      symbol: "NAS100",
      interval: "15m",
      from,
      to: from + 120 * 900,
      iterations: 10,
    });
    const run = await settle(started.id);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Only 120 bars");
  }, 20_000);

  test("no terminal at all says so, instead of searching nothing", async () => {
    delete process.env.TEO_MT5_DIR;
    const cfg = defaultConfig();
    const started = startRun(
      db,
      {
        ...cfg,
        mt5: { ...cfg.mt5, enabled: true, directory: join(dir, "absent") },
      },
      {
        assetId: "MT5:NAS100",
        symbol: "NAS100",
        interval: "15m",
        from: 1_704_067_200,
        to: 1_704_067_200 + 3000 * 900,
        iterations: 10,
      },
    );
    const run = await settle(started.id);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("MetaTrader 5");
  }, 20_000);
});
