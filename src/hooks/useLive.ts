/**
 * Live data hooks — the replacement for Convex's reactive `useQuery`.
 *
 * One EventSource is shared by the whole app. When the server changes
 * something it publishes an event, and every hook watching that kind refetches.
 * The ergonomics deliberately match what the components already expect:
 * `undefined` while loading, then the value.
 *
 * Why refetch on a nudge rather than push the data itself: the payloads here
 * are small and the queries are indexed SQLite reads on localhost, so a refetch
 * costs almost nothing — and it means every consumer sees consistent state
 * rather than each maintaining its own patched copy.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { EventKind } from "@/lib/events";

type Listener = (kind: EventKind) => void;

// ─── Shared EventSource ───

let source: EventSource | null = null;
const listeners = new Set<Listener>();
let connected = false;
const connectionListeners = new Set<(ok: boolean) => void>();

function setConnected(ok: boolean) {
  if (connected === ok) return;
  connected = ok;
  for (const fn of connectionListeners) fn(ok);
}

function ensureSource() {
  if (source) return;
  source = new EventSource("/api/events");

  source.onopen = () => setConnected(true);

  source.onmessage = e => {
    try {
      const parsed = JSON.parse(e.data) as { kind: EventKind };
      setConnected(true);
      for (const fn of listeners) fn(parsed.kind);
    } catch {
      // Keepalive comment frames and anything malformed are ignored.
    }
  };

  source.onerror = () => {
    // EventSource reconnects on its own; surface the gap so the UI can say so
    // rather than quietly showing stale numbers as if they were live.
    setConnected(false);
  };
}

function subscribe(fn: Listener): () => void {
  ensureSource();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    // Keep the connection open: components mount and unmount constantly during
    // navigation, and tearing the stream down each time would thrash it.
  };
}

/** Whether the event stream is currently connected. */
export function useConnection(): boolean {
  const [ok, setOk] = useState(connected);
  useEffect(() => {
    ensureSource();
    connectionListeners.add(setOk);
    return () => {
      connectionListeners.delete(setOk);
    };
  }, []);
  return ok;
}

// ─── The query hook ───

export interface LiveResult<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Fetch `fetcher()` and refetch whenever the server publishes one of `kinds`.
 *
 * `deps` must contain everything the fetcher closes over — it plays the role of
 * a Convex query's arguments.
 */
export function useLiveQuery<T>(
  fetcher: () => Promise<T>,
  kinds: EventKind[],
  deps: unknown[] = [],
): LiveResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep the latest fetcher without making it a dependency, so an inline
  // arrow function in a component does not retrigger on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const kindKey = kinds.join(",");
  const alive = useRef(true);

  const run = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (!alive.current) return;
      setData(result);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void run();

    const watched = new Set(kindKey.split(","));
    const unsubscribe = subscribe(kind => {
      if (watched.has(kind)) void run();
    });

    return () => {
      alive.current = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindKey, run, ...deps]);

  return { data, error, loading, refetch: run };
}

/**
 * Convex-shaped convenience wrapper: returns the value or `undefined`.
 *
 * Lets existing call sites keep their `data === undefined ? <Skeleton/> : ...`
 * pattern unchanged.
 */
export function useLive<T>(
  fetcher: () => Promise<T>,
  kinds: EventKind[],
  deps: unknown[] = [],
): T | undefined {
  return useLiveQuery(fetcher, kinds, deps).data;
}

/**
 * A mutation with a pending flag.
 *
 * The server publishes an event after every write, so subscribed queries
 * refresh on their own — there is nothing to invalidate by hand.
 */
export function useMutation<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): [(...args: Args) => Promise<R | undefined>, boolean, Error | null] {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const call = useCallback(
    async (...args: Args) => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );

  return [call, pending, error];
}
