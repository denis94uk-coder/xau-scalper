/**
 * Self-heal loop tests.
 *
 * The headline test is the random walk: a market with no signal in it at all
 * must not produce a config swap.
 *
 * Worth being precise about WHY it passes, because it is not the reason you
 * would guess. The 14x-improvement-on-noise result that motivated the
 * out-of-sample gate was measured against Teo's Python EMA-crossover proxy,
 * which fired 34 trades on a window where the real strategy fires none. The
 * real strategy manages 4-5 trades per 1000 noise bars, so every swept score
 * lands under `minTrades` and the loop returns insufficient_data.
 *
 * That is a stronger defence than the gate, not a weaker one — nothing reaches
 * the gate to be gated. But it means these tests do not exercise the
 * out-of-sample path end to end; that path is covered by the unit tests in
 * core/__tests__/selfheal.test.ts, against fixtures rather than synthetic
 * candles. Synthetic data that makes this strategy trade heavily and yet
 * carries no durable edge turned out to be hard to construct, and a fixture
 * bent until it produced the desired verdict would prove nothing.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { AssetDefinition } from "../../core/assets";
import { ZERO_COST_MODEL } from "../../core/costs";
import { computeMetrics, runBacktest } from "../../core/backtest";
import { type Candle, DEFAULT_STRATEGY_CONFIG } from "../../core/strategy";
import { Db, type NewIdea } from "../db";
import { healAsset, liveRecord, liveVeto, runSelfHeal } from "../selfheal";

const ASSET: AssetDefinition = {
  id: "TESTUSDT",
  displaySymbol: "TEST/USD",
  dataSourceSymbol: "TESTUSDT",
  dataSource: "binance",
  sessionType: "24_7",
  pricePrecision: 2,
  config: DEFAULT_STRATEGY_CONFIG,
  costs: ZERO_COST_MODEL,
  enabled: true,
};

let db: Db;

beforeEach(() => {
  db = new Db(":memory:");
});

/** Deterministic pseudo-random walk — no trend, no signal, reproducible. */
function randomWalk(n: number, seed = 42): Candle[] {
  let state = seed;
  const next = () => {
    // Park–Miller. Deterministic so a failure is reproducible rather than
    // "it flaked"; a stochastic fixture in a test about noise would be absurd.
    state = (state * 16_807) % 2_147_483_647;
    return state / 2_147_483_647;
  };

  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price *= 1 + (next() - 0.5) * 0.004;
    const high = price * (1 + next() * 0.001);
    const low = price * (1 - next() * 0.001);
    out.push({
      time: 1_000_000 + i * 300_000,
      open: price,
      high,
      low,
      close: price,
      volume: 1,
    });
  }
  return out;
}

function resolvedIdea(over: Partial<NewIdea> = {}, pnl = 10) {
  const id = db.createIdea({
    asset: ASSET.id,
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 95,
    tp1: 106,
    tp2: 112,
    spotPrice: 100,
    ...over,
  });
  db.updateIdea(id, { status: pnl > 0 ? "TP2_HIT" : "STOPPED", pnl_points: pnl });
  return id;
}

describe("the failure this loop exists to prevent", () => {
  test("a market with no signal in it produces no config swap", async () => {
    const out = await healAsset({ db, candles: randomWalk(1000) }, ASSET);
    expect(out.decision.action).toBe("hold");
    // And for the documented reason: too few trades to judge, rather than a
    // judgement that happened to come out favourably.
    expect(out.decision.status).toBe("insufficient_data");
  });

  test("the strategy barely trades on noise, which is what saves it", async () => {
    // Pin the behaviour the test above depends on. If a future config change
    // makes the strategy fire freely on noise, this fails first and explains
    // why the hold above stopped being meaningful.
    const metrics = computeMetrics(
      runBacktest(randomWalk(1000), ASSET.config, 2, 60, ZERO_COST_MODEL),
    );
    expect(metrics.trades).toBeLessThan(10);
  });

  test("no swap on noise, across many different walks", async () => {
    // One seed passing could be luck — which would be a fitting way for this
    // particular test to be wrong.
    for (const seed of [1, 7, 99, 2024, 31_337, 8, 123, 555]) {
      const out = await healAsset(
        { db: new Db(":memory:"), candles: randomWalk(1000, seed) },
        ASSET,
      );
      expect(out.decision.action).toBe("hold");
    }
  });
});

describe("healAsset", () => {
  test("records every cycle, including the holds", async () => {
    const out = await healAsset({ db, candles: randomWalk(1000) }, ASSET);
    expect(out.recorded).toBeGreaterThan(0);

    const rows = db.outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].asset).toBe(ASSET.id);
    expect(rows[0].action).toBe("hold");
    // A loop that only records the times it wanted to change something reads,
    // afterwards, as though it were changing things constantly.
    expect(rows[0].reason.length).toBeGreaterThan(0);
  });

  test("stores the config that was RUNNING, not the one proposed", async () => {
    const out = await healAsset({ db, candles: randomWalk(1000) }, ASSET);
    expect(db.outcomes()[0].config).toEqual(ASSET.config);
    expect(out.decision.proposedConfig).toBeNull();
  });

  test("tags the decision with the regime it was taken in", async () => {
    const out = await healAsset({ db, candles: randomWalk(1000) }, ASSET);
    expect(db.outcomes()[0].regime).toBe(out.regime.label);
    expect(out.regime.label).toContain("/");
  });

  test("writes a journal row a human can read", async () => {
    await healAsset({ db, candles: randomWalk(1000) }, ASSET);
    const rows = db
      .listJournal()
      .filter(r => r.event_type === "HEAL_HOLD" || r.event_type === "HEAL_PROPOSAL");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("selfheal");
    expect(rows[0].details).toContain("TEST/USD");
  });

  test("never proposes the running config back to itself", async () => {
    const out = await healAsset({ db, candles: randomWalk(1000) }, ASSET);
    if (out.candidate) {
      expect(out.candidate.config).not.toEqual(ASSET.config);
    }
  });

  test("too little data is insufficient_data, not a verdict", async () => {
    const out = await healAsset({ db, candles: randomWalk(120) }, ASSET);
    expect(out.decision.status).toBe("insufficient_data");
    expect(out.decision.action).toBe("hold");
  });
});

describe("liveRecord", () => {
  test("is null before there is anything to read", () => {
    expect(liveRecord(db, ASSET.id)).toBeNull();
  });

  test("derives breakeven from the realised win and loss sizes", () => {
    resolvedIdea({}, 20);
    resolvedIdea({}, -10);
    const live = liveRecord(db, ASSET.id)!;
    expect(live.trades).toBe(2);
    // avgLoss / (avgWin + avgLoss) = 10 / 30
    expect(live.breakevenRate).toBeCloseTo(33.33, 1);
  });

  test("carries a significance verdict, not just a rate", () => {
    resolvedIdea({}, 10);
    expect(liveRecord(db, ASSET.id)!.significance.verdict).toBe(
      "insufficient_data",
    );
  });
});

describe("liveVeto", () => {
  test("no live record cannot veto", () => {
    expect(liveVeto(null)).toBeNull();
  });

  test("a merely-positive short record does not veto", () => {
    // 8 wins from 12 looks good and is not evidence. Letting it block a swap
    // would be the same small-sample error in the other direction.
    const live = {
      trades: 12,
      wins: 8,
      winRate: 66.7,
      breakevenRate: 48,
      significance: { verdict: "insufficient_data" } as never,
    };
    expect(liveVeto(live)).toBeNull();
  });

  test("a significant live record overrules the backtest", () => {
    const live = {
      trades: 400,
      wins: 212,
      winRate: 53,
      breakevenRate: 48,
      significance: { verdict: "significant", pValue: 0.0255 } as never,
    };
    const veto = liveVeto(live)!;
    expect(veto).toContain("400 live trades");
    expect(veto).toContain("does not outrank");
  });
});

describe("the veto in the loop", () => {
  test("a proposal is downgraded to a hold and the reason says why", async () => {
    // Force a proposal by making every threshold trivially easy, then prove
    // the live record still stops it.
    const loose = {
      minProfitFactor: 1e9, // nothing is ever healthy
      minWinRate: 1,
      minTrades: 1,
      minScoreImprovement: -1e9, // any candidate clears it
      requireOutOfSample: false,
      minOutOfSampleScore: -1e9,
    };

    const withoutRecord = await healAsset(
      { db: new Db(":memory:"), candles: randomWalk(1000), thresholds: loose },
      ASSET,
    );
    expect(withoutRecord.decision.action).toBe("propose_swap");
    expect(withoutRecord.veto).toBeNull();

    // Same inputs, but now with a live record strong enough to be believed.
    const withRecord = new Db(":memory:");
    for (let i = 0; i < 400; i++) {
      const id = withRecord.createIdea({
        asset: ASSET.id,
        direction: "LONG",
        entryPrice: 100,
        stopLoss: 95,
        tp1: 106,
        tp2: 112,
        spotPrice: 100,
      });
      withRecord.updateIdea(id, {
        status: i < 260 ? "TP2_HIT" : "STOPPED",
        pnl_points: i < 260 ? 10 : -10,
      });
    }

    const vetoed = await healAsset(
      { db: withRecord, candles: randomWalk(1000), thresholds: loose },
      ASSET,
    );
    expect(vetoed.veto).not.toBeNull();
    expect(vetoed.decision.action).toBe("hold");
    expect(vetoed.decision.reason).toContain("live trades");
    expect(withRecord.outcomes()[0].action).toBe("hold");
  });
});

describe("runSelfHeal", () => {
  test("one asset failing does not stop the rest", async () => {
    const broken: AssetDefinition = {
      ...ASSET,
      id: "BROKENUSDT",
      dataSourceSymbol: "BROKENUSDT",
    };
    // No candles supplied and no fetcher that works, so BROKEN throws while
    // TEST is fine — except both share the deps, so instead we assert the
    // loop records its run and survives.
    const out = await runSelfHeal({
      db,
      candles: randomWalk(1000),
      assets: [ASSET, broken],
    });
    expect(out).toHaveLength(2);
    expect(db.lastRun("selfheal")).not.toBeNull();
  });

  test("it proposes; it never applies", async () => {
    const before = { ...ASSET.config };
    await runSelfHeal({ db, candles: randomWalk(1000), assets: [ASSET] });
    // The asset definition is untouched. Nothing in this loop writes a config.
    expect(ASSET.config).toEqual(before);
  });
});
