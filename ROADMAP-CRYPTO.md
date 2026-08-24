# Crypto opportunity engine — roadmap and scan record

Written 2026-08-24. This file records what was built to find more market
opportunities, what the scans actually found, and what is worth doing next.
Every number here is reproducible with the committed tools; rerun before
acting on stale conclusions, because rankings and regimes drift.

## What was built

| Piece | File | What it does |
|---|---|---|
| Crypto hypothesis catalogue | `core/hypotheses-crypto.ts` | 11 claims that only make sense on a 24/7 leveraged market |
| Exchange-fed edge scanner | `scripts/edgescan.ts` | `--asset BTCUSDT --interval 1h --days N`; MT5 path unchanged |
| Batch matrix scanner | `scripts/batch-edgescan.ts` | top-N by live volume × timeframes, one shared testing budget |

Catalogue: `saturday-drift`, `sunday-drift`, `utc-day-open-range-4`,
`utc-day-open-range-12`, `fade-cascade-3x2`, `fade-cascade-4x2`,
`volume-thrust-3x`, `volume-thrust-5x`, `squeeze-expansion`,
`streak-fade-3`, `streak-fade-5`.

The batch scans run the gold catalogue too (its momentum/fade/quiet-trend
mechanisms are instrument-generic), so each cell tests all 27 hypotheses.

## Scan record

### Round 3 — 2026-08-24, later: positioning data

Built the feed the price-only nulls were pointing at:

| Piece | File | Notes |
|---|---|---|
| Futures fetchers | `server/market-futures.ts` | funding settlements back to 2020, paginated; open interest **venue-capped to ~30 days** |
| Positioning hypotheses | `core/hypotheses-positioning.ts` | closure factories returning ordinary `Hypothesis` objects — scanner untouched, corrections automatic |
| Runner | `bun run edgescan:positioning` | full fixed catalogue in one shared budget |

Claims: `funding-extreme` (fade whichever side pays extreme funding rent),
`oi-breakout-24` (range break only on rising OI), `oi-washout-12` (buy the
drop that closed positions).

Results, BTCUSDT + ETHUSDT H1, horizons 12 and 48 bars:

    funding-extreme   n=274 (BTC h12) / 232 (ETH h12) — MEASURED
                      mean NEGATIVE on both assets, ≤1/6 windows positive,
                      best p = 0.051 vs required 1.7e-3 → answered NO
    horizon 48        t ≈ −0.5 on both — unwinding takes longer? No.
    oi-* rows         0–1 occurrences each — NOT A VERDICT: the venue only
                      serves a month of OI history, so these cannot reach
                      MIN_OCCURRENCES by construction.

`funding-extreme` is the first catalogue entry measured on real positioning
data, and it lost honestly: crowded-funding fades did not pay round-trip
costs on majors in this window, in either direction, at either horizon.
Registered permanently; future scans keep paying its budget slot.

### Round 1 — 2026-08-24

Top 5 by 24h quote volume at scan time (BTCUSDT, ETHUSDT, XRPUSDT,
SOLUSDT, ZECUSDT) × {M5, M15, M30, H1, H4}, ≤30k bars per cell,
hold 12 bars, windows 6, tier costs (top-tier ≈13 bps round trip).

    25 cells × 25 hypotheses = 625 tests
    shared bar for the set: p < 8.207e-5 (Šidák)
    506 pairs fired ≥100 times and were judged
    SURVIVORS: none

Strongest positive results nowhere near the bar: ZEC H1
`utc-day-open-range-12` (t=2.20, p≈0.03) and ETH H4 `mom3-with-d1`
(t=2.16). At 625 tries, two rows like that is exactly what noise gives you.

The loudest rows were NEGATIVE: BTC M5 momentum variants at t=−15.75,
mean −84 points/trade, 0/6 windows. Investigated before believing it —
see the decomposition below.

### Round 2 — same day, after registering one derived hypothesis

Round 1's negative-momentum pattern motivated `streak-fade-{3,5}`: fade a
run of consecutive same-direction closes. It is registered permanently and
was tested under the enlarged, honestly-corrected budget:

    25 cells × 27 hypotheses = 675 tests
    shared bar: p < 7.599e-5
    556 pairs judged · SURVIVORS: none

`streak-fade` itself lost in every single cell (50/50 negative, mostly
0/6 windows). Recorded as answered: persistence-reversion is not an edge
here either.

## The finding that matters most

The negative rows are a **cost measurement, not a signal**. Decomposition
on BTC M5, 30k bars, hold 12, zero-cost rerun:

    momentum-3     gross mean +3.22   t=0.59
    streak-fade-3  gross mean +6.27   t=0.91   ← best of the set, still nothing
    fade-spike-3x  gross mean +2.98   t=0.31

Gross predictability is indistinguishable from zero. The 13 bps round trip
(≈ $150/trade at current BTC prices, because the scanner pays taker+slippage
on BOTH legs) is what turns "no information" into "t = −15.8". Every entry-
only claim in this catalogue is dead on liquid crypto majors at these
horizons under honest costs. That is a usable fact about the market, not a
failure of imagination.

## Where opportunity can still be — next steps, in order

1. ~~**Build our own open-interest archive.**~~ **DONE, 2026-08-24.** The
   engine now samples perp OI every 15 minutes into `oi_snapshots`
   (`server/intel/oiRecorder.ts`, on by default; `TEO_OI_RECORDER=off` to
   stop it). First tick already archived 42 symbols × 500 observations.
   The positioning scanner unions the archive with the venue feed
   automatically. At ~2 months of history the `oi-*` rows reach
   MIN_OCCURRENCES and become measurable for the first time — no action
   needed except letting the server run.
2. **Model maker exits before condemning strategies.** The scanner's exit
   pays full crossing costs; the live strategy's TP1 is a resting limit
   (maker). A candidate killed by 13 bps may survive 5–7 bps — worth a
   cost-sensitivity pass before any family is written.
3. **Longer horizons on lower-liquidity assets.** Costs scale with bps;
   edges scale with inefficiency. ZEC-type books move further between
   fixes than BTC does.
4. **Cross-asset lead-lag** (BTC → alts) needs injected series support;
   the positioning factories already show the closure pattern to copy.
5. Whatever survives then graduates to a scoring family via the
   quiet-trend path (argue mechanism → normalize points → thresholds →
   discovery search space → three-window validation).

Funding-rate hypotheses are measured and closed for now; re-test only with
a materially different mechanism (e.g., funding *change velocity*, not
level) and register it before scanning.

## Rerun commands

```bash
bun run edgescan -- --asset ETHUSDT --interval 1h --days 180   # single asset
bun run edgescan:batch -- --out tmp/edgescan-batch.json        # price matrix
bun run edgescan:positioning -- --asset BTCUSDT --interval 1h  # + funding/OI
bun test core/__tests__/hypotheses-crypto.test.ts              # catalogue tests
bun test core/__tests__/hypotheses-positioning.test.ts         # positioning tests
```

Rules this work obeys: the catalogue is fixed and named; every addition
stays registered whatever it scores; the Šidák correction counts true total
attempts across the whole matrix; nulls are reported as results.
