import type { PoolStatsAdapter } from "./types";

/**
 * Ergo (ERG) pool-stats adapters. Added 2026-05-15 alongside the
 * "re-add Pending / Payout balance UI for ERG" task.
 *
 * - HeroMiners ERG uses the same `cryptonote-nodejs-pool` fork as the
 *   XMR / CFX / RVN pools — the Rust backend's `HerominersJson` parser
 *   handles it verbatim, so the adapter is a metadata-only entry.
 * - WoolyPooly ERG uses the standard WoolyPooly schema (`stats.balance`,
 *   `mode_stats.pplns.default.currentHashrate`, etc.) — `WoolypoolyJson`
 *   parses it with ERG's 9 decimals (added in `pool_stats.rs` 2026-05-15).
 * - Nanopool ERG is a separate Nanopool variant — same API skeleton as
 *   the Conflux endpoint (`{"status":...,"data":{"balance":..,"hashrate":..}}`)
 *   but with 9-decimal ERG balance and a different base URL. The two
 *   EU/US entries share one parser via `pool_stats.rs::NanopoolErgJson`.
 *
 * All three pools poll at the standard 30-second cadence — Nanopool's
 * documented 30 calls/min budget gives 10x headroom at 2 req/min per
 * (pool, address) pair.
 */
const POLL = 30_000;

export const HEROMINERS_ERGO: PoolStatsAdapter = {
  id: "herominers-ergo",
  recommendedPollMs: POLL,
};

export const WOOLYPOOLY_ERGO: PoolStatsAdapter = {
  id: "woolypooly-ergo",
  recommendedPollMs: POLL,
};

export const NANOPOOL_ERGO_EU: PoolStatsAdapter = {
  id: "nanopool-ergo-eu",
  recommendedPollMs: POLL,
};

export const NANOPOOL_ERGO_US: PoolStatsAdapter = {
  id: "nanopool-ergo-us",
  recommendedPollMs: POLL,
};
