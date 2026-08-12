import { describe, expect, it } from "bun:test";
import { calcEMA as emaUi, calcRSI as rsiUi } from "../../src/lib/indicators";
import { calcEMA as emaCore, calcRSI as rsiCore } from "../strategy";

// The UI chart maths (src/lib/indicators.ts) must stay numerically identical to
// the strategy core (core/strategy.ts). The whole point of one strategy core is
// that live and display can never drift; this pins that. If a fix lands in one
// place, this fails until the other is updated too.
const closes = Array.from(
  { length: 60 },
  (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1,
);

describe("indicator drift: UI vs strategy core", () => {
  it("EMA matches", () => {
    expect(emaUi(closes, 20)).toEqual(emaCore(closes, 20));
  });

  it("RSI matches", () => {
    expect(rsiUi(closes, 14)).toEqual(rsiCore(closes, 14));
  });
});
