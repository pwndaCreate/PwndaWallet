import type { PoolStatsAdapter } from "./types";

/**
 * Pwnda's ZEPH and ZANO pools (2026-09-18).
 *
 * Both run upstream cryptonote-nodejs-pool behind pwnda.org: ZEPH at
 * `/pool-api`, ZANO at `/zano-api` — the same endpoints the pwnda.org MY STATS
 * page (`/pool`) reads. The Rust side parses them with the HeroMiners parser
 * (same `stats_address` shape; the hashrate sits inside `stats`). Pwnda's XEL
 * pool is a different server and lives in `xelis.ts`.
 */
const POLL = 30_000;

export const PWNDA_ZEPHYR: PoolStatsAdapter = {
  id: "pwnda-zephyr",
  recommendedPollMs: POLL,
};

export const PWNDA_ZANO: PoolStatsAdapter = {
  id: "pwnda-zano",
  recommendedPollMs: POLL,
};
