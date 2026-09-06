import { useEffect, useState } from "react";
import type { ChainType } from "../../wallets";
import {
  fetchCoinStats,
  getCachedCoinStats,
  isStale,
  type CoinStats,
} from "./coin-stats";
import { fetchNetworkHashrate } from "./useNetworkHashrate";

/**
 * Layered live-coin-stats hook. Single source of truth for the
 * volatile chain params (`networkHashrate`, `blockReward`,
 * `blockTimeSecs`) that drive the earnings estimator.
 *
 * Precedence chain (first non-null wins for each field):
 *
 *   1. WhatToMine `/coins.json`  ← preferred — single endpoint, all 4
 *      coins, current block reward (handles PoS / halvings), updated
 *      ~5 min, free, CORS-friendly.
 *   2. Per-chain explorer        ← fallback for `networkHashrate` only.
 *      `localmonero.co/blocks/api/get_stats` for XMR,
 *      `ravencoin.network/api/getdifficulty` for RVN. Block reward +
 *      block time stay on the hardcoded defaults at this layer.
 *   3. `NETWORK_PARAMS_DEFAULT`  ← hardcoded constants in earnings.ts.
 *      Final defense; rarely the active source if WhatToMine is up.
 *
 * The hook returns a result for one chain at a time. Each call mounts
 * its own poll loop, but `fetchCoinStats` collapses concurrent
 * fetches and shares one in-memory cache across all hook instances,
 * so mounting multiple `useCoinStats` calls on one screen still
 * results in one HTTP round-trip per cache cycle.
 */

export interface CoinStatsResult {
  /** Live network hashrate in H/s, or null if no source has a value
   *  yet. The earnings estimator falls back to the hardcoded constant
   *  when this is null. */
  networkHashrate: number | null;
  /** Current per-block emission. Null when only fallbacks are
   *  available — those don't carry block-reward data. */
  blockReward: number | null;
  /** Block time in seconds. Same caveat as `blockReward`. */
  blockTimeSecs: number | null;
  /** Where the result came from. Drives the UI's provenance pill. */
  source: "whattomine" | "explorer" | "fallback";
  /** True when WhatToMine's last-fetched value is older than the
   *  staleness threshold. Drives a "(stale)" UI hint. */
  stale: boolean;
  /** Unix-ms timestamp of the last successful fetch (any source).
   *  Useful for telemetry; not used by the estimator. */
  fetchedAt: number | null;
}

/** Sync convert a `CoinStats` snapshot into the public result shape. */
function fromWhatToMine(s: CoinStats): CoinStatsResult {
  return {
    networkHashrate: s.networkHashrate,
    blockReward: s.blockReward,
    blockTimeSecs: s.blockTimeSecs,
    source: "whattomine",
    stale: isStale(s),
    fetchedAt: s.fetchedAt,
  };
}

const HOOK_REFRESH_MS = 60_000;

export function useCoinStats(chain: ChainType): CoinStatsResult {
  const [result, setResult] = useState<CoinStatsResult>(() => {
    // First paint: prefer whatever the in-memory WhatToMine cache
    // already has (other consumers may have warmed it). Otherwise
    // start with all-null and let the effect populate.
    const cached = getCachedCoinStats(chain);
    if (cached) return fromWhatToMine(cached);
    return {
      networkHashrate: null,
      blockReward: null,
      blockTimeSecs: null,
      source: "fallback",
      stale: false,
      fetchedAt: null,
    };
  });

  useEffect(() => {
    let cancelled = false;

    async function runOnce() {
      // Layer 1 — WhatToMine. Single fetch covers all four coins;
      // the per-chain `[chain]` lookup is in the parser.
      const all = await fetchCoinStats();
      if (cancelled) return;
      const wtm = all[chain];
      if (wtm && wtm.networkHashrate != null) {
        setResult(fromWhatToMine(wtm));
        return;
      }

      // Layer 2 — per-chain explorer for network hashrate only.
      // Same call useNetworkHashrate makes today; collapses with
      // that hook's cache so we don't double-fetch.
      const fallbackHashrate = await fetchNetworkHashrate(chain);
      if (cancelled) return;
      setResult({
        networkHashrate: fallbackHashrate,
        blockReward: null,
        blockTimeSecs: null,
        source: fallbackHashrate != null ? "explorer" : "fallback",
        stale: false,
        fetchedAt: fallbackHashrate != null ? Date.now() : null,
      });
    }

    void runOnce();
    const id = window.setInterval(runOnce, HOOK_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [chain]);

  return result;
}
