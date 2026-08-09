-- Local SQLite schema. Replaces convex/schema.ts.
--
-- Ported table-for-table so the migration is mechanical, with three changes the
-- Convex version could not express well:
--   * `asset` is NOT NULL with a default, instead of optional-and-assume-gold.
--     The optional field meant every read had to remember `?? DEFAULT_ASSET_ID`,
--     and exit-journal rows that forgot it were silently filed under gold.
--   * Real indexes on the columns actually filtered, so the full-table scans
--     that would have broken Convex's per-query limits are ordinary lookups.
--   * CHECK constraints on the enum-ish columns, which Convex enforced in the
--     validator but SQLite will otherwise happily ignore.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── OHLC candles, cached locally so a restart doesn't refetch history ───
CREATE TABLE IF NOT EXISTS candles (
  asset      TEXT    NOT NULL,
  interval   TEXT    NOT NULL,
  open_time  INTEGER NOT NULL,          -- epoch seconds, kline open
  open       REAL    NOT NULL,
  high       REAL    NOT NULL,
  low        REAL    NOT NULL,
  close      REAL    NOT NULL,
  volume     REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (asset, interval, open_time)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_candles_lookup
  ON candles (asset, interval, open_time DESC);

-- ─── Trading ideas / signals (engine, teo, manual) ───
CREATE TABLE IF NOT EXISTS trading_ideas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asset         TEXT    NOT NULL,
  direction     TEXT    NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  status        TEXT    NOT NULL CHECK (
                  status IN ('ACTIVE','TP1_HIT','TP2_HIT','STOPPED','EXPIRED')),
  source        TEXT    NOT NULL DEFAULT 'engine' CHECK (
                  source IN ('engine','teo','dashboard','experimental')),

  entry_price   REAL    NOT NULL,
  stop_loss     REAL    NOT NULL,
  tp1           REAL    NOT NULL,
  tp2           REAL    NOT NULL,
  trailing_sl   REAL,

  confidence    REAL    NOT NULL DEFAULT 0,
  grade         TEXT,
  reason        TEXT    NOT NULL DEFAULT '',
  timeframe     TEXT    NOT NULL DEFAULT '5m',
  bias          TEXT    NOT NULL DEFAULT 'NEUTRAL',
  bias_strength REAL    NOT NULL DEFAULT 0,
  spot_price    REAL    NOT NULL,

  -- Teo provenance; NULL unless source = 'teo'.
  teo_score     REAL,
  teo_regime    TEXT,

  pnl_points    REAL,
  created_at    INTEGER NOT NULL,       -- epoch ms
  resolved_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ideas_open
  ON trading_ideas (asset, status) WHERE status IN ('ACTIVE', 'TP1_HIT');
CREATE INDEX IF NOT EXISTS idx_ideas_recent
  ON trading_ideas (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_asset_recent
  ON trading_ideas (asset, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_cooldown
  ON trading_ideas (asset, direction, created_at DESC);

-- ─── Per-idea journey events (was an embedded journeyLog array) ───
-- Split into rows so appending an event is an INSERT rather than a
-- read-modify-write of the whole array, which is what the Convex version did on
-- every trailing-stop tick.
CREATE TABLE IF NOT EXISTS idea_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id   INTEGER NOT NULL REFERENCES trading_ideas(id) ON DELETE CASCADE,
  event     TEXT    NOT NULL,
  price     REAL    NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idea_events_idea
  ON idea_events (idea_id, timestamp);

-- ─── Signal journal: the audit trail ───
CREATE TABLE IF NOT EXISTS signal_journal (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT    NOT NULL,
  asset      TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'engine',
  idea_id    INTEGER REFERENCES trading_ideas(id) ON DELETE SET NULL,
  direction  TEXT CHECK (direction IS NULL OR direction IN ('LONG','SHORT')),
  price      REAL,
  details    TEXT    NOT NULL DEFAULT '',
  metadata   TEXT,                       -- JSON blob
  timestamp  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_recent
  ON signal_journal (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_journal_asset
  ON signal_journal (asset, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_journal_type
  ON signal_journal (event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_journal_idea
  ON signal_journal (idea_id, timestamp);

-- ─── Manual trades (Risk Manager) ───
CREATE TABLE IF NOT EXISTS manual_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asset       TEXT    NOT NULL,
  direction   TEXT    NOT NULL CHECK (direction IN ('LONG','SHORT')),
  status      TEXT    NOT NULL CHECK (status IN ('OPEN','WIN','LOSS','BREAKEVEN')),
  entry_price REAL    NOT NULL,
  exit_price  REAL,
  stop_loss   REAL    NOT NULL,
  take_profit REAL    NOT NULL,
  lot_size    REAL    NOT NULL,
  risk_amount REAL,
  pnl_points  REAL,
  pnl_dollars REAL,
  notes       TEXT,
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_manual_status ON manual_trades (status, opened_at DESC);

-- ─── Key/value settings (regime, macro, news, sweeps state) ───
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,           -- JSON blob
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- ─── Engine run bookkeeping, for gap recovery after downtime ───
-- The machine hosting this can sleep. On startup the engine reads the last run
-- per job and replays what it missed rather than pretending the gap never
-- happened, which is how the Convex weekend gate silently lost exits.
CREATE TABLE IF NOT EXISTS job_runs (
  job          TEXT PRIMARY KEY,
  last_run_at  INTEGER NOT NULL,
  last_ok_at   INTEGER,
  last_error   TEXT
) WITHOUT ROWID;
