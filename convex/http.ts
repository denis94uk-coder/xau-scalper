import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Binance klines proxy (via data-api.binance.vision — no geo-restrictions) ──
http.route({
  path: "/api/klines",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol") || "PAXGUSDT";
    const interval = url.searchParams.get("interval") || "5m";
    const limit = url.searchParams.get("limit") || "200";

    try {
      const apiUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(apiUrl);
      const data = await res.text();
      return new Response(data, {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
});

http.route({
  path: "/api/klines",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

// ── Binance 24hr ticker proxy ──
http.route({
  path: "/api/ticker",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol") || "PAXGUSDT";

    try {
      const apiUrl = `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`;
      const res = await fetch(apiUrl);
      const data = await res.text();
      return new Response(data, {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
});

http.route({
  path: "/api/ticker",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

// ── Gold spot price proxy ──
http.route({
  path: "/api/gold-price",
  method: "GET",
  handler: httpAction(async () => {
    // 1. Try goldprice.org
    try {
      const res = await fetch("https://data-asg.goldprice.org/dbXRates/USD");
      if (res.ok) {
        const data = await res.text();
        return new Response(
          JSON.stringify({ source: "goldprice.org", data: JSON.parse(data) }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    } catch {
      // fall through
    }

    // 2. Binance PAXG as fallback (via binance.vision)
    try {
      const res = await fetch(
        "https://data-api.binance.vision/api/v3/ticker/24hr?symbol=PAXGUSDT",
      );
      if (res.ok) {
        const data = await res.text();
        return new Response(
          JSON.stringify({ source: "binance", data: JSON.parse(data) }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    } catch {
      // fall through
    }

    return new Response(JSON.stringify({ error: "All price sources failed" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/gold-price",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

// ═══════════════════════════════════════════════════════════════
// Teo sidecar endpoints
//
// These WRITE to the forward-test record, so unlike the read-only market-data
// proxies above they are NOT browser-facing and NOT CORS-open. A forward test
// is only evidence if nobody can backfill it, so both routes require a shared
// secret (TEO_SHARED_SECRET, set via `bunx convex env set`). Without the env
// var configured the routes refuse every request rather than failing open.
// ═══════════════════════════════════════════════════════════════

const jsonHeaders = { "Content-Type": "application/json" };

/** Constant-time-ish comparison so a wrong secret can't be timed out char by char. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** Returns an error Response when the caller isn't authorised, else null. */
function authorizeTeo(request: Request): Response | null {
  const expected = process.env.TEO_SHARED_SECRET;
  if (!expected) {
    return new Response(
      JSON.stringify({ error: "Teo endpoints not configured" }),
      { status: 503, headers: jsonHeaders },
    );
  }
  const provided = request.headers.get("x-teo-secret") ?? "";
  if (!secretMatches(provided, expected)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: jsonHeaders,
    });
  }
  return null;
}

// ── Teo forward test: record a proposal BEFORE the outcome is known ──
http.route({
  path: "/teo/propose",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = authorizeTeo(request);
    if (denied) return denied;

    try {
      const body = (await request.json()) as Record<string, unknown>;

      // Every price field must be a finite number — `!value` would wrongly
      // reject a legitimate 0 and wrongly accept a NaN.
      const numeric = ["entryPrice", "stopLoss", "tp1", "tp2"] as const;
      for (const key of numeric) {
        if (typeof body[key] !== "number" || !Number.isFinite(body[key])) {
          return new Response(
            JSON.stringify({ error: `Missing or invalid ${key}` }),
            { status: 400, headers: jsonHeaders },
          );
        }
      }
      if (body.direction !== "LONG" && body.direction !== "SHORT") {
        return new Response(
          JSON.stringify({ error: "direction must be LONG or SHORT" }),
          { status: 400, headers: jsonHeaders },
        );
      }

      const entryPrice = body.entryPrice as number;
      const id = await ctx.runMutation(internal.forwardTest.proposeTrade, {
        direction: body.direction,
        entryPrice,
        stopLoss: body.stopLoss as number,
        tp1: body.tp1 as number,
        tp2: body.tp2 as number,
        confidence: (body.confidence as number) ?? 0,
        reason: (body.reason as string) ?? "Teo proposal",
        timeframe: (body.timeframe as string) ?? "15m",
        bias: (body.bias as string) ?? "neutral",
        biasStrength: (body.biasStrength as number) ?? 0,
        spotPrice: (body.spotPrice as number) ?? entryPrice,
        asset: body.asset as string | undefined,
        teoScore: body.teoScore as number | undefined,
        teoRegime: body.teoRegime as string | undefined,
      });

      return new Response(JSON.stringify({ ok: true, id }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: jsonHeaders,
      });
    }
  }),
});

// ── Teo self-heal decision journal (append-only; never applies a config) ──
http.route({
  path: "/teo/decision",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = authorizeTeo(request);
    if (denied) return denied;

    try {
      const body = (await request.json()) as Record<string, unknown>;
      const required = [
        "asset",
        "strategyId",
        "regime",
        "status",
        "action",
        "reason",
      ];
      if (required.some(key => typeof body[key] !== "string")) {
        return new Response(
          JSON.stringify({ error: "Missing required decision fields" }),
          { status: 400, headers: jsonHeaders },
        );
      }

      const result = await ctx.runMutation(
        internal.teoDecisions.recordDecision,
        {
          asset: body.asset as string,
          strategyId: body.strategyId as string,
          regime: body.regime as string,
          status: body.status as string,
          action: body.action as string,
          reason: body.reason as string,
          currentScore: (body.currentScore as number) ?? 0,
          proposedScore: body.proposedScore as number | undefined,
          improvement: body.improvement as number | undefined,
          metadata:
            body.metadata === undefined
              ? undefined
              : JSON.stringify(body.metadata),
        },
      );

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: jsonHeaders,
      });
    }
  }),
});

export default http;
