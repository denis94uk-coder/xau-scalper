import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Db } from "../../server/db";

const WEEK = 1788739200000; // Mon Sep 7 2026 00:00 UTC
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const db = new Db(join(ROOT, "data/teo.db"));
try {
  const rows = db.raw
    .query(
      `SELECT source,
        COUNT(*) AS n,
        SUM(CASE WHEN status = 'TP2_HIT' THEN 1 ELSE 0 END) AS tp2,
        SUM(CASE WHEN status = 'STOPPED' AND pnl_points > 0 THEN 1 ELSE 0 END) AS trailwin,
        SUM(CASE WHEN status = 'STOPPED' AND pnl_points = 0 THEN 1 ELSE 0 END) AS scratch,
        SUM(CASE WHEN status = 'STOPPED' AND pnl_points < 0 THEN 1 ELSE 0 END) AS fullloss
       FROM trading_ideas
       WHERE status IN ('STOPPED','TP2_HIT','EXPIRED')
         AND resolved_at >= ? AND pnl_points IS NOT NULL
       GROUP BY source`,
    )
    .all(WEEK);
  for (const r of rows) {
    const scratchPct = (((r.scratch ?? 0) / r.n) * 100).toFixed(1);
    console.log(
      `${r.source}: n=${r.n} tp2=${r.tp2} trailwin=${r.trailwin} scratch=${r.scratch} (${scratchPct}%) fullloss=${r.fullloss}`,
    );
  }
  const lse = rows.find(r => r.source === "lse");
  if (!lse) {
    console.log("TP_ANALYSIS_NODATA");
    process.exit(1);
  }
  console.log("TP_ANALYSIS_OK");
} finally {
  db.close();
}
