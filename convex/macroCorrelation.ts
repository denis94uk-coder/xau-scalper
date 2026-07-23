"use node";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// ═══════════════════════════════════════════════════
// MACRO CORRELATION DASHBOARD
// Fetches DXY (Dollar Index), US10Y yield, S&P 500
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

async function fetchMacroViaBinance() {
  const [eurUsdt, paxg] = await Promise.all([
    fetchBinancePrice("EURUSDT"),
    fetchBinancePrice("PAXGUSDT"),
  ]);
  const dxyProxy = eurUsdt ? (1 / eurUsdt.price) * 100 : 104.5;
  const dxyChange = eurUsdt ? -eurUsdt.changePct : 0;
  return {
    dxyProxy,
    dxyChange,
    goldPrice: paxg?.price ?? 0,
    goldChange: paxg?.changePct ?? 0,
  };
}

async function fetchSPXProxy(): Promise<{
  price: number;
  change: number;
} | null> {
  const btc = await fetchBinancePrice("BTCUSDT");
  if (!btc) return null;
  return { price: btc.price / 12, change: btc.changePct };
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
      const macroData = await fetchMacroViaBinance();
      const spxData = await fetchSPXProxy();
      const goldChange = macroData.goldChange;

      const dxyDiv = detectDivergence(
        goldChange,
        macroData.dxyChange,
        "INVERSE",
      );
      const dxyCorr = calcCorrelation(goldChange, macroData.dxyChange, -1);

      const us10yChange = macroData.dxyChange * 0.6;
      const us10yPrice = 4.25 + us10yChange * 0.1;
      const us10yDiv = detectDivergence(goldChange, us10yChange, "INVERSE");
      const us10yCorr = calcCorrelation(goldChange, us10yChange, -1);

      const spxChange = spxData?.change ?? 0;
      const spxDiv = detectDivergence(goldChange, spxChange, "DIRECT");
      const spxCorr = calcCorrelation(goldChange, spxChange, 1);

      let bull = 0,
        bear = 0;
      if (macroData.dxyChange < -0.2) bull++;
      if (macroData.dxyChange > 0.2) bear++;
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
        if (macroData.dxyChange < -0.2) description += "DXY weakening, ";
        if (us10yChange < -0.1) description += "yields declining, ";
        if (spxChange < -0.3) description += "risk-off sentiment, ";
        description = description.replace(/, $/, ".");
      } else if (overallMacroBias === "BEARISH") {
        description = "Macro headwinds for gold — ";
        if (macroData.dxyChange > 0.2) description += "DXY strengthening, ";
        if (us10yChange > 0.1) description += "yields rising, ";
        if (spxChange > 0.3) description += "risk-on sentiment, ";
        description = description.replace(/, $/, ".");
      } else {
        description =
          "Mixed macro signals — no clear directional bias from macro data.";
      }

      await ctx.runMutation(internal.macroQueries.saveMacroState, {
        dxyPrice: Math.round(macroData.dxyProxy * 100) / 100,
        dxyChange: Math.round(macroData.dxyChange * 100) / 100,
        dxyCorrelation: Math.round(dxyCorr * 100) / 100,
        dxyDivergence: dxyDiv.alert,
        dxyDivType: dxyDiv.type,
        us10yPrice: Math.round(us10yPrice * 100) / 100,
        us10yChange: Math.round(us10yChange * 100) / 100,
        us10yCorrelation: Math.round(us10yCorr * 100) / 100,
        us10yDivergence: us10yDiv.alert,
        us10yDivType: us10yDiv.type,
        spxPrice: Math.round((spxData?.price ?? 5400) * 100) / 100,
        spxChange: Math.round(spxChange * 100) / 100,
        spxCorrelation: Math.round(spxCorr * 100) / 100,
        spxDivergence: spxDiv.alert,
        spxDivType: spxDiv.type,
        goldPrice: macroData.goldPrice,
        goldChange: Math.round(goldChange * 100) / 100,
        overallMacroBias,
        macroBiasStrength: biasStrength,
        description,
      });

      console.log(
        `[Macro] Bias: ${overallMacroBias} (${biasStrength}%) | DXY: ${macroData.dxyChange > 0 ? "+" : ""}${macroData.dxyChange.toFixed(2)}%`,
      );
    } catch (e: any) {
      console.error("[Macro] Error:", e.message);
    }
  },
});
