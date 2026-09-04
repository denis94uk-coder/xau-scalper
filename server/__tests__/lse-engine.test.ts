/**
 * Tests for the LSE book's per-asset strategy machinery: resolution order
 * (discovered store → hand-qualified fallback → no trade), the strict
 * qualification gate, alias canonicalization, and the family-aware
 * regime veto.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_STRATEGY_CONFIG } from "../../core/strategy";
import { Db } from "../db";
import {
  confirmFor,
  lseCanonicalId,
  lseRegimeBlocks,
  lseStrategyFor,
  lseUniverseStatus,
  strategyIsQualified,
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

  test("an unqualified discovered entry (p ≈ 1) must not trade", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      NAS100: {
        family: "reversion",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "1h",
        confirm: null,
        adjustedP: 0.9999,
        adoptedAt: 123,
      },
    });
    expect(lseStrategyFor(db, "NAS100")).toBeNull();
    db.close();
  });

  test("a relaxed or failed-verdict entry must not trade even with a low p", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      GER: {
        family: "trend",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "1h",
        confirm: null,
        adjustedP: 0.01,
        adoptedAt: 123,
        relaxed: true,
        verdict: "failed_walk_forward",
      },
      FTSE: {
        family: "trend",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "1h",
        confirm: null,
        adjustedP: 0.01,
        adoptedAt: 123,
        verdict: "not_significant",
      },
    });
    expect(lseStrategyFor(db, "GER")).toBeNull();
    expect(lseStrategyFor(db, "FTSE")).toBeNull();
    db.close();
  });

  test("a legacy entry without verdict trades on p alone", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      GER: {
        family: "reversion",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "1h",
        confirm: null,
        adjustedP: 0.002,
        adoptedAt: 123,
      },
    });
    const s = lseStrategyFor(db, "GER");
    expect(s).not.toBeNull();
    expect(s!.family).toBe("reversion");
    db.close();
  });
});

describe("strategyIsQualified", () => {
  const base = {
    family: "breakout" as const,
    config: DEFAULT_STRATEGY_CONFIG,
    interval: "1h",
    confirm: null,
    adjustedP: 0.01,
    adoptedAt: 1,
  };
  test("qualified verdict + low p trades", () => {
    expect(strategyIsQualified({ ...base, verdict: "qualified" })).toBe(true);
  });
  test("relaxed never trades", () => {
    expect(
      strategyIsQualified({ ...base, relaxed: true, verdict: "qualified" }),
    ).toBe(false);
  });
  test("p above 0.05 never trades", () => {
    expect(strategyIsQualified({ ...base, adjustedP: 0.5 })).toBe(false);
  });
});

describe("aliases", () => {
  test("UK100 mirrors FTSE, DE30 mirrors GER, others stand alone", () => {
    expect(lseCanonicalId("UK100")).toBe("FTSE");
    expect(lseCanonicalId("DE30")).toBe("GER");
    expect(lseCanonicalId("FTSE")).toBe("FTSE");
    expect(lseCanonicalId("NAS100")).toBe("NAS100");
  });

  test("universe status marks aliases non-trading with a reason", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      FTSE: {
        family: "reversion",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "1h",
        confirm: null,
        adjustedP: 0.001,
        adoptedAt: 1,
        verdict: "qualified",
      },
    });
    const rows = lseUniverseStatus(db);
    const ftse = rows.find(r => r.id === "FTSE")!;
    const uk100 = rows.find(r => r.id === "UK100")!;
    expect(ftse.trading).toBe(true);
    expect(ftse.aliasOf).toBeNull();
    expect(uk100.trading).toBe(false);
    expect(uk100.aliasOf).toBe("FTSE");
    expect(uk100.reason).toContain("FTSE");
    // NAS100's unqualified entry is reported, not trading.
    const nas100 = rows.find(r => r.id === "NAS100")!;
    expect(nas100.trading).toBe(false);
    expect(nas100.qualified).toBe(false);
    db.close();
  });
});
