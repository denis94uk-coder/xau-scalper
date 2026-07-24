import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// Queries and mutations for news calendar (no "use node")

export const saveNewsState = internalMutation({
  args: {
    events: v.string(),
    isShieldActive: v.boolean(),
    shieldReason: v.string(),
    nextHighImpactEvent: v.string(),
    minutesToNextEvent: v.number(),
    shieldStartsAt: v.number(),
    shieldEndsAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", q => q.eq("key", "newsShield"))
      .first();
    const value = JSON.stringify({ ...args, timestamp: Date.now() });
    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("settings", {
        key: "newsShield",
        value,
        updatedAt: Date.now(),
      });
    }
  },
});

export const getNewsState = query({
  args: {},
  handler: async ctx => {
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", q => q.eq("key", "newsShield"))
      .first();
    if (!row) return null;
    try {
      const data = JSON.parse(row.value);
      return {
        ...data,
        events: JSON.parse(data.events || "[]"),
        nextHighImpactEvent: data.nextHighImpactEvent
          ? JSON.parse(data.nextHighImpactEvent)
          : null,
      };
    } catch {
      return null;
    }
  },
});
