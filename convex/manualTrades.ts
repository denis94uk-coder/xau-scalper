import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Log a new manual trade
export const logTrade = mutation({
  args: {
    direction: v.union(v.literal("LONG"), v.literal("SHORT")),
    entryPrice: v.number(),
    stopLoss: v.number(),
    takeProfit: v.number(),
    lotSize: v.number(),
    riskAmount: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("manualTrades", {
      ...args,
      status: "OPEN",
      openedAt: Date.now(),
    });
  },
});

// Close a manual trade
export const closeTrade = mutation({
  args: {
    id: v.id("manualTrades"),
    exitPrice: v.number(),
    status: v.union(
      v.literal("WIN"),
      v.literal("LOSS"),
      v.literal("BREAKEVEN"),
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.id);
    if (!trade) return;

    let pnlPoints: number;
    if (trade.direction === "LONG") {
      pnlPoints = args.exitPrice - trade.entryPrice;
    } else {
      pnlPoints = trade.entryPrice - args.exitPrice;
    }

    const pnlDollars = pnlPoints * trade.lotSize * 100; // rough: 1 lot ≈ 100 units

    await ctx.db.patch(args.id, {
      exitPrice: args.exitPrice,
      status: args.status,
      pnlPoints: Math.round(pnlPoints * 100) / 100,
      pnlDollars: Math.round(pnlDollars * 100) / 100,
      closedAt: Date.now(),
      notes: args.notes ?? trade.notes,
    });
  },
});

// Delete a manual trade
export const deleteTrade = mutation({
  args: { id: v.id("manualTrades") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// List all manual trades
export const listTrades = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("manualTrades")
      .withIndex("by_opened")
      .order("desc")
      .take(args.limit ?? 200);
  },
});

// List open trades
export const listOpenTrades = query({
  args: {},
  handler: async ctx => {
    return await ctx.db
      .query("manualTrades")
      .withIndex("by_status", q => q.eq("status", "OPEN"))
      .collect();
  },
});

// Get trade stats
export const getStats = query({
  args: {},
  handler: async ctx => {
    const all = await ctx.db.query("manualTrades").collect();
    const closed = all.filter(t => t.status !== "OPEN");

    const wins = closed.filter(t => t.status === "WIN");
    const losses = closed.filter(t => t.status === "LOSS");
    const breakevens = closed.filter(t => t.status === "BREAKEVEN");

    const totalPnl = closed.reduce((sum, t) => sum + (t.pnlPoints ?? 0), 0);
    const totalPnlDollars = closed.reduce(
      (sum, t) => sum + (t.pnlDollars ?? 0),
      0,
    );
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

    const grossProfit = wins.reduce(
      (sum, t) => sum + Math.abs(t.pnlPoints ?? 0),
      0,
    );
    const grossLoss = losses.reduce(
      (sum, t) => sum + Math.abs(t.pnlPoints ?? 0),
      0,
    );
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const avgWin =
      wins.length > 0
        ? wins.reduce((s, t) => s + (t.pnlPoints ?? 0), 0) / wins.length
        : 0;
    const avgLoss =
      losses.length > 0
        ? losses.reduce((s, t) => s + Math.abs(t.pnlPoints ?? 0), 0) /
          losses.length
        : 0;

    return {
      totalTrades: closed.length,
      openTrades: all.length - closed.length,
      wins: wins.length,
      losses: losses.length,
      breakevens: breakevens.length,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: Math.round(profitFactor * 100) / 100,
      totalPnlPoints: Math.round(totalPnl * 100) / 100,
      totalPnlDollars: Math.round(totalPnlDollars * 100) / 100,
      avgWinPoints: Math.round(avgWin * 100) / 100,
      avgLossPoints: Math.round(avgLoss * 100) / 100,
      avgRR: avgLoss > 0 ? Math.round((avgWin / avgLoss) * 100) / 100 : 0,
    };
  },
});
