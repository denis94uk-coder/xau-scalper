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
`LINKUSDT`, `AAVEUSDT`, `TAOUSDT`. Those are the defaults, not the limits:
instruments, indicator parameters, risk and the MT5 bridge are all edited in
the UI at `/settings` and stored in the database. Nothing here requires
editing code.

Three things you can do from the browser alone:

- **Settings** (`/settings`) — add or remove instruments, retune every
  indicator, set risk, point the app at your MT5 terminal, and arm live
  execution. A rejected save reports each offending field and changes nothing.
- **Find Strategies** (`/research`) — pick a symbol, a timeframe and a date
  range; the app pulls the history from MT5 itself and searches for a
  configuration, then either offers one with its out-of-sample evidence or
  tells you it found nothing. Adopting a result writes it into settings.
- **Live execution** — off by default, behind its own switch, and impossible
  to arm while the bridge is off.

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

And beating breakeven is not the same as having an edge. A 58% win rate over 30
trades looks convincing and is well inside what a coin flip produces. The app
now refuses to let that pass: every win rate it reports is served with a verdict
on whether it is distinguishable from chance — see
[Is the edge real?](#is-the-edge-real).

What has not changed: nothing here has been validated against live results.
There is no forward-test record. The machinery to reach a verdict exists and is
tested; the trades to feed it do not exist yet.

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
│             ├── selfheal  6h   sweep + propose       │
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
| `core/` | Strategy, indicators, asset registry, backtest replay, cost model, regime tagging, parameter sweep, self-heal decision, regime-tagged memory, statistical significance, portfolio risk. No framework imports — shared by the server, the CLI tools and the tests. |
| `server/` | HTTP + SSE, SQLite layer, signal engine, self-heal loop, scheduler. |
| `server/intel/` | Regime, macro correlation, news calendar, liquidity sweeps. |
| `src/` | React UI (Vite, Tailwind, shadcn/ui). |
| `scripts/` | Backtest, batch scorer, edge audit. |
| `teo/` | Python sidecar: Kronos forecasting, parameter sweeps, self-heal. |
| `tests/`, `core/__tests__/`, `server/__tests__/` | 294 TypeScript + 89 Python tests. |

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
| `bun test core server` | 249 TypeScript tests across the strategy core and server. |
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
| `GET` | `/api/performance?asset` | Per-asset stats: win rate, expectancy, streaks, profit factor — each with a `significance` block stating whether the record beats chance. |
| `GET` | `/api/portfolio` | Open book as one number: effective risk, concentration, net exposure, every pairwise correlation with its sample count, and the record discounted for correlated positions. |
| `GET` | `/api/selfheal?asset&limit` | Self-heal decision history, including the holds, plus what has been learned per regime. |
| `GET` | `/api/candles?asset&interval&limit` | Stored OHLCV from the database. |
| `GET` | `/api/klines?symbol&interval&limit` | Live OHLCV proxied from the venue. Serves intervals the engine does not persist (1m, 3m); the browser cannot call the venue directly because of CORS. |
| `GET` | `/api/prices?symbols` | Batched 24h ticker. One upstream request for all symbols. |
| `GET` | `/api/state/:key` | Intel engine output — `marketRegime`, `macroState`, `newsShield`, `liquiditySweeps`. |
| `GET` | `/api/events` | SSE stream. Pushes `{kind}` on change; clients refetch. |
| `GET` | `/api/config` | The whole live configuration document. |
| `GET` | `/api/config/defaults` | The shipped defaults, for a reset preview. |
| `GET` | `/api/mt5/status` | Bridge directory, whether a terminal is answering, per-symbol freshness. Reports disconnected rather than failing when no terminal exists. |
| `GET` | `/api/mt5/discover` | Look for a terminal in the usual install locations. |
| `GET` | `/api/research/runs` | Strategy searches, newest first. |
| `GET` | `/api/research/runs/:id` | One search: status, progress, and the report once it has one. |

### Writes

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/ideas` | Log a signal by hand (`source: dashboard`). |
| `DELETE` | `/api/ideas/:id` | Remove a signal. Journal rows survive as orphans — an audit trail that vanishes with its subject is not an audit trail. |
| `POST` | `/api/trades` | Open a manual trade. |
| `POST` | `/api/trades/:id` | Close at `exitPrice`. **P&L and WIN/LOSS/BREAKEVEN are derived server-side** from the stored entry; the caller does not get to state the result. |
| `DELETE` | `/api/trades/:id` | Remove a manual trade. |
| `GET` | `/api/trades/stats` | Aggregate manual-trade performance. |
| `PUT` | `/api/config` | Replace the configuration wholesale. Validated as a document: a rejection is `422` with every offending field and path, and nothing is written. Partial saves are not possible. |
| `POST` | `/api/config/reset` | Restore the shipped defaults. |
| `POST` | `/api/mt5/sync` | Pull bars and symbol specifications now. `502` when no terminal answers. |
| `POST` | `/api/research/runs` | Start a search over a symbol, timeframe and date range. |
| `POST` | `/api/research/runs/:id/cancel` | Stop a search. |
| `POST` | `/api/research/runs/:id/adopt` | Write the discovered configuration into settings. `409` if the search produced no qualifying candidate. Adds the instrument disabled if it was not configured. |
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

## Searching for a strategy

`core/discovery.ts`, driven from **Find Strategies**. A random search over the
parameter space, scored on three windows cut in time order: it fits on the
first, selects on the second, and reports the third — which no decision
touched — as the number to believe. The page says so, and shows all three side
by side so a configuration that only works in-sample is obvious.

Searching thousands of configurations will surface a good-looking one from pure
noise, so the reported p-value is corrected (Šidák) for how many were actually
tried, and the correction is redone at the end against the true attempt count.
A candidate that does not clear the bar is labelled and listed with the reason
it failed. **A search is allowed to conclude that it found nothing** — the test
suite includes a random walk, and asserts that no strategy is offered for it.

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

## Self-healing

`server/selfheal.ts`, on a 6-hour cycle. Per asset: pull 1,000 bars, tag the
regime, sweep the parameter grid with a 70/30 out-of-sample split, and ask
whether the running config is degraded and whether anything demonstrably beats
it.

**It proposes; it never applies.** Nothing in this loop writes a config. A
system that silently rewrites its own trading parameters cannot be reasoned
about after the fact.

Three gates stand between "a candidate scored higher" and a proposal:

1. **Out-of-sample** — the candidate must hold up on bars it was not selected on.
2. **Improvement margin** — a hair's-width gain is not a reason to change anything.
3. **The live veto** — a config whose *real* record beats its breakeven by more
   than chance explains is not replaced on the strength of a backtest. The first
   two gates are computed from history, and history is what a sweep overfits;
   the live record is the only evidence that was not selected on.

The veto uses the same significance test as everything else, so a merely
*positive* live record does not block a swap — 8 wins from 12 looks convincing
and is not evidence.

**Every cycle is recorded, including the holds.** A loop that logs only the
times it wanted to change something reads, afterwards, as though it were
changing things constantly. Records are regime-tagged, because a config that
worked in a quiet uptrend says nothing about a choppy, volatile one, and
`core/memory.ts` recalls per regime rather than globally.

```
  PAXGUSDT   chop/normal_vol   hold   insufficient_data
             only 4 trades (< 10); not enough to judge
```

### What actually stops a bad swap

Worth being precise, because it is not the gate you would guess. On a pure
random walk the loop holds — but it holds because **the real strategy fires 4–5
trades per 1,000 noise bars**, so every swept score lands under `minTrades` and
the verdict is `insufficient_data`. Nothing reaches the out-of-sample gate to be
gated.

That is a stronger defence than the gate, not a weaker one. It is also a
correction: the "14× improvement on noise" result that motivated the gate was
measured against Teo's Python EMA-crossover proxy, which fired 34 trades on a
window where the real strategy fires none. The gate is unit-tested against
fixtures; it is not exercised end-to-end by the random-walk test, and no fixture
was bent until it produced the desired verdict.

`GET /api/selfheal?asset&limit` serves the decision history and what has been
learned per regime. `TEO_SELFHEAL=off` disables the loop; `TEO_SELFHEAL_MS`
changes the cadence.

---

## The hedge

`core/portfolio.ts`. The engine decides one asset at a time, and nothing in a
per-asset view can see the problem that creates: six of the seven registered
assets are crypto that move as a block, so "one signal per asset, each risking
1R" routinely opens **five simultaneous longs that are one bet at five times the
size**. The first correlated drawdown is where that becomes visible.

Portfolio risk is `sqrt(wᵀΣw)` with **signed** weights, in units of one
independent position:

| Book | Risk | Reading |
|---|---|---|
| 4 uncorrelated longs | 2.00 | Four bets' worth of diversification. |
| 4 longs at ρ = 0.85 | 3.77 | Barely better than four times one bet. |
| 4 longs at ρ = 1.00 | 4.00 | One position at 4× size. |
| 2 longs + 2 shorts at ρ = 0.85 | 0.77 | The shorts hedge the longs. |

The sign is what makes the last row a **real hedge** rather than a label: a
short on a correlated asset subtracts from portfolio risk. That falls out of the
arithmetic; there is no special case for it.

**The cap is on risk, not on position count.** `maxRisk` defaults to 3, which
admits nine genuinely uncorrelated positions or three that move together. Feed
six correlated signals in one at a time and three are refused; feed six
uncorrelated ones and all six are taken. That asymmetry is the entire reason the
limit is expressed this way.

A trade that *lowers* portfolio risk is admitted unconditionally, including when
the book is already over its cap — refusing the one trade that reduces exposure
because exposure is too high would be exactly backwards.

Refusals are not silent. Each writes a `SIGNAL_BLOCKED` journal row naming the
correlation that caused it:

```
[BTC/USD] A LONG not taken. Refused: would take portfolio risk to 3.41,
over the 3.00 cap, on 3 open position(s). Closest open position is
ETHUSDT at ρ = 0.91.
```

**Correlations are measured, not assumed.** Pearson on log returns from the 5m
candles the engine already stores, aligned **by bar timestamp** — correlating
index-for-index across series that start on different days produces a confident
number that means nothing. Where fewer than 30 bars overlap, the estimate falls
back to a prior of **0.8 and flags itself as assumed**. Not 0: defaulting an
unmeasured correlation to "independent" would wave through exactly the cluster
the cap exists to catch, and erring toward refusing a trade is the cheap
direction to be wrong in.

`GET /api/portfolio` serves the book, every pairwise correlation with its sample
count, and the discounted evidence below. The Risk Manager page renders it.

---

## Is the edge real?

`core/significance.ts`. Every other number in the system describes what
happened; these describe **how much of it you are entitled to believe**.

The failure this exists to prevent is specific and common: a strategy runs for a
few weeks, shows a 58% win rate against a 48% breakeven, and the operator scales
up. With 30 trades that gap is comfortably inside what a coin flip produces.

`GET /api/performance` returns a `significance` block on every asset, and the
Performance page renders its verdict **above** the win rate — a rate read before
its sample size is the whole error.

| Field | Meaning |
|---|---|
| `verdict` | `insufficient_data` (under 30 trades — no verdict offered at all), `indistinguishable_from_chance`, or `significant`. |
| `pValue` | One-sided binomial: probability of a record this good if the true edge were zero. |
| `interval` | 95% Wilson score interval on the true win rate. Wilson rather than the textbook normal approximation, which at 20 trades can return bounds below 0% or above 100%. |
| `breakevenRate` | The rate that must be beaten after costs, derived from the realised average win and loss. |
| `tradesNeeded` | Trades required to settle an edge of the observed size, at 95% confidence and 80% power. `null` when the observed rate is at or below breakeven — there is no positive edge to size for. |

What that looks like across sample sizes, against a 48% breakeven:

```
  trades  wins   rate   p-value   verdict
      12     8   66.7%   0.1575   too few to judge
      30    18   60.0%   0.1286   could be luck
     120    66   55.0%   0.0745   could be luck
     400   212   53.0%   0.0255   real edge
    1000   530   53.0%   0.0009   real edge
```

Note the third row: 55% over 120 trades is a result most people would act on,
and it does not clear the bar.

**Correlated positions are not independent evidence.** Six of the seven
registered assets are crypto that move together, so seven simultaneous longs are
close to one bet repeated — but every statistic above counts them as seven,
which overstates confidence exactly when a correlated drawdown is most likely.
`effectiveSampleSize(trades, avgConcurrent, correlation)` applies the
equicorrelation discount: 600 trades across 6 assets at ρ = 0.8 are worth **120**.

`GET /api/portfolio` reports that discount against the real record, with both
inputs measured rather than supplied: `averageConcurrency` integrates open
position count over time (so a one-second brush does not score the same as a
week held side by side), and the correlation is the measured average from
stored candles.

The maths is exact rather than approximated — log-factorials are summed and
cached, not estimated with Stirling, because being wrong about a four-trade
probability is precisely the case this module exists to get right. 27 tests
check it against hand-computable values.

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

**History on demand**

The exporter also answers requests. The server writes a small JSON file into
`teo/requests/`, the EA fills it with `CopyRates` — retrying while the broker
back-fills the range — and writes the answer to `teo/history/` with a progress
file beside it. Answers land under a temporary name and are renamed into place,
so a half-written file is never read as a complete one. This is what "Find
Strategies" uses; you do not download or convert anything by hand.

**Order execution**

Orders are opt-in twice: `InpAllowTrading` on the EA (default `false`) and the
execution switch in Settings (default off, and unavailable while the bridge is
off). When both are on, a qualifying signal is written as an order file, the
EA deletes the file before sending so a restart cannot replay it, sends with
the stop and second target as the broker-side bracket, and writes an
acknowledgement. Every send and every refusal, with its reason, is journalled.

**What it does not do**: read your credentials, or trade an instrument you have
not configured. Volume is tick count, not traded size — most FX and CFD brokers
do not publish real volume.

Only the spread is measured. Fees and stop slippage cannot be read from a quote,
so they remain assumptions and are labelled as such in the output.

### Trend and mean-reversion are scored separately

The original model sums trend-following and mean-reversion evidence into one
bull/bear pair. They fire in opposite conditions, so they cancel. Through a
clean synthetic uptrend the combined model signals **SHORT on 300 of 300 bars**:
the bullish EMA structure is worth 40 points, and the upper-band touch, RSI > 70
and Stoch > 80 that necessarily accompany an uptrend are worth 43 to the other
side.

That caps how high `max(bullScore, bearScore)` can ever climb. On 4,940 bars of
XAUUSD M5 the highest strength observed was **63**, against a grade A threshold
of 70 — grade A did not occur once, and could not have.

`core/families.ts` scores each half on its own evidence, with its own grade
thresholds, normalised to 0-100 against what that family can actually reach.
`core/strategy.ts` is untouched; its behaviour is pinned by a parity fixture and
the live engine still runs it.

```bash
bun run compare -- --asset MT5:XAUUSD --interval 5m
```

Runs all three models on the same bars and costs, and reports whether each
result is distinguishable from chance. Individual models:

```bash
bun run backtest -- --source db --asset MT5:XAUUSD --model trend
bun run backtest -- --source db --asset MT5:XAUUSD --model reversion --sweep
```

**A high win rate here is a warning, not a result.** Backtesting a
trend-following model on a series that happens to trend will produce one. The
number that matters is whether it survives out-of-sample and forward.

### Does it hold up across time?

```bash
bun run compare -- --asset MT5:XAUUSD --interval 15m --walk-forward 6 --model trend
```

Splits the history into consecutive non-overlapping windows and reports the edge
in each. Windows are replayed with the full preceding history, so indicators are
warm and each window still measures only its own bars.

One backtest over one window cannot tell a persistent edge from a single
profitable stretch — and once you have compared several models on several
timeframes, the best-looking combination is the one most likely to *be* that
stretch. Read the "windows with a positive edge" line first: a real edge shows
up in most of them.

Validated against series with known answers. On a pure random walk it reports
0 of 6 windows positive; on a momentum-autocorrelated series with a genuine
trend edge, 6 of 6. It does not manufacture edges and does not miss them.

Significance is the exact binomial from `core/significance.ts`, not a normal
approximation — the latter is unreliable at the low win rates this exit geometry
produces.

### Why did the strategy not fire?

```bash
bun run diagnose -- --asset MT5:XAUUSD --interval 5m
```

Reports where every bar went: session gaps, how many bars failed to score at
all, how many were killed by the neutral-bias filter, how many were graded
NO_TRADE, and the strength distribution against the thresholds in force.

Read the strength distribution before touching a threshold. If bars clear the
strength bar but few are graded, the extreme-indicator count is binding and
lowering strength changes nothing. If the 95th percentile sits below it, the
model is not finding the instrument's setups — and lowering the bar to force
trades selects noise rather than discovering an edge.

### Backtesting on broker data

Once synced, the bars are stored under `MT5:<SYMBOL>` and the backtester can
replay them instead of fetching from Binance:

```bash
bun run mt5:backtest      # one backtest on the default config
bun run mt5:sweep         # rank configs by risk-adjusted score
```

Costs come from the sync — your measured spread, not the registry estimate — so
the result describes your account. Fees default to zero, which is right for a
commission-free CFD account and wrong for anything else; stop slippage is
assumed at one spread.

Any symbol and timeframe the exporter wrote works:

```bash
bun run backtest -- --source db --asset MT5:XAUUSD --interval 15m --sweep
```

**Reading the sweep.** Configs are selected on the leading 70% of bars and
scored again on the held-out 30%. The in-sample columns are the ones that
flatter; the OOS column is the one that discriminates. A config that tops the
ranking with a negative OOS score was selected by luck on that window. `too few`
means the config did not trade enough on the held-out slice to be judged at all
— not a bad score, the absence of one.

The sweep **prints and stops**. Nothing is written to the running config, by
design: a system that silently rewrites its own trading parameters is one you
cannot reason about afterwards. To adopt a config, paste it into `core/assets.ts`
yourself.

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
| `TEO_MT5_DIR` | auto-discovered | MT5 `MQL5/Files/teo` directory. Settings can also set this. |
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
6. **Live execution has not been proven against a real account.** The order path
   is covered by tests against a simulated terminal, not by a filled trade.
   Run it on a demo account first, and take point 1 seriously before arming it
   on anything else. It sends market orders with a broker-side bracket; it does
   not manage the position afterwards from the broker side, so the trail and
   partial exits still depend on this process being alive.
7. **A discovered strategy is a hypothesis.** The third window is honest
   evidence, not a guarantee: it is one sample of one period, and the search
   still chose the space it drew from. Forward-test before believing it.
8. **Credentials were committed, now removed.** `.env.local` was once tracked
   while this repo was public. It has since been `git rm --cached`'d and stays
   out of the tree (see `.gitignore`), and a secret-free `.env.example` now
   documents every variable. If those keys were ever live, **rotate them** — the
   values may still exist in old commits.

---

## Licence

MIT. Vendored Kronos source is MIT, © 2025 ShiYu — see
`teo/vendor/kronos/LICENSE`.
