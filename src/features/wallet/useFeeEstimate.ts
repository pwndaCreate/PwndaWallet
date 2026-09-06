/**
 * Per-chain fee estimate hook.
 *
 * Mirrors `useTxHistory`'s shape: pass a list of chains, get back a map of
 * `{ slow, normal, fast, unit, fetchedAt }` keyed by chain. Polls every
 * `pollMs` (default 30s — fees move faster than tx history). Pauses while
 * the document is hidden. Adapters handle their own redundancy; this hook
 * only records errors and retries on the next tick.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAdapterByChain } from "../../wallets";
import type { ChainType, FeeEstimate } from "../../wallets";

export interface UseFeeEstimateResult {
  feeByChain: Record<string, FeeEstimate>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  refresh(chain?: ChainType): Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;

export function useFeeEstimate(
  chains: ChainType[],
  opts: { pollMs?: number; enabled?: boolean } = {}
): UseFeeEstimateResult {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const enabled = opts.enabled ?? true;

  const [feeByChain, setFeeByChain] = useState<Record<string, FeeEstimate>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const sig = useMemo(() => chains.slice().sort().join("|"), [chains]);
  const inFlight = useRef<Map<string, Promise<void>>>(new Map());

  const fetchOne = useCallback(async (chain: ChainType): Promise<void> => {
    const existing = inFlight.current.get(chain);
    if (existing) return existing;
    const promise = (async () => {
      setLoading((l) => ({ ...l, [chain]: true }));
      try {
        const adapter = getAdapterByChain(chain);
        const fee = await adapter.getFeeEstimate();
        setFeeByChain((m) => ({ ...m, [chain]: fee }));
        setErrors((e) => ({ ...e, [chain]: null }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setErrors((er) => ({ ...er, [chain]: msg }));
      } finally {
        setLoading((l) => ({ ...l, [chain]: false }));
        inFlight.current.delete(chain);
      }
    })();
    inFlight.current.set(chain, promise);
    return promise;
  }, []);

  useEffect(() => {
    if (!enabled || chains.length === 0) return;
    let cancelled = false;
    for (const c of chains) void fetchOne(c);
    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      for (const c of chains) void fetchOne(c);
    };
    const id = window.setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sig, pollMs, enabled, fetchOne]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(
    async (chain?: ChainType) => {
      const targets = chain ? [chain] : chains;
      await Promise.all(targets.map(fetchOne));
    },
    [chains, fetchOne]
  );

  return { feeByChain, loading, errors, refresh };
}
