# XAU Scalper

A local-first multi-asset trading dashboard. One process serves the UI, the API
and the signal engine; all state lives in a single SQLite file.

No hosted services, no accounts, no API keys, no deploy step. The only thing it
reaches for is public market data, which needs no signup.

```bash
bun install
bun run build
bun run start          # → http://127.0.0.1:4000
```

---

## What it does

Watches seven instruments on 5-minute bars, grades setups against a
six-indicator model, records the ones that qualify, then tracks each to its exit
(partial take-profit → breakeven → ATR trail → target or stop). Every signal and
every exit is written to an append-only journal before the outcome is known, so
performance is a record rather than a reconstruction.

**Registered assets** — `PAXGUSDT` (gold), `BTCUSDT`, `ETHUSDT`, `BNBUSDT`,
`LINKUSDT`, `AAVEUSDT`, `TAOUSDT`.

### Read this before trusting a number

`bun run edge-audit` reports, per asset, the win rate the strategy must exceed
just to break even after spread, fees and slippage. On the **built-in exchange
cost estimates** that is **69–87%**, against a gross breakeven of 45.5% — which
would make the default configuration unprofitable at TP1 no matter how good the
entries were.

**But that number is only as good as the spread it assumes**, and the built-in
figures are estimates for crypto-exchange proxies. Gold is priced from PAXGUSDT,
a token, not from a CFD broker. Sync a real MT5 account and the picture can
change completely:

```
  symbol      spread     TP1      TP2
  XAUUSD       0.72bps   48.3%   30.7%     ← a typical retail CFD spread
  (estimate)   8.00bps   83.0%   58.6%     ← what the app assumes without MT5
```

48% is a demanding but reachable bar; 83% is not. So **run `bun run mt5:sync`
before drawing any conclusion about viability** — see [MetaTrader 5](#metatrader-5).
The estimates are the pessimistic case, not the truth about your account.

What has not changed: nothing here has been validated against live results.
There is no forward-test record, and the strategy has never been shown to beat a
null hypothesis.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  bun run start   —   one process                     │
│                                                      │
│  Bun.serve ──┬── /            built React UI         │
│              ├── /api/*       REST                   │
│              └── /api/events  SSE (live updates)     │
│                                                      │
│  timers   ──┬── monitor  60s   open positions        │
│             ├── signals   5m   generate signals      │
│             ├── intel    15m   regime/macro/news     │
│             └── prune     6h   journal retention     │
│                                                      │
│  bun:sqlite ──── data/teo.db                         │
└──────────────────────────────────────────────────────┘
             ▲                          │
             │ same SQLite file         │ public market data
             │                          ▼
┌────────────────────────┐      data-api.binance.vision
│  teo/  (Python)        │      query1.finance.yahoo.com
│  forecasting, sweeps,  │      (keyless, no account)
│  self-heal proposals   │
└────────────────────────┘
```

**Why one process:** the machine hosting this can sleep. On startup the engine
replays candles elapsed since its last run and resolves exits at the bar that
actually hit them, rather than comparing open positions against the current
price — which would either miss a stop that was hit and recovered, or book it at
a price that never existed.

---

## Layout

| Path | What lives there |
|---|---|
| `core/` | Strategy, indicators, asset registry, backtest replay, cost model, regime tagging, parameter sweep, self-heal decision. No framework imports — shared by the server, the CLI tools and the tests. |
| `server/` | HTTP + SSE, SQLite layer, signal engine, scheduler. |
| `server/intel/` | Regime, macro correlation, news calendar, liquidity sweeps. |
| `src/` | React UI (Vite, Tailwind, shadcn/ui). |
| `scripts/` | Backtest, batch scorer, edge audit. |
| `teo/` | Python sidecar: Kronos forecasting, parameter sweeps, self-heal. |
| `tests/`, `core/__tests__/`, `server/__tests__/` | 102 TypeScript + 89 Python tests. |

---

## Commands

### Running

| Command | What it does |
|---|---|
| `bun run start` | The app. UI + API + engine on `127.0.0.1:4000`. |
| `bun run serve` | Same, with `--watch` for development. |
| `bun run dev` | Vite dev server for UI work only — needs `bun run start` alongside for data. |
| `bun run build` | Typecheck then build the UI into `dist/`. |
| `bun run package` | Compile a standalone executable into `release/`. Bundles the Bun runtime, server and strategy — no Node, no `node_modules`, nothing to install. |
| `bun run package -- --target darwin-arm64 --app` | Build a double-clickable `XAU Scalper.app`. |

### Desktop app

`bun build --compile` produces one executable containing the runtime, the
server and the whole strategy. The built UI ships beside it, because a compiled
binary resolves `import.meta.dir` into a virtual filesystem that holds no assets.

```bash
bun run build
bun run package -- --target darwin-arm64 --app
open "release/XAU Scalper.app"
```

The bundle starts the server, waits for it to answer, then opens the dashboard
in your default browser. It is deliberately not a webview wrapper: the UI is
already a web app, so embedding a second rendering engine would add ~100 MB and
a class of bugs for no gain. `LSUIElement` keeps it out of the dock.

Data lives in `~/Library/Application Support/XAU Scalper/`, not inside the
bundle — bundles can be read-only and are replaced wholesale on upgrade.

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
`windows-x64`. Cross-compiling works, but a binary built on another platform
cannot be run or signed there — verify on the target machine. macOS will refuse
an unsigned bundle that arrived from elsewhere; built locally it just runs.

**Python is not required for the app.** The server, strategy, engine, backtest
and cost model are all TypeScript and compile into the binary. `teo/` is an
optional sidecar — see below for what actually still needs it.

### Analysis

| Command | What it does |
|---|---|
| `bun run edge-audit` | Cost-adjusted breakeven win rate per asset. Pure arithmetic on the strategy's own geometry — no backtest, so no sample can flatter it. `-- --atr 0.15` to assume a livelier bar. |
| `bun run backtest -- --asset BTCUSDT --from 2024-01-01 --to 2024-06-01` | Replay history through the real strategy. Reports net of costs, plus expectancy per trade and the breakeven rate. |
| `bun run score` | Batch config scorer. Reads a JSON job on stdin, scores N configs over one candle window, writes JSON to stdout. This is what Teo's sweep calls, so it optimises the *real* strategy rather than a re-implementation. |

```bash
# score three configs, with a 70/30 in-sample / out-of-sample split
echo '{"symbol":"BTCUSDT","interval":"5m","lookback":1000,"splitRatio":0.7,
       "configs":[{},{"atrSlMultiplier":2.0,"tp2R":3.5},{"atrSlMultiplier":1.0}]}' \
  | bun run score
```

Config entries are **partial overrides** merged onto the asset's own
`StrategyConfig`. Unknown keys are rejected rather than ignored — silently
dropping them is how a sweep ends up reporting that it tuned a knob it never
applied.

### Quality

| Command | What it does |
|---|---|
| `bun run typecheck` | `tsc -b --force` across UI, server, core and scripts. |
| `bun test core server` | 102 tests. |
| `bun run check` / `format` | Biome lint + format. |
| `.venv/bin/python -m pytest` | 89 Python tests. |

---

## HTTP API

Served on the same origin as the UI. No authentication: the server binds to
`127.0.0.1`, so the only callers are processes on this machine.

### Reads

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/health` | Engine liveness, open position count, last run timestamps. |
| `GET` | `/api/assets` | The asset registry. |
| `GET` | `/api/ideas?asset&limit` | Signals, newest first, each with its journey events. |
| `GET` | `/api/ideas/open?asset` | Positions still being tracked (`ACTIVE` + `TP1_HIT`). |
| `GET` | `/api/ideas/:id` | One signal with its events. |
| `GET` | `/api/journal?asset&limit` | Audit trail. |
| `GET` | `/api/journal/counts` | Row counts by event type (a SQL aggregate, not a table read). |
| `GET` | `/api/performance?asset` | Per-asset stats: win rate, expectancy, streaks, profit factor. |
| `GET` | `/api/candles?asset&interval&limit` | Stored OHLCV from the database. |
| `GET` | `/api/klines?symbol&interval&limit` | Live OHLCV proxied from the venue. Serves intervals the engine does not persist (1m, 3m); the browser cannot call the venue directly because of CORS. |
| `GET` | `/api/prices?symbols` | Batched 24h ticker. One upstream request for all symbols. |
| `GET` | `/api/state/:key` | Intel engine output — `marketRegime`, `macroState`, `newsShield`, `liquiditySweeps`. |
| `GET` | `/api/events` | SSE stream. Pushes `{kind}` on change; clients refetch. |

### Writes

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/ideas` | Log a signal by hand (`source: dashboard`). |
| `DELETE` | `/api/ideas/:id` | Remove a signal. Journal rows survive as orphans — an audit trail that vanishes with its subject is not an audit trail. |
| `POST` | `/api/trades` | Open a manual trade. |
| `POST` | `/api/trades/:id` | Close at `exitPrice`. **P&L and WIN/LOSS/BREAKEVEN are derived server-side** from the stored entry; the caller does not get to state the result. |
| `DELETE` | `/api/trades/:id` | Remove a manual trade. |
| `GET` | `/api/trades/stats` | Aggregate manual-trade performance. |
| `POST` | `/teo/propose` | Teo forward-test entry, recorded before the outcome is known. |
| `POST` | `/teo/decision` | Teo self-heal decision. Append-only — it never applies a config change. |

Set `TEO_SHARED_SECRET` to require a matching `x-teo-secret` header on the two
`/teo/*` routes. The server binds to localhost, so a local process is already
the only possible caller; the secret matters if you ever bind wider.

Any unmatched `/api/*` path is a `404`, not the SPA shell — returning HTML
where JSON was expected surfaces as an opaque parse error rather than a missing
route.

An unknown `asset` is a `404`, not an empty list — silently returning `[]` is
indistinguishable from "no activity yet" and hides typos in a filter.

---

## The strategy

`core/strategy.ts`. Six indicators vote; the winning side's score becomes a bias
strength, which is graded A/B/C.

| Signal | Weight |
|---|---|
| EMA alignment (9/21/50) | 25 aligned, 10 partial |
| Price vs EMA21 | 10 |
| RSI extreme (<30 / >70) | 20 + extreme, 5 for merely being the right side of 50 |
| MACD histogram cross | 20 + extreme, 8 for direction only |
| Stochastic extreme (<20 / >80) | 15 + extreme |
| Bollinger band touch | 18 + extreme, 8 for the zone |

**Grades** — A: ≥3 extremes and ≥70 strength. B: ≥2 and ≥60. C: ≥50. Only A and
B are traded.

**Entry** requires the 5-minute signal to be A or B, and the 15-minute read to
agree if it has an opinion (silence does not veto). A per-asset, per-direction
cooldown prevents restacking the same idea.

**Exit** — stop at 1.5×ATR. TP1 at 1.2R books a partial and moves the stop to
breakeven; the remainder trails at 2×ATR to TP2 at 2.5R. A bar wide enough to
reach both targets resolves fully at TP2.

Every knob is a field on `StrategyConfig`, per asset in `core/assets.ts`.

### Costs

`core/costs.ts` models spread, fees and slippage, **asymmetrically** — which is
the part that decides profitability:

- A take-profit is a resting limit order. It fills at your price and pays a
  maker fee.
- A stop is a market order triggered into the move that is hurting you. It pays
  the spread, taker fees **and** slippage past the trigger.

So costs shrink every win and enlarge every loss. On gold a stop-out costs
**2.6× what the chart shows**. Rates are per asset — gold quotes wider than BTC,
and TAO wider still; a blended rate flatters exactly the illiquid assets where
costs decide the outcome.

---

## MetaTrader 5

Source bars and — more importantly — your broker's **real symbol specifications**
from a running MT5 terminal. No Python: the official MetaTrader5 package ships
`win_amd64` wheels only, so on macOS that route does not exist at all. MT5 runs
there under Wine, and its `MQL5/Files` directory is an ordinary directory on the
host, so a small MQL5 exporter plus a file read is the whole bridge.

**Setup**

1. MT5 → File → Open Data Folder → `MQL5/Experts`, copy `mt5/TeoExporter.mq5` there
2. MetaEditor → F7 to compile
3. Drag **TeoExporter** onto any chart
4. Tools → Options → Expert Advisors → allow automated trading

Then:

```bash
bun run mt5:sync              # find the terminal, ingest, report
bun run mt5:sync -- --watch   # keep pulling every 30s
bun run mt5:sync -- --dir "/path/to/MQL5/Files/teo"
```

The exporter takes symbol and timeframe inputs — use the names **your** broker
uses, since gold is `XAUUSD` at some and `GOLD` or `XAUUSD.r` at others.

**What it gets you**

- Bars normalised to UTC. Timestamps arrive in broker server time (usually UTC+2
  or +3, shifting with DST); the exporter reports the offset so it is subtracted
  rather than guessed. A two-hour error would misalign every bar.
- Your actual spread, contract size, tick value and digits — which is what makes
  the edge audit describe your account instead of a plausible one.
- Bars are stored under a namespaced asset id (`MT5:XAUUSD`) so broker data can
  never be mixed with an exchange symbol of the same name.

**What it does not do**: place orders, or read your credentials. It is a
read-only data path. Volume is tick count, not traded size — most FX and CFD
brokers do not publish real volume.

Only the spread is measured. Fees and stop slippage cannot be read from a quote,
so they remain assumptions and are labelled as such in the output.

---

## Teo (Python sidecar)

Optional, and **not part of the packaged app**. The dashboard, engine, backtest
and cost model are all TypeScript.

**Regime tagging, the parameter sweep and the self-heal decision are now
TypeScript** (`core/regime.ts`, `core/sweep.ts`, `core/selfheal.ts`) and score
with the real strategy directly — no proxy, no subprocess. The Python
equivalents remain for the FastAPI service, but nothing in the app depends on
them.

What genuinely still needs Python is Kronos, which is PyTorch. If you never want
to install Python, skip this section; you lose Kronos forecasting, which has not
been shown to beat its own baseline (see Known limitations).

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness, active forecaster. |
| `POST /forecast` | OHLCV → forecast cone. |
| `POST /backtest` | Replay a config. |
| `POST /optimize` | Parameter sweep, ranked. |
| `POST /selfheal` | Detect degradation, propose a config swap. |
| `GET /assets` | Teo's asset registry (tiers 1–3). |

```bash
uvicorn teo.main:app --port 8000
python -m teo.loop --interval 15m --lookback 1000    # self-heal across assets
```

Teo **proposes**; it never applies. Swaps are recorded for audit and applied by
you.

### How a proposal is validated

`teo/backtest/ts_bridge.py` shells out to `scripts/score.ts`, so the winner of a
sweep is re-scored against the **real** strategy — `analyzeCandles`, net of real
per-asset costs — on a held-out slice it was not selected on.

This matters because the sweep itself ranks candidates with a fast Python
EMA-crossover proxy that is *not* the dashboard's strategy. On a random walk the
real strategy produces ~0 trades where the proxy fires 34.

`assess()` will not propose a swap without out-of-sample evidence. Best-of-36 on
one window measures selection luck: on synthetic data with no signal at all, the
in-sample "improvement" cleared the swap threshold by 14×. Set
`require_out_of_sample=False` to disable the gate, knowingly.

### Kronos forecasting

The architecture is **vendored** at `teo/vendor/kronos` (MIT, from
[shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos)) rather than
installed from PyPI, because the published `kronos-model-arch` hard-pins
`matplotlib==3.9.3`, `einops==0.8.1` and others — pins from the research repo's
plotting examples that the model code never imports.

Weights are a one-time anonymous download, no account:

```bash
.venv/bin/pip install -e ".[kronos]"
python -m teo.forecasting.fetch_weights          # Kronos-mini, ~20 MB
export TEO_KRONOS_LOCAL_DIR=models/kronos
```

After that, inference never touches the network. With nothing configured,
`/forecast` serves a transparent baseline instead of failing.

---

## Configuration

Everything has a working default; none of this is required.

| Variable | Default | Purpose |
|---|---|---|
| `TEO_HOST` | `127.0.0.1` | Bind address. See the warning below before changing. |
| `TEO_PORT` | `4000` | Server port. |
| `TEO_DB_PATH` | `data/teo.db` | SQLite file. |
| `TEO_JOURNAL_DAYS` | `90` | Journal retention. |
| `TEO_BINANCE_BASE_URL` | public mirror | Market data endpoint. |
| `TEO_KRONOS_LOCAL_DIR` | — | Local Kronos weights. |
| `TEO_KRONOS_DEVICE` | `cpu` | Kronos inference device. |

> **Binding beyond localhost.** There is no authentication. Setting
> `TEO_HOST=0.0.0.0` exposes read *and write* endpoints to your whole network.
> Put a token check in `server/api.ts` first.

---

## Data model

One SQLite file, inspectable with any SQLite tool.

| Table | Holds |
|---|---|
| `candles` | OHLCV per asset/interval. Fetched incrementally from the newest stored bar. |
| `trading_ideas` | Signals and their outcomes. |
| `idea_events` | Journey events per idea (own rows, so appending is an INSERT rather than rewriting an array). |
| `signal_journal` | Append-only audit trail. |
| `manual_trades` | Risk Manager entries. |
| `settings` | Intel engine state, keyed. |
| `job_runs` | Last run per scheduled job — what gap recovery reads. |

`asset` is `NOT NULL` throughout. An optional asset column meant every read had
to remember a default, and writes that forgot were silently filed under gold.

---

## Known limitations

Stated plainly, because a trading tool that hides these is worse than no tool.

1. **No demonstrated edge.** See the edge audit above. The default targets are
   unprofitable after costs on every asset; nothing has been forward-tested.
2. **The backtest is not the live engine.** `core/backtest.ts` is
   single-position and single-timeframe; the live engine requires 15m confluence
   and can hold several ideas per asset. Treat backtest output as a comparison
   between configs, not a P&L forecast.
3. **It only runs while the machine is on.** Gap recovery resolves exits
   correctly after downtime, but it cannot act during it. For continuous
   monitoring, run it on something always-on.
4. **Forecast confidence is not accuracy.** It measures how narrow the predicted
   cone is. Nothing scores forecasts against what actually happened, so there is
   no evidence Kronos beats the baseline — or that either beats guessing.
5. **No portfolio view.** Six of seven assets are crypto that move together.
   Seven simultaneous longs is one leveraged bet on a single factor, currently
   reported as seven independent results. The `hedge` strategy in Teo scales
   position size and drawdown by the same constant, so every ratio is identical
   to `edge` — it is not a hedge.
6. **Credentials in git history.** `.env.local` was committed while this repo
   was public. Those keys are now dead (they addressed a Convex deployment and
   an email service the app no longer uses) but the values remain in history.

---

## Licence

MIT. Vendored Kronos source is MIT, © 2025 ShiYu — see
`teo/vendor/kronos/LICENSE`.
