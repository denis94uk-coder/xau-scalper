/**
 * Server-side signal engine for XAU Scalper.
 * Runs as Convex cron actions — fetches candles, runs analysis, generates signals.
 * Also monitors active ideas for SL/TP hits every minute.
 */
import { action, internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// ─── Constants ───
const BINANCE_API = "https://data-api.binance.vision/api/v3";
const SYMBOL = "PAXGUSDT";
const MIN_CONFIDENCE = 45;
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

// ─── Indicator calculations (server-side copies) ───

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

function r2(n: number): number {
  return Math.round(n * 100) / 100;
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
  indicators: Record<string, number | undefined>;
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

  const currentATR = atr[last] ?? price * 0.002;

  let bullScore = 0, bearScore = 0;
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
    if (lastRSI < 30) { bullScore += 20; reasons.push(`RSI oversold ${lastRSI.toFixed(0)}`); }
    else if (lastRSI > 70) { bearScore += 20; reasons.push(`RSI overbought ${lastRSI.toFixed(0)}`); }
    else if (lastRSI > 50) bullScore += 5;
    else bearScore += 5;
  }

  // MACD
  if (histogram[last] !== undefined && histogram[last - 1] !== undefined) {
    if (histogram[last] > 0 && histogram[last - 1] <= 0) {
      bullScore += 20; reasons.push("MACD bull cross");
    } else if (histogram[last] < 0 && histogram[last - 1] >= 0) {
      bearScore += 20; reasons.push("MACD bear cross");
    } else if (histogram[last] > 0) {
      bullScore += 8;
    } else {
      bearScore += 8;
    }
  }

  // Stochastic
  const lastK = stoch.k[last];
  if (lastK !== undefined) {
    if (lastK < 20) { bullScore += 15; reasons.push(`Stoch oversold`); }
    else if (lastK > 80) { bearScore += 15; reasons.push(`Stoch overbought`); }
  }

  const total = bullScore + bearScore;
  if (total === 0) return null;

  const biasStrength = Math.round((Math.abs(bullScore - bearScore) / total) * 100);
  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    biasStrength < 15 ? "NEUTRAL" : bullScore > bearScore ? "BULLISH" : "BEARISH";

  if (bias === "NEUTRAL") return null;

  const direction = bias === "BULLISH" ? "LONG" as const : "SHORT" as const;
  const confidence = Math.min(90, Math.round(Math.max(bullScore, bearScore) * 1.2));

  if (confidence < MIN_CONFIDENCE) return null;

  let sl: number, tp1: number, tp2: number;
  if (direction === "LONG") {
    sl = r2(price - currentATR * 1.5);
    const risk = price - sl;
    tp1 = r2(price + risk * 1.5);
    tp2 = r2(price + risk * 2.5);
  } else {
    sl = r2(price + currentATR * 1.5);
    const risk = sl - price;
    tp1 = r2(price - risk * 1.5);
    tp2 = r2(price - risk * 2.5);
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
    indicators: {
      rsi: lastRSI ? r2(lastRSI) : undefined,
      stochK: lastK ? r2(lastK) : undefined,
      macdHist: histogram[last] ? r2(histogram[last]) : undefined,
      ema9: ema9[last] ? r2(ema9[last]) : undefined,
      ema21: ema21[last] ? r2(ema21[last]) : undefined,
      atr: currentATR ? r2(currentATR) : undefined,
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
      v.literal("MONITOR_CHECK")
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

// ─── Internal mutation: update idea with journey ───
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
    if (args.status !== "ACTIVE" && args.status !== "TP1_HIT") {
      patch.resolvedAt = Date.now();
    }

    await ctx.db.patch(args.id, patch);
  },
});

// ═══════════════════════════════════════
// CRON ACTION: Generate signals (every 15 min)
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
      // Fetch 15-min candles for primary analysis
      const candles15m = await fetchCandles("15m", 200);
      const candles5m = await fetchCandles("5m", 200);
      const price = candles15m[candles15m.length - 1]?.close;

      if (!price) return;

      // Analyze on 15-minute timeframe
      const analysis = analyzeCandles(candles15m);

      // Cross-confirm with 5-minute
      const analysis5m = analyzeCandles(candles5m);

      // Log engine run
      await ctx.runMutation(internal.signalEngine._logJournal, {
        eventType: "ENGINE_RUN",
        price,
        details: `15m: ${analysis?.bias ?? "N/A"} (${analysis?.confidence ?? 0}%) | 5m: ${analysis5m?.bias ?? "N/A"} (${analysis5m?.confidence ?? 0}%)`,
        metadata: JSON.stringify({
          analysis15m: analysis ? { bias: analysis.bias, confidence: analysis.confidence, indicators: analysis.indicators } : null,
          analysis5m: analysis5m ? { bias: analysis5m.bias, confidence: analysis5m.confidence } : null,
        }),
      });

      // Only generate if both timeframes agree
      if (!analysis || !analysis5m) return;
      if (analysis.direction !== analysis5m.direction) return;

      // Boost confidence if multi-TF confluence
      const finalConfidence = Math.min(95, analysis.confidence + 10);

      // Create the signal
      const ideaId = await ctx.runMutation(internal.signalEngine._createSignal, {
        direction: analysis.direction,
        entryPrice: analysis.entryPrice,
        stopLoss: analysis.stopLoss,
        tp1: analysis.tp1,
        tp2: analysis.tp2,
        confidence: finalConfidence,
        reason: `[ENGINE] ${analysis.reason}`,
        timeframe: "15m+5m",
        bias: analysis.bias,
        biasStrength: analysis.biasStrength,
        spotPrice: price,
      });

      if (ideaId) {
        await ctx.runMutation(internal.signalEngine._logJournal, {
          eventType: "SIGNAL_GENERATED",
          ideaId,
          direction: analysis.direction,
          price: analysis.entryPrice,
          details: `${analysis.direction} @ ${analysis.entryPrice} | SL: ${analysis.stopLoss} | TP1: ${analysis.tp1} | TP2: ${analysis.tp2} | Confidence: ${finalConfidence}%`,
        });
      }
    } catch (e: any) {
      console.error("Signal engine error:", e.message);
    }
  },
});

// ═══════════════════════════════════════
// CRON ACTION: Monitor active ideas (every 1 min)
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

      // Get all active ideas (we query from a helper)
      const activeIdeas = await ctx.runQuery(
        internal.signalEngine._getActiveIdeas,
        {}
      );

      if (!activeIdeas || activeIdeas.length === 0) return;

      let hits = 0;

      for (const idea of activeIdeas) {
        let event: string | null = null;
        let newStatus: "TP1_HIT" | "TP2_HIT" | "STOPPED" | null = null;
        let pnl = 0;
        let exitPrice = price;

        if (idea.direction === "LONG") {
          if (price >= idea.tp2) {
            newStatus = "TP2_HIT"; event = "TP2_HIT";
            pnl = idea.tp2 - idea.entryPrice; exitPrice = idea.tp2;
          } else if (price >= idea.tp1 && idea.status === "ACTIVE") {
            newStatus = "TP1_HIT"; event = "TP1_HIT";
            pnl = idea.tp1 - idea.entryPrice; exitPrice = idea.tp1;
          } else if (price <= idea.stopLoss) {
            newStatus = "STOPPED"; event = "SL_HIT";
            pnl = idea.stopLoss - idea.entryPrice; exitPrice = idea.stopLoss;
          }
        } else {
          // SHORT
          if (price <= idea.tp2) {
            newStatus = "TP2_HIT"; event = "TP2_HIT";
            pnl = idea.entryPrice - idea.tp2; exitPrice = idea.tp2;
          } else if (price <= idea.tp1 && idea.status === "ACTIVE") {
            newStatus = "TP1_HIT"; event = "TP1_HIT";
            pnl = idea.entryPrice - idea.tp1; exitPrice = idea.tp1;
          } else if (price >= idea.stopLoss) {
            newStatus = "STOPPED"; event = "SL_HIT";
            pnl = idea.entryPrice - idea.stopLoss; exitPrice = idea.stopLoss;
          }
        }

        if (newStatus && event) {
          hits++;
          const roundedPnl = r2(pnl);

          // For TP1_HIT, keep tracking toward TP2
          if (newStatus === "TP1_HIT") {
            await ctx.runMutation(internal.signalEngine._addJourneyEvent, {
              id: idea._id,
              status: "TP1_HIT",
              event: "TP1_HIT",
              price: exitPrice,
              pnlPoints: roundedPnl,
            });
          } else {
            // TP2 or SL — fully close
            await ctx.runMutation(internal.signalEngine._updateIdeaJourney, {
              id: idea._id,
              status: newStatus,
              pnlPoints: roundedPnl,
              exitPrice,
              event,
            });
          }

          // Log to journal
          const journalType = event === "SL_HIT" ? "SL_HIT" as const :
            event === "TP1_HIT" ? "TP1_HIT" as const : "TP2_HIT" as const;

          await ctx.runMutation(internal.signalEngine._logJournal, {
            eventType: journalType,
            ideaId: idea._id,
            direction: idea.direction,
            price: exitPrice,
            details: `${idea.direction} ${event} @ ${exitPrice} | Entry: ${idea.entryPrice} | P&L: ${roundedPnl >= 0 ? "+" : ""}${roundedPnl} pts`,
          });
        }
      }

      // Log monitor check periodically (every 5 min worth)
      if (hits > 0) {
        await ctx.runMutation(internal.signalEngine._logJournal, {
          eventType: "MONITOR_CHECK",
          price,
          details: `Checked ${activeIdeas.length} active ideas, ${hits} triggered @ ${price}`,
        });
      }
    } catch (e: any) {
      console.error("Monitor error:", e.message);
    }
  },
});

// ─── Internal query: get active ideas (for use in actions) ───
import { internalQuery } from "./_generated/server";

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
