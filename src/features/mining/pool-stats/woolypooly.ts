import type { PoolStatsAdapter } from "./types";

/**
 * WoolyPooly's API path uses pool IDs (`raven-1`, `cfx-1`), NOT bare
 * tickers — `/api/rvn/...` returns 404. The Rust backend bakes the
 * mapping into its URL templates; the frontend just passes pool_id.
 *
 * Brand-new miners see `currentHashrate: 0` and an all-zero hashrate
 * snapshot array because no hourly bucket has filled yet. The UI
 * surfaces this as "Collecting…" rather than treating it as an error.
 */
const POLL = 30_000;

export const WOOLYPOOLY_CONFLUX: PoolStatsAdapter = {
  id: "woolypooly-conflux",
  recommendedPollMs: POLL,
};

export const WOOLYPOOLY_RAVENCOIN: PoolStatsAdapter = {
  id: "woolypooly-ravencoin",
  recommendedPollMs: POLL,
};
