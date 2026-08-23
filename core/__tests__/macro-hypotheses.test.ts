import { describe, expect, test } from "bun:test";
import {
  buildSeries,
  dxyAligned,
  dxyContrarian,
  largeYieldMove,
  realYieldProxy,
  yieldCurveSlope,
  yieldDirectionGold,
} from "../macro-hypotheses";
import type { Candle } from "../strategy";

function makeCandle(date: string, close = 2000): Candle {
  const time = Math.floor(new Date(`${date}T12:00:00Z`).getTime() / 1000);
  return {
    time,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  };
}

describe("buildSeries", () => {
  test("maps date strings to values", () => {
    const m = buildSeries([
      { date: "2024-01-02", value: 4.5 },
      { date: "2024-01-03", value: 4.6 },
    ]);
    expect(m.get("2024-01-02")).toBe(4.5);
    expect(m.get("2024-01-03")).toBe(4.6);
  });

  test("skips null values", () => {
    const m = buildSeries([{ date: "2024-01-02", value: null }]);
    expect(m.size).toBe(0);
  });

  test("normalises date to YYYY-MM-DD", () => {
    const m = buildSeries([{ date: "2024-01-02T00:00:00Z", value: 1.0 }]);
    expect(m.has("2024-01-02")).toBe(true);
  });
});

describe("dxyAligned", () => {
  test("DXY up yesterday → SHORT gold", () => {
    const dxy = new Map([
      ["2024-01-01", 101.0],
      ["2024-01-02", 102.0], // up
    ]);
    const candle = makeCandle("2024-01-03");
    const hyp = dxyAligned(dxy);
    expect(hyp.signal([candle], 0)).toBe("SHORT");
  });

  test("DXY down yesterday → LONG gold", () => {
    const dxy = new Map([
      ["2024-01-01", 103.0],
      ["2024-01-02", 101.0], // down
    ]);
    const candle = makeCandle("2024-01-03");
    expect(dxyAligned(dxy).signal([candle], 0)).toBe("LONG");
  });

  test("no data → null", () => {
    const dxy = new Map<string, number>();
    const candle = makeCandle("2024-01-03");
    expect(dxyAligned(dxy).signal([candle], 0)).toBeNull();
  });
});

describe("dxyContrarian", () => {
  test("DXY up → LONG gold (contrarian)", () => {
    const dxy = new Map([
      ["2024-01-01", 101.0],
      ["2024-01-02", 102.0],
    ]);
    const candle = makeCandle("2024-01-03");
    expect(dxyContrarian(dxy).signal([candle], 0)).toBe("LONG");
  });
});

describe("yieldDirectionGold", () => {
  test("yields up → SHORT gold", () => {
    const yields = new Map([
      ["2024-01-01", 4.0],
      ["2024-01-02", 4.1],
    ]);
    const candle = makeCandle("2024-01-03");
    expect(yieldDirectionGold(yields).signal([candle], 0)).toBe("SHORT");
  });

  test("yields down → LONG gold", () => {
    const yields = new Map([
      ["2024-01-01", 4.1],
      ["2024-01-02", 4.0],
    ]);
    const candle = makeCandle("2024-01-03");
    expect(yieldDirectionGold(yields).signal([candle], 0)).toBe("LONG");
  });

  test("flat yields → null", () => {
    const yields = new Map([
      ["2024-01-01", 4.0],
      ["2024-01-02", 4.0],
    ]);
    const candle = makeCandle("2024-01-03");
    expect(yieldDirectionGold(yields).signal([candle], 0)).toBeNull();
  });
});

describe("largeYieldMove", () => {
  test("small move → null (below threshold)", () => {
    const yields = new Map([
      ["2024-01-01", 4.0],
      ["2024-01-02", 4.02], // 2bps — below 5bps threshold
    ]);
    const candle = makeCandle("2024-01-03");
    expect(largeYieldMove(yields, 0.05).signal([candle], 0)).toBeNull();
  });

  test("large yield rise → SHORT gold", () => {
    const yields = new Map([
      ["2024-01-01", 4.0],
      ["2024-01-02", 4.1], // 10bps
    ]);
    const candle = makeCandle("2024-01-03");
    expect(largeYieldMove(yields, 0.05).signal([candle], 0)).toBe("SHORT");
  });

  test("large yield drop → LONG gold", () => {
    const yields = new Map([
      ["2024-01-01", 4.1],
      ["2024-01-02", 4.0],
    ]);
    const candle = makeCandle("2024-01-03");
    expect(largeYieldMove(yields, 0.05).signal([candle], 0)).toBe("LONG");
  });
});

describe("yieldCurveSlope", () => {
  test("steepening curve → LONG gold", () => {
    const y10 = new Map([
      ["2024-01-01", 4.0],
      ["2024-01-02", 4.1],
    ]);
    const y2 = new Map([
      ["2024-01-01", 3.8],
      ["2024-01-02", 3.8],
    ]); // 2yr flat
    const candle = makeCandle("2024-01-03");
    expect(yieldCurveSlope(y10, y2).signal([candle], 0)).toBe("LONG");
  });

  test("flattening curve → SHORT gold", () => {
    const y10 = new Map([
      ["2024-01-01", 4.0],
      ["2024-01-02", 3.9],
    ]);
    const y2 = new Map([
      ["2024-01-01", 3.8],
      ["2024-01-02", 3.8],
    ]);
    const candle = makeCandle("2024-01-03");
    expect(yieldCurveSlope(y10, y2).signal([candle], 0)).toBe("SHORT");
  });
});

describe("realYieldProxy", () => {
  test("real yield falling (10yr drops faster than 1yr) → LONG gold", () => {
    const y10 = new Map([
      ["2024-01-01", 4.0],
      ["2024-01-02", 3.8],
    ]);
    const y1 = new Map([
      ["2024-01-01", 3.5],
      ["2024-01-02", 3.5],
    ]);
    const candle = makeCandle("2024-01-03");
    expect(realYieldProxy(y10, y1).signal([candle], 0)).toBe("LONG");
  });

  test("real yield rising → SHORT gold", () => {
    const y10 = new Map([
      ["2024-01-01", 4.0],
      ["2024-01-02", 4.2],
    ]);
    const y1 = new Map([
      ["2024-01-01", 3.5],
      ["2024-01-02", 3.5],
    ]);
    const candle = makeCandle("2024-01-03");
    expect(realYieldProxy(y10, y1).signal([candle], 0)).toBe("SHORT");
  });
});

describe("weekend gap handling", () => {
  test("looks back through missing weekend dates", () => {
    // Saturday/Sunday missing — Friday data used for Monday candle
    const yields = new Map([
      ["2024-01-05", 4.0], // Friday
      ["2024-01-04", 3.9], // Thursday
      // Sat Jan 6 / Sun Jan 7 missing
    ]);
    const candle = makeCandle("2024-01-08"); // Monday
    // prev(Monday)=Sunday→missing, prev(Sun)=Sat→missing, prev(Sat)=Fri→4.0
    expect(yieldDirectionGold(yields).signal([candle], 0)).toBe("SHORT"); // 4.0 > 3.9
  });
});
