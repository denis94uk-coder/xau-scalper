import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const tradeDoc = v.object({
  _id: v.id("trades"),
  _creationTime: v.number(),
  userId: v.id("users"),
  type: v.union(v.literal("BUY"), v.literal("SELL")),
  entryPrice: v.number(),
  exitPrice: v.optional(v.number()),
  lotSize: v.number(),
  stopLoss: v.optional(v.number()),
  takeProfit: v.optional(v.number()),
  pnl: v.optional(v.number()),
  status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
  notes: v.optional(v.string()),
  openedAt: v.number(),
  closedAt: v.optional(v.number()),
});

export const list = query({
  args: {},
  returns: v.array(tradeDoc),
  handler: async ctx => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("trades")
      .withIndex("by_user", q => q.eq("userId", userId))
      .order("desc")
      .collect();
  },
});

export const getOpen = query({
  args: {},
  returns: v.array(tradeDoc),
  handler: async ctx => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("trades")
      .withIndex("by_user_status", q =>
        q.eq("userId", userId).eq("status", "OPEN"),
      )
      .collect();
  },
});

export const openTrade = mutation({
  args: {
    type: v.union(v.literal("BUY"), v.literal("SELL")),
    entryPrice: v.number(),
    lotSize: v.number(),
    stopLoss: v.optional(v.number()),
    takeProfit: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: v.id("trades"),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("trades", {
      userId,
      type: args.type,
      entryPrice: args.entryPrice,
      lotSize: args.lotSize,
      stopLoss: args.stopLoss,
      takeProfit: args.takeProfit,
      notes: args.notes,
      pnl: undefined,
      exitPrice: undefined,
      status: "OPEN",
      openedAt: Date.now(),
      closedAt: undefined,
    });
  },
});

export const closeTrade = mutation({
  args: {
    tradeId: v.id("trades"),
    exitPrice: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const trade = await ctx.db.get(args.tradeId);
    if (!trade || trade.userId !== userId) throw new Error("Trade not found");
    if (trade.status === "CLOSED") throw new Error("Trade already closed");

    const pips =
      trade.type === "BUY"
        ? args.exitPrice - trade.entryPrice
        : trade.entryPrice - args.exitPrice;
    const pnl = pips * trade.lotSize * 100; // simplified PnL

    await ctx.db.patch(args.tradeId, {
      exitPrice: args.exitPrice,
      pnl,
      status: "CLOSED",
      closedAt: Date.now(),
    });
    return null;
  },
});

export const deleteTrade = mutation({
  args: { tradeId: v.id("trades") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const trade = await ctx.db.get(args.tradeId);
    if (!trade || trade.userId !== userId) throw new Error("Trade not found");
    await ctx.db.delete(args.tradeId);
    return null;
  },
});
