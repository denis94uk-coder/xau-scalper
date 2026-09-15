import { copyFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getAsset } from "../../core/assets";
import { Db } from "../../server/db";
import { applyPrice } from "../../server/engine";

// JST inversion experiment: mirror every closed JST idea around its entry
// (direction + SL/TP1/TP2 reflected) and replay stored 5m bars through the
// engine's own applyPrice on a COPY of the DB. Answers: what would fading
// every JST signal have made? Approximation disclosed, not a backtest:
// 5m replay granularity for all timeframes, no costs beyond stored levels.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const COPY = join(ROOT, "tmp/jst-flip.db");
copyFileSync(join(ROOT, "data/teo.db"), COPY);

const r2 = (n, p) => Math.round(n * 10 ** p) / 10 ** p;
function atrAt(candles, i, period = 14) {
  if (i < period) return 0;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const prev = candles[j - 1].close;
    sum += Math.max(
      candles[j].high - candles[j].low,
      Math.abs(candles[j].high - prev),
      Math.abs(candles[j].low - prev),
    );
  }
  return sum / period;
}

const live = new Db(join(ROOT, "data/teo.db"));
const originals = live.raw
  .query(
    `SELECT id, direction, entry_price, stop_loss, tp1, tp2, created_at, resolved_at, pnl_points, entry_price AS e
     FROM trading_ideas
     WHERE asset = 'JSTUSDT' AND status IN ('STOPPED','TP2_HIT')
       AND pnl_points IS NOT NULL AND resolved_at >= (strftime('%s','now')-30*86400)*1000`,
  )
  .all();
live.close();

const db = new Db(COPY);
const asset =
  getAsset("JSTUSDT") ??
  (() => {
    const cfg = db.getSetting("appConfig");
    const found = cfg?.assets?.find((a) => a.id === "JSTUSDT");
    if (found) return { id: "JSTUSDT", pricePrecision: found.pricePrecision ?? 5, config: found.config };
    return { id: "JSTUSDT", pricePrecision: 5, config: { atrTrailMultiplier: 2 } };
  })();
let n = 0;
for (const o of originals) {
  const dir = o.direction === "LONG" ? "SHORT" : "LONG";
  const mir = (x) => r2(o.entry_price + (o.entry_price - x), asset.pricePrecision);
  const id = db.createIdea({
    asset: "JSTUSDT",
    direction: dir,
    source: "experimental",
    entryPrice: o.entry_price,
    stopLoss: mir(o.stop_loss),
    tp1: mir(o.tp1),
    tp2: mir(o.tp2),
    spotPrice: o.entry_price,
    reason: `[FLIP JST] mirror of #${o.id}`,
    timeframe: "5m",
  });
  const bars = db
    .getCandleRange("JSTUSDT", "5m", Math.floor(o.created_at / 1000), Math.ceil((o.resolved_at ?? Date.now()) / 1000))
    .filter((c) => c.time * 1000 > o.created_at);
  let tracked = db.getIdea(id);
  for (let i = 0; i < bars.length; i++) {
    applyPrice(db, asset, tracked, bars[i], atrAt(bars, i));
    tracked = db.getIdea(id);
    if (tracked.status !== "ACTIVE" && tracked.status !== "TP1_HIT") break;
  }
  n++;
}
const rows = db.raw
  .query(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN pnl_points > 0 THEN 1 ELSE 0 END) AS w,
      SUM(CASE WHEN pnl_points < 0 THEN 1 ELSE 0 END) AS l,
      COALESCE(SUM(pnl_points/entry_price*100),0) AS pct,
      COALESCE(SUM(pnl_points),0) AS pts
     FROM trading_ideas WHERE reason LIKE '[FLIP JST]%' AND status IN ('STOPPED','TP2_HIT','EXPIRED')`,
  )
  .get();
const open = db.raw
  .query(`SELECT COUNT(*) AS n FROM trading_ideas WHERE reason LIKE '[FLIP JST]%' AND status IN ('ACTIVE','TP1_HIT')`)
  .get();
const orig = originals.reduce((s, o) => s + (o.pnl_points / o.entry_price) * 100, 0);
console.log(`originals: n=${originals.length} net=${orig.toFixed(2)}%`);
console.log(`mirrored : n=${rows.n} W=${rows.w} L=${rows.l} stillOpen=${open.n} net=${Number(rows.pct).toFixed(2)}% (${Number(rows.pts).toFixed(4)} pts)`);
console.log("FLIP_DONE");
db.close();
