import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Negative check: LSE must not scale exits by regime (backtest never did).
// Positive control: the main engine still does (proves the checker can see it).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const lse = readFileSync(join(ROOT, "server/lse-engine.ts"), "utf8");
const main = readFileSync(join(ROOT, "server/engine.ts"), "utf8");

const lseReadsRegime = /regime\?\.slMultiplier|regime\?\.tpMultiplier/.test(lse);
const mainReadsRegime = /regime\?\.slMultiplier/.test(main) && /regime\?\.tpMultiplier/.test(main);

console.log(`lse reads regime multipliers: ${lseReadsRegime}`);
console.log(`main engine reads regime multipliers (control): ${mainReadsRegime}`);

if (lseReadsRegime || !mainReadsRegime) {
  console.log("BYPASS_MISMATCH");
  process.exit(1);
}
console.log("BYPASS_OK");
