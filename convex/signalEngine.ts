/**
 * Server-side signal engine for XAU Scalper.
 * Full capabilities: TA analysis with grading, partial TP, ATR trailing stops.
 * Runs as Convex cron actions — fetches candles, runs analysis, generates signals.
 * Also monitors active ideas for SL/TP hits every minute.
 */
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// ─── Constants ───
const BINANCE_API = "https://data-api.binance.vision/api/v3";
const SYMBOL = "PAXGUSDT";
const SIGNAL_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between signals in same direction

// ─── Types ───
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Indicator calculations ───

function calcEMA(data: number[], period: number): number[] {
  const ema: number[] = [];
  const m = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < data.length; i++) sum += data[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    ema[i] = (data[i] - ema[i - 1]) * m + ema[i - 1];
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) { avgG += gains[i] || 0; avgL += losses[i] || 0; }
  avgG /= period; avgL /= period;
  rsi[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    avgG = (avgG * (period - 1) + (gains[i] || 0)) / period;
    avgL = (avgL * (period - 1) + (losses[i] || 0)) / period;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

function calcMACD(closes: number[]) {
  const fast = calcEMA(closes, 12);
  const slow = calcEMA(closes, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fast[i] !== undefined && slow[i] !== undefined) macdLine[i] = fast[i] - slow[i];
  }
  const vals = macdLine.filter(v => v !== undefined);
  const sig = calcEMA(vals, 9);
  const signal: number[] = [];
  const histogram: number[] = [];
  let idx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== undefined) {
      if (sig[idx] !== undefined) {
        signal[i] = sig[idx];
        histogram[i] = macdLine[i] - sig[idx];
      }
      idx++;
    }
  }
  return { macd: macdLine, signal, histogram };
}

function calcATR(candles: Candle[], period = 14): number[] {
  if (candles.length === 0) return [];
  const tr: number[] = [];
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }
  const atr: number[] = [];
  let s = 0;
  for (let i = 0; i < period; i++) s += tr[i];
  atr[period - 1] = s / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function calcStochastic(candles: Candle[], kPeriod = 14) {
  const k: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const range = hi - lo;
    k[i] = range === 0 ? 50 : ((candles[i].close - lo) / range) * 100;
  }
  return { k };
}

function calcBollingerBands(closes: number[], period = 20, stdDevMult = 2) {
  const upper: number[] = [];
  const lower: number[] = [];
  const middle: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - mean) ** 2;
    const stdDev = Math.sqrt(sqSum / period);
    middle[i] = mean;
    upper[i] = mean + stdDev * stdDevMult;
    lower[i] = mean - stdDev * stdDevMult;
  }
  return { upper, lower, middle };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Signal Grading ───
function gradeSignal(_confidence: number, extremeIndicators: number, totalStrength: number): "A" | "B" | "C" | "NO_TRADE" {
  if (extremeIndicators >= 3 && totalStrength >= 70) return "A";
  if (extremeIndicators >= 2 && totalStrength >= 60) return "B";
  if (totalStrength >= 50) return "C";
  return "NO_TRADE";
}

// ─── Full analysis function ───
function analyzeCandles(candles: Candle[]): {
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  biasStrength: number;
  confidence: number;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  reason: string;
  grade: "A" | "B" | "C" | "NO_TRADE";
  indicators: Record<string, number | undefined>;
  atr: number;
} | null {
  if (candles.length < 60) return null;

  const closes = candles.map(c => c.close);
  const last = candles.length - 1;
  const price = closes[last];

  const rsi = calcRSI(closes, 14);
  const { histogram } = calcMACD(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const atr = calcATR(candles, 14);
  const stoch = calcStochastic(candles);
  const bb = calcBollingerBands(closes);

  const currentATR = atr[last] ?? price * 0.002;

  let bullScore = 0, bearScore = 0;
  let extremeBull = 0, extremeBear = 0;
  const reasons: string[] = [];

  // EMA alignment
  if (ema9[last] !== undefined && ema21[last] !== undefined && ema50[last] !== undefined) {
    if (ema9[last] > ema21[last] && ema21[last] > ema50[last]) {
      bullScore += 25; reasons.push("EMAs bullish");
    } else if (ema9[last] < ema21[last] && ema21[last] < ema50[last]) {
      bearScore += 25; reasons.push("EMAs bearish");
    } else if (ema9[last] > ema21[last]) {
      bullScore += 10; reasons.push("EMA 9>21");
    } else {
      bearScore += 10; reasons.push("EMA 9<21");
    }
  }

  // Price vs EMA21
  if (ema21[last] !== undefined) {
    if (price > ema21[last]) bullScore += 10;
    else bearScore += 10;
  }

  // RSI
  const lastRSI = rsi[last];
  if (lastRSI !== undefined) {
    if (lastRSI < 30) { bullScore += 20; extremeBull++; reasons.push(`RSI oversold ${lastRSI.toFixed(0)}`); }
    else if (lastRSI > 70) { bearScore += 20; extremeBear++; reasons.push(`RSI overbought ${lastRSI.toFixed(0)}`); }
    else if (lastRSI > 50) bullScore += 5;
    else bearScore += 5;
  }

  // MACD
  if (histogram[last] !== undefined && histogram[last - 1] !== undefined) {
    if (histogram[last] > 0 && histogram[last - 1] <= 0) {
      bullScore += 20; extremeBull++; reasons.push("MACD bull cross");
    } else if (histogram[last] < 0 && histogram[last - 1] >= 0) {
      bearScore += 20; extremeBear++; reasons.push("MACD bear cross");
    } else if (histogram[last] > 0) {
      bullScore += 8;
    } else {
      bearScore += 8;
    }
  }

  // Stochastic
  const lastK = stoch.k[last];
  if (lastK !== undefined) {
    if (lastK < 20) { bullScore += 15; extremeBull++; reasons.push("Stoch oversold"); }
    else if (lastK > 80) { bearScore += 15; extremeBear++; reasons.push("Stoch overbought"); }
  }

  // Bollinger Bands
  if (bb.upper[last] !== undefined && bb.lower[last] !== undefined) {
    const bbWidth = bb.upper[last] - bb.lower[last];
    const pricePos = (price - bb.lower[last]) / bbWidth; // 0 = lower band, 1 = upper band
    if (pricePos <= 0.05) {
      bullScore += 18; extremeBull++; reasons.push("BB lower band touch");
    } else if (pricePos >= 0.95) {
      bearScore += 18; extremeBear++; reasons.push("BB upper band touch");
    } else if (pricePos < 0.3) {
      bullScore += 8; reasons.push("BB lower zone");
    } else if (pricePos > 0.7) {
      bearScore += 8; reasons.push("BB upper zone");
    }
  }

  const total = bullScore + bearScore;
  if (total === 0) return null;

  const biasStrength = Math.round((Math.abs(bullScore - bearScore) / total) * 100);
  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    biasStrength < 15 ? "NEUTRAL" : bullScore > bearScore ? "BULLISH" : "BEARISH";

  if (bias === "NEUTRAL") return null;

  const direction = bias === "BULLISH" ? "LONG" as const : "SHORT" as const;
  const confidence = Math.min(95, Math.round(Math.max(bullScore, bearScore) * 1.2));

  // Grade the signal
  const extremeCount = direction === "LONG" ? extremeBull : extremeBear;
  const strength = Math.max(bullScore, bearScore);
  const grade = gradeSignal(confidence, extremeCount, strength);

  // Only generate tradeable signals (A or B grade)
  if (grade === "NO_TRADE") return null;

  // TP/SL with partial TP system: TP1 @ 1.2R, TP2 @ 2.5R
  let sl: number, tp1: number, tp2: number;
  if (direction === "LONG") {
    sl = r2(price - currentATR * 1.5);
    const risk = price - sl;
    tp1 = r2(price + risk * 1.2);  // Partial TP at 1.2R
    tp2 = r2(price + risk * 2.5);  // Full TP at 2.5R
  } else {
    sl = r2(price + currentATR * 1.5);
    const risk = sl - price;
    tp1 = r2(price - risk * 1.2);  // Partial TP at 1.2R
    tp2 = r2(price - risk * 2.5);  // Full TP at 2.5R
  }

  return {
    bias,
    biasStrength,
    confidence,
    direction,
    entryPrice: r2(price),
    stopLoss: sl,
    tp1,
    tp2,
    reason: reasons.join(" · "),
    grade,
    atr: r2(currentATR),
    indicators: {
      rsi: lastRSI ? r2(lastRSI) : undefined,
      stochK: lastK ? r2(lastK) : undefined,
      macdHist: histogram[last] ? r2(histogram[last]) : undefined,
      ema9: ema9[last] ? r2(ema9[last]) : undefined,
      ema21: ema21[last] ? r2(ema21[last]) : undefined,
      atr: currentATR ? r2(currentATR) : undefined,
      bbUpper: bb.upper[last] ? r2(bb.upper[last]) : undefined,
      bbLower: bb.lower[last] ? r2(bb.lower[last]) : undefined,
    },
  };
}

// ─── Fetch candles from Binance ───
async function fetchCandles(interval: string, limit = 200): Promise<Candle[]> {
  const url = `${BINANCE_API}/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API ${res.status}`);
  const data = await res.json();
  return data.map((k: any[]) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetchCurrentPrice(): Promise<number> {
  const url = `${BINANCE_API}/ticker/price?symbol=${SYMBOL}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  const data = await res.json();
  return parseFloat(data.price);
}

// ─── Internal mutation: log journal entry ───
export const _logJournal = internalMutation({
  args: {
    eventType: v.union(
      v.literal("SIGNAL_GENERATED"),
      v.literal("ENTRY_TRIGGERED"),
      v.literal("TP1_HIT"),
      v.literal("TP2_HIT"),
      v.literal("SL_HIT"),
      v.literal("EXPIRED"),
      v.literal("ENGINE_RUN"),
      v.literal("MONITOR_CHECK"),
      v.literal("TRAIL_UPDATE")
    ),
    ideaId: v.optional(v.id("tradingIdeas")),
    direction: v.optional(v.union(v.literal("LONG"), v.literal("SHORT"))),
    price: v.optional(v.number()),
    details: v.string(),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("signalJournal", {
      ...args,
      timestamp: Date.now(),
    });
  },
});

// ─── Internal mutation: create signal as trading idea ───
export const _createSignal = internalMutation({
  args: {
    direction: v.union(v.literal("LONG"), v.literal("SHORT")),
    entryPrice: v.number(),
    stopLoss: v.number(),
    tp1: v.number(),
    tp2: v.number(),
    confidence: v.number(),
    reason: v.string(),
    timeframe: v.string(),
    bias: v.string(),
    biasStrength: v.number(),
    spotPrice: v.number(),
    grade: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check cooldown — don't create signal if same direction within cooldown
    const recent = await ctx.db
      .query("tradingIdeas")
      .withIndex("by_source_created", (q) => q.eq("source", "engine"))
      .order("desc")
      .take(5);

    const now = Date.now();
    const duplicate = recent.find(
      (r) =>
        r.direction === args.direction &&
        now - r.createdAt < SIGNAL_COOLDOWN_MS
    );
    if (duplicate) return null;

    const id = await ctx.db.insert("tradingIdeas", {
      ...args,
      source: "engine",
      status: "ACTIVE",
      grade: args.grade,
      createdAt: now,
      journeyLog: [
        {
          event: "SIGNAL_GENERATED",
          price: args.spotPrice,
          timestamp: now,
        },
        {
          event: "ENTRY_TRIGGERED",
          price: args.entryPrice,
          timestamp: now,
        },
      ],
    });
    return id;
  },
});

// ─── Internal mutation: update idea with journey (full close) ───
export const _updateIdeaJourney = internalMutation({
  args: {
    id: v.id("tradingIdeas"),
    status: v.union(
      v.literal("TP1_HIT"),
      v.literal("TP2_HIT"),
      v.literal("STOPPED"),
      v.literal("EXPIRED")
    ),
    pnlPoints: v.number(),
    exitPrice: v.number(),
    event: v.string(),
  },
  handler: async (ctx, args) => {
    const idea = await ctx.db.get(args.id);
    if (!idea) return;

    const journeyLog = idea.journeyLog ?? [];
    journeyLog.push({
      event: args.event,
      price: args.exitPrice,
      timestamp: Date.now(),
    });

    await ctx.db.patch(args.id, {
      status: args.status,
      pnlPoints: args.pnlPoints,
      resolvedAt: Date.now(),
      journeyLog,
    });
  },
});

// ─── Internal mutation: add journey event without closing ───
export const _addJourneyEvent = internalMutation({
  args: {
    id: v.id("tradingIdeas"),
    status: v.union(
      v.literal("ACTIVE"),
      v.literal("TP1_HIT"),
      v.literal("TP2_HIT"),
      v.literal("STOPPED"),
      v.literal("EXPIRED")
    ),
    event: v.string(),
    price: v.number(),
    pnlPoints: v.optional(v.number()),
    trailingSL: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const idea = await ctx.db.get(args.id);
    if (!idea) return;

    const journeyLog = idea.journeyLog ?? [];
    journeyLog.push({
      event: args.event,
      price: args.price,
      timestamp: Date.now(),
    });

    const patch: any = { journeyLog, status: args.status };
    if (args.pnlPoints !== undefined) patch.pnlPoints = args.pnlPoints;
    if (args.trailingSL !== undefined) patch.trailingSL = args.trailingSL;
    if (args.status !== "ACTIVE" && args.status !== "TP1_HIT") {
      patch.resolvedAt = Date.now();
    }

    await ctx.db.patch(args.id, patch);
  },
});

// ─── Internal mutation: update trailing stop level ───
export const _updateTrailingSL = internalMutation({
  args: {
    id: v.id("tradingIdeas"),
    trailingSL: v.number(),
  },
  handler: async (ctx, args) => {
    const idea = await ctx.db.get(args.id);
    if (!idea) return;

    const journeyLog = idea.journeyLog ?? [];
    journeyLog.push({
      event: "TRAIL_SL_UPDATE",
      price: args.trailingSL,
      timestamp: Date.now(),
    });

    await ctx.db.patch(args.id, {
      trailingSL: args.trailingSL,
      journeyLog,
    });
  },
});

// ═══════════════════════════════════════
// CRON ACTION: Generate signals (every 5 min)
// ═══════════════════════════════════════
export const generateSignals = internalAction({
  args: {},
  handler: async (ctx) => {
    // Skip weekends (forex closed)
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (day === 6 || (day === 0 && hour < 21) || (day === 5 && hour >= 22)) {
      return; // Market closed
    }

    try {
      // Fetch candles for analysis
      const candles5m = await fetchCandles("5m", 200);
      const candles15m = await fetchCandles("15m", 200);
      const price = candles5m[candles5m.length - 1]?.close;

      if (!price) return;

      // Primary analysis on 5-minute (scalper timeframe)
      const analysis5m = analyzeCandles(candles5m);

      // Cross-confirm with 15-minute
      const analysis15m = analyzeCandles(candles15m);

      // Log engine run
      await ctx.runMutation(internal.signalEngine._logJournal, {
        eventType: "ENGINE_RUN",
        price,
        details: `5m: ${analysis5m?.bias ?? "N/A"} ${analysis5m?.grade ?? "-"} (${analysis5m?.confidence ?? 0}%) | 15m: ${analysis15m?.bias ?? "N/A"} ${analysis15m?.grade ?? "-"} (${analysis15m?.confidence ?? 0}%)`,
        metadata: JSON.stringify({
          analysis5m: analysis5m ? { bias: analysis5m.bias, confidence: analysis5m.confidence, grade: analysis5m.grade, indicators: analysis5m.indicators } : null,
          analysis15m: analysis15m ? { bias: analysis15m.bias, confidence: analysis15m.confidence, grade: analysis15m.grade } : null,
        }),
      });

      // Need at least the 5m signal
      if (!analysis5m) return;

      // Multi-TF confluence: both must agree on direction
      if (analysis15m && analysis15m.direction !== analysis5m.direction) return;

      // Only trade A or B grade signals
      if (analysis5m.grade !== "A" && analysis5m.grade !== "B") return;

      // Boost confidence if multi-TF confluence
      const finalConfidence = analysis15m
        ? Math.min(95, analysis5m.confidence + 10)
        : analysis5m.confidence;

      // Upgrade grade if 15m confirms
      const finalGrade = analysis15m && analysis5m.grade === "B" && analysis15m.grade === "A"
        ? "A" : analysis5m.grade;

      // Create the signal
      const ideaId = await ctx.runMutation(internal.signalEngine._createSignal, {
        direction: analysis5m.direction,
        entryPrice: analysis5m.entryPrice,
        stopLoss: analysis5m.stopLoss,
        tp1: analysis5m.tp1,
        tp2: analysis5m.tp2,
        confidence: finalConfidence,
        reason: `[ENGINE] ${analysis5m.reason}${analysis15m ? " · 15m confirms" : ""}`,
        timeframe: analysis15m ? "5m+15m" : "5m",
        bias: analysis5m.bias,
        biasStrength: analysis5m.biasStrength,
        spotPrice: price,
        grade: finalGrade,
      });

      if (ideaId) {
        await ctx.runMutation(internal.signalEngine._logJournal, {
          eventType: "SIGNAL_GENERATED",
          ideaId,
          direction: analysis5m.direction,
          price: analysis5m.entryPrice,
          details: `${finalGrade} ${analysis5m.direction} @ ${analysis5m.entryPrice} | SL: ${analysis5m.stopLoss} | TP1: ${analysis5m.tp1} | TP2: ${analysis5m.tp2} | Conf: ${finalConfidence}% | ATR: ${analysis5m.atr}`,
        });
      }
    } catch (e: any) {
      console.error("Signal engine error:", e.message);
    }
  },
});

// ═══════════════════════════════════════
// CRON ACTION: Monitor active ideas (every 1 min)
// Full partial TP + ATR trailing stop logic
// ═══════════════════════════════════════
export const monitorIdeas = internalAction({
  args: {},
  handler: async (ctx) => {
    // Skip weekends
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (day === 6 || (day === 0 && hour < 21) || (day === 5 && hour >= 22)) {
      return;
    }

    try {
      const price = await fetchCurrentPrice();

      // Also fetch current ATR for trailing stops
      let currentATR = 0;
      try {
        const candles5m = await fetchCandles("5m", 30);
        const atrArr = calcATR(candles5m, 14);
        currentATR = atrArr[atrArr.length - 1] ?? 0;
      } catch {
        // If ATR fetch fails, we'll skip trailing updates
      }

      // Get all active ideas
      const activeIdeas = await ctx.runQuery(
        internal.signalEngine._getActiveIdeas,
        {}
      );

      if (!activeIdeas || activeIdeas.length === 0) return;

      let hits = 0;

      for (const idea of activeIdeas) {
        const isLong = idea.direction === "LONG";
        const effectiveSL = idea.trailingSL ?? idea.stopLoss;

        // === Check SL first (use trailing SL if set) ===
        const slHit = isLong ? price <= effectiveSL : price >= effectiveSL;
        if (slHit) {
          hits++;
          const pnl = r2(isLong ? effectiveSL - idea.entryPrice : idea.entryPrice - effectiveSL);

          await ctx.runMutation(internal.signalEngine._updateIdeaJourney, {
            id: idea._id,
            status: "STOPPED",
            pnlPoints: pnl,
            exitPrice: effectiveSL,
            event: idea.trailingSL ? "TRAIL_SL_HIT" : "SL_HIT",
          });

          await ctx.runMutation(internal.signalEngine._logJournal, {
            eventType: "SL_HIT",
            ideaId: idea._id,
            direction: idea.direction,
            price: effectiveSL,
            details: `${idea.direction} ${idea.trailingSL ? "TRAIL " : ""}SL @ ${effectiveSL.toFixed(2)} | Entry: ${idea.entryPrice.toFixed(2)} | P&L: ${pnl >= 0 ? "+" : ""}${pnl} pts`,
          });
          continue;
        }

        // === Check TP2 (full close) — for ideas already at TP1_HIT ===
        if (idea.status === "TP1_HIT") {
          const tp2Hit = isLong ? price >= idea.tp2 : price <= idea.tp2;
          if (tp2Hit) {
            hits++;
            const pnl = r2(isLong ? idea.tp2 - idea.entryPrice : idea.entryPrice - idea.tp2);

            await ctx.runMutation(internal.signalEngine._updateIdeaJourney, {
              id: idea._id,
              status: "TP2_HIT",
              pnlPoints: pnl,
              exitPrice: idea.tp2,
              event: "TP2_HIT",
            });

            await ctx.runMutation(internal.signalEngine._logJournal, {
              eventType: "TP2_HIT",
              ideaId: idea._id,
              direction: idea.direction,
              price: idea.tp2,
              details: `${idea.direction} TP2 @ ${idea.tp2.toFixed(2)} | Entry: ${idea.entryPrice.toFixed(2)} | P&L: +${pnl} pts`,
            });
            continue;
          }

          // === ATR Trailing Stop (only after TP1 hit) ===
          if (currentATR > 0) {
            const trailDistance = currentATR * 2;
            const newTrailSL = isLong
              ? r2(price - trailDistance)
              : r2(price + trailDistance);

            const currentTrailSL = idea.trailingSL ?? (isLong ? idea.entryPrice : idea.entryPrice);

            // Only update if trailing SL improved (moved in favorable direction)
            const shouldUpdate = isLong
              ? newTrailSL > currentTrailSL
              : newTrailSL < currentTrailSL;

            if (shouldUpdate) {
              await ctx.runMutation(internal.signalEngine._updateTrailingSL, {
                id: idea._id,
                trailingSL: newTrailSL,
              });
            }
          }
          continue;
        }

        // === Check TP1 (partial close — move SL to breakeven) ===
        if (idea.status === "ACTIVE") {
          const tp1Hit = isLong ? price >= idea.tp1 : price <= idea.tp1;
          if (tp1Hit) {
            hits++;
            const pnl = r2(isLong ? idea.tp1 - idea.entryPrice : idea.entryPrice - idea.tp1);

            // Move to TP1_HIT status and set trailing SL to breakeven
            await ctx.runMutation(internal.signalEngine._addJourneyEvent, {
              id: idea._id,
              status: "TP1_HIT",
              event: "TP1_HIT",
              price: idea.tp1,
              pnlPoints: pnl,
              trailingSL: idea.entryPrice, // Move SL to breakeven
            });

            await ctx.runMutation(internal.signalEngine._logJournal, {
              eventType: "TP1_HIT",
              ideaId: idea._id,
              direction: idea.direction,
              price: idea.tp1,
              details: `${idea.direction} TP1 @ ${idea.tp1.toFixed(2)} | Entry: ${idea.entryPrice.toFixed(2)} | P&L: +${pnl} pts | SL → BE @ ${idea.entryPrice.toFixed(2)} | Now trailing to TP2`,
            });
            continue;
          }

          // === Check TP2 directly (rare but possible on gap) ===
          const tp2Hit = isLong ? price >= idea.tp2 : price <= idea.tp2;
          if (tp2Hit) {
            hits++;
            const pnl = r2(isLong ? idea.tp2 - idea.entryPrice : idea.entryPrice - idea.tp2);

            await ctx.runMutation(internal.signalEngine._updateIdeaJourney, {
              id: idea._id,
              status: "TP2_HIT",
              pnlPoints: pnl,
              exitPrice: idea.tp2,
              event: "TP2_HIT",
            });

            await ctx.runMutation(internal.signalEngine._logJournal, {
              eventType: "TP2_HIT",
              ideaId: idea._id,
              direction: idea.direction,
              price: idea.tp2,
              details: `${idea.direction} TP2 (gap) @ ${idea.tp2.toFixed(2)} | Entry: ${idea.entryPrice.toFixed(2)} | P&L: +${pnl} pts`,
            });
            continue;
          }
        }
      }

      // Log monitor check if anything happened
      if (hits > 0) {
        await ctx.runMutation(internal.signalEngine._logJournal, {
          eventType: "MONITOR_CHECK",
          price,
          details: `Checked ${activeIdeas.length} active ideas, ${hits} triggered @ ${price.toFixed(2)}${currentATR > 0 ? ` | ATR: ${currentATR.toFixed(2)}` : ""}`,
        });
      }
    } catch (e: any) {
      console.error("Monitor error:", e.message);
    }
  },
});

// ─── Internal query: get active ideas ───
export const _getActiveIdeas = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Get both ACTIVE and TP1_HIT (still tracking toward TP2)
    const active = await ctx.db
      .query("tradingIdeas")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .collect();
    const tp1Hit = await ctx.db
      .query("tradingIdeas")
      .withIndex("by_status", (q) => q.eq("status", "TP1_HIT"))
      .collect();
    return [...active, ...tp1Hit];
  },
});
