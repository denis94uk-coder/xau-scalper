import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Db } from "../../server/db";

// Vault feed audit: bar coverage, gaps and staleness per LSE instrument.
// A gappy feed whipsaws exits (the BTC 4x-stack ran on 1h vault bars).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SPECS = [
  { id: "GER", interval: "30m", secs: 1800 },
  { id: "GER", interval: "1h", secs: 3600 },
  { id: "BTCUSD", interval: "1h", secs: 3600 },
  { id: "FTSE", interval: "1h", secs: 3600 },
  { id: "XAUUSD", interval: "1h", secs: 3600 },
  { id: "XAGUSD", interval: "1h", secs: 3600 },
];
const nowSec = Math.floor(Date.now() / 1000);
const fromSec = nowSec - 30 * 86400;

const db = new Db(join(ROOT, "data/teo.db"));
try {
  for (const { id, interval, secs } of SPECS) {
    const bars = db.getCandleRange(id, interval, fromSec, nowSec);
    if (bars.length === 0) {
      console.log(`${id} ${interval}: NO BARS in 30d`);
      continue;
    }
    let maxGap = 0;
    for (let i = 1; i < bars.length; i++) {
      maxGap = Math.max(maxGap, (bars[i].time - bars[i - 1].time) / secs);
    }
    const ageH = ((nowSec - bars[bars.length - 1].time) / 3600).toFixed(1);
    const coverage = ((bars.length / ((nowSec - fromSec) / secs)) * 100).toFixed(1);
    console.log(
      `${id} ${interval}: bars=${bars.length} coverage=${coverage}% maxGap=${maxGap.toFixed(1)}x latestAge=${ageH}h`,
    );
  }
  console.log("AUDIT_OK");
} finally {
  db.close();
}
