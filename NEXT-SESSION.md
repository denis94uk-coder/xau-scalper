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
