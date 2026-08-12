# Instructions for the next session

Written 2026-08-12. Read this top to bottom before touching anything.

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

## Item 1 — Rotate the leaked credentials (do this first)

This is the only item that gets worse with time. It is dashboard work, ~15 minutes, and
the agent cannot do it alone because it needs the user's logins.

`.env.local` was committed in `e08cfc2` and is still reachable in the **public** history
of both the fork and upstream `donnnod/xau-scalper`. Deleting it (done in `b05e346`)
does not help; the blob is still fetchable via `git show e08cfc2:.env.local`. The file is
currently untracked and gitignored (`.gitignore:9`), so no new exposure is being added.

Four secrets need rotating:

- `JWT_PRIVATE_KEY` (an RSA private key — rotating invalidates existing sessions)
- `CONVEX_DEPLOY_KEY`
- `VIKTOR_SPACES_PROJECT_SECRET`
- `TEST_USER_PASSWORD`

Rotation is what actually fixes this. History rewriting is optional and mostly cosmetic:
upstream is a separate repo the user may not control, and forks/clones/caches persist.
**Do not offer history rewriting as a substitute for rotation.** If the user wants it
anyway, it is a force-push across two repos and needs explicit confirmation.

Ask the user to rotate in the Convex and Spaces dashboards; offer to update local
`.env.local` with the new values once they have them.

## Item 2 — Fill one order on a DEMO account

No order has ever been filled on a real broker account. The path is proven end to end up
to the ack (order → pending → ack, simulated EA), so this is a confidence check rather
than construction.

**Demo account only.** Do not arm a live account. Confirm with the user which account the
terminal is pointed at before arming anything.

Recall the safety design, which is intentional and must not be "simplified":
- MT5 execution is armed by a switch separate from data ingest
- Both default to off
- Execution cannot be armed while the bridge is off, enforced server-side (verified from
  both directions)

Steps: launch the app, point it at the demo terminal, enable ingest, then arm execution,
place one minimum-size order, and confirm the fill appears. Then disarm.

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
