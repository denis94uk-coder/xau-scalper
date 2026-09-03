/**
 * Tests for the LSE book's per-asset strategy machinery: resolution order
 * (discovered store → hand-qualified fallback → no trade) and the
 * family-aware regime veto.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_STRATEGY_CONFIG } from "../../core/strategy";
import { Db } from "../db";
import {
  confirmFor,
  lseRegimeBlocks,
  lseStrategyFor,
} from "../lse-engine";

describe("confirmFor", () => {
  test("each intraday interval confirms on the next one up", () => {
    expect(confirmFor("15m")).toBe("30m");
    expect(confirmFor("30m")).toBe("1h");
  });

  test("1h+ strategies stand alone", () => {
    expect(confirmFor("1h")).toBeNull();
    expect(confirmFor("4h")).toBeNull();
  });
});

describe("lseRegimeBlocks", () => {
  test("reversion is a range edge — vetoed outside RANGING", () => {
    expect(lseRegimeBlocks("reversion", "TRENDING_UP")).toBe(true);
    expect(lseRegimeBlocks("reversion", "VOLATILE")).toBe(true);
    expect(lseRegimeBlocks("reversion", null)).toBe(true);
  });

  test("reversion trades in RANGING", () => {
    expect(lseRegimeBlocks("reversion", "RANGING")).toBe(false);
  });

  test("families validated without a regime filter get no veto", () => {
    expect(lseRegimeBlocks("breakout", "RANGING")).toBe(false);
    expect(lseRegimeBlocks("trend", "RANGING")).toBe(false);
    expect(lseRegimeBlocks("momentum", undefined)).toBe(false);
  });
});

describe("lseStrategyFor", () => {
  test("falls back to the hand-qualified gold strategy", () => {
    const db = new Db(":memory:");
    const s = lseStrategyFor(db, "XAUUSD");
    expect(s).not.toBeNull();
    expect(s!.family).toBe("breakout");
    expect(s!.interval).toBe("1h");
    expect(s!.config.breakoutPeriod).toBe(10);
    db.close();
  });

  test("a discovered store entry wins over the fallback", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      XAUUSD: {
        family: "trend",
        config: { ...DEFAULT_STRATEGY_CONFIG, emaFast: 21 },
        interval: "30m",
        confirm: "1h",
        adjustedP: 0.01,
        adoptedAt: 123,
      },
    });
    const s = lseStrategyFor(db, "XAUUSD");
    expect(s!.family).toBe("trend");
    expect(s!.interval).toBe("30m");
    expect(s!.confirm).toBe("1h");
    expect(s!.config.emaFast).toBe(21);
    db.close();
  });

  test("an instrument with neither store entry nor fallback must not trade", () => {
    const db = new Db(":memory:");
    expect(lseStrategyFor(db, "EURUSD")).toBeNull();
    expect(lseStrategyFor(db, "SPX500")).toBeNull();
    db.close();
  });
});
