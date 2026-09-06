import { useEffect, useRef, useState } from "react";
import {
  fetchZephyrLiveStats,
  type ZphLiveStats,
} from "../../wallets/zph-scanner-api";
import type { ChainType } from "../../wallets";
import type { FeatureFocus } from "../../state/featureFocus";

/**
 * Polls the Zephyr Protocol Scanner API for live reserve-ratio +
 * asset-supply + oracle-price snapshots while the user is on the Zephyr
 * dashboard. Server cache is ~30s, so a 60s poll keeps cost minimal
 * while still feeling live.
 *
 * Lifecycle:
 *   - Polls only when `activeChain === "zephyr"` AND focus is the
 *     dashboard (avoids burning cycles in the background).
 *   - Single-flight: in-flight request guard prevents pile-up if a
 *     request takes longer than the interval.
 *   - Errors are surfaced via `error` but don't clear stale data —
 *     that lets the UI show "(refreshing…)" instead of replacing
 *     real numbers with a placeholder.
 */
export function useZphReserveInfo(args: {
  activeChain: ChainType;
  focus: FeatureFocus;
}) {
  const { activeChain, focus } = args;

  const [stats, setStats] = useState<ZphLiveStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  const inflight = useRef(false);

  const refresh = async () => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const next = await fetchZephyrLiveStats();
      setStats(next);
      setError(null);
      setFetchedAt(Date.now());
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e?.message ?? "Fetch failed");
      console.warn("[useZphReserveInfo] livestats fetch failed:", msg);
      setError(msg);
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  };

  useEffect(() => {
    if (activeChain !== "zephyr") return;
    if (focus !== "dashboard") return;

    // Immediate fetch on entry, then 60s interval. Cache TTL on the
    // server is ~30s so this is the right cadence — anything tighter
    // wastes traffic, anything wider feels stale to a user watching
    // the panel.
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChain, focus]);

  return { stats, loading, error, fetchedAt, refresh };
}
