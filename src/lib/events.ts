/**
 * Event kinds published by the server over SSE.
 *
 * Mirrors server/events.ts. Kept as a separate frontend module rather than
 * imported across the boundary so the browser bundle never pulls in anything
 * from the server tree (which imports bun:sqlite).
 */
export type EventKind =
  | "ideas"
  | "trades"
  | "journal"
  | "prices"
  | "regime"
  | "engine"
  | "config"
  | "candles"
  | "mt5"
  | "hello";
