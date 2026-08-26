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
mechanisms are instrument-generic), so each cell tests all 32 hypotheses
(since round 6; 27 before it).

## Scan record

### Round 11 — 2026-08-26, latest: funding CARRY, not funding direction

The operator locked scope to crypto-only. Within it, one line remained that
no round had touched: the harvest question. Round 3 measured whether price
REVERTS after extreme funding (NO); it never measured what a delta-neutral
book COLLECTS while funding stays elevated — long spot + short perp receives
every positive settlement regardless of where price goes.

`bun run carry` (`scripts/funding-carry.ts`) measures episodes: enter when
the settlement rate crosses above a threshold, exit below half of it, sum
what the short-perp leg collects, against a pessimistic 20 bps round trip
(four taker legs). Three years of settlements (3,285 per asset):

    BTC: p95 rate 1.96 bps · thr 3bps → 16 episodes, avg collect 32.6 bps,
         net ~+67 bps/yr; only 4/16 episodes individually profitable
    ETH: p95 2.28 bps · thr 3bps → 16 episodes, avg collect 40.6 bps,
         net ~+110 bps/yr; 5/16 profitable
    Above 8bps the event barely exists (1 episode in three years)

**First positive-expectancy structure measured this whole effort** — and an
honest reading of how thin it is:

1. The total is carried by a few large episodes (bull-run regimes); the median
   episode roughly pays its costs at taker-everything assumptions.
2. The 20 bps bracket is the worst case. Maker legs on spot and realistic
   fee tiers put the true number between 8–12 bps, which flips most episodes
   positive — but limit-leg fills carry adverse selection that this arithmetic
   does not model.
3. Basis drift between legs is unmodelled. It is THE risk of the structure and
   must be quantified from premium-index data before any capital cares.
4. Income is regime-dependent: near zero across 2024–25 calm, concentrated in
   manias. As a standalone it is pocket money; as an overlay on a book that
   holds the assets anyway, it is free optionality.

Next steps if pursued: basis-risk measurement from premium index history,
maker-fill cost sensitivity, always-on hysteresis variant (harvest whenever
rate > trailing median), and — before anything live — the Binance execution
path that does not exist yet (MT5 cannot trade this).

### Round 10 — 2026-08-26: the operator's Trend Progression v2, built and tested

Different kind of round: not a scan but a full STRATEGY port. The operator's
Pine v6 "Trend Progression" document became the fifth scoring family,
selectable everywhere models are (`--model progression`, BacktestModel
union, sweep/self-heal included).

| Piece | File | Notes |
|---|---|---|
| Progression family | `core/families.ts` | four components × 25 pts exactly as specified: EMA21/50 direction + slope + ATR-normalised separation; ADX(14) added to both sides (strength, not direction); RSI-band + ATR-scaled MACD momentum; Chande ±15 outside-bar counter with 0.95 decay |
| Entry gates | `progressionGates()` | compressed-Asian-range breakout close (ported from Pine), 24-bar HTF slope agreement, atr(5)>atr(50)×0.85 expansion |
| Documented omissions | header comment | session killzones (round 6 measured them null on majors), DXY filter (no second series; Pine skips when missing too), small-TF confirmations (single-TF harness) |

Tests pin the pipeline end-to-end (graded LONG on a synthetic compressed-
overnight breakout day, HTF veto, compression gate, component responses).

Verdict through the REAL exit harness (ATR stop, TP1 partial → breakeven →
trail → TP2) at tier costs:

    BTC H1: 136 trades, WR 30.9% vs 32.6% breakeven — gross +3287 pts,
            costs −7992 · NO edge
    ETH H1: 142 trades, WR 34.5% vs 31.9% — net POSITIVE +455 …
    …then the 730-day six-window walk-forward killed it honestly:
      ETH: 2439 trades, −5201 pts, 0/6 windows positive (WR 24.8–28.9%)
      BTC: 2486 trades, −210383 pts, 0/6 windows positive (WR 27.6–31.1%)

**Verdict: the composite carries real gross signal on H1 (rare this session)
but its win rate sits under the cost-adjusted breakeven everywhere, in every
window, on both majors.** Same conclusion as rounds 1–9 from the opposite
direction: the strategy was designed for session-structured markets (gold,
index CFDs) and finds no habitat on 24/7 crypto at these cost bands. It stays
in the system as a permanent family — the honest next test for it is
`--asset MT5:XAUUSD` or index CFDs once a terminal syncs.

### Round 9 — 2026-08-26: taker-flow imbalance

The last free-data line that had never been asked. Binance klines publish
per-bar aggressive TAKER BUY base volume (field 9); the system fetched it
since day one and dropped it in `toCandle`. Built:

| Piece | File | What it does |
|---|---|---|
| Flow field kept | `core/strategy.ts` + `server/market.ts` | optional `Candle.takerBuyBase`, parsed when present; absence means unknown, never zero |
| Flow catalogue | `core/hypotheses-flow.ts` | 4 claims registered BEFORE scanning: `flow-thrust-3x/5x` (loud bar, >70%/<30% aggressive side continues), `flow-absorption-24` (new 24-bar low/high against the aggressive side reverts), `flow-divergence-12` (cumulative share vs price direction, fade the price) |
| Runner gating | `scripts/edgescan.ts` | flow claims join a scan only when the series actually carries the field |

Cells: {BTC, ETH, SOL, XRP} × {H1, M15} × {365d}, then the H1 cells extended
to 1500d so near-threshold rows were measured rather than imagined.

    M15: nothing survives; loudest rows NEGATIVE (BTC absorption t=−3.98,
         divergence −3.85; XRP divergence −2.23)
    H1 @365d: mostly "too few" — thrust is structurally rare hourly;
         three rows looked positive but unmeasured
    H1 @1500d: every temptation dissolved — BTC divergence +141/hold at n=88
         became −35 at n=226; SOL absorption +1.2/5-of-6 became +0.2 t=0.94
         at n=266. flow-thrust stays unmeasurable at H1 even across four
         years (fires 3–26 times), which is itself the finding: the claimed
         event barely exists at that resolution.

**Verdict: answered NO.** Aggregated taker-side volume carries no exploitable
directional information on liquid majors after costs — consistent with every
round since 1: whatever order-flow edge exists is below bar resolution or
below the cost floor. Note: live fetches now carry the field but the DB
schema still stores plain OHLCV; scans fetch fresh, stored history does not
gain flow retroactively.

### Round 8 — 2026-08-24: cross-asset lead-lag (BTC → alts)

Roadmap step 3 executed. Built the missing machinery first:

| Piece | File | What it does |
|---|---|---|
| Injected-series support | `core/edgescan.ts` | `ScanOptions.series` timestamp-aligns auxiliary candles onto the primary grid; gaps stay undefined, staleness voids signals rather than reusing old bars |
| Lead-lag catalogue | `core/hypotheses-leads.ts` | 3 claims reading an injected `btc` key: momentum-3/12 continuation, single-bar follow |
| Runner injection | `scripts/edgescan.ts` | any non-BTC exchange asset fetches BTCUSDT at the same interval and appends the 3 claims (Šidák count follows automatically) |

Tests cover paired-truncation look-ahead, off-grid/late-leader voiding, and
the no-mirror rule. 555 TS tests green.

Cells: {ETH, SOL, BNB, XRP, DOGE} × {H1, M15}, 365 days, hold 12 bars,
windows 6 — 10 cells × 35 hypotheses = 350 tests.

    H1:   every lead row between t = −1.6 and +0.4 — nothing
    M15:  ALL FIFTEEN rows NEGATIVE, t from −2.1 to −6.6, hit rates 39–43%,
          nearly all 0/6 or 1/6 windows

**Verdict: answered NO at bar scale.** When BTC has just moved, the move is
already in the alt — entering after alignment pays the full round trip for
information the alt's own price holds. The loud negative rows say alignment
is essentially instant relative to a 15-minute bar close, which kills the
arbitrage-delay story on liquid pairs at these horizons. Whatever lead-lag
exists lives below bar resolution (tick/order-flow), which is a different
instrument than this scanner.

Step 3 is CLOSED for bar-close data on liquid alts. Remaining lines: OI
archive maturation (passive), MT5 index CFDs (needs terminal sync), tick-
level flow (needs a different data path entirely).

### Round 7 — 2026-08-24: lower-liquidity books

Roadmap step 2 executed: `bun run edgescan:batch -- --top 20 --out
tmp/r7-batch-top20.json` — live top-20 by 24h quote volume × {M5, M15, M30,
H1, H4}, ≤30k bars per cell, tier-banded pessimistic costs by volume rank,
ONE shared Šidák budget across everything (now including round 6's five
operator-playbook hypotheses).

    99 scans × 32 hypotheses = 3168 tests · shared bar p < 1.619e-5 (|t| ≈ 4.3)
    2469 pairs fired ≥100 times and were judged
    SURVIVORS: none

Loudest rows, all far under the bar: TUTUSDT M5 saturday-drift (t=2.74),
TUTUSDT M15 saturday-drift (t=2.19), ENAUSDT H4 mom3-with-d1 (t=2.13),
TRUMPUSDT H1 momentum-48 (t=2.04). At 3168 tries, a handful of rows this
size is exactly what noise yields. The new playbook rows topped a few
low-cap cells (break-prior-day TUT M30 t=2.01, asian-range-breakout ADA M5
t=0.72) without approaching significance anywhere.

Step 2's answer for THIS pass: no exit from the cost floor one rank band
lower. Untried variants remain — longer horizons than H4, deeper than rank
20, and the maker-exit lens over low-cap cells specifically — but each is
another draw against the same budget, and the prior after 3800+ corrected
tests is firmly negative. Next lines stay: OI maturation (passive),
cross-asset lead-lag (needs injected-series support), MT5 index CFDs.

### Round 6 — 2026-08-24: the operator's playbooks, measured

The operator supplied two strategy documents — a Pine v6 "Trend Progression"
gold script (session-aware, composite trend score, DXY filter) and an
M15→M1 liquidity-sweep execution plan (Asian range levels, prior-close magnet,
opening stop-runs that reverse). Their mechanisms were translated into scanner
claims and REGISTERED BEFORE ANY SCAN, per the house rule:

    sweep-prior-day        wick through yesterday's UTC extreme, closing back
                           inside, reverts (the plan's §3–5 stop-run)
    asian-range-breakout   compressed 00:00–07:00 UTC range, first close
                           outside continues through London/NY (both documents)
    fade-london-drive      first hour after 07:00 UTC fades (the plan's §3)
    fade-ny-drive          same at 13:00 UTC (equities cash open)
    break-prior-day        close beyond yesterday's extreme continues —
                           registered MID-ROUND as measurement-derived, like
                           streak-fade in round 2: the zero-cost lens had the
                           fade losing gross on BTC M15, and the complement
                           entered the fixed set declared as such

Five additions take the per-cell catalogue from 27 to 32 hypotheses; every
future scan corrects for the larger set permanently.

Cells: BTCUSDT + ETHUSDT × {M15, H1}, 365 days each, hold 12 bars, windows 6,
tier costs ≈9–10 bps RT, per-cell Šidák bar p < 1.6e-3. Plus BTC H1 extended
to 1500 days so newyork/london-open-range reach MIN_OCCURRENCES (they fire
~40×/year; 365 days left them unmeasured, which is not a verdict).

    new rows, net TRAIL_SL lens (t-stat, mean pts/hold, windows):
    BTC H1   sweep −0.83 · break −0.65 · asian-arb −0.34 · ldn-fade −0.29 · ny-fade −2.45
    ETH H1   sweep −0.20 · break −0.80 · asian-arb −0.47 · ldn-fade +0.86 (5/6!) · ny-fade −2.34
    BTC M15  sweep −4.37 · break −2.73 · asian-arb −1.93 · ldn-fade −3.36 · ny-fade −1.66
    ETH M15  all five between −0.11 and −2.44
    SURVIVORS: none in any cell

Investigated before filing under noise:

- **ETH H1 fade-london-drive** (+3.5 pts/hold, 5/6 windows) flipped to gross
  NEGATIVE over a 400-day window. Not robust across window length; dropped.
- **newyork-open-range** was gross-positive on BTC at both timeframes over
  365 days — the plan's own NY-window mechanism, tantalizingly unmeasured.
  At 1500 days (n=147) it scored t = −0.73, 3/6 windows. Window artifact.
- **Zero-cost decomposition** (all 32 × all 4 cells):
  ETH: |gross| ≤ 7 pts everywhere — no information present, cost model
  irrelevant. BTC M15: best gross +46 pts against a ≈53 pt maker floor —
  costs exceed every edge, so no parameter choice can rescue any row.
  BTC H1: a maker-exit-positive cluster exists (streak-fade-5 +99, quiet-trend
  -p50 +30, momentum-48 +23, fade-london-drive +15 pts/hold) — this is round
  4's mirage reproduced exactly, and its flagship member already died under
  real exits in round 5.

**Verdict: the operator's three mechanisms carry no measurable directional
edge on liquid crypto majors after real costs.** "Fine-tuning" here would be
fitting noise: on BTC M15 the gap between best gross expectancy and the cost
floor is arithmetic, not calibration. The strategies' native habitat — where
session structure and thin opens are real market structure rather than
analogy — is index CFDs (DAX, UK100, NAS100) and FX majors over MT5;
`bun run edgescan -- --asset MT5:DAX40` judges them there once a terminal
syncs those symbols. Crypto-side live lines are unchanged: OI archive
maturation, then lower-liquidity books.

### Round 5 — 2026-08-24: momentum-48 meets a real exit

`bun run momentum48-test` backtested the round-4 pattern with the live
engine's actual exit geometry (ATR stop, TP1 limit at 1.2R, breakeven move,
trail) over three chronological windows on both assets, with lookback 24 as
control and pooled binomial significance against each result's own
breakeven. Guards were stated before the run.

    BTCUSDT H1: lb48 net NEGATIVE in all three windows (−5.8k / −12.7k / −3.0k);
                pooled p = 0.78
    ETHUSDT H1: +614 / −1053 / +431 — incoherent; pooled p = 0.54
    control lb24 on both: nothing significant either

**The line is closed.** The fixed-bar scan flattered momentum-48 precisely
the way core/edgescan.ts's header warned it might: without a stop, holds
that would have been stopped out keep their open loss off the books, and a
fixed-hold mean cannot see that shape. Given real exits, the pattern dies.
PRICE-ONLY ENTRY EDGES ON MAJORS ARE NOW MEASURED TO EXHAUSTION AND CLOSED:
five rounds, ~700 corrected scan tests plus this exit test, zero survivors.

What remains open is in §"Where opportunity can still be" below.

### Round 4 — 2026-08-24: the cost-sensitivity pass

Question: how much of the catalogue's apparent death is the exit's price
tag rather than absent information? `bun run cost-sensitivity` runs every
hypothesis over identical bars at three lenses — zero cost (gross signal),
maker exit (entry crosses, exit fills as a resting limit, the live TP1's
treatment), and the standing full-cost pessimism. Same tests each time, so
no extra testing budget is spent; each lens corrects for its own set.

BTCUSDT H1 (400d) and ETHUSDT H1:

    BTC: 21 of 27 judged → 6 positive after a maker exit · 3 gross-positive
         but dead even at maker costs · 12 carry nothing at all
    ETH: similar shape; nothing survives significance under any lens

The one pattern worth carrying forward is **momentum-48** (48-bar momentum
continuation):

    BTC  maker +25.5/hold  n=794  windows 5/6   gross +81.5/hold
    ETH  maker +2.1/hold   n=794  windows 4/6   gross +4.0/hold

Positive expectancy after realistic best-case exits on both assets, majority
of windows positive on both — but it does NOT clear the Šidák bar under any
lens, so it is a candidate for the next measurement, not a finding. The
honest next step is the one the scanner always names: give momentum-48 a
real exit (runBacktest with ATR stop + limit take-profits) and see whether
the edge survives contact with an actual trade shape. That test costs
nothing in discovery budget because it is not another scan.

Also confirmed: the maker-vs-full gap on these tiers is small (~0.5 bps);
the decisive gap is between zero and any cost (~5–7 bps). Exit engineering
matters less than entry selection here — which is why the nulls above stand.

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

1. **OI archive maturation.** Recording since 2026-08-24; at ~2 months of
   history `bun run edgescan:positioning` measures the oi-* hypotheses for
   the first time. No action needed except letting the server run. This is
   now the only live line on liquid majors.
2. **Lower-liquidity books, longer horizons.** ANSWERED for rank ≤ 20 ×
   M5–H4 (round 7): nothing survives. Deeper ranks or longer bars are new
   draws against the same budget.
3. **Cross-asset lead-lag** — ANSWERED NO at bar scale on liquid alts
   (round 8); alignment is faster than a bar close. Tick-level flow would
   need a different data path; machinery (`core/hypotheses-leads.ts` +
   series injection) stays for any future partner series.
4. Whatever survives then graduates to a scoring family via the
   quiet-trend path (argue mechanism → normalize points → thresholds →
   discovery search space → three-window validation).

Closed for good unless a NEW mechanism arrives: price-only entries on
liquid majors (rounds 1–5), funding-level fades (round 3), level-sweep
reversal, compressed-Asian-range breakout and opening-drive fade on majors
(round 6), bar-scale lead-lag on liquid alts (round 8), taker-flow imbalance
from kline aggregates (round 9). The catalogue claims stay registered;
re-testing them needs a new argument, not a new parameter. Re-opening any of
these requires registering the new claim BEFORE scanning.

## Rerun commands

```bash
bun run edgescan -- --asset ETHUSDT --interval 1h --days 180   # single asset
bun run edgescan:batch -- --out tmp/edgescan-batch.json        # price matrix
bun run edgescan:positioning -- --asset BTCUSDT --interval 1h  # + funding/OI
bun run cost-sensitivity -- --asset BTCUSDT --interval 1h      # exit-cost lenses
bun run momentum48-test                                        # real-exit gauntlet
bun test core/__tests__/hypotheses-crypto.test.ts              # catalogue tests
bun test core/__tests__/hypotheses-positioning.test.ts         # positioning tests
```

Rules this work obeys: the catalogue is fixed and named; every addition
stays registered whatever it scores; the Šidák correction counts true total
attempts across the whole matrix; nulls are reported as results.
