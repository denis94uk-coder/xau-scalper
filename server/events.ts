/**
 * In-process event bus backing the SSE stream.
 *
 * Replaces Convex's reactive subscriptions. The server owns all state, so when
 * something changes it publishes here and every connected browser is pushed the
 * new value — no polling, no third-party realtime service.
 *
 * Deliberately tiny: a Set of listeners. There is exactly one server process
 * and a handful of browser tabs, so anything more elaborate would be ceremony.
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
  | "research"
  | "risk"
  | "hello";

export interface AppEvent {
  kind: EventKind;
  /** Optional payload. Consumers mostly use this as a nudge to refetch. */
  data?: unknown;
  at: number;
}

type Listener = (e: AppEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publish(kind: EventKind, data?: unknown): void {
  const event: AppEvent = { kind, data, at: Date.now() };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // A broken pipe on one browser tab must not stop the others, and must
      // never propagate into the engine loop that published the event.
    }
  }
}

export function listenerCount(): number {
  return listeners.size;
}
