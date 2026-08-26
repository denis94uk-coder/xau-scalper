/**
 * Guarantees for the taker-flow catalogue: bars without flow data void
 * signals rather than reading as zero, nothing reads past bar `i`, names do
 * not collide with the other catalogues, and each claim fires as its words
 * say on constructed bars.
 */

import { describe, expect, test } from "bun:test";
import { HYPOTHESES } from "../hypotheses";
import { CRYPTO_HYPOTHESES } from "../hypotheses-crypto";
import { FLOW_HYPOTHESES } from "../hypotheses-flow";

const H1 = 3600;

function bar(
  time: number,
  open: number,
  close: number,
  volume: number,
  takerBuyBase?: number,
) {
  return {
    time,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume,
    ...(takerBuyBase !== undefined ? { takerBuyBase } : {}),
  };
}

/** Fifty quiet bars at 60% taker-buy share, then one loud bar. */
function series(loud: { close: number; volume: number; taker?: number }) {
  const start = Date.UTC(2024, 2, 1) / 1000;
  const candles = [];
  for (let k = 0; k < 50; k++) {
    candles.push(bar(start + k * H1, 100, 100, 100, 60));
  }
  candles.push(bar(start + 50 * H1, 100, loud.close, loud.volume, loud.taker));
  return candles;
}

describe("flow hypotheses structure", () => {
  test("every name is distinct across all catalogues", async () => {
    const all = [...HYPOTHESES, ...CRYPTO_HYPOTHESES, ...FLOW_HYPOTHESES].map(
      h => h.name,
    );
    expect(new Set(all).size).toBe(all.length);
  });

  test("none of them reads a bar past the one it was given", () => {
    const candles = series({ close: 110, volume: 600, taker: 80 });
    for (const h of FLOW_HYPOTHESES) {
      for (let i = 40; i <= 50; i++) {
        const cut = candles.slice(0, i + 1);
        expect(h.signal(cut, i)).toBe(h.signal(candles, i));
      }
    }
  });
});

describe("flowThrust", () => {
  test("loud bar dominated by taker buys goes LONG, by sells SHORT", () => {
    const h3 = FLOW_HYPOTHESES.find(x => x.name === "flow-thrust-3x")!;
    expect(h3.signal(series({ close: 112, volume: 500, taker: 420 }), 50)).toBe(
      "LONG",
    );
    expect(h3.signal(series({ close: 88, volume: 500, taker: 80 }), 50)).toBe(
      "SHORT",
    );
  });

  test("quiet or balanced loud bars fire nothing", () => {
    const h5 = FLOW_HYPOTHESES.find(x => x.name === "flow-thrust-5x")!;
    // Loud for 3x but not 5x.
    expect(
      h5.signal(series({ close: 112, volume: 300, taker: 280 }), 50),
    ).toBeNull();
    // Loud enough, but share sits in the middle band.
    expect(
      h5.signal(series({ close: 106, volume: 600, taker: 320 }), 50),
    ).toBeNull();
  });
});

describe("flowAbsorption", () => {
  function downtoThen(lowClose: number, taker: number) {
    const start = Date.UTC(2024, 2, 1) / 1000;
    const candles = [];
    // 30 bars drifting down from 120 to ~102 on sell-heavy flow…
    for (let k = 0; k < 30; k++) {
      const c = 120 - k * 0.6;
      candles.push(bar(start + k * H1, c + 0.6, c, 100, 40));
    }
    // …then the candidate bar breaking the 24-bar low with given flow.
    candles.push(bar(start + 30 * H1, 102, lowClose, 150, taker));
    return candles;
  }

  test("new low with buy-dominated flow reverts LONG", () => {
    const h = FLOW_HYPOTHESES.find(x => x.name === "flow-absorption-24")!;
    // Prior lows sit near 103.8; this bar's low pierces them while flow
    // leans to buys.
    expect(h.signal(downtoThen(101, 95), 30)).toBe("LONG");
  });

  test("new low WITH sell-heavy flow is continuation, not absorption", () => {
    const h = FLOW_HYPOTHESES.find(x => x.name === "flow-absorption-24")!;
    expect(h.signal(downtoThen(101, 20), 30)).toBeNull();
  });
});

describe("flowDivergence", () => {
  test("price down under persistent buy pressure fades LONG", () => {
    const h = FLOW_HYPOTHESES.find(x => x.name === "flow-divergence-12")!;
    const start = Date.UTC(2024, 2, 1) / 1000;
    const candles = [];
    // Twelve bars falling gently while 65% of flow is aggressive buying.
    let price = 110;
    for (let k = 0; k < 13; k++) {
      candles.push(bar(start + k * H1, price, price - 0.2, 100, 65));
      price -= 0.2;
    }
    expect(h.signal(candles, 12)).toBe("LONG");
  });

  test("insufficient flow coverage in the window fires nothing", () => {
    const h = FLOW_HYPOTHESES.find(x => x.name === "flow-divergence-12")!;
    const start = Date.UTC(2024, 2, 1) / 1000;
    const candles = [];
    let price = 110;
    for (let k = 0; k < 13; k++) {
      // Only three of thirteen bars carry flow data — below the half-window gate.
      candles.push(
        bar(
          start + k * H1,
          price,
          price - 0.2,
          100,
          k % 4 === 0 ? 65 : undefined,
        ),
      );
      price -= 0.2;
    }
    expect(h.signal(candles, 12)).toBeNull();
  });
});
