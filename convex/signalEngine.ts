/**
 * Server-side signal engine for XAU Scalper.
 * Full capabilities: TA analysis with grading, partial TP, ATR trailing stops.
 * Runs as Convex cron actions — fetches candles, runs analysis, generates signals.
 * Also monitors active ideas for SL/TP hits every minute.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { DEFAULT_ASSET_ID, getAsset, getEnabledAssets } from "./lib/assets";
import {
  analyzeCandles,
  type Candle,
  calcATR,
  DEFAULT_STRATEGY_CONFIG,
  roundTo,
} from "./lib/strategy";

// ─── Constants ───
const BINANCE_API = "https://data-api.binance.vision/api/v3";

// ─── Fetch candles from Binance ───
async function fetchCandles(
  symbol: string,
  interval: string,
  limit = 200,
): Promise<Candle[]> {
  const url = `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
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

async function fetchCurrentPrice(symbol: string): Promise<number> {
  const url = `${BINANCE_API}/ticker/price?symbol=${symbol}`;
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
      v.literal("TRAIL_UPDATE"),
    ),
    ideaId: v.optional(v.id("tradingIdeas")),
    direction: v.optional(v.union(v.literal("LONG"), v.literal("SHORT"))),
    price: v.optional(v.number()),
    details: v.string(),
    metadata: v.optional(v.string()),
    asset: v.optional(v.string()),
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
    asset: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Resolve per-asset cooldown (falls back to the default gold config).
    const assetId = args.asset ?? DEFAULT_ASSET_ID;
    const cooldownMs =
      getAsset(assetId)?.config.cooldownMs ??
      DEFAULT_STRATEGY_CONFIG.cooldownMs;

    // Check cooldown — don't create signal if same direction within cooldown.
    // Cooldown is scoped PER asset so one asset can't block another.
    const recent = await ctx.db
      .query("tradingIdeas")
      .withIndex("by_source_created", q => q.eq("source", "engine"))
      .order("desc")
      .take(50);

    const now = Date.now();
    const duplicate = recent.find(
      r =>
        (r.asset ?? DEFAULT_ASSET_ID) === assetId &&
        r.direction === args.direction &&
        now - r.createdAt < cooldownMs,
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
      v.literal("EXPIRED"),
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
      v.literal("EXPIRED"),
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
  handler: async ctx => {
    // Skip weekends (forex closed)
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (day === 6 || (day === 0 && hour < 21) || (day === 5 && hour >= 22)) {
      return; // Market closed
    }

    // Iterate every enabled asset — each analyses its own feed independently.
    for (const asset of getEnabledAssets()) {
      try {
        // Fetch candles for analysis
        const candles5m = await fetchCandles(asset.dataSourceSymbol, "5m", 200);
        const candles15m = await fetchCandles(
          asset.dataSourceSymbol,
          "15m",
          200,
        );
        const price = candles5m[candles5m.length - 1]?.close;

        if (!price) continue;

        // Primary analysis on 5-minute (scalper timeframe)
        const analysis5m = analyzeCandles(
          candles5m,
          asset.config,
          asset.pricePrecision,
        );

        // Cross-confirm with 15-minute
        const analysis15m = analyzeCandles(
          candles15m,
          asset.config,
          asset.pricePrecision,
        );

        // Log engine run
        await ctx.runMutation(internal.signalEngine._logJournal, {
          eventType: "ENGINE_RUN",
          price,
          asset: asset.id,
          details: `[${asset.displaySymbol}] 5m: ${analysis5m?.bias ?? "N/A"} ${analysis5m?.grade ?? "-"} (${analysis5m?.confidence ?? 0}%) | 15m: ${analysis15m?.bias ?? "N/A"} ${analysis15m?.grade ?? "-"} (${analysis15m?.confidence ?? 0}%)`,
          metadata: JSON.stringify({
            asset: asset.id,
            analysis5m: analysis5m
              ? {
                  bias: analysis5m.bias,
                  confidence: analysis5m.confidence,
                  grade: analysis5m.grade,
                  indicators: analysis5m.indicators,
                }
              : null,
            analysis15m: analysis15m
              ? {
                  bias: analysis15m.bias,
                  confidence: analysis15m.confidence,
                  grade: analysis15m.grade,
                }
              : null,
          }),
        });

        // Need at least the 5m signal
        if (!analysis5m) continue;

        // Multi-TF confluence: both must agree on direction
        if (analysis15m && analysis15m.direction !== analysis5m.direction)
          continue;

        // Only trade A or B grade signals
        if (analysis5m.grade !== "A" && analysis5m.grade !== "B") continue;

        // Boost confidence if multi-TF confluence
        const finalConfidence = analysis15m
          ? Math.min(95, analysis5m.confidence + 10)
          : analysis5m.confidence;

        // Upgrade grade if 15m confirms
        const finalGrade =
          analysis15m && analysis5m.grade === "B" && analysis15m.grade === "A"
            ? "A"
            : analysis5m.grade;

        // Create the signal
        const ideaId = await ctx.runMutation(
          internal.signalEngine._createSignal,
          {
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
            asset: asset.id,
          },
        );

        if (ideaId) {
          await ctx.runMutation(internal.signalEngine._logJournal, {
            eventType: "SIGNAL_GENERATED",
            ideaId,
            direction: analysis5m.direction,
            price: analysis5m.entryPrice,
            asset: asset.id,
            details: `[${asset.displaySymbol}] ${finalGrade} ${analysis5m.direction} @ ${analysis5m.entryPrice} | SL: ${analysis5m.stopLoss} | TP1: ${analysis5m.tp1} | TP2: ${analysis5m.tp2} | Conf: ${finalConfidence}% | ATR: ${analysis5m.atr}`,
          });
        }
      } catch (e: any) {
        console.error(`Signal engine error [${asset.id}]:`, e.message);
      }
    }
  },
});

// ═══════════════════════════════════════
// CRON ACTION: Monitor active ideas (every 1 min)
// Full partial TP + ATR trailing stop logic
// ═══════════════════════════════════════
export const monitorIdeas = internalAction({
  args: {},
  handler: async ctx => {
    // Skip weekends
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (day === 6 || (day === 0 && hour < 21) || (day === 5 && hour >= 22)) {
      return;
    }

    // Fetch every open idea once, then process per asset so each idea is
    // checked against its OWN asset's live price and ATR.
    const allIdeas = await ctx.runQuery(
      internal.signalEngine._getActiveIdeas,
      {},
    );
    if (!allIdeas || allIdeas.length === 0) return;

    for (const asset of getEnabledAssets()) {
      const r = (n: number) => roundTo(n, asset.pricePrecision);
      const activeIdeas = allIdeas.filter(
        idea => (idea.asset ?? DEFAULT_ASSET_ID) === asset.id,
      );
      if (activeIdeas.length === 0) continue;

      try {
        const price = await fetchCurrentPrice(asset.dataSourceSymbol);

        // Also fetch current ATR for trailing stops
        let currentATR = 0;
        try {
          const candles5m = await fetchCandles(
            asset.dataSourceSymbol,
            "5m",
            30,
          );
          const atrArr = calcATR(candles5m, asset.config.atrPeriod);
          currentATR = atrArr[atrArr.length - 1] ?? 0;
        } catch {
          // If ATR fetch fails, we'll skip trailing updates
        }

        let hits = 0;

        for (const idea of activeIdeas) {
          const isLong = idea.direction === "LONG";
          const effectiveSL = idea.trailingSL ?? idea.stopLoss;

          // === Check SL first (use trailing SL if set) ===
          const slHit = isLong ? price <= effectiveSL : price >= effectiveSL;
          if (slHit) {
            hits++;
            const pnl = r(
              isLong
                ? effectiveSL - idea.entryPrice
                : idea.entryPrice - effectiveSL,
            );

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
              const pnl = r(
                isLong
                  ? idea.tp2 - idea.entryPrice
                  : idea.entryPrice - idea.tp2,
              );

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
              const trailDistance =
                currentATR * asset.config.atrTrailMultiplier;
              const newTrailSL = isLong
                ? r(price - trailDistance)
                : r(price + trailDistance);

              const currentTrailSL =
                idea.trailingSL ?? (isLong ? idea.entryPrice : idea.entryPrice);

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
              const pnl = r(
                isLong
                  ? idea.tp1 - idea.entryPrice
                  : idea.entryPrice - idea.tp1,
              );

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
              const pnl = r(
                isLong
                  ? idea.tp2 - idea.entryPrice
                  : idea.entryPrice - idea.tp2,
              );

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
            }
          }
        }

        // Log monitor check if anything happened
        if (hits > 0) {
          await ctx.runMutation(internal.signalEngine._logJournal, {
            eventType: "MONITOR_CHECK",
            price,
            asset: asset.id,
            details: `[${asset.displaySymbol}] Checked ${activeIdeas.length} active ideas, ${hits} triggered @ ${price.toFixed(2)}${currentATR > 0 ? ` | ATR: ${currentATR.toFixed(2)}` : ""}`,
          });
        }
      } catch (e: any) {
        console.error(`Monitor error [${asset.id}]:`, e.message);
      }
    }
  },
});

// ─── Internal query: get active ideas ───
export const _getActiveIdeas = internalQuery({
  args: {},
  handler: async ctx => {
    // Get both ACTIVE and TP1_HIT (still tracking toward TP2)
    const active = await ctx.db
      .query("tradingIdeas")
      .withIndex("by_status", q => q.eq("status", "ACTIVE"))
      .collect();
    const tp1Hit = await ctx.db
      .query("tradingIdeas")
      .withIndex("by_status", q => q.eq("status", "TP1_HIT"))
      .collect();
    return [...active, ...tp1Hit];
  },
});
