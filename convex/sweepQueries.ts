import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// Queries and mutations for liquidity sweep detection (no "use node")

export const saveSweeps = internalMutation({
  args: {
    sweeps: v.string(),
    supportLevels: v.string(),
    resistanceLevels: v.string(),
    totalSweepsDetected: v.number(),
    actionableSweeps: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", q => q.eq("key", "liquiditySweeps"))
      .first();
    const value = JSON.stringify({ ...args, timestamp: Date.now() });
    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("settings", {
        key: "liquiditySweeps",
        value,
        updatedAt: Date.now(),
      });
    }
  },
});

export const getSweeps = query({
  args: {},
  handler: async ctx => {
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", q => q.eq("key", "liquiditySweeps"))
      .first();
    if (!row) return null;
    try {
      const data = JSON.parse(row.value);
      return {
        sweeps: JSON.parse(data.sweeps || "[]"),
        supportLevels: JSON.parse(data.supportLevels || "[]"),
        resistanceLevels: JSON.parse(data.resistanceLevels || "[]"),
        totalSweepsDetected: data.totalSweepsDetected,
        actionableSweeps: data.actionableSweeps,
        timestamp: data.timestamp,
      };
    } catch {
      return null;
    }
  },
});
