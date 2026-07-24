import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// Queries and mutations for macro correlation (no "use node")

export const saveMacroState = internalMutation({
  args: {
    dxyPrice: v.number(),
    dxyChange: v.number(),
    dxyCorrelation: v.number(),
    dxyDivergence: v.boolean(),
    dxyDivType: v.string(),
    us10yPrice: v.number(),
    us10yChange: v.number(),
    us10yCorrelation: v.number(),
    us10yDivergence: v.boolean(),
    us10yDivType: v.string(),
    spxPrice: v.number(),
    spxChange: v.number(),
    spxCorrelation: v.number(),
    spxDivergence: v.boolean(),
    spxDivType: v.string(),
    goldPrice: v.number(),
    goldChange: v.number(),
    overallMacroBias: v.string(),
    macroBiasStrength: v.number(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", q => q.eq("key", "macroState"))
      .first();
    const value = JSON.stringify({ ...args, timestamp: Date.now() });
    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("settings", {
        key: "macroState",
        value,
        updatedAt: Date.now(),
      });
    }
  },
});

export const getMacroState = query({
  args: {},
  handler: async ctx => {
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", q => q.eq("key", "macroState"))
      .first();
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  },
});
