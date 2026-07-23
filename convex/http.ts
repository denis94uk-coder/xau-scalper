import { httpRouter } from "convex/server";
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

export default http;
