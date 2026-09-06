import type { PoolStatsAdapter } from "./types";

/**
 * HeroMiners runs the same `cryptonote-nodejs-pool` fork on three different
 * coin-subdomain stratum pools. The Rust backend handles the subdomain
 * dispatch via `pool_id`; the frontend only needs the metadata.
 *
 * cryptonote-nodejs-pool aggregates miner stats every ~5s server-side, so
 * 30s polling is generous on the data-freshness side and conservative on
 * the bandwidth side.
 */
const POLL = 30_000;

export const HEROMINERS_MONERO: PoolStatsAdapter = {
  id: "herominers-monero",
  recommendedPollMs: POLL,
};

export const HEROMINERS_CONFLUX: PoolStatsAdapter = {
  id: "herominers-conflux",
  recommendedPollMs: POLL,
};

export const HEROMINERS_RAVENCOIN: PoolStatsAdapter = {
  id: "herominers-ravencoin",
  recommendedPollMs: POLL,
};
