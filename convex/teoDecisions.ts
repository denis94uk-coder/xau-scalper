import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/** Record a proposal/hold decision without applying any strategy change. */
export const recordDecision = internalMutation({
  args: {
    asset: v.string(),
    strategyId: v.string(),
    regime: v.string(),
    status: v.string(),
    action: v.string(),
    reason: v.string(),
    currentScore: v.number(),
    proposedScore: v.optional(v.number()),
    improvement: v.optional(v.number()),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("signalJournal", {
      eventType: "TEO_DECISION",
      source: "teo",
      asset: args.asset,
      details: `[Teo/${args.strategyId}] ${args.action} ${args.asset} | ${args.reason}`,
      metadata: JSON.stringify({
        strategyId: args.strategyId,
        regime: args.regime,
        status: args.status,
        action: args.action,
        currentScore: args.currentScore,
        proposedScore: args.proposedScore,
        improvement: args.improvement,
        extra: args.metadata,
      }),
      timestamp: now,
    });
    return { ok: true, timestamp: now };
  },
});
