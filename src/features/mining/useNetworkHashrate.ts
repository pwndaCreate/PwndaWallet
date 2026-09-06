import { useEffect, useState } from "react";
import type { ChainType } from "../../wallets";

/**
 * Live network hashrate per chain — Phase 3 of the SESSION-stats plan.
 *
 * Most chains let us derive `networkHashrate ≈ difficulty / blockTime`
 * from a single keyless explorer endpoint. We fetch one per chain we
 * actively mine on (XMR / ZEPH / RVN / CFX), cache for 60 s, and the
 * earnings estimator picks up the freshest value via
 * `estimateEarningsForChain(chain, hashrate, liveNetworkHashrate)`.
 *
 * If a chain's endpoint is rate-limited / CORS-blocked / down, the
 * hook returns `null` and the estimator silently falls back to the
 * `NETWORK_PARAMS_DEFAULT` constant for that chain. The user sees a
 * slightly stale estimate, never a broken one.
 *
 * Endpoints chosen for their CORS-friendliness and stability:
 *   - Monero    → localmonero.co/blocks/api/get_stats (open API)
 *   - Ravencoin → ravencoin.network/api/getdifficulty (Insight-style)
 *   - Zephyr    → zephyrprotocol.com/api/v1/livestats (already used
 *                 for reserve info; exposes block_target + difficulty
 *                 indirectly via reserve_ratio_ma. Today we don't have
 *                 a clean diff field — left null until the scanner
 *                 ships one.)
 *   - Conflux   → no free + CORS-friendly source identified; null.
 */

interface CacheEntry {
  at: number;
  value: number | null;
}

const TTL_MS = 60_000;
const cache = new Map<ChainType, CacheEntry>();
const inflight = new Map<ChainType, Promise<number | null>>();

const BLOCK_TIME_SECS: Partial<Record<ChainType, number>> = {
  monero: 120,
  zephyr: 120,
  ravencoin: 60,
  conflux: 0.5,
  ergo: 120,
};

async function fetchMonero(): Promise<number | null> {
  try {
    const r = await fetch("https://localmonero.co/blocks/api/get_stats", {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { difficulty?: number };
    if (typeof j.difficulty !== "number" || j.difficulty <= 0) return null;
    return j.difficulty / (BLOCK_TIME_SECS.monero ?? 120);
  } catch {
    return null;
  }
}

async function fetchRavencoin(): Promise<number | null> {
  try {
    const r = await fetch("https://ravencoin.network/api/getdifficulty", {
      headers: { accept: "application/json, text/plain" },
    });
    if (!r.ok) return null;
    const text = await r.text();
    const diff = parseFloat(text);
    if (!Number.isFinite(diff) || diff <= 0) return null;
    // KAWPOW (Bitcoin-style work): hashes per second ≈ diff × 2^32 / blockTime.
    return (diff * 2 ** 32) / (BLOCK_TIME_SECS.ravencoin ?? 60);
  } catch {
    return null;
  }
}

async function fetchErgo(): Promise<number | null> {
  // Ergo Explorer v1: latest block's difficulty is already in work-per-2-min
  // units (NOT Bitcoin-style 2^32-scaled). Network hashrate ≈ difficulty /
  // blockTime. Cross-checks against minerstat / 2miners reported values.
  // CORS-permissive — the same explorer the wallet adapter uses.
  try {
    const r = await fetch("https://api.ergoplatform.com/api/v1/blocks?limit=1", {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { items?: Array<{ difficulty?: number | string }> };
    const raw = j.items?.[0]?.difficulty;
    const diff =
      typeof raw === "string"
        ? Number(raw)
        : typeof raw === "number"
          ? raw
          : NaN;
    if (!Number.isFinite(diff) || diff <= 0) return null;
    return diff / (BLOCK_TIME_SECS.ergo ?? 120);
  } catch {
    return null;
  }
}

async function fetchOne(chain: ChainType): Promise<number | null> {
  switch (chain) {
    case "monero":
      return fetchMonero();
    case "ravencoin":
      return fetchRavencoin();
    case "ergo":
      return fetchErgo();
    case "zephyr":
    case "conflux":
    default:
      return null;
  }
}

/**
 * Fetch — with cache + inflight collapsing — the live network
 * hashrate (H/s) for a given chain. Returns null when no source is
 * configured or the call failed.
 */
export async function fetchNetworkHashrate(
  chain: ChainType
): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(chain);
  if (cached && now - cached.at < TTL_MS) return cached.value;
  const existing = inflight.get(chain);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const value = await fetchOne(chain);
      cache.set(chain, { at: Date.now(), value });
      return value;
    } finally {
      inflight.delete(chain);
    }
  })();
  inflight.set(chain, promise);
  return promise;
}

/**
 * React hook — fetches on mount + every 60 s. Returns the latest
 * value (or null if no live source is wired for this chain).
 */
export function useNetworkHashrate(chain: ChainType): number | null {
  const [value, setValue] = useState<number | null>(() => {
    const c = cache.get(chain);
    return c?.value ?? null;
  });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const v = await fetchNetworkHashrate(chain);
      if (!cancelled) setValue(v);
    };
    void run();
    const id = window.setInterval(run, TTL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [chain]);

  return value;
}
