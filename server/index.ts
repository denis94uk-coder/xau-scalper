/**
 * The whole backend, in one process.
 *
 *   bun run start
 *
 * Serves the built UI, the REST API and the SSE stream, and runs the signal
 * engine and position monitor on timers. No database server, no scheduler
 * service, no deploy step, no accounts — the only external thing it touches is
 * the public market-data feed.
 *
 * Binds to 127.0.0.1 by default so nothing is exposed beyond this machine.
 * Set TEO_HOST=0.0.0.0 to reach it from your phone on the LAN, but read the
 * note in api.ts first: there is no authentication.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getEnabledAssets } from "../core/assets";
import { handleApi, handleEvents } from "./api";
import { Db } from "./db";
import { generateSignals, monitorIdeas, recoverGap } from "./engine";
import { publish } from "./events";
import { scanLiquiditySweeps } from "./intel/liquiditySweep";
import { fetchMacroData } from "./intel/macroCorrelation";
import { updateCalendar } from "./intel/newsCalendar";
import { detectMarketRegime } from "./intel/regime";

const HOST = process.env.TEO_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TEO_PORT ?? 4000);
/**
 * Where the built UI lives.
 *
 * When compiled with `bun build --compile`, import.meta.dir points into the
 * binary's virtual filesystem (/$bunfs/root), which contains no assets — so the
 * UI is resolved next to the executable instead. TEO_DIST overrides both.
 */
const COMPILED = import.meta.dir.startsWith("/$bunfs");
const DIST =
  process.env.TEO_DIST ??
  (COMPILED
    ? join(dirname(process.execPath), "dist")
    : join(import.meta.dir, "..", "dist"));

/** Timer cadences. Monitor is the tight loop; the rest are housekeeping. */
const MONITOR_MS = 60_000;
const SIGNAL_MS = 5 * 60_000;
const PRUNE_MS = 6 * 60 * 60_000;
// Regime, macro, news and sweeps move on a much slower clock than price, so
// running them every 5 minutes (as the Convex crons did) spent requests to
// recompute values that had not changed.
const INTEL_MS = 15 * 60_000;
const JOURNAL_RETENTION_DAYS = Number(process.env.TEO_JOURNAL_DAYS ?? 90);

const db = new Db();

/**
 * Run a job, never letting a failure kill the timer.
 *
 * An unhandled rejection inside setInterval would take the process down and
 * stop the monitor — the one loop that must not stop.
 */
async function safely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.recordRun(name, false, msg);
    console.error(`[${name}]`, msg);
  }
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

/** Serve the built SPA, falling back to index.html for client-side routes. */
async function serveStatic(pathname: string): Promise<Response> {
  if (!existsSync(DIST)) {
    return new Response(
      "UI not built yet — run `bun run build`, then reload.",
      { status: 503, headers: { "Content-Type": "text/plain" } },
    );
  }

  // Reject traversal before touching the filesystem.
  const clean = pathname.replace(/\.\.+/g, "");
  const candidate = join(DIST, clean === "/" ? "index.html" : clean);

  if (candidate.startsWith(DIST) && existsSync(candidate)) {
    const file = Bun.file(candidate);
    if ((await file.exists()) && !candidate.endsWith("/")) {
      return new Response(file, {
        headers: { "Content-Type": contentType(candidate) },
      });
    }
  }

  const index = Bun.file(join(DIST, "index.html"));
  return new Response(index, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0, // SSE connections are long-lived by design
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/events") return handleEvents();

    const api = await handleApi(db, req, url);
    if (api) return api;

    return serveStatic(url.pathname);
  },
  error(e) {
    console.error("[server]", e);
    return new Response("internal error", { status: 500 });
  },
});

console.log(`
  Teo — local trading dashboard
  ─────────────────────────────
  UI + API   http://${HOST}:${PORT}
  Database   ${process.env.TEO_DB_PATH ?? "data/teo.db"}
  UI assets  ${DIST}
  Assets     ${getEnabledAssets().length} enabled
  Feed       public market data (no account, no key)
`);

// Resolve anything that happened while this machine was off BEFORE starting the
// timers, so the first monitor tick sees an accurate position set.
await safely("recover", async () => {
  const changed = await recoverGap({ db });
  if (changed > 0) console.log(`[recover] resolved ${changed} state change(s)`);
});

/** The four intel engines, run together. One failing must not stop the rest. */
async function runIntel(): Promise<void> {
  await safely("regime", () => detectMarketRegime(db));
  await safely("macro", () => fetchMacroData(db));
  await safely("news", () => updateCalendar(db));
  await safely("sweeps", () => scanLiquiditySweeps(db));
  publish("regime");
}

// Prime candles and evaluate immediately rather than idling for a full cycle.
await safely("signals", () => generateSignals({ db }));
await safely("monitor", () => monitorIdeas({ db }));
await runIntel();

const timers = [
  setInterval(
    () => void safely("monitor", () => monitorIdeas({ db })),
    MONITOR_MS,
  ),
  setInterval(
    () => void safely("signals", () => generateSignals({ db })),
    SIGNAL_MS,
  ),
  setInterval(() => void runIntel(), INTEL_MS),
  setInterval(() => {
    const removed = db.pruneJournal(JOURNAL_RETENTION_DAYS);
    if (removed > 0) {
      console.log(`[prune] removed ${removed} journal row(s)`);
      publish("journal");
    }
  }, PRUNE_MS),
];

function shutdown(signal: string) {
  console.log(`\n${signal} — shutting down`);
  for (const t of timers) clearInterval(t);
  server.stop();
  // Checkpoint WAL and release the file cleanly so the next start is fast.
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
