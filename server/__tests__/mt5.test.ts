/**
 * MT5 ingestion tests.
 *
 * The MQL5 side cannot run here — it needs a terminal — so these test against
 * fixtures matching the format TeoExporter.mq5 writes. The two behaviours that
 * matter most are timezone normalisation (bar times arrive in broker server
 * time) and cost derivation (an estimated spread was most of the edge audit's
 * answer).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../core/config";
import { Db } from "../db";
import {
  costModelFrom,
  findExportDir,
  ingestDir,
  type Mt5Export,
  parseExport,
  toCandles,
} from "../mt5";
import { status, syncOnce } from "../mt5bridge";

let db: Db;
let dir: string;

beforeEach(() => {
  db = new Db(":memory:");
  dir = mkdtempSync(join(tmpdir(), "mt5-"));
});

function exportFixture(over: Partial<Mt5Export> = {}): Mt5Export {
  const bars: Mt5Export["bars"] = Array.from({ length: 120 }, (_, i) => {
    const base = 3450 + Math.sin(i / 10) * 5;
    return [
      1_700_000_000 + i * 300,
      base,
      base + 1.2,
      base - 1.1,
      base + 0.3,
      100 + i,
    ];
  });
  return {
    symbol: "XAUUSD",
    timeframe: "M5",
    digits: 2,
    point: 0.01,
    spreadPoints: 25, // 25 points × 0.01 = $0.25 spread
    contractSize: 100,
    tickValue: 1,
    tickSize: 0.01,
    bid: 3450,
    ask: 3450.25,
    gmtOffsetSeconds: 7200, // broker on UTC+2
    exportedAt: 1_700_036_000,
    volumeIsTickCount: true,
    bars,
    ...over,
  };
}

function write(name: string, exp: Mt5Export) {
  writeFileSync(join(dir, name), JSON.stringify(exp));
}

describe("parseExport", () => {
  test("round-trips a well-formed export", () => {
    const exp = parseExport(JSON.stringify(exportFixture()));
    expect(exp.symbol).toBe("XAUUSD");
    expect(exp.bars).toHaveLength(120);
  });

  test("rejects an export missing a required field", () => {
    const broken = exportFixture() as Partial<Mt5Export>;
    broken.spreadPoints = undefined;
    expect(() => parseExport(JSON.stringify(broken))).toThrow(/spreadPoints/);
  });

  test("rejects malformed JSON rather than returning junk", () => {
    expect(() => parseExport("{not json")).toThrow();
  });

  test("optional fields fall back rather than becoming undefined", () => {
    const exp = parseExport(
      JSON.stringify({
        symbol: "X",
        timeframe: "M5",
        digits: 2,
        point: 0.01,
        spreadPoints: 10,
        bars: [],
      }),
    );
    expect(exp.gmtOffsetSeconds).toBe(0);
    expect(exp.contractSize).toBe(0);
  });
});

describe("toCandles", () => {
  test("normalises broker server time to UTC", () => {
    // The single most consequential conversion here: a broker on UTC+2 that is
    // read as UTC misplaces every bar by two hours.
    const exp = exportFixture({ gmtOffsetSeconds: 7200 });
    const candles = toCandles(exp);
    expect(candles[0].time).toBe(exp.bars[0][0] - 7200);
  });

  test("a broker already on UTC is unshifted", () => {
    const exp = exportFixture({ gmtOffsetSeconds: 0 });
    expect(toCandles(exp)[0].time).toBe(exp.bars[0][0]);
  });

  test("returns candles oldest-first", () => {
    const candles = toCandles(exportFixture());
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].time).toBeGreaterThan(candles[i - 1].time);
    }
  });

  test("skips malformed bar rows instead of producing NaN candles", () => {
    const exp = exportFixture();
    // A truncated row would otherwise become a candle with undefined prices.
    (exp.bars as unknown[]).push([1, 2, 3]);
    expect(toCandles(exp)).toHaveLength(120);
  });
});

describe("costModelFrom", () => {
  test("derives half-spread in bps from the broker's own quote", () => {
    // 25 points × 0.01 = $0.25 on a $3450 bid = 0.7246 bps; half is 0.3623.
    const costs = costModelFrom(exportFixture());
    expect(costs.halfSpreadBps).toBeCloseTo(0.3623, 3);
  });

  test("a wider broker spread produces a proportionally worse model", () => {
    const tight = costModelFrom(exportFixture({ spreadPoints: 10 }));
    const wide = costModelFrom(exportFixture({ spreadPoints: 50 }));
    expect(wide.halfSpreadBps).toBeCloseTo(tight.halfSpreadBps * 5, 4);
  });

  test("fees default to zero — commission-free CFD accounts really have none", () => {
    const costs = costModelFrom(exportFixture());
    expect(costs.takerFeeBps).toBe(0);
    expect(costs.makerFeeBps).toBe(0);
  });

  test("fee and slippage assumptions are the caller's to state", () => {
    const costs = costModelFrom(exportFixture(), {
      takerFeeBps: 3,
      stopSlippageSpreads: 2,
    });
    expect(costs.takerFeeBps).toBe(3);
    expect(costs.stopSlippageBps).toBeCloseTo(costs.halfSpreadBps * 4, 4);
  });

  test("falls back to the last close when no live bid is present", () => {
    // Files exported outside market hours can carry a zero bid.
    const costs = costModelFrom(exportFixture({ bid: 0 }));
    expect(costs.halfSpreadBps).toBeGreaterThan(0);
  });

  test("refuses to invent costs with no usable price", () => {
    expect(() => costModelFrom(exportFixture({ bid: 0, bars: [] }))).toThrow(
      /no usable price/,
    );
  });
});

describe("ingestDir", () => {
  test("loads bars under a namespaced asset id", () => {
    write("XAUUSD_M5.json", exportFixture());
    const { ingested, errors } = ingestDir(db, dir);

    expect(errors).toHaveLength(0);
    expect(ingested).toHaveLength(1);
    expect(ingested[0].bars).toBe(120);
    // Namespaced: broker XAUUSD must not collide with an exchange symbol.
    expect(db.getCandles("MT5:XAUUSD", "5m", 500)).toHaveLength(120);
  });

  test("maps every MT5 timeframe the engine uses", () => {
    write("XAUUSD_M5.json", exportFixture({ timeframe: "M5" }));
    write("XAUUSD_M15.json", exportFixture({ timeframe: "M15" }));
    ingestDir(db, dir);
    expect(db.getCandles("MT5:XAUUSD", "5m", 500)).toHaveLength(120);
    expect(db.getCandles("MT5:XAUUSD", "15m", 500)).toHaveLength(120);
  });

  test("one bad file does not cost you the rest", () => {
    write("good_M5.json", exportFixture({ symbol: "GOOD" }));
    writeFileSync(join(dir, "bad_M5.json"), "{ truncated");
    const { ingested, errors } = ingestDir(db, dir);
    expect(ingested).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test("an unsupported timeframe is an error, not a silent skip", () => {
    write("XAUUSD_W1.json", exportFixture({ timeframe: "W1" }));
    const { errors } = ingestDir(db, dir);
    expect(errors[0].error).toMatch(/unsupported timeframe/);
  });

  test("records symbol specs without duplicating the bars into settings", () => {
    write("XAUUSD_M5.json", exportFixture());
    ingestDir(db, dir);
    const spec = db.getSetting<Record<string, unknown>>("mt5:XAUUSD")!;
    expect(spec.spreadPoints).toBe(25);
    expect(spec.barCount).toBe(120);
    expect(spec.bars).toBeUndefined();
  });

  test("reports how stale each export is", () => {
    write("XAUUSD_M5.json", exportFixture({ exportedAt: 1_700_036_000 }));
    const { ingested } = ingestDir(db, dir, { now: 1_700_036_090_000 });
    // A stale file means the terminal stopped exporting; the caller needs to
    // be able to see that rather than trade on old bars.
    expect(ingested[0].ageSeconds).toBe(90);
  });

  test("re-ingesting the same export does not duplicate bars", () => {
    write("XAUUSD_M5.json", exportFixture());
    ingestDir(db, dir);
    ingestDir(db, dir);
    expect(db.getCandles("MT5:XAUUSD", "5m", 500)).toHaveLength(120);
  });

  test("a missing directory is reported, not thrown", () => {
    const { errors } = ingestDir(db, join(dir, "nope"));
    expect(errors).toHaveLength(1);
  });
});

describe("sync diagnostics", () => {
  // Pointing at the terminal root instead of MQL5/Files/teo is the mistake an
  // operator is most likely to make, and it used to report zero ingested with
  // no error at all — nothing to act on.
  test("an existing directory with no exports explains itself", () => {
    const cfg = defaultConfig();
    cfg.mt5.enabled = true;
    cfg.mt5.directory = dir; // exists, but empty

    const out = syncOnce(db, cfg);

    expect(out.ok).toBe(false);
    expect(out.ingested).toBe(0);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toContain(dir);
    expect(out.errors[0]).toMatch(/MQL5\/Files\/teo/);
    expect(out.errors[0]).toMatch(/attached to a chart/);

    // The Settings page reads the stored error, not the sync response.
    expect(status(db, cfg).lastError).toBe(out.errors[0]);
  });

  test("a directory that does not exist is named", () => {
    const cfg = defaultConfig();
    cfg.mt5.enabled = true;
    cfg.mt5.directory = join(dir, "nope");

    const out = syncOnce(db, cfg);

    expect(out.ok).toBe(false);
    expect(out.errors[0]).toContain("directory not found");
  });

  test("a real export still syncs cleanly", () => {
    const cfg = defaultConfig();
    cfg.mt5.enabled = true;
    cfg.mt5.directory = dir;
    writeFileSync(join(dir, "XAUUSD_M5.json"), JSON.stringify(exportFixture()));

    const out = syncOnce(db, cfg);

    expect(out.ok).toBe(true);
    expect(out.symbols).toEqual(["XAUUSD"]);
    expect(status(db, cfg).lastError).toBe(null);
  });
});

describe("test-suite safety", () => {
  // A stray history request once appeared in the operator's real terminal.
  // The EA consumes that directory, so an artifact there is not litter — it is
  // an instruction to a live trading terminal. The preload guard in
  // src/__tests__/mt5-guard.ts is what stops discovery reaching it.
  test("discovery cannot reach a real terminal, even after the pin is deleted", () => {
    delete process.env.TEO_MT5_DIR;

    // The guard restores the safe value rather than allowing the delete.
    expect(String(process.env.TEO_MT5_DIR)).toBe(
      "/nonexistent/teo-test-terminal",
    );
    expect(findExportDir()).toBe(null);
  });
});
