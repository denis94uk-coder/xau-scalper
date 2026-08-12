# Contributing to XAU Scalper

Local-first, single-process trading dashboard. TypeScript carries the app
(strategy, engine, API, UI); Python is an optional forecasting sidecar.

## Prerequisites

- **Bun** for the TypeScript app: https://bun.sh
- **Python ≥ 3.10** and `venv` for the Teo sidecar (optional)

## TypeScript app

```bash
bun install
bun run build        # typecheck (tsc -b --force) + UI build into dist/
bun run start        # http://127.0.0.1:4000
```

Quality gates (all run in CI-equivalent locally):

| Command | What it does |
|---|---|
| `node ./node_modules/typescript/bin/tsc -b --force` | Full typecheck across UI, server, core, scripts. |
| `bun test core server` | 254 unit tests for the strategy core and server. |
| `bun run check` | Biome lint + format. |

> `bun run typecheck`/`build` wrap `tsc`/`vite`; if your environment reports
> "error loading current directory", invoke `tsc` directly as shown above —
> the code is fine, the wrapper is environment-sensitive.

## Python sidecar (optional)

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest
```

The sidecar is **not** part of the packaged binary. Kronos (PyTorch) is the
only part that truly needs Python; regime/sweep/self-heal run in TypeScript.

## Architecture rules

- **One strategy core.** `core/` is framework-free and shared by the server,
  CLI tools and tests. Never reimplement an indicator or the signal logic
  elsewhere — the whole point is that live and backtest can't drift. UI chart
  maths in `src/lib/indicators.ts` is deliberately an exact copy of
  `core/strategy.ts`; the `indicatorDrift` test pins that.
- **Server-side truth.** P&L and win/loss are derived from stored data, never
  trusted from a client. Keep it that way at any trust boundary.
- **Append-only audit.** Every signal and exit is journaled before its outcome
  is known. Don't overwrite journal rows.
- **No secrets in git.** `.env.local` is gitignored. A secret-free
  `.env.example` documents every variable. If you add an env var, add it there.
- **Lazy by default.** The smallest change that works. No new abstractions for
  a single use, no new dependencies for what stdlib/a helper already does.

## Pull requests

- Keep the test suites green (TS + Python where touched).
- Document anything user-facing in `README.md` (architecture, API, known
  limitations).
- Don't commit `.env.local` or any credential. Rotate and report leaked keys
  immediately (see `SECURITY.md`).
