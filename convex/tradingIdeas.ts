import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Log a new trading idea
export const logIdea = mutation({
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
    source: v.optional(
      v.union(
        v.literal("dashboard"),
        v.literal("experimental"),
        v.literal("engine"),
      ),
    ),
    grade: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("tradingIdeas", {
      ...args,
      source: args.source ?? "dashboard",
      grade: args.grade,
      status: "ACTIVE",
      createdAt: now,
      journeyLog: [
        { event: "CREATED", price: args.spotPrice, timestamp: now },
        { event: "ENTRY_TRIGGERED", price: args.entryPrice, timestamp: now },
      ],
    });
  },
});

// List all ideas (newest first), with optional limit
export const listIdeas = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    return await ctx.db
      .query("tradingIdeas")
      .withIndex("by_created")
      .order("desc")
      .take(limit);
  },
});

// List only active ideas (ACTIVE + TP1_HIT still tracking)
export const listActiveIdeas = query({
  args: {},
  handler: async ctx => {
    const active = await ctx.db
      .query("tradingIdeas")
      .withIndex("by_status", q => q.eq("status", "ACTIVE"))
      .collect();
    const tp1 = await ctx.db
      .query("tradingIdeas")
      .withIndex("by_status", q => q.eq("status", "TP1_HIT"))
      .collect();
    return [...active, ...tp1];
  },
});

// Update idea status (when TP or SL is hit)
export const updateIdeaStatus = mutation({
  args: {
    id: v.id("tradingIdeas"),
    status: v.union(
      v.literal("ACTIVE"),
      v.literal("TP1_HIT"),
      v.literal("TP2_HIT"),
      v.literal("STOPPED"),
      v.literal("EXPIRED"),
    ),
    pnlPoints: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const idea = await ctx.db.get(args.id);
    if (!idea) return;

    const journeyLog = idea.journeyLog ?? [];
    journeyLog.push({
      event: args.status,
      price: args.pnlPoints
        ? idea.entryPrice +
          (idea.direction === "LONG" ? args.pnlPoints : -args.pnlPoints)
        : idea.entryPrice,
      timestamp: Date.now(),
    });

    await ctx.db.patch(args.id, {
      status: args.status,
      pnlPoints: args.pnlPoints,
      resolvedAt:
        args.status !== "ACTIVE" && args.status !== "TP1_HIT"
          ? Date.now()
          : undefined,
      journeyLog,
    });
  },
});

// Delete an idea
export const deleteIdea = mutation({
  args: { id: v.id("tradingIdeas") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// ─── Performance stats query ───
export const getPerformanceStats = query({
  args: {
    source: v.optional(
      v.union(
        v.literal("dashboard"),
        v.literal("experimental"),
        v.literal("engine"),
        v.literal("all"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    let all = await ctx.db.query("tradingIdeas").collect();

    // Filter by source if specified
    if (args.source && args.source !== "all") {
      all = all.filter(i => i.source === args.source);
    }

    const closed = all.filter(
      i =>
        i.status === "TP1_HIT" ||
        i.status === "TP2_HIT" ||
        i.status === "STOPPED" ||
        i.status === "EXPIRED",
    );

    const active = all.filter(
      i => i.status === "ACTIVE" || i.status === "TP1_HIT",
    );
    const wins = closed.filter(
      i => i.status === "TP1_HIT" || i.status === "TP2_HIT",
    );
    const losses = closed.filter(i => i.status === "STOPPED");
    const expired = closed.filter(i => i.status === "EXPIRED");

    const totalPnl = closed.reduce((sum, i) => sum + (i.pnlPoints ?? 0), 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

    const grossProfit = wins.reduce(
      (sum, i) => sum + Math.abs(i.pnlPoints ?? 0),
      0,
    );
    const grossLoss = losses.reduce(
      (sum, i) => sum + Math.abs(i.pnlPoints ?? 0),
      0,
    );
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    const avgWin =
      wins.length > 0
        ? wins.reduce((s, i) => s + (i.pnlPoints ?? 0), 0) / wins.length
        : 0;
    const avgLoss =
      losses.length > 0
        ? losses.reduce((s, i) => s + Math.abs(i.pnlPoints ?? 0), 0) /
          losses.length
        : 0;

    // Win/loss streaks
    let currentStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    const sortedClosed = [...closed].sort(
      (a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0),
    );
    for (const idea of sortedClosed) {
      if (idea.status === "TP1_HIT" || idea.status === "TP2_HIT") {
        currentStreak = currentStreak > 0 ? currentStreak + 1 : 1;
        maxWinStreak = Math.max(maxWinStreak, currentStreak);
      } else {
        currentStreak = currentStreak < 0 ? currentStreak - 1 : -1;
        maxLossStreak = Math.max(maxLossStreak, Math.abs(currentStreak));
      }
    }

    // Daily P&L for chart
    const dailyPnl: Record<string, number> = {};
    for (const idea of closed) {
      const date = new Date(idea.resolvedAt ?? idea.createdAt)
        .toISOString()
        .split("T")[0];
      dailyPnl[date] = (dailyPnl[date] ?? 0) + (idea.pnlPoints ?? 0);
    }

    // Equity curve
    let equity = 0;
    const equityCurve = sortedClosed.map(idea => {
      equity += idea.pnlPoints ?? 0;
      return {
        date: idea.resolvedAt ?? idea.createdAt,
        equity: Math.round(equity * 100) / 100,
        pnl: idea.pnlPoints ?? 0,
      };
    });

    return {
      totalSignals: all.length,
      activeSignals: active.length,
      closedSignals: closed.length,
      wins: wins.length,
      losses: losses.length,
      expired: expired.length,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: Math.round(profitFactor * 100) / 100,
      totalPnlPoints: Math.round(totalPnl * 100) / 100,
      avgWinPoints: Math.round(avgWin * 100) / 100,
      avgLossPoints: Math.round(avgLoss * 100) / 100,
      avgRR: avgLoss > 0 ? Math.round((avgWin / avgLoss) * 100) / 100 : 0,
      maxWinStreak,
      maxLossStreak,
      currentStreak,
      dailyPnl,
      equityCurve,
    };
  },
});
