# Instructions for the next session

Written 2026-08-12. Read this top to bottom before touching anything.

## DIRECTION CHANGE — 2026-08-23

The operator's decision: **all new work targets crypto** (BTC, ETH, and the
liquid top-100 on Binance's free feed). The traditional/MT5 side is kept
working but quarantined under the sidebar's "Experimental" group — maintain,
do not extend. Concretely so far:

- `core/assets.ts` ships ~50 curated crypto assets (tiered cost estimates).
- `scripts/top-assets.ts` merges the live top-N by 24h quote volume into the
  stored config; re-run it periodically, rankings drift.
- MT5 remains the only live-execution path. If live crypto trading is wanted,
  a Binance execution path must be built first.

## Sweep + adoption — 2026-08-24

- Full batch discovery ran on real Binance data (44 assets × 300 configs ×
  all 5 models, 15m, 365d, seed 42): **0/44 qualified**. Honest null — the
  dominant verdict was `failed_validation`; BTC's best passed all three
  windows plus walk-forward but p=0.94–1.0 after Šidák. The breakout and
  momentum families trade and reach top-10 but found nothing defensible.
- The gate is provably passable: the Carpet holds 5 pins (4 unique, all
  `combined`) from 2026-08-23 pre-commit runs — BTCUSDT, XRPUSDT, RUNEUSDT,
  GRTUSDT (p 0.017–0.046, 11–30 test trades).
- Operator chose adoption: all 4 winners merged into the live config with
  the same semantics as `--adopt` (model=combined, config wholesale per
  asset; RUNE/GRT remain disabled). DB backup in `tmp/teo.db.backup-*`.

## Opportunity engine — 2026-08-24 (later)

Built to widen the search beyond existing indicator families; full record,
numbers and next steps live in **`ROADMAP-CRYPTO.md`** — read that before
touching hypotheses or scans. Short version:

- New: `core/hypotheses-crypto.ts` (11 crypto-native claims),
  exchange-fed `scripts/edgescan.ts` (`--asset BTCUSDT`), and
  `scripts/batch-edgescan.ts` (`bun run edgescan:batch`) which scans the
  live top-N by volume × five timeframes under ONE shared Šidák budget.
- Two full matrix runs (625 then 675 corrected tests, top-5 × M5–H4):
  **nothing survived**. Decomposition showed gross predictability ≈ 0 on
  BTC M5 (zero-cost rerun t≤0.91); the loud negative rows are purely the
  ~13 bps round-trip cost floor, not hidden signals.
- Consequence for new work: price-only entry edges are measured to
  exhaustion on majors at these horizons. The ranked next steps are in
  ROADMAP-CRYPTO.md §"Where opportunity can still be" — funding/OI feeds
  first, maker-exit cost sensitivity second.
- Round 3 (positioning) also ran: `server/market-futures.ts` +
  `core/hypotheses-positioning.ts` + `bun run edgescan:positioning`.
  `funding-extreme` is measured and answered NO (negative on BTC and ETH,
  both horizons). OI hypotheses are unmeasurable until we archive OI
  ourselves — the venue serves only ~30 days of history.
- The OI archive is now BUILT and LIVE (`server/intel/oiRecorder.ts`):
  every 15m the running server samples perp open interest into
  `oi_snapshots` for all enabled binance assets. First tick archived
  42 × 500 rows. In ~2 months `bun run edgescan:positioning` measures the
  oi-* hypotheses for the first time. Nothing to do but let it run.
- Round 4 (cost sensitivity, `bun run cost-sensitivity`): maker-exit vs
  full-cost lenses over the whole catalogue. Nothing survives significance
  under any lens, but **momentum-48** is positive after a maker exit on
  BOTH BTC and ETH H1 (5/6 and 4/6 windows). It was the single remaining
  price-only lead.
- Round 5 (`bun run momentum48-test`): momentum-48 with REAL exits —
  dead. BTC negative in all three windows; ETH incoherent; pooled p=0.78 /
  0.54; control lookback also nothing. The fixed-bar scan had flattered it
  exactly as core/edgescan.ts's header warned. PRICE-ONLY ENTRIES ON MAJORS
  ARE CLOSED. The only live line on liquid majors is the OI archive
  maturing (~2 months); then lower-liquidity books and lead-lag. Full
  record: ROADMAP-CRYPTO.md.

## NEW GOTCHA — the dev server runs with --watch

A `bun run --watch server/index.ts` process is often alive in another
terminal. Editing any file under `server/` makes bun hot-reload THAT REAL
SERVER against the real `data/teo.db` — top-level jobs (signals, monitor,
self-heal, the OI recorder) fire immediately. This is how the first OI
archive tick happened without anyone starting anything. Before assuming a
script or test wrote something surprising, check for a live watch process:
`ps aux | grep "watch server"`. The MT5 guard does not cover this path.

## Where things stand

The build is finished and green. Do not restart the project or "improve" it broadly.
There are exactly two open items, and **neither of them is code**.

- Repo: `/Users/denisteodorbobocea/Documents/GitHub/xau-scalper`
- Branch `main`, clean tree, **0 unpushed**, HEAD = `36b0269`
- `origin` = `https://github.com/denis94uk-coder/xau-scalper.git` (the user's fork)
- `upstream` = `https://github.com/donnnod/xau-scalper.git`
- CI run `31603361614` is **success** on both jobs (`py`, `ts`)

Verified working: 373 TS tests + 104 Python tests (3 skipped), typecheck clean, build
clean, double-clickable `.app` launches and is configurable with no code editing, and
the README headline claim was reproduced against 10,000 real bars from the user's own
MT5 terminal (0.50bps spread → TP1 breakeven 83% → 47.4%).

## Environment gotchas that cost time last session

1. **`gh` is not on PATH.** Use `~/.local/bin/gh`. It is logged in via device flow with
   `workflow` scope. There is no brew, no SSH key, no keychain entry.
2. **Python on PATH is 3.9**, but the project needs >= 3.10. Use `python3.11` (at
   `~/.local/bin/python3.11`). A venv already exists at `.venv` (3.11, gitignored) with
   dev deps installed. Run Python tests as `.venv/bin/python -m pytest tests/`.
3. **Always run `bun run check` before pushing.** CI runs Biome and it failed on 30 lint
   errors that `bun run test` does not catch. `bun run format` fixes them.
4. **Some tests only pass because `bun` is on PATH locally.** CI's Python job now installs
   bun. If you add bridge tests, gate them with the `requires_bun` marker.
5. **`bun run package -- --target darwin-arm64 --app` REPLACES `release/xau-scalper`.**
   Rerun plain `bun run package` to get the CLI binary back. Right now `release/` holds
   the CLI binary, not the `.app`.
6. **Never let the suite touch the real MT5 terminal.** `src/__tests__/mt5-guard.ts` is a
   preload (wired in `bunfig.toml`) that pins `TEO_MT5_DIR` to a nonexistent path using a
   `process.env` Proxy, so even `delete` restores the guard. A stray history request was
   once written into the user's live terminal. If you touch MT5 discovery or env handling,
   re-verify `requests/` stays empty after a full suite run.

## Item 1 — Rotate the leaked credentials — CLOSED 2026-08-26

Operator's verdict: these credentials belonged to the **old development
phase** (the upstream project this was forked from). The current system runs
**locally and fully independently** — no Convex, no Viktor Spaces, no external
deployment — so the leaked blobs are dead secrets for this codebase. Nothing
to rotate. Do not reopen.

## Item 2 — Fill one order on a DEMO account — CLOSED 2026-08-26

Operator's verdict: a leftover from the **old development** phase. The system
is now local and fully independent; live MT5 execution is not part of the
current plan. No demo fill is needed. Do not reopen.

## Known gap the agent cannot close alone

In-browser click-through was never done because the Firefox bridge extension needs a
human click: `about:addons` → gear icon → Install Add-on From File →
`~/.jcode/browser/browser-agent-bridge.xpi`. Ask the user to do this once if browser
automation is needed; otherwise it is not blocking anything.

## Working agreements with this user

- Wants something **simple that actually works**: open the UI, configure it, no code edits
- Publicly advertised features must be genuinely reachable — verify claims against real
  CLIs and real data, do not take the README's word for it
- Split work into micro tasks
- Defaults must reproduce old behaviour exactly
- Validation returns **every** problem at once for per-field display; config is replaced
  wholesale, never partially
- Discovery uses a three-way split with multiple-comparisons correction and presents null
  results honestly
- Commit as you go

## Sanity check to run first

```bash
cd /Users/denisteodorbobocea/Documents/GitHub/xau-scalper
git status --porcelain && git log --oneline -1
bun run test && bun run typecheck && bun run check
.venv/bin/python -m pytest tests/ -q
~/.local/bin/gh run list -R denis94uk-coder/xau-scalper --limit 1
```

Expect: clean tree at `36b0269`, 373 TS tests pass, 104 Python tests pass, no lint
errors, latest CI success. If all of that holds, go straight to Item 1.

---

# SESSION LOG — 2026-09-04 (audit → journal rescues → go-live reliability)

Backup before everything: branch+tag `backup/pre-audit-20260903-225317`
(intact). DB rescue dump: `tmp/teo.db.backup-20260904-journal-rescue` (875M,
pre-cleanup). All pushed to `jcode` remote
(`https://github.com/denis94uk-coder/Jcode-xau-scalper.git`, branch `main`).

## 1. End-to-end audit + critical fixes (`83c7a54`)
- `scripts/lse-per-asset-tune.ts`: RELAXED fallback adopted non-significant /
  failed-walk-forward strategies to the live store under plain `--adopt`.
  Now requires explicit `--adopt --adopt-relaxed`, tags entries
  `relaxed`+`verdict`. Fixed `sanitizeCandles` (off-by-one median, close-only
  check → close/high/low true median + loud warnings).
- `core/config.ts`: validator rejected legal `dataSource: "lse"`.
- `server/api.ts`: manual-trade creation had no range/geometry checks (now
  `entryPrice/lotSize/exitPrice > 0` + directional SL/TP, 422 on inversion).
- `server/reconciliation.ts`: strict `<`/`>` left price-exactly-at-level
  ghosts open forever (now `<=`/`>=`).
- `server/lse-engine.ts` + `server/top10.ts`: daily breaker used LOCAL
  midnight vs RiskManager UTC (now UTC) + NaN/Infinity `entry_price` guard.
- `src/components/ErrorBoundary.tsx`: full `error.stack` rendered to users
  (now message-only in prod, stack in DEV).
- `server/index.ts`: loud `[security]` warning on non-loopback bind;
  `publish("regime")` moved inside `safely()`.
- Downgraded non-issues with evidence: no SQL injection (all bound), no CORS
  headers at all, path traversal mitigated, no hardcoded secrets. Open item:
  secrets once committed in git history still need rotation by operator.

## 2. Same-numbers-across-books (`cde7898`)
- Root cause: `TradingIdeasPage` fetched per-`source` but never declared
  `source` in `useLive` deps; router reuses the instance across
  `/ideas`→`/top10/ideas`→`/lse/ideas`, so every book showed the first-loaded
  book. Fixed with `[source]` dep. Server/DB filtering verified correct.
- Lesson learned twice: the server serves prebuilt `dist/` — **frontend
  fixes are invisible until `vite build` reruns AND the browser takes the new
  shell** (SPA clicks never refetch index.html; SW kept the old bundle
  alive). Bumped SW `v1`→`v2` to force migration.

## 3. Journal corruption rescue (300k bogus rows)
- Sep 3, 21:15–21:28: first LSE vault-monitor run replayed an unbounded
  vault fetch with no resolved-guard → 300,007 duplicate `SL_HIT` rows for
  ideas 291/292/297 (~400/sec). `e359261` fixed the loop 1 min later; rows
  stayed and poisoned every journal number (SL Hits showed 300,258 vs 137
  real signals).
- Deleted 300,006 bogus `SL_HIT` + 3 `TP1_HIT` dupes (+3 journey dupes),
  kept 291's one legitimate scratch exit. 292/297 correctly remain ACTIVE
  (false stops on garbage data). Journal: 489,559 → 189,602 rows.
- Hardened: LSE monitor loop tracks refreshed state; `applyPrice` exits now
  carry `source: idea.source` (LSE/top10 exits previously inflated engine
  counts); `/api/journal/counts` allowlist extended to top10/lse.

## 4. EXP journal zeros
- Causes: exits logged as `engine` (fixed in §3), `generateExperimentalSignal`
  never wrote `ENGINE_RUN` (heartbeat added), 188 history rows reattributed
  to `experimental` by idea-book join. EXP now reads ~138 signals / 65 TP /
  89 SL / ticking runs. "Signals" (136) is a row count incl. 36 legacy
  duplicate signal rows for the same 100 ideas.

## 5. Server restarts (operator-approved)
- Old server (Sep 3 21:26, no `--watch`) replaced twice to activate fixes:
  `kill <pid>` (graceful, WAL checkpoint) + `bun ./server/index.ts`
  (direct binary — the `bun run` wrapper intermittently fails in this shell
  with `CouldntReadCurrentDirectory`). Same pattern if needed again.
- NOTE: `bun run` wrapper broken in the agent shell only; direct
  `./node_modules/.bin/tsc|vite|biome` + `bun test` all work.

## 6. Performance Daily/Total % (`cde7898`)
- Performance page grid leads with Daily P&L % (local midnight, same rule as
  Ideas + calendar) and Total P&L %, both honoring asset+source filters.

## 7. LSE strict per-asset book (`5de6175`, `09e5265`)
- New `GET /api/lse/universe` + LSE page "Assets under LSE" board (12
  instruments, strategy/p/status/open each). Live: XAUUSD breakout@1h,
  FTSE + GER reversion@1h TRADING; NAS100 BLOCKED (p≈1.0, was live);
  UK100→FTSE, DE30→GER ALIAS mirrors; rest NO EDGE.
- `strategyIsQualified` gate in `lseStrategyFor` (p≤0.05, no relaxed/failed
  verdict); one-trader-per-underlying in signal + monitor universes (legacy
  alias positions stay monitored). 9 new tests.

## 8. Go-live reliability pass (`0807118`, 613→620 tests green)
- Backend: one-book `/api/portfolio` (positions+correlations+evidence share
  the filter); monitor covers disabled-asset orphans (registry fallback +
  warn); reconciliation covers LSE via vault bars; `applyPrice` re-reads the
  row (concurrent-tick double-exits closed); prune/intel/midnight timers
  guarded; signal health fails when all assets fail; `/ideas/open` +
  `/journal/counts` honor/validate filters. New `reconciliation.test.ts` (4)
  + API filter tests (3).
- Frontend: `++x%` signs fixed; TP1 legs no longer counted closed;
  null-PnL rows never phantom losses; `%` sums no longer labeled `pts`
  (Calendar/Top10/LSE); PF null → `∞` (not `0.00`); Performance cards honor
  the source toggle (derived from filtered view); R:R + entryPrice guards;
  EXP ideas server-side source filter; no silent asset substitution;
  ticker sub-cent precision; BID/ASK/SPREAD marked indicative*; RM $ labels.
- Repo: 5 wrongly-tracked `tmp/` files untracked (stay on disk).
- Deliberately deferred: scratch-0-as-loss (moves all win rates — operator
  call), shared risk kill-switch across books, top10-vs-performance win-rate
  definitions, unknown-param 400s, source-file/dep deletions (dead list
  ready: framer-motion, 8 components, 9 scripts — separate pass).

## Live state at log time
- Server on new code, health OK, 13 open (2 exp + 4 LSE + 5 top10 + engine).
  Books pure: engine 131 / top10 93 / lse 5 / experimental 102.
- Open question from last check: main `engine` book holds few/no open
  positions — everything open sits in satellite books.
- UI requires FULL browser reload (new bundle) — in-app clicks keep old JS.

## 9. Frontier discovery + adoption (10y window, seed 42, 800+400)
- General sweep over the six non-trading assets, 10y (`--days 3650`) per
  operator direction (modern economy only). Full log: `tmp/tune-frontier.log`.
- SURVIVORS (strict): XAGUSD momentum@1h (PF 1.76, 165tr, p=0.0075 raw →
  p=0.00015 refined, 3/4 folds) and BTCUSD momentum@1h (PF 1.22→1.28,
  284tr, p=0.0385→0.0093 refined, 4/4 folds). Full-history verify: XAG
  PF 1.27/1620tr, BTC PF 1.29/1033tr.
- NULLS (honest, not adopted): EURUSD, GBPUSD, USDJPY, SPX500 — all p≈1.0;
  full-history nets 0/−1/+10/+3176 confirm noise.
- ADOPTED both (operator choice) from carpet pins 149/151 into
  `lse:strategies` — no relaxed flags. Book now trades
  XAUUSD + XAGUSD + BTCUSD + FTSE + GER; NAS100 blocked.
- DB backup pre-adoption: `tmp/teo.db.backup-20260904-adopt-xag-btc`.

## 10. FTSE/GER clean re-check (10y sanitized, seed 42)
- Log: `tmp/tune-ftse-ger-recheck.log`. FTSE: 0 qualified (relaxed only,
  p≈1.0; full-history PF 1.00, net −303 — dead flat). GER: live
  reversion@1h not reproduced; NEW momentum@30m qualified (PF 1.78, 242tr,
  p=0.032, 3/4 folds; carpet pin 153; full-history PF 1.14, net +18282).
- OPERATOR DECISION: change nothing — both live edges stay as-is.

## 11. GER adopted momentum@30m (operator reversal)
- Operator adopted carpet pin 153 (momentum@30m, p=0.032, 3/4 folds,
  confirm 1h), replacing reversion@1h. Verified TRADING live, no restart
  needed. The 3 open GER SHORTs (reversion-era) stay monitored under the
  strategy-independent monitor.
- DB backup pre-swap: `tmp/teo.db.backup-20260904-adopt-ger-mom`.
