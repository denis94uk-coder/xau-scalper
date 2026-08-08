import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { DEFAULT_ASSET_ID, getAsset } from "./lib/assets";

/**
 * proposeTrade — called by the Teo Python service via POST /teo/propose
 * Records a trading idea BEFORE outcome is known (true forward test).
 * Writes an immutable signalJournal entry atomically.
 */
export const proposeTrade = internalMutation({
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
    asset: v.optional(v.string()),
    teoScore: v.optional(v.number()),
    teoRegime: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const symbol = args.asset ?? DEFAULT_ASSET_ID;
    // Reject symbols the dashboard doesn't actually track — a forward-test
    // record for an unknown asset can never be monitored or resolved.
    if (!getAsset(symbol)) {
      throw new Error(`unknown asset ${symbol}`);
    }

    // Insert the idea (before outcome is known — true forward test)
    const ideaId = await ctx.db.insert("tradingIdeas", {
      direction: args.direction,
      entryPrice: args.entryPrice,
      stopLoss: args.stopLoss,
      tp1: args.tp1,
      tp2: args.tp2,
      confidence: args.confidence,
      reason: args.reason,
      timeframe: args.timeframe,
      bias: args.bias,
      biasStrength: args.biasStrength,
      spotPrice: args.spotPrice,
      asset: symbol,
      source: "teo",
      teoScore: args.teoScore,
      teoRegime: args.teoRegime,
      status: "ACTIVE",
      createdAt: now,
      journeyLog: [{ event: "CREATED", price: args.spotPrice, timestamp: now }],
    });

    // Immutable audit trail entry
    await ctx.db.insert("signalJournal", {
      eventType: "SIGNAL_GENERATED",
      ideaId,
      source: "teo",
      asset: symbol,
      direction: args.direction,
      price: args.entryPrice,
      details: `[Teo] ${args.direction} ${symbol} @ ${args.entryPrice} | regime: ${args.teoRegime ?? "unknown"} | score: ${args.teoScore ?? "n/a"}`,
      metadata: JSON.stringify({
        teoScore: args.teoScore,
        teoRegime: args.teoRegime,
        asset: symbol,
        confidence: args.confidence,
      }),
      timestamp: now,
    });

    return ideaId;
  },
});
