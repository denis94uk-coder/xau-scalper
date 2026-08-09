"use node";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// ═══════════════════════════════════════════════════
// MACRO CORRELATION DASHBOARD
// Fetches DXY (Dollar Index), US10Y yield, S&P 500 from Yahoo Finance.
// PAXG gold spot remains on Binance's keyless market-data endpoint.
// Calculates correlation with gold and divergence alerts
// ═══════════════════════════════════════════════════

async function fetchBinancePrice(
  symbol: string,
): Promise<{ price: number; change: number; changePct: number } | null> {
  try {
    const r = await fetch(
      `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`,
    );
    if (!r.ok) return null;
    const d = await r.json();
    return {
      price: parseFloat(d.lastPrice),
      change: parseFloat(d.priceChange),
      changePct: parseFloat(d.priceChangePercent),
    };
  } catch {
    return null;
  }
}

type MarketQuote = {
  price: number;
  changePct: number;
  timestamp: number;
};

async function fetchYahooQuote(symbol: string): Promise<MarketQuote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const response = await fetch(url, {
      headers: { "User-Agent": "teo-dashboard/1.0" },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    const metaPrice = Number(result?.meta?.regularMarketPrice);
    const timestamps: number[] = result?.timestamp ?? [];
    const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close ?? [];
    const valid = closes.filter((value): value is number => Number.isFinite(value));
    const last = valid.length > 0 ? valid[valid.length - 1] : undefined;
    const price = Number.isFinite(metaPrice) && metaPrice > 0 ? metaPrice : last;
    if (!price || !Number.isFinite(price)) return null;
    const previous = valid.length > 1 ? valid[valid.length - 2] : undefined;
    const changePct = previous && previous !== 0 ? ((price - previous) / previous) * 100 : 0;
    const lastTimestamp = timestamps.length > 0 ? timestamps[timestamps.length - 1] : undefined;
    return {
      price,
      changePct,
      timestamp: lastTimestamp ? lastTimestamp * 1000 : Date.now(),
    };
  } catch {
    return null;
  }
}

async function fetchYahooMacroData() {
  const [dxy, spx, us10y, paxg] = await Promise.all([
    fetchYahooQuote("DX-Y.NYB"),
    fetchYahooQuote("^GSPC"),
    fetchYahooQuote("^TNX"),
    fetchBinancePrice("PAXGUSDT"),
  ]);
  if (!dxy || !spx || !us10y || !paxg) {
    throw new Error("Yahoo macro data incomplete; preserving the previous state");
  }
  return {
    dxy,
    spx,
    us10y,
    goldPrice: paxg.price,
    goldChange: paxg.changePct,
    timestamp: Math.min(dxy.timestamp, spx.timestamp, us10y.timestamp),
  };
}

function calcCorrelation(
  goldChange: number,
  assetChange: number,
  expectedSign: number,
): number {
  if (goldChange === 0 || assetChange === 0) return 0;
  const sameDir =
    (goldChange > 0 && assetChange > 0) || (goldChange < 0 && assetChange < 0);
  const strength = Math.min(
    1,
    (Math.abs(goldChange) + Math.abs(assetChange)) / 4,
  );
  return (sameDir ? strength : -strength) * expectedSign;
}

function detectDivergence(
  goldChange: number,
  assetChange: number,
  rel: "INVERSE" | "DIRECT",
) {
  const t = 0.3;
  if (Math.abs(goldChange) < t && Math.abs(assetChange) < t)
    return { alert: false, type: "NONE" };
  if (rel === "INVERSE") {
    if (assetChange < -t && goldChange < -t)
      return { alert: true, type: "BULLISH_GOLD" };
    if (assetChange > t && goldChange > t)
      return { alert: true, type: "BEARISH_GOLD" };
    return { alert: false, type: "NONE" };
  }
  if (assetChange > t && goldChange < -t)
    return { alert: true, type: "BEARISH_GOLD" };
  if (assetChange < -t && goldChange > t)
    return { alert: true, type: "BULLISH_GOLD" };
  return { alert: false, type: "NONE" };
}

export const fetchMacroData = internalAction({
  args: {},
  handler: async ctx => {
    try {
      const macroData = await fetchYahooMacroData();
      const goldChange = macroData.goldChange;
      const dxyChange = macroData.dxy.changePct;
      const us10yChange = macroData.us10y.changePct;
      const spxChange = macroData.spx.changePct;

      const dxyDiv = detectDivergence(goldChange, dxyChange, "INVERSE");
      const dxyCorr = calcCorrelation(goldChange, dxyChange, -1);

      const us10yPrice = macroData.us10y.price;
      const us10yDiv = detectDivergence(goldChange, us10yChange, "INVERSE");
      const us10yCorr = calcCorrelation(goldChange, us10yChange, -1);

      const spxDiv = detectDivergence(goldChange, spxChange, "DIRECT");
      const spxCorr = calcCorrelation(goldChange, spxChange, 1);

      let bull = 0,
        bear = 0;
      if (dxyChange < -0.2) bull++;
      if (dxyChange > 0.2) bear++;
      if (us10yChange < -0.1) bull++;
      if (us10yChange > 0.1) bear++;
      if (spxChange < -0.3) bull++;
      if (spxChange > 0.3) bear++;
      if (dxyDiv.alert && dxyDiv.type === "BULLISH_GOLD") bull += 2;
      if (dxyDiv.alert && dxyDiv.type === "BEARISH_GOLD") bear += 2;

      const overallMacroBias =
        bull > bear ? "BULLISH" : bear > bull ? "BEARISH" : "NEUTRAL";
      const biasStrength = Math.min(100, Math.abs(bull - bear) * 25);

      let description = "";
      if (overallMacroBias === "BULLISH") {
        description = "Macro environment favors gold — ";
        if (dxyChange < -0.2) description += "DXY weakening, ";
        if (us10yChange < -0.1) description += "yields declining, ";
        if (spxChange < -0.3) description += "risk-off sentiment, ";
        description = description.replace(/, $/, ".");
      } else if (overallMacroBias === "BEARISH") {
        description = "Macro headwinds for gold — ";
        if (dxyChange > 0.2) description += "DXY strengthening, ";
        if (us10yChange > 0.1) description += "yields rising, ";
        if (spxChange > 0.3) description += "risk-on sentiment, ";
        description = description.replace(/, $/, ".");
      } else {
        description =
          "Mixed macro signals — no clear directional bias from macro data.";
      }

      await ctx.runMutation(internal.macroQueries.saveMacroState, {
        dxyPrice: Math.round(macroData.dxy.price * 100) / 100,
        dxyChange: Math.round(dxyChange * 100) / 100,
        dxyCorrelation: Math.round(dxyCorr * 100) / 100,
        dxyDivergence: dxyDiv.alert,
        dxyDivType: dxyDiv.type,
        us10yPrice: Math.round(us10yPrice * 100) / 100,
        us10yChange: Math.round(us10yChange * 100) / 100,
        us10yCorrelation: Math.round(us10yCorr * 100) / 100,
        us10yDivergence: us10yDiv.alert,
        us10yDivType: us10yDiv.type,
        spxPrice: Math.round((macroData.spx.price) * 100) / 100,
        spxChange: Math.round(spxChange * 100) / 100,
        spxCorrelation: Math.round(spxCorr * 100) / 100,
        spxDivergence: spxDiv.alert,
        spxDivType: spxDiv.type,
        goldPrice: macroData.goldPrice,
        goldChange: Math.round(goldChange * 100) / 100,
        overallMacroBias,
        macroBiasStrength: biasStrength,
        description,
        source: "Yahoo Finance + Binance PAXG",
        dataTimestamp: macroData.timestamp,
      });

      console.log(
        `[Macro] Bias: ${overallMacroBias} (${biasStrength}%) | DXY: ${dxyChange > 0 ? "+" : ""}${dxyChange.toFixed(2)}%`,
      );
    } catch (e: any) {
      console.error("[Macro] Error:", e.message);
    }
  },
});
