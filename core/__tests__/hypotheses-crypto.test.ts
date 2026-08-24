/**
 * Structural guarantees for the crypto catalogue: no two hypotheses are one
 * claim negated (which would double-spend the testing budget), names cannot be
 * confused, and nothing reads past the bar it was given. Behaviour tests pin
 * each mechanism on constructed candles so a refactor cannot silently change
 * what fires.
 */

import { describe, expect, test } from "bun:test";
import { HYPOTHESES } from "../hypotheses";
import { CRYPTO_HYPOTHESES } from "../hypotheses-crypto";
import type { Candle, Direction } from "../strategy";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function series(n: number, step: (r: number, i: number) => number, seed = 11) {
  const r = rng(seed);
  const candles: Candle[] = [];
  let price = 30000;
  // Starts Friday 2024-01-05 00:00 UTC, so weekend hypotheses see both
  // weekend days within a few hundred bars.
  const start = Date.UTC(2024, 0, 5) / 1000;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += step(r(), i);
    candles.push({
      time: start + i * 3600,
      open,
      high: Math.max(open, price) + 1,
      low: Math.min(open, price) - 1,
      close: price,
      volume: 100,
    });
  }
  return candles;
}

describe("crypto hypotheses structure", () => {
  test("no two of them are the same claim negated", () => {
    const candles = series(2000, r => (r - 0.5) * 40);
    const flip = (d: Direction | null) =>
      d === null ? null : d === "LONG" ? "SHORT" : "LONG";

    for (let a = 0; a < CRYPTO_HYPOTHESES.length; a++) {
      for (let b = a + 1; b < CRYPTO_HYPOTHESES.length; b++) {
        let compared = 0;
        let mirrored = 0;
        for (let i = 150; i < 1000; i++) {
          const x = CRYPTO_HYPOTHESES[a].signal(candles, i);
          const y = CRYPTO_HYPOTHESES[b].signal(candles, i);
          if (x === null && y === null) continue;
          compared++;
          if (y === flip(x)) mirrored++;
        }
        if (compared > 0 && mirrored === compared) {
          throw new Error(
            `${CRYPTO_HYPOTHESES[a].name} and ${CRYPTO_HYPOTHESES[b].name} are the same test negated`,
          );
        }
      }
    }
  });

  test("every name is distinct", () => {
    const names = CRYPTO_HYPOTHESES.map(h => h.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no name collides with the gold catalogue", () => {
    const all = [...HYPOTHESES, ...CRYPTO_HYPOTHESES].map(h => h.name);
    expect(new Set(all).size).toBe(all.length);
  });

  test("none of them reads a bar past the one it was given", () => {
    const candles = series(2000, r => (r - 0.5) * 40);
    for (const h of CRYPTO_HYPOTHESES) {
      for (let i = 150; i < 400; i++) {
        const truncated = candles.slice(0, i + 1);
        expect(h.signal(truncated, i)).toBe(h.signal(candles, i));
      }
    }
  });
});

describe("weekendDrift", () => {
  test("fires only on its own UTC day", () => {
    const sat = CRYPTO_HYPOTHESES.find(h => h.name === "saturday-drift");
    if (!sat) throw new Error("saturday-drift missing from catalogue");
    const candles = series(400, () => 0);
    let firedOnSaturday = 0;
    let firedElsewhere = 0;
    for (let i = 0; i < candles.length; i++) {
      const d = new Date(candles[i].time * 1000).getUTCDay();
      if (sat.signal(candles, i) !== null) {
        if (d === 6) firedOnSaturday++;
        else firedElsewhere++;
      }
    }
    expect(firedOnSaturday).toBeGreaterThan(0);
    expect(firedElsewhere).toBe(0);
  });
});

describe("utcDayOpenRange", () => {
  test("breaks out when price leaves the opening range", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "utc-day-open-range-4")!;
    if (!h) throw new Error("utc-day-open-range-4 missing from catalogue");

    // Hourly bars. The session open is detected at index 1 (first bar at or
    // after 00:00 UTC — index 0 is the previous day's 23:00 filler), so with
    // bars=4 the range is indices 1-4 and the breakout must be index 5.
    const start = Date.UTC(2024, 2, 1) / 1000 - 3600;
    const mk = (time: number, open: number, close: number): Candle => ({
      time,
      open,
      high: Math.max(open, close) + 5,
      low: Math.min(open, close) - 5,
      close,
      volume: 10,
    });
    const candles = [
      mk(start, 100, 100), // 23:00 filler
      mk(start + 3600, 100, 101), // 00:00 UTC — range starts here
      mk(start + 7200, 101, 102),
      mk(start + 10800, 102, 101),
      mk(start + 14400, 101, 103), // range high 108, low 96
      mk(start + 18000, 103, 115), // closes above the range
    ];
    expect(h.signal(candles, 5)).toBe("LONG");

    candles[5] = mk(start + 18000, 103, 90); // below the range instead
    expect(h.signal(candles, 5)).toBe("SHORT");

    candles[5] = mk(start + 18000, 103, 103); // still inside
    expect(h.signal(candles, 5)).toBeNull();
  });
});

describe("fadeCascade", () => {
  // Twenty quiet bars alternating ±1, so the pre-run average move is exactly 1
  // and each cascade bar's threshold is unambiguous.
  function quietBase(): Candle[] {
    const start = Date.UTC(2024, 2, 1) / 1000;
    const candles: Candle[] = [];
    let price = 30000;
    for (let k = 0; k < 60; k++) {
      const drift = k % 2 === 0 ? 1 : -1;
      const open = price;
      price += drift;
      candles.push({
        time: start + k * 300,
        open,
        high: Math.max(open, price) + 0.5,
        low: Math.min(open, price) - 0.5,
        close: price,
        volume: 100,
      });
    }
    return candles;
  }

  function runBar(
    candles: Candle[],
    start: number,
    index: number,
    move: number,
  ): void {
    const prevClose = candles[index - 1].close;
    const close = prevClose + move;
    candles.push({
      time: start + index * 300,
      open: prevClose,
      high: Math.max(prevClose, close) + 1,
      low: Math.min(prevClose, close) - 1,
      close,
      volume: 100,
    });
  }

  test("fades three consecutive oversized same-direction bars", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "fade-cascade-3x2")!;
    if (!h) throw new Error("fade-cascade-3x2 missing from catalogue");
    const start = Date.UTC(2024, 2, 1) / 1000;
    const base = quietBase();
    const from = base.length;
    for (let k = 0; k < 3; k++) runBar(base, start, from + k, 30);
    expect(h.signal(base, base.length - 1)).toBe("SHORT");
  });

  test("a mixed-direction run is not a cascade", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "fade-cascade-3x2")!;
    const start = Date.UTC(2024, 2, 1) / 1000;
    const base = quietBase();
    let from = base.length;
    for (const m of [30, -35, 30]) runBar(base, start, from++, m);
    expect(h.signal(base, base.length - 1)).toBeNull();
  });

  test("an undersized bar inside the run breaks it", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "fade-cascade-3x2")!;
    const start = Date.UTC(2024, 2, 1) / 1000;
    const base = quietBase();
    let from = base.length;
    for (const m of [30, 30, 1.5]) runBar(base, start, from++, m);
    expect(h.signal(base, base.length - 1)).toBeNull();
  });
});

describe("volumeThrust", () => {
  test("needs both the volume multiple and a directional body", () => {
    const h5 = CRYPTO_HYPOTHESES.find(x => x.name === "volume-thrust-5x")!;
    if (!h5) throw new Error("volume-thrust-5x missing from catalogue");
    const candles = series(100, r => (r - 0.5) * 20);

    const quiet = { ...candles[99], volume: 100 };
    expect(h5.signal([...candles.slice(0, 99), quiet], 99)).toBeNull();

    const loudUp = { ...candles[99], volume: 600, open: 100, close: 110 };
    expect(h5.signal([...candles.slice(0, 99), loudUp], 99)).toBe("LONG");

    const loudDoji = { ...candles[99], volume: 600, open: 105, close: 105 };
    expect(h5.signal([...candles.slice(0, 99), loudDoji], 99)).toBeNull();
  });
});

describe("squeezeExpansion", () => {
  test("requires compression before the wide bar", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "squeeze-expansion")!;
    if (!h) throw new Error("squeeze-expansion missing from catalogue");
    const start = Date.UTC(2024, 2, 1) / 1000;

    // 130 narrow bars (range 2) — the compression gate samples back 120 bars,
    // so the wide bar needs at least 121 before it — then one wide bar.
    const candles: Candle[] = [];
    let price = 30000;
    for (let k = 0; k < 130; k++) {
      candles.push({
        time: start + k * 300,
        open: price,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 100,
      });
    }
    candles.push({
      time: start + 130 * 300,
      open: 30000,
      high: 30025,
      low: 29985,
      close: 30020,
      volume: 100,
    });
    expect(h.signal(candles, 130)).toBe("LONG");

    // Same wide bar, but volatility was RISING into it — the recent ten bars
    // are far above the sampled history, so the compression gate rejects.
    const noisy: Candle[] = [];
    price = 30000;
    for (let k = 0; k < 120; k++) {
      noisy.push({
        time: start + k * 300,
        open: price,
        high: price + 3,
        low: price - 3,
        close: price,
        volume: 100,
      });
    }
    for (let k = 120; k < 130; k++) {
      const drift = k % 2 === 0 ? 20 : -20;
      const open = price;
      price += drift;
      noisy.push({
        time: start + k * 300,
        open,
        high: Math.max(open, price) + 10,
        low: Math.min(open, price) - 10,
        close: price,
        volume: 100,
      });
    }
    noisy.push({
      time: start + 130 * 300,
      open: price,
      high: price + 25,
      low: price - 15,
      close: price + 20,
      volume: 100,
    });
    expect(h.signal(noisy, 130)).toBeNull();
  });
});
