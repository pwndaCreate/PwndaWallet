import type { PoolStatsAdapter } from "./types";

/**
 * Xelis (XEL) pool-stats adapters. Added 2026-09-15.
 *
 * K1Pool, and since 2026-09-16 Pwnda's own pool. K1Pool's public `GET https://k1pool.com/api/miner/xel/<address>` was
 * fetched live for a real active account that day and its fields pinned
 * (`pool_stats.rs::parse_k1pool_miner`). The three K1Pool entries in `pools.ts`
 * are three PORTS of one account backend, so all three share the parser.
 *
 * Deliberately absent:
 *   - Kryptex — pool.kryptex.com is a single-page app with no discoverable
 *     per-address JSON API; nothing to verify against.
 *   - HeroMiners — xelis.herominers.com is blocked by the dev box's web filter
 *     (plain HTTP 302s to safebrowse.io, HTTPS fails the handshake), so no
 *     response could be captured. Its stratum port works; its API is
 *     unverified, and an unverified parser is how a panel shows wrong money.
 *
 * 60-second polling: an active account's response is ~180 KB (it carries
 * charts), so the 30 s cadence the small JSON pools use would be wasteful.
 */
const POLL = 60_000;

export const K1POOL_XELIS_CPU: PoolStatsAdapter = {
  id: "k1pool-xelis-cpu",
  recommendedPollMs: POLL,
};

export const K1POOL_XELIS_GPU: PoolStatsAdapter = {
  id: "k1pool-xelis-gpu",
  recommendedPollMs: POLL,
};

export const K1POOL_XELIS_SSL: PoolStatsAdapter = {
  id: "k1pool-xelis-ssl",
  recommendedPollMs: POLL,
};

/**
 * Pwnda's XEL pool: `GET https://pwnda.org/xelis-api/stats/<xel:address>`,
 * read live on 2026-09-16 (`pool_stats.rs::parse_pwnda_xelis`). The response
 * is small, but the pool computes the chart every 15 minutes and pays out
 * every 4 hours, so a faster poll would only show the same numbers.
 */
export const PWNDA_XELIS: PoolStatsAdapter = {
  id: "pwnda-xelis",
  recommendedPollMs: POLL,
};
