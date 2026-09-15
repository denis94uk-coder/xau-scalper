import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Db } from "../../server/db";
import { lseStrategiesFor } from "../../server/lse-engine";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const db = new Db(join(ROOT, "data/teo.db"));
try {
  const paused = ["BTCUSD", "XAGUSD", "FTSE", "XAUUSD"];
  let ok = true;
  for (const id of paused) {
    const t = lseStrategiesFor(db, id).map(s => `${s.family}@${s.interval}`);
    console.log(`${id} tradeable: [${t.join(", ")}]`);
    if (t.length !== 0) ok = false;
  }
  const ger = lseStrategiesFor(db, "GER").map(s => `${s.family}@${s.interval}`);
  console.log(`GER tradeable: [${ger.join(", ")}]`);
  if (ger.length !== 1 || ger[0] !== "momentum@30m") ok = false;
  if (!ok) {
    console.log("CARPET_MISMATCH");
    process.exit(1);
  }
  console.log("CARPET_OK");
} finally {
  db.close();
}
