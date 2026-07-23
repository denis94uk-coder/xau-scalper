import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// Queries and mutations for regime detection (no "use node")

export const saveRegime = internalMutation({
  args: {
    regime: v.string(),
    confidence: v.number(),
    atrRatio: v.number(),
    adxProxy: v.number(),
    trendStrength: v.number(),
    priceVsEma50: v.number(),
    priceVsEma200: v.number(),
    bbWidth: v.number(),
    rangeHighLow: v.number(),
    recommendedStrategy: v.string(),
    description: v.string(),
    slMultiplier: v.number(),
    tpMultiplier: v.number(),
    positionSizeMultiplier: v.number(),
    minGrade: v.string(),
    favorDirection: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", q => q.eq("key", "marketRegime"))
      .first();

    const value = JSON.stringify({
      ...args,
      timestamp: Date.now(),
    });

    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("settings", {
        key: "marketRegime",
        value,
        updatedAt: Date.now(),
      });
    }
  },
});

export const getRegime = query({
  args: {},
  handler: async ctx => {
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", q => q.eq("key", "marketRegime"))
      .first();
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  },
});
