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
  lseDirectionAllowed,
  lseRegimeBlocks,
  lseStrategyFor,
  lseUniverse,
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
  test("an empty store means no trade — no fallbacks", () => {
    const db = new Db(":memory:");
    expect(lseStrategyFor(db, "GER")).toBeNull();
    db.close();
  });

  test("a discovered store entry resolves verbatim", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      GER: {
        family: "trend",
        config: { ...DEFAULT_STRATEGY_CONFIG, emaFast: 21 },
        interval: "30m",
        confirm: "1h",
        adjustedP: 0.01,
        adoptedAt: 123,
      },
    });
    const s = lseStrategyFor(db, "GER");
    expect(s!.family).toBe("trend");
    expect(s!.interval).toBe("30m");
    expect(s!.confirm).toBe("1h");
    expect(s!.config.emaFast).toBe(21);
    db.close();
  });

  test("an unknown instrument must not trade", () => {
    const db = new Db(":memory:");
    expect(lseStrategyFor(db, "XAUUSD")).toBeNull();
    expect(lseStrategyFor(db, "EURUSD")).toBeNull();
    db.close();
  });

  test("an unqualified discovered entry (p ≈ 1) must not trade", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      GER: {
        family: "reversion",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "15m",
        confirm: "30m",
        adjustedP: 0.9999,
        adoptedAt: 123,
      },
    });
    expect(lseStrategyFor(db, "GER")).toBeNull();
    db.close();
  });

  test("a relaxed or failed-verdict entry must not trade even with a low p", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      GER: [
        {
          family: "trend",
          config: DEFAULT_STRATEGY_CONFIG,
          interval: "1h",
          confirm: null,
          adjustedP: 0.01,
          adoptedAt: 123,
          relaxed: true,
          verdict: "failed_walk_forward",
        },
        {
          family: "momentum",
          config: DEFAULT_STRATEGY_CONFIG,
          interval: "30m",
          confirm: "1h",
          adjustedP: 0.01,
          adoptedAt: 123,
          verdict: "not_significant",
        },
      ],
    });
    expect(lseStrategyFor(db, "GER")).toBeNull();
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
  test("exact-0 p is an underflow, never an edge", () => {
    expect(strategyIsQualified({ ...base, adjustedP: 0 })).toBe(false);
    expect(
      strategyIsQualified({ ...base, adjustedP: 0, verdict: "qualified" }),
    ).toBe(false);
  });
  test("NaN p never trades", () => {
    expect(strategyIsQualified({ ...base, adjustedP: NaN })).toBe(false);
  });
});

describe("lseDirectionAllowed", () => {
  const base = {
    family: "momentum" as const,
    config: DEFAULT_STRATEGY_CONFIG,
    interval: "30m",
    confirm: "1h",
    adjustedP: 0.032,
    adoptedAt: 1,
  };
  test("undefined flags allow both sides (legacy entries)", () => {
    expect(lseDirectionAllowed(base, "LONG")).toBe(true);
    expect(lseDirectionAllowed(base, "SHORT")).toBe(true);
  });
  test("allowLong false blocks only LONG", () => {
    const s = { ...base, allowLong: false };
    expect(lseDirectionAllowed(s, "LONG")).toBe(false);
    expect(lseDirectionAllowed(s, "SHORT")).toBe(true);
  });
  test("allowShort false blocks only SHORT", () => {
    const s = { ...base, allowShort: false };
    expect(lseDirectionAllowed(s, "LONG")).toBe(true);
    expect(lseDirectionAllowed(s, "SHORT")).toBe(false);
  });
});
describe("GER-only board", () => {
  test("board holds only focus ids — one instrument, no mirrors", () => {
    const db = new Db(":memory:");
    const ids = lseUniverseStatus(db).map(r => r.id);
    expect(ids).toEqual(["GER"]);
    db.close();
  });

  test("a qualified GER entry reports trading", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      GER: {
        family: "momentum",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "30m",
        confirm: "1h",
        adjustedP: 0.032,
        adoptedAt: 1,
      },
    });
    const rows = lseUniverseStatus(db);
    expect(rows.map(r => r.id)).toEqual(["GER"]);
    const ger = rows.find(r => r.id === "GER")!;
    expect(ger.trading).toBe(true);
    expect(ger.aliasOf).toBeNull();
    db.close();
  });

  test("a blocked GER entry is reported as BLOCKED, not missing", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      GER: {
        family: "reversion",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "15m",
        confirm: "30m",
        adjustedP: 0.9999,
        adoptedAt: 1,
      },
    });
    const ger = lseUniverseStatus(db).find(r => r.id === "GER")!;
    expect(ger.strategy).not.toBeNull();
    expect(ger.strategy!.family).toBe("reversion");
    expect(ger.trading).toBe(false);
    expect(ger.reason).toContain("blocked");
    db.close();
  });
});

describe("GER-only focus", () => {
  test("universe holds only focus ids even when others qualify", () => {
    const db = new Db(":memory:");
    db.setSetting("lse:strategies", {
      GER: {
        family: "momentum",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "30m",
        confirm: "1h",
        adjustedP: 0.032,
        adoptedAt: 1,
      },
      BTCUSD: {
        family: "momentum",
        config: DEFAULT_STRATEGY_CONFIG,
        interval: "1h",
        confirm: null,
        adjustedP: 0.009,
        adoptedAt: 1,
        verdict: "qualified",
      },
    });
    const ids = lseUniverse(db).map(a => a.id);
    expect(ids).toEqual(["GER"]);
    db.close();
  });
});
