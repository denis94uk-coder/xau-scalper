import { v } from "convex/values";
import { query } from "./_generated/server";

// List journal entries (newest first)
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("signalJournal")
      .withIndex("by_timestamp")
      .order("desc")
      .take(args.limit ?? 500);
  },
});

// List journal entries for a specific idea
export const listByIdea = query({
  args: { ideaId: v.id("tradingIdeas") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("signalJournal")
      .withIndex("by_idea", q => q.eq("ideaId", args.ideaId))
      .collect();
  },
});

// Count by event type (for stats)
export const countByType = query({
  args: {},
  handler: async ctx => {
    const all = await ctx.db.query("signalJournal").collect();
    const counts: Record<string, number> = {};
    for (const entry of all) {
      counts[entry.eventType] = (counts[entry.eventType] ?? 0) + 1;
    }
    return counts;
  },
});
