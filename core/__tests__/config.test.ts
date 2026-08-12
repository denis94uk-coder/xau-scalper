/**
 * Configuration tests.
 *
 * Two properties carry the feature. First, defaults must reproduce the
 * behaviour the app had when every knob lived in source, or upgrading silently
 * changes how live positions are managed. Second, validation must reject every
 * incoherent document and say which field was wrong, because the settings form
 * has nothing else to point at.
 */

import { describe, expect, test } from "bun:test";
import { ASSETS } from "../assets";
import {
  defaultConfig,
  enabledAssets,
  newAsset,
  toAssetDefinition,
  validateConfig,
  withDefaults,
} from "../config";

const ok = (cfg: unknown) => validateConfig(cfg).length === 0;

/** The default document with one deep change applied. */
function mutate(fn: (c: ReturnType<typeof defaultConfig>) => void) {
  const cfg = defaultConfig();
  fn(cfg);
  return cfg;
}

describe("defaults", () => {
  test("are valid", () => {
    expect(validateConfig(defaultConfig())).toEqual([]);
  });

  test("reproduce the built-in asset registry exactly", () => {
    // The upgrade guarantee: someone who never opens Settings must get the
    // same signals from the same bars as before the config existed.
    const cfg = defaultConfig();
    for (const asset of ASSETS) {
      const configured = cfg.assets.find(a => a.id === asset.id);
      expect(configured).toBeDefined();
      expect(toAssetDefinition(configured!)).toEqual(asset);
    }
  });

  test("leave MT5 execution disarmed", () => {
    const cfg = defaultConfig();
    expect(cfg.mt5.executionEnabled).toBe(false);
  });

  test("leave signal generation on, matching the previous behaviour", () => {
    expect(defaultConfig().engine.autoTradingEnabled).toBe(true);
  });
});

describe("structural validation", () => {
  test("rejects a non-object", () => {
    expect(ok(null)).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok("{}")).toBe(false);
  });

  test("rejects unknown keys rather than ignoring them", () => {
    // A typo'd key that is silently dropped is worse than an error: the
    // operator sees their setting accepted and the engine never reads it.
    const issues = validateConfig({ ...defaultConfig(), tradingMode: "yolo" });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(i => i.path.includes("tradingMode"))).toBe(true);
  });

  test("requires at least one asset", () => {
    expect(
      ok(
        mutate(c => {
          c.assets = [];
        }),
      ),
    ).toBe(false);
  });

  test("rejects duplicate asset ids", () => {
    const issues = validateConfig(
      mutate(c => {
        c.assets = [c.assets[0], { ...c.assets[0] }];
      }),
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("cross-field rules", () => {
  test("TP1 must sit inside TP2", () => {
    const issues = validateConfig(
      mutate(c => {
        c.assets[0].config.tp1R = 3;
        c.assets[0].config.tp2R = 2;
      }),
    );
    expect(
      issues.some(i => i.path.includes("tp1R") || i.path.includes("tp2R")),
    ).toBe(true);
  });

  test("MACD fast must be shorter than slow", () => {
    expect(
      ok(
        mutate(c => {
          c.assets[0].config.macdFast = 30;
          c.assets[0].config.macdSlow = 20;
        }),
      ),
    ).toBe(false);
  });

  test("the EMAs must be strictly ordered", () => {
    expect(
      ok(
        mutate(c => {
          c.assets[0].config.emaFast = 50;
          c.assets[0].config.emaMid = 20;
        }),
      ),
    ).toBe(false);
  });

  test("oversold must be below overbought", () => {
    expect(
      ok(
        mutate(c => {
          c.assets[0].config.rsiOversold = 80;
          c.assets[0].config.rsiOverbought = 20;
        }),
      ),
    ).toBe(false);
  });

  test("execution cannot be armed while the bridge is off", () => {
    // Orders written for a bridge nothing reads look exactly like orders the
    // broker rejected, which is the most expensive kind of confusion here.
    const issues = validateConfig(
      mutate(c => {
        c.mt5.enabled = false;
        c.mt5.executionEnabled = true;
      }),
    );
    expect(issues.some(i => i.path.startsWith("mt5"))).toBe(true);
  });

  test("execution with the bridge on is allowed", () => {
    expect(
      ok(
        mutate(c => {
          c.mt5.enabled = true;
          c.mt5.executionEnabled = true;
        }),
      ),
    ).toBe(true);
  });
});

describe("bounds", () => {
  test("a negative cadence is rejected", () => {
    expect(
      ok(
        mutate(c => {
          c.engine.monitorSeconds = -1;
        }),
      ),
    ).toBe(false);
  });

  test("a zero lot size is rejected", () => {
    expect(
      ok(
        mutate(c => {
          c.mt5.lotSize = 0;
        }),
      ),
    ).toBe(false);
  });

  test("a correlation outside [-1, 1] is rejected", () => {
    expect(
      ok(
        mutate(c => {
          c.risk.assumedCorrelation = 1.5;
        }),
      ),
    ).toBe(false);
  });

  test("negative costs are rejected", () => {
    expect(
      ok(
        mutate(c => {
          c.assets[0].costs.halfSpreadBps = -1;
        }),
      ),
    ).toBe(false);
  });

  test("a zero-risk cap is rejected, since it could admit nothing", () => {
    expect(
      ok(
        mutate(c => {
          c.risk.maxRisk = 0;
        }),
      ),
    ).toBe(false);
  });
});

describe("every issue is reported, not just the first", () => {
  test("three broken fields produce three issues", () => {
    const issues = validateConfig(
      mutate(c => {
        c.engine.monitorSeconds = -5;
        c.risk.maxRisk = -1;
        c.mt5.lotSize = -2;
      }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(3);
    // The form marks fields by path, so each must carry one.
    for (const i of issues) expect(i.path.length).toBeGreaterThan(0);
  });
});

describe("withDefaults", () => {
  test("fills a missing section from the defaults", () => {
    const { mt5, ...partial } = defaultConfig();
    const filled = withDefaults(partial);
    expect(filled.mt5).toEqual(defaultConfig().mt5);
  });

  test("keeps what was given", () => {
    const engine = { ...defaultConfig().engine, autoTradingEnabled: false };
    expect(withDefaults({ engine }).engine.autoTradingEnabled).toBe(false);
  });

  test("produces a valid document from nothing at all", () => {
    expect(validateConfig(withDefaults({}))).toEqual([]);
  });
});

describe("helpers", () => {
  test("enabledAssets skips disabled instruments", () => {
    const cfg = mutate(c => {
      c.assets[0].enabled = false;
    });
    expect(enabledAssets(cfg).some(a => a.id === cfg.assets[0].id)).toBe(false);
  });

  test("a new asset is valid on its own", () => {
    const cfg = mutate(c => {
      c.assets.push(newAsset("TESTASSET"));
    });
    expect(validateConfig(cfg)).toEqual([]);
  });

  test("a new asset starts disabled, so adding one cannot start trading it", () => {
    expect(newAsset("TESTASSET").enabled).toBe(false);
  });
});
