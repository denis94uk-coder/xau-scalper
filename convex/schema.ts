import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,

  // Cached price snapshots
  priceSnapshots: defineTable({
    price: v.number(),
    bid: v.number(),
    ask: v.number(),
    high24h: v.number(),
    low24h: v.number(),
    change24h: v.number(),
    changePct24h: v.number(),
    timestamp: v.number(),
  }).index("by_timestamp", ["timestamp"]),

  // OHLC candle data
  candles: defineTable({
    open: v.number(),
    high: v.number(),
    low: v.number(),
    close: v.number(),
    volume: v.number(),
    timestamp: v.number(),
    interval: v.string(),
  }).index("by_interval_timestamp", ["interval", "timestamp"]),

  // Trade journal entries (legacy)
  trades: defineTable({
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
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"]),

  // ─── Trading ideas / signals (auto + manual) ───
  tradingIdeas: defineTable({
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
    status: v.union(
      v.literal("ACTIVE"),
      v.literal("TP1_HIT"),
      v.literal("TP2_HIT"),
      v.literal("STOPPED"),
      v.literal("EXPIRED")
    ),
    pnlPoints: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
    source: v.optional(
      v.union(
        v.literal("dashboard"),
        v.literal("experimental"),
        v.literal("engine")
      )
    ),
    // Signal quality grade (A/B/C)
    grade: v.optional(v.string()),
    // Trailing stop level (updated dynamically)
    trailingSL: v.optional(v.number()),
    // Journey tracking
    journeyLog: v.optional(
      v.array(
        v.object({
          event: v.string(),
          price: v.number(),
          timestamp: v.number(),
        })
      )
    ),
  })
    .index("by_created", ["createdAt"])
    .index("by_status", ["status"])
    .index("by_status_created", ["status", "createdAt"])
    .index("by_source", ["source"])
    .index("by_source_created", ["source", "createdAt"]),

  // ─── Signal Journal — full audit trail of every engine event ───
  signalJournal: defineTable({
    eventType: v.union(
      v.literal("SIGNAL_GENERATED"),
      v.literal("ENTRY_TRIGGERED"),
      v.literal("TP1_HIT"),
      v.literal("TP2_HIT"),
      v.literal("SL_HIT"),
      v.literal("EXPIRED"),
      v.literal("ENGINE_RUN"),
      v.literal("MONITOR_CHECK"),
      v.literal("TRAIL_UPDATE")
    ),
    ideaId: v.optional(v.id("tradingIdeas")),
    direction: v.optional(v.union(v.literal("LONG"), v.literal("SHORT"))),
    price: v.optional(v.number()),
    details: v.string(),
    metadata: v.optional(v.string()), // JSON stringified extra data
    timestamp: v.number(),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_event_type", ["eventType"])
    .index("by_idea", ["ideaId"]),

  // ─── Manual trades (Risk Manager) ───
  manualTrades: defineTable({
    direction: v.union(v.literal("LONG"), v.literal("SHORT")),
    entryPrice: v.number(),
    exitPrice: v.optional(v.number()),
    stopLoss: v.number(),
    takeProfit: v.number(),
    lotSize: v.number(),
    riskAmount: v.optional(v.number()), // $ risk
    status: v.union(
      v.literal("OPEN"),
      v.literal("WIN"),
      v.literal("LOSS"),
      v.literal("BREAKEVEN")
    ),
    pnlPoints: v.optional(v.number()),
    pnlDollars: v.optional(v.number()),
    notes: v.optional(v.string()),
    openedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_opened", ["openedAt"]),

  // ─── Settings (key-value store for intel engines) ───
  settings: defineTable({
    key: v.string(),
    value: v.string(), // JSON stringified
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // User alerts
  alerts: defineTable({
    userId: v.id("users"),
    targetPrice: v.number(),
    direction: v.union(v.literal("ABOVE"), v.literal("BELOW")),
    active: v.boolean(),
    triggeredAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),
});
