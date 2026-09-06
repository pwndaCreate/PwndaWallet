import type { PoolId } from "../pools";

/**
 * Normalised mining-pool stats for one (pool, address) pair.
 * Source-of-truth shape lives in
 * `wiki/synthesis/pool-stats-implementation-plan.md` §2.
 *
 * All atomic-unit balance fields are decimal strings to preserve precision
 * (XMR/ZEPH 1e-12, RVN 1e-8, CFX 1e-18). Hashrate is f64 H/s — already
 * normalised regardless of whether the pool reports KH/s, MH/s, or H/s.
 */
export interface MinerStats {
  pendingBalance: string;
  immatureBalance: string | null;
  totalPaid: string | null;
  payoutThreshold: string | null;
  hashrate: number;
  hashrate1h: number | null;
  hashrate6h: number | null;
  hashrate24h: number | null;
  validShares: number | null;
  invalidShares: number | null;
  staleShares: number | null;
  /** Unix seconds. Null if the miner has never submitted a share. */
  lastShare: number | null;
  workersOnline: number | null;
  /** Unix seconds at which the response was fetched (used for UI staleness pill). */
  fetchedAt: number;
}

export interface PoolStatsAdapter {
  /** Same id as the entry in `pools.ts`. */
  id: PoolId;
  /**
   * Floor poll cadence in milliseconds. The hook honours this when
   * scheduling the next tick.
   */
  recommendedPollMs: number;
}
