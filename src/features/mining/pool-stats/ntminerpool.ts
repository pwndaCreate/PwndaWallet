import type { PoolStatsAdapter } from "./types";

/**
 * Ntminerpool's ZEPH dashboard is server-rendered HTML rather than a JSON
 * API — Phase 2 of the rollout taught the Rust backend's
 * `parse_ntminer_html` to scrape the values inline. From the frontend
 * perspective it's just another adapter; the parser difference is hidden.
 *
 * Pool's own page declares `自动刷新(60)` (auto-refresh every 60s), so
 * 60s is the floor cadence — anything faster wastes bandwidth.
 */
export const NTMINERPOOL_ZEPHYR: PoolStatsAdapter = {
  id: "ntminerpool-zephyr",
  recommendedPollMs: 60_000,
};
