import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../../lib/tauri";
import type { MiningFocus } from "../featureFocus";
import type { PoolId } from "../pools";
import { getStatsAdapter, type MinerStats } from "../pool-stats";

/** localStorage key for the per-(pool,address) "user opted in to live stats" set. */
const STATS_OPTIN_KEY = "pwnda.poolStats.optIn";

export function loadOptIns(): Set<string> {
  try {
    const raw = localStorage.getItem(STATS_OPTIN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function saveOptIn(set: Set<string>) {
  try {
    localStorage.setItem(STATS_OPTIN_KEY, JSON.stringify([...set]));
  } catch {
    /* localStorage full / disabled — non-fatal */
  }
}

export const optInKey = (poolId: string, address: string) =>
  `${poolId}:${address}`;

/**
 * Pool public-stats polling extracted from `useMiner` 2026-06-16.
 *
 * Owns the live-stats poll lifecycle (exponential backoff on failure,
 * paused off the mining view, gated on the privacy opt-in), the
 * displayed-stats reset on (pool, address) change, and the manual
 * refresh trigger. The per-(pool,address) opt-in Set is owned here too,
 * but its state + setter are returned so the orchestrator's
 * `startMining` can auto-opt-in when the user starts a session (the
 * address is sent to the pool over stratum at that point regardless).
 *
 * Behaviour is byte-identical to the inline version: same effect
 * dependency arrays, same backoff math, same invoke commands.
 */
export function usePoolStats(args: {
  focus: MiningFocus;
  selectedPoolId: PoolId | null;
  statsAddress: string | null;
}) {
  const { focus, selectedPoolId, statsAddress } = args;

  const [poolStats, setPoolStats] = useState<MinerStats | null>(null);
  const [poolStatsLoading, setPoolStatsLoading] = useState(false);
  const [poolStatsError, setPoolStatsError] = useState<string | null>(null);
  // Per-(pool,address) opt-in: stored in localStorage so the toggle sticks.
  // Once mining starts, the `startMining` callback auto-opts the user in
  // since they've definitionally shared their address with the pool.
  const [statsOptIns, setStatsOptIns] = useState<Set<string>>(() => loadOptIns());
  const refreshTriggerRef = useRef(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const statsAdapter = getStatsAdapter(selectedPoolId);
  const statsOptInForCurrent =
    !!(statsAddress && selectedPoolId && statsOptIns.has(optInKey(selectedPoolId, statsAddress)));

  // ── Pool-stats poll effect ─────────────────────────────────────────
  // Lifecycle owned here so it pauses with view switches, follows the
  // selected pool / wallet, and exponential-backs-off on failure.
  // The first call is gated on the user having opted in — see
  // `statsOptIns` (auto-set when they start mining at this pool).
  useEffect(() => {
    if (focus !== "mining") return;
    if (!statsAdapter) return;
    if (!statsAddress) return;
    if (!statsOptInForCurrent) return;

    let cancelled = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      setPoolStatsLoading(true);
      try {
        const stats = await invoke<MinerStats>("fetch_pool_stats", {
          poolId: statsAdapter.id,
          address: statsAddress,
        });
        if (cancelled) return;
        setPoolStats(stats);
        setPoolStatsError(null);
        consecutiveFailures = 0;
      } catch (e: any) {
        if (cancelled) return;
        consecutiveFailures += 1;
        setPoolStatsError(typeof e === "string" ? e : e?.message ?? String(e));
      } finally {
        if (!cancelled) setPoolStatsLoading(false);
      }
      const baseMs = statsAdapter.recommendedPollMs;
      const delay = Math.min(baseMs * Math.pow(2, consecutiveFailures), 5 * 60_000);
      timer = setTimeout(tick, consecutiveFailures > 0 ? delay : baseMs);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [focus, statsAdapter?.id, statsAddress, statsOptInForCurrent, refreshTrigger]);

  // Reset displayed stats whenever (pool, address) changes so we don't
  // briefly show one pool's numbers while the next fetch is in flight.
  useEffect(() => {
    setPoolStats(null);
    setPoolStatsError(null);
  }, [statsAdapter?.id, statsAddress]);

  const optInToPoolStats = useCallback(() => {
    if (!selectedPoolId || !statsAddress) return;
    const key = optInKey(selectedPoolId, statsAddress);
    if (statsOptIns.has(key)) return;
    const next = new Set(statsOptIns);
    next.add(key);
    setStatsOptIns(next);
    saveOptIn(next);
  }, [selectedPoolId, statsAddress, statsOptIns]);

  const refreshPoolStats = useCallback(() => {
    refreshTriggerRef.current += 1;
    setRefreshTrigger(refreshTriggerRef.current);
  }, []);

  return {
    statsAdapter,
    poolStats,
    poolStatsLoading,
    poolStatsError,
    statsOptIns,
    setStatsOptIns,
    statsOptInForCurrent,
    optInToPoolStats,
    refreshPoolStats,
  };
}
