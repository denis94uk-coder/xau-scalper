/**
 * Guarantees for the lead-lag catalogue: the aligned series it reads cannot
 * smuggle in future bars, a stale or missing leader voids the signal instead
 * of silently reusing an old bar, and each claim fires on constructed data as
 * its words say.
 */

import { describe, expect, test } from "bun:test";
import type { AlignedSeries } from "../edgescan";
import { LEAD_HYPOTHESES } from "../hypotheses-leads";
import type { Candle, Direction } from "../strategy";

const H1 = 3600;

function hourlies(from: number, n: number, price: number): Candle[] {
  return Array.from({ length: n }, (_, k) => ({
    time: from + k * H1,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 100,
  }));
}

function rising(
  from: number,
  n: number,
  start: number,
  step: number,
): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let k = 0; k < n; k++) {
    const open = price;
    price += step;
    out.push({
      time: from + k * H1,
      open,
      high: Math.max(open, price) + 1,
      low: Math.min(open, price) - 1,
      close: price,
      volume: 100,
    });
  }
  return out;
}

/** Aligned wrapper mirroring what core/edgescan.ts's alignSeries produces. */
function align(primary: Candle[], aux: Candle[]): AlignedSeries {
  const aligned: (Candle | undefined)[] = new Array(primary.length).fill(
    undefined,
  );
  let j = 0;
  for (let i = 0; i < primary.length; i++) {
    while (j < aux.length && aux[j].time < primary[i].time) j++;
    if (j < aux.length && aux[j].time === primary[i].time) aligned[i] = aux[j];
  }
  return { btc: aligned };
}

describe("lead hypotheses structure", () => {
  test("every name is distinct and no name collides with other catalogues", async () => {
    const others = await Promise.all([
      import("../hypotheses"),
      import("../hypotheses-crypto"),
    ]);
    const all = [
      ...others[0].HYPOTHESES,
      ...others[1].CRYPTO_HYPOTHESES,
      ...LEAD_HYPOTHESES,
    ].map(h => h.name);
    expect(new Set(all).size).toBe(all.length);
  });

  test("none of them reads a bar past the one it was given", () => {
    const start = Date.UTC(2024, 2, 1) / 1000;
    const primary = rising(start, 400, 100, 0.3);
    const leader = rising(start, 400, 50000, -12);
    for (const h of LEAD_HYPOTHESES) {
      for (let i = 60; i < 200; i++) {
        const cutPrimary = primary.slice(0, i + 1);
        const cutLeader = leader.slice(0, i + 1);
        const full = h.signal(primary, i, align(primary, leader));
        const cut = h.signal(cutPrimary, i, align(cutPrimary, cutLeader));
        expect(cut).toBe(full);
      }
    }
  });
});

describe("leadMomentum", () => {
  const start = Date.UTC(2024, 2, 1) / 1000;

  test("a rising leader sends the alt LONG", () => {
    const h = LEAD_HYPOTHESES.find(x => x.name === "lead-btc-mom3")!;
    const primary = hourlies(start, 20, 100);
    const leader = rising(start, 20, 50000, 50);
    expect(h.signal(primary, 10, align(primary, leader))).toBe("LONG");
  });

  test("a falling leader sends the alt SHORT", () => {
    const h = LEAD_HYPOTHESES.find(x => x.name === "lead-btc-mom3")!;
    const primary = hourlies(start, 20, 100);
    const leader = rising(start, 20, 50000, -40);
    expect(h.signal(primary, 10, align(primary, leader))).toBe("SHORT");
  });

  test("a missing or stale leader bar voids the signal", () => {
    const h = LEAD_HYPOTHESES.find(x => x.name === "lead-btc-mom3")!;
    const primary = hourlies(start, 40, 100);
    const leader = rising(start, 40, 50000, 50);

    // No injection at all.
    expect(h.signal(primary, 10)).toBeNull();

    // Leader half an hour off-grid: no bar ever shares a timestamp with the
    // primary, so every lookup is undefined and the claim stays silent.
    const offGrid = leader.map(c => ({ ...c, time: c.time + 1800 }));
    expect(h.signal(primary, 30, align(primary, offGrid))).toBeNull();

    // Leader listed a day later: void before the grids overlap…
    const lateLeader = leader.map(c => ({ ...c, time: c.time + 86400 }));
    expect(h.signal(primary, 10, align(primary, lateLeader))).toBeNull();
    // …and live once they do.
    expect(h.signal(primary, 30, align(primary, lateLeader))).not.toBeNull();
  });
});

describe("leadLastBar", () => {
  const start = Date.UTC(2024, 2, 1) / 1000;

  test("follows the leader's last closed bar", () => {
    const h = LEAD_HYPOTHESES.find(x => x.name === "lead-btc-bar1")!;
    const primary = hourlies(start, 20, 100);
    const up = rising(start, 20, 50000, 30);
    expect(h.signal(primary, 9, align(primary, up))).toBe("LONG");

    const down = rising(start, 20, 50000, -25);
    expect(h.signal(primary, 9, align(primary, down))).toBe("SHORT");
  });

  test("no pair of lead claims is one claim negated", () => {
    const flip = (d: Direction | null) =>
      d === null ? null : d === "LONG" ? "SHORT" : "LONG";
    const startAll = Date.UTC(2024, 2, 1) / 1000;
    const primary = rising(startAll, 300, 100, (Math.random() - 0.5) * 2);
    const leader = rising(startAll, 300, 50000, (Math.random() - 0.5) * 80);
    const ctx = align(primary, leader);

    for (let a = 0; a < LEAD_HYPOTHESES.length; a++) {
      for (let b = a + 1; b < LEAD_HYPOTHESES.length; b++) {
        let compared = 0;
        let mirrored = 0;
        for (let i = 60; i < 290; i++) {
          const x = LEAD_HYPOTHESES[a].signal(primary, i, ctx);
          const y = LEAD_HYPOTHESES[b].signal(primary, i, ctx);
          if (x === null && y === null) continue;
          compared++;
          if (y === flip(x)) mirrored++;
        }
        if (compared > 0) expect(mirrored).toBeLessThan(compared);
      }
    }
  });
});
