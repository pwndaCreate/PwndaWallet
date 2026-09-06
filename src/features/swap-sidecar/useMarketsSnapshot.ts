/**
 * src/features/swap-sidecar/useMarketsSnapshot.ts
 *
 * Reads the public BasicSwap market snapshot for whichever P2P surface is on
 * screen, and only while one is.
 *
 * # Fetch policy, and why it is not "on launch"
 *
 * The wallet routes swap traffic over i2p/Tor and goes to some length not to
 * announce itself. Fetching a public market API at boot would tell a third
 * party "this IP runs a swap-capable wallet" before the user has opened
 * anything or agreed to anything — a privacy cost paid by every user,
 * including the ones who never touch P2P.
 *
 * So the hook is `enabled`-gated and every caller passes "is my surface
 * visible". Opening Swap ▸ P2P or EARN fetches; the rest of the app does not.
 * Nothing is requested until the user has expressed interest by navigating to
 * a P2P surface, and `MarketPreview` names the source on screen whenever it
 * renders anything derived from this.
 *
 * # One fetch, many mounts
 *
 * The snapshot is process-wide state, not per-component: Swap and EARN can be
 * mounted in the same session, both layouts render the same block, and the
 * publisher caches for 10 minutes anyway. A module-level cache with an
 * in-flight promise means N mounts produce ONE request, and a remount inside
 * the TTL produces none. Written as a plain module cache rather than a context
 * because there is exactly one snapshot and no configuration to thread.
 */
import { useCallback, useEffect, useState } from "react";
import {
  type MarketSnapshot,
  MarketSnapshotError,
  fetchMarketSnapshot,
} from "./marketsSnapshot";

/**
 * How long a snapshot is reused before another fetch is allowed.
 *
 * Five minutes, against a publisher that regenerates roughly every five and
 * serves `cache-control: max-age=600`. Polling faster cannot produce fresher
 * data — it can only produce more requests, which is the exact cost this
 * module is trying not to impose.
 */
export const SNAPSHOT_TTL_MS = 5 * 60_000;

/** Failures are cached too, briefly, so a down publisher is not hammered. */
export const SNAPSHOT_ERROR_TTL_MS = 60_000;

interface CacheEntry {
  snapshot: MarketSnapshot | null;
  error: string | null;
  at: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;

/** Test seam — resets module state between cases. */
export function __resetMarketSnapshotCache(): void {
  cache = null;
  inFlight = null;
}

function fresh(entry: CacheEntry, now: number): boolean {
  const ttl = entry.snapshot ? SNAPSHOT_TTL_MS : SNAPSHOT_ERROR_TTL_MS;
  return now - entry.at < ttl;
}

async function load(force: boolean): Promise<CacheEntry> {
  const now = Date.now();
  if (!force && cache && fresh(cache, now)) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const snapshot = await fetchMarketSnapshot();
      return { snapshot, error: null, at: Date.now() };
    } catch (e) {
      return {
        snapshot: null,
        error:
          e instanceof MarketSnapshotError || e instanceof Error
            ? e.message
            : "market snapshot unavailable",
        at: Date.now(),
      };
    }
  })()
    .then((entry) => {
      cache = entry;
      return entry;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export interface MarketsSnapshotState {
  snapshot: MarketSnapshot | null;
  loading: boolean;
  /**
   * Why the preview is unavailable, when it is.
   *
   * Rendered as "preview unavailable", never as an empty market: a publisher
   * outage and a dead network look identical in the data and must not look
   * identical on screen. The whole point of this surface is to tell a user
   * whether there is a market worth opting in for, and answering "no" when we
   * simply could not ask would be the most expensive possible lie here.
   */
  error: string | null;
  refresh: () => void;
}

export function useMarketsSnapshot(opts: {
  enabled: boolean;
}): MarketsSnapshotState {
  const { enabled } = opts;
  const [entry, setEntry] = useState<CacheEntry | null>(() =>
    cache && fresh(cache, Date.now()) ? cache : null,
  );
  const [loading, setLoading] = useState(false);

  const run = useCallback(
    (force: boolean) => {
      let cancelled = false;
      setLoading(true);
      void load(force)
        .then((e) => {
          if (!cancelled) setEntry(e);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    return run(false);
  }, [enabled, run]);

  const refresh = useCallback(() => {
    run(true);
  }, [run]);

  return {
    snapshot: entry?.snapshot ?? null,
    loading: loading && !entry?.snapshot,
    error: entry?.error ?? null,
    refresh,
  };
}
