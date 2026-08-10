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
import { reconcileState } from "./reconciliation";
import { RiskManager, riskConfigFromEnv } from "./risk-manager";
import { publish } from "./events";
import { scanLiquiditySweeps } from "./intel/liquiditySweep";
import { fetchMacroData } from "./intel/macroCorrelation";
import { updateCalendar } from "./intel/newsCalendar";
import { detectMarketRegime } from "./intel/regime";
import { runSelfHeal } from "./selfheal";

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
/**
 * Self-heal cadence. Six hours, not minutes: a sweep re-reads the same market
 * a faster loop would, so running it often produces more chances to be fooled
 * by noise rather than more information. Set TEO_SELFHEAL_MS to change it, or
 * TEO_SELFHEAL=off to disable the loop entirely.
 */
const SELFHEAL_MS = Number(process.env.TEO_SELFHEAL_MS ?? 6 * 60 * 60_000);
const SELFHEAL_ON = process.env.TEO_SELFHEAL !== "off";

const db = new Db();
const risk = new RiskManager(db, riskConfigFromEnv());

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

    const api = await handleApi(db, req, url, risk);
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

// Safety net for positions that candle-replay could not reach (downtime longer
// than the stored candle window). Compares open ideas against the current live
// price; anything definitively past its SL or TP2 is force-closed here.
await safely("reconcile", async () => {
  const ghosts = await reconcileState({ db });
  if (ghosts > 0) console.log(`[reconcile] closed ${ghosts} ghost trade(s)`);
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
await safely("signals", () => generateSignals({ db, riskManager: risk }));
await safely("monitor", () => monitorIdeas({ db }));
await runIntel();

// Catch up if the loop is overdue. A bare interval means a machine that
// restarts more often than the cadence never self-heals at all, and this one
// is expected to sleep — that is why gap recovery exists two lines above.
if (SELFHEAL_ON) {
  const last = db.lastRun("selfheal");
  if (last === null || Date.now() - last >= SELFHEAL_MS) {
    void safely("selfheal", async () => {
      await runSelfHeal({ db });
    });
  }
}

/** Milliseconds until the next UTC midnight. */
function msUntilMidnight(): number {
  const now = Date.now();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

const timers = [
  setInterval(
    () => void safely("monitor", () => monitorIdeas({ db })),
    MONITOR_MS,
  ),
  setInterval(
    () =>
      void safely("signals", () => generateSignals({ db, riskManager: risk })),
    SIGNAL_MS,
  ),
  setInterval(() => void runIntel(), INTEL_MS),
  ...(SELFHEAL_ON
    ? [
        setInterval(
          () =>
            void safely("selfheal", async () => {
              await runSelfHeal({ db });
            }),
          SELFHEAL_MS,
        ),
      ]
    : []),
  setInterval(() => {
    const removed = db.pruneJournal(JOURNAL_RETENTION_DAYS);
    if (removed > 0) {
      console.log(`[prune] removed ${removed} journal row(s)`);
      publish("journal");
    }
  }, PRUNE_MS),
];

// Fire once at the next UTC midnight, then every 24 h, to reset the kill switch
// daily loss accounting for the new trading day.
setTimeout(() => {
  risk.dailyReset();
  timers.push(setInterval(() => risk.dailyReset(), 24 * 60 * 60_000));
}, msUntilMidnight());

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
