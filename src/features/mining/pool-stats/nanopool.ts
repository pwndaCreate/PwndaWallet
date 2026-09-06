import type { PoolStatsAdapter } from "./types";

/**
 * Nanopool documents a 30 calls/min cap on `api.nanopool.org`. Even with
 * one Mining tab open, our 20s cadence yields 3 req/min — 10x headroom.
 */
export const NANOPOOL_CONFLUX: PoolStatsAdapter = {
  id: "nanopool-conflux",
  recommendedPollMs: 20_000,
};
