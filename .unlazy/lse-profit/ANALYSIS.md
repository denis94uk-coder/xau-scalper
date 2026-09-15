# LSE unprofitability — deeper analysis (2026-09-11)

Scope: week Mon Sep 7 00:00 UTC → Fri Sep 11 (~18:00 UTC), plus full-history
per-strategy. All figures re-measured from `data/teo.db`, closed ideas only
(`STOPPED`/`TP2_HIT`/`EXPIRED`, `pnl_points IS NOT NULL`).

## Week per book (equal-weight % = Σ pnl/entry)

| book | closed | W/L/scratch | net pts | net % | TP2 |
|---|---|---|---|---|---|
| top10 | 256 | 107/145/4 | +5510 | +32.6% | 45 |
| experimental | 62 | 24/37/1 | +55 | +1.3% | 13 |
| engine | 83 | 24/51/8 | −345 | +5.2%* | 18 |
| lse | 153 | 36/77/40 | −14883 | −43.2% | 0 |

*engine points are BTC-dominated; per-trade % is positive. Points can't be
summed across assets — % is the comparable unit.

## LSE full history per strategy (closed)

| asset · strategy | n | W | net | avg win | avg loss | breakeven WR needed |
|---|---|---|---|---|---|---|
| BTCUSD mom@1h | 10 | 0 | −11761 | — | −1176 | — (0 TP1 hits) |
| GER rev@30m | 26 | 6 | −1711 | +37 | −102 | 73% (has 23%) |
| GER rev@15m | 35 | 6 | −655 | +14 | −53 | 79% (has 17%) |
| GER mom@30m | 56 | 24 | −439 | +51 | −103 | 67% (has 60% decided) |
| FTSE rev@1h | 19 | 0 | −248 | — | −23 | — |
| XAU fallback breakout | 3 | 0 | −104 | — | −52 | — |
| XAU discovered breakout@1h | 3 | 2 | +45 | +52 | −60 | green shoot, n=3 |
| XAGUSD mom@1h | 6 | 0 | −9 | — | −1.5 | — |

## Findings

1. **R:R inversion is the core disease.** Every LSE strategy's avg loss is
   2–4× its avg win (wide 3.1–3.4×ATR stops, close 0.68–1.9R TP1s shrunk
   further by the 0.7× regime factor). Required win rates of 67–79% are
   unreachable; the best strategy has 60%. Negative expectancy by design.
2. **Regime scaling was never validated** (fixed this pass: `server/lse-engine.ts`
   now trades 1×/1×, regime kept as reason-tag context). The RANGING fallback
   (0.8×/0.7×, derived from PAXGUSDT 15m, confidence 45 "no clear trend") was
   applied to DAX/FTSE/BTC/XAG alike. Bypass widens TP1 ~43% and SL 25%
   toward the validated geometry.
3. **p≈0 adoptions = overfit signature.** Both GER reversions (adjustedP
   exactly 0.0 — underflow, not a measurement) and FTSE (p=1.2e-9) went
   0–30% win live. Recommend walk-forward + min-trades re-tune before any
   re-adopt; treat exact-0 p-values as a block signal in the adopt path.
4. **BTCUSD: no edge at this horizon + duplicate stacking.** 0 TP1 hits in 10;
   four parallel SHORTs (Sep 10, 13:47–14:22) stacked pre-anti-pyramid into one
   reversal. Vault BTC feed ≠ Binance; momentum lookback-42/1h not transferable.
5. **XAU double-carpet.** Fallback `custom` + discovered `breakout` both @1h
   fired simultaneously (cannibalism). Discovered leg is the only green shoot
   book-wide (+45, n=3) — candidate for solo re-enable once n grows on paper.
6. **Scratch factory: 26% vs top10 1.6%.** TP1 too close + no partial banking
   (final pnl overwrites the TP1 mark-to-market; 40 scratches gave it all back).
   Next lever: re-tune tp1R via discovery grid, or bank half at TP1 (shared
   `applyPrice` change — affects all books, separate proposal).
7. **GER LONGs bleed, SHORTs ~breakeven.** Momentum LONG 2/8 (−355) vs SHORT
   22/48 (−84); reversion LONGs carry most of the −2200. No direction toggle
   exists per strategy — sample too small (8) to justify building one. Watch
   item: if LONGs stay red over the next 30 closes, add a long/short toggle.
8. **Costs are not the driver.** GER spreadBps 3.0 vs ~50–100pt stops; the loss
   is R:R geometry, not spread.

## JST fade experiment (2026-09-13)

Mirrored all 196 closed JST ideas (30d) around entry, replayed stored 5m
bars via `applyPrice` on a DB copy (`.unlazy/lse-fixes/flip-jst.mjs`):
originals −7.56% → mirrored **−22.50%** (14W/88L, 64 scratch-trapped,
23 no-touch). Fading loses 3× more — the bleed is structural (exit geometry
+ churn), not directional. JST paused engine-side; top10 already excludes it
on lifetime PF.

## State after this pass

- Paused (disabled, reversible): BTCUSD, XAGUSD, FTSE, XAUUSD (both legs),
  GER rev@15m + rev@30m. Backup: `tmp/lse-strategies.backup-*.json`.
- Trading: GER mom@30m only. 8 open ideas (incl. paused-strategy legs) stay
  monitored to exit — monitor is strategy-independent, nothing stranded.
- 14 dirty-tree files (anti-pyramid, market fallback, paper-collect) NOT
  committed by this pass — separate decision.
