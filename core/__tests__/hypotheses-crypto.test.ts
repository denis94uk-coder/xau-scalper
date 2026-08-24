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

describe("streakFade", () => {
  test("fades a run of same-direction closes", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "streak-fade-3")!;
    if (!h) throw new Error("streak-fade-3 missing from catalogue");
    const start = Date.UTC(2024, 2, 1) / 1000;
    const candles: Candle[] = [];
    let price = 30000;
    // Quiet alternating history, then three up closes of any size.
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
    for (const m of [4, 2, 6]) {
      const open = price;
      price += m;
      candles.push({
        time: start + candles.length * 300,
        open,
        high: Math.max(open, price) + 1,
        low: Math.min(open, price) - 1,
        close: price,
        volume: 100,
      });
    }
    expect(h.signal(candles, candles.length - 1)).toBe("SHORT");
  });

  test("a flat close inside the run breaks the streak", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "streak-fade-3")!;
    const start = Date.UTC(2024, 2, 1) / 1000;
    const candles: Candle[] = [];
    let price = 30000;
    for (let k = 0; k < 60; k++) {
      candles.push({
        time: start + k * 300,
        open: price,
        high: price + 0.5,
        low: price - 0.5,
        close: price,
        volume: 100,
      });
    }
    for (const m of [4, 0, 6]) {
      const open = price;
      price += m;
      candles.push({
        time: start + candles.length * 300,
        open,
        high: Math.max(open, price) + 1,
        low: Math.min(open, price) - 1,
        close: price,
        volume: 100,
      });
    }
    expect(h.signal(candles, candles.length - 1)).toBeNull();
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

/** One flat hourly bar fully inside [lo, hi] except where overridden. */
function hourly(
  time: number,
  open: number,
  close: number,
  hiPad = 3,
  loPad = 3,
): Candle {
  return {
    time,
    open,
    high: Math.max(open, close) + hiPad,
    low: Math.min(open, close) - loPad,
    close,
    volume: 100,
  };
}

describe("sweepPriorDay", () => {
  const day1 = Date.UTC(2024, 2, 1) / 1000;
  const day2 = day1 + 86400;

  // Day 1: twenty-four flat bars at 105, each spanning 102–108, so the
  // prior day's levels are unambiguous.
  function base(): Candle[] {
    return Array.from({ length: 24 }, (_, k) =>
      hourly(day1 + k * 3600, 105, 105),
    );
  }

  test("a pierce of the prior low that closes back inside goes LONG", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "sweep-prior-day")!;
    const candles = base();
    candles.push(hourly(day2 + 9 * 3600, 104, 104, 1, 3)); // low 101 < 102
    expect(h.signal(candles, candles.length - 1)).toBe("LONG");
  });

  test("a pierce of the prior high that closes back inside goes SHORT", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "sweep-prior-day")!;
    const candles = base();
    candles.push(hourly(day2 + 10 * 3600, 106, 106, 3, 1)); // high 109 > 108
    expect(h.signal(candles, candles.length - 1)).toBe("SHORT");
  });

  test("a close beyond the level is continuation, not a sweep", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "sweep-prior-day")!;
    const candles = base();
    candles.push(hourly(day2 + 11 * 3600, 104, 101, 1, 3)); // low 98, close 101 < 102
    expect(h.signal(candles, candles.length - 1)).toBeNull();

    const above: Candle[] = [
      ...base(),
      hourly(day2 + 11 * 3600, 106, 109, 3, 1),
    ];
    expect(h.signal(above, above.length - 1)).toBeNull();
  });
});

describe("breakPriorDay", () => {
  const day1 = Date.UTC(2024, 2, 1) / 1000;
  const day2 = day1 + 86400;

  function base(): Candle[] {
    return Array.from({ length: 24 }, (_, k) =>
      hourly(day1 + k * 3600, 105, 105),
    );
  }

  test("a close beyond the prior high goes LONG, beyond the low SHORT", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "break-prior-day")!;
    if (!h) throw new Error("break-prior-day missing from catalogue");

    const up: Candle[] = [...base(), hourly(day2 + 9 * 3600, 107, 110)];
    expect(h.signal(up, up.length - 1)).toBe("LONG");

    const down: Candle[] = [...base(), hourly(day2 + 9 * 3600, 103, 100)];
    expect(h.signal(down, down.length - 1)).toBe("SHORT");
  });

  test("a close inside the prior range fires nothing", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "break-prior-day")!;
    // Pierces the low intrabar but closes back inside — that is the sweep
    // hypothesis's event, not this one's.
    const candles: Candle[] = [
      ...base(),
      hourly(day2 + 9 * 3600, 104, 104, 1, 3),
    ];
    expect(h.signal(candles, candles.length - 1)).toBeNull();
  });
});

describe("asianRangeBreakout", () => {
  const day0 = Date.UTC(2024, 2, 1) / 1000;

  // Seven days of history whose Asian windows all span exactly 1 point
  // (99.5–100.5); the eighth day's window is what the test varies.
  function week(narrowWidth: number): Candle[] {
    const candles: Candle[] = [];
    for (let d = 0; d < 7; d++) {
      const ds = day0 + d * 86400;
      for (let hr = 0; hr < 24; hr++) {
        if (hr < 7) {
          candles.push(hourly(ds + hr * 3600, 100, 100, 0.5, 0.5));
        } else {
          candles.push(hourly(ds + hr * 3600, 100, 101));
        }
      }
    }
    const last = day0 + 7 * 86400;
    const pad = narrowWidth / 2;
    for (let hr = 0; hr < 7; hr++) {
      candles.push(hourly(last + hr * 3600, 100, 100, pad, pad));
    }
    return candles;
  }

  test("first close outside a compressed range continues", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "asian-range-breakout")!;
    const candles = week(0.5); // narrower than every prior day
    candles.push(hourly(day0 + 7 * 86400 + 8 * 3600, 100, 103));
    expect(h.signal(candles, candles.length - 1)).toBe("LONG");

    candles[candles.length - 1] = hourly(day0 + 7 * 86400 + 8 * 3600, 100, 97);
    expect(h.signal(candles, candles.length - 1)).toBe("SHORT");
  });

  test("an uncompressed range fires nothing", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "asian-range-breakout")!;
    const candles = week(2); // wider than the prior days' 1-point norm
    candles.push(hourly(day0 + 7 * 86400 + 8 * 3600, 100, 103));
    expect(h.signal(candles, candles.length - 1)).toBeNull();
  });

  test("only the crossing bar fires, and only inside the session window", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "asian-range-breakout")!;
    const candles = week(0.5);
    const cross = day0 + 7 * 86400 + 8 * 3600;
    candles.push(hourly(cross, 100, 103)); // the breakout bar
    expect(h.signal(candles, candles.length - 1)).toBe("LONG");

    candles.push(hourly(cross + 3600, 103, 105)); // already outside: stale
    expect(h.signal(candles, candles.length - 1)).toBeNull();

    candles.push(hourly(cross + 8 * 3600, 105, 108)); // past 15:00 UTC
    expect(h.signal(candles, candles.length - 1)).toBeNull();
  });
});

describe("fadeOpenDrive", () => {
  const day = Date.UTC(2024, 2, 1) / 1000;

  function dayBars(): Candle[] {
    return Array.from({ length: 24 }, (_, k) =>
      hourly(day + k * 3600, 100, 100),
    );
  }

  test("fades an upward London drive SHORT, once", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "fade-london-drive")!;
    const candles = dayBars();
    candles[7] = hourly(day + 7 * 3600, 100, 106); // the drive bar
    // First bar completing the drive hour is 08:00; entry against the move.
    candles[8] = hourly(day + 8 * 3600, 106, 107);
    expect(h.signal(candles, 8)).toBe("SHORT");
    // The next bar is not a second event…
    expect(h.signal(candles, 9)).toBeNull();
    // …and before the hour completes there is nothing to fade yet.
    expect(h.signal(candles, 7)).toBeNull();
  });

  test("fades a downward New York drive LONG", () => {
    const h = CRYPTO_HYPOTHESES.find(x => x.name === "fade-ny-drive")!;
    const candles = dayBars();
    candles[13] = hourly(day + 13 * 3600, 100, 95);
    candles[14] = hourly(day + 14 * 3600, 95, 94);
    expect(h.signal(candles, 14)).toBe("LONG");
    expect(h.signal(candles, 13)).toBeNull();
  });
});
