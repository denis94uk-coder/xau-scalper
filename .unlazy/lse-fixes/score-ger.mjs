import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Db } from "../../server/db";

// GER momentum@30m scoreboard since the 1x/1x bypass marker.
// Structural gate: prints the window table and SCORED_OK. The numbers fill
// in as closes accumulate — 30 closes is the evaluation window.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const db = new Db(join(ROOT, "data/teo.db"));
try {
  const since = db.getSetting("lse:fix1xAt") ?? 0;
  console.log(`window since: ${new Date(since).toISOString()}`);
  const rows = db.raw
    .query(
      `SELECT COUNT(*) AS n,
        SUM(CASE WHEN pnl_points > 0 THEN 1 ELSE 0 END) AS w,
        SUM(CASE WHEN pnl_points < 0 THEN 1 ELSE 0 END) AS l,
        SUM(CASE WHEN pnl_points = 0 THEN 1 ELSE 0 END) AS s,
        COALESCE(SUM(pnl_points), 0) AS net,
        AVG(CASE WHEN pnl_points > 0 THEN pnl_points END) AS avgwin,
        AVG(CASE WHEN pnl_points < 0 THEN pnl_points END) AS avgloss
       FROM trading_ideas
       WHERE source = 'lse' AND asset = 'GER'
         AND reason LIKE '[LSE momentum@30m]%'
         AND status IN ('STOPPED','TP2_HIT','EXPIRED')
         AND resolved_at >= ? AND pnl_points IS NOT NULL`,
    )
    .all(since);
  const r = rows[0];
  const decided = (r.w ?? 0) + (r.l ?? 0);
  const wr = decided > 0 ? (((r.w ?? 0) / decided) * 100).toFixed(1) : "n/a";
  const be =
    r.avgwin > 0 && r.avgloss < 0
      ? ((Math.abs(r.avgloss) / (r.avgwin + Math.abs(r.avgloss))) * 100).toFixed(1)
      : "n/a";
  console.log(
    `GER mom@30m post-1x: n=${r.n} W=${r.w} L=${r.l} S=${r.s} net=${Number(r.net).toFixed(1)} ` +
      `avgwin=${r.avgwin?.toFixed(1) ?? "n/a"} avgloss=${r.avgloss?.toFixed(1) ?? "n/a"} ` +
      `decidedWR=${wr}% breakevenWR=${be}% (${r.n}/30 closes)`,
  );
  console.log("SCORED_OK");
} finally {
  db.close();
}
