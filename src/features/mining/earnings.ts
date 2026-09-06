import type { ChainType } from "../../wallets";

/**
 * Earnings estimator — pure math, no IO.
 *
 * The user's expected payout per period is, in the simplest model:
 *
 *     (myHashrate / networkHashrate) × blockReward × blocksPerSec × period
 *
 * `blocksPerSec = 1 / blockTimeSecs`. Pool fees come off the top.
 *
 * The hard input is `networkHashrate` — it changes every block. Phase 2
 * uses a hardcoded conservative value per chain (the floor-of-last-30d
 * average at the time this file was written). Phase 3 swaps that for a
 * live difficulty fetch via `live-difficulty.ts`, but the *shape* of
 * `NetworkParams` doesn't change, so consumers don't have to re-wire.
 *
 * Note on accuracy: hardcoded `networkHashrate` will drift; the
 * estimate is labelled "est." in the UI on purpose. Pool diff (which we
 * have live) is *not* a substitute — pool diff scales with worker
 * hashrate, not with chain difficulty.
 */

export type Period = "hour" | "day" | "week" | "month";
export type EarningsEstimate = Record<Period, number>;

export interface NetworkParams {
  /** Coins emitted per block, after coinbase but before pool fee. */
  blockReward: number;
  /** Average block time in seconds. */
  blockTimeSecs: number;
  /** Network hashrate in H/s (the chain's current total). */
  networkHashrate: number;
  /** Pool fee, 0..1 (e.g. 0.01 = 1%). Default per pool, not per chain. */
  poolFeePct: number;
}

/* ────────────────────────────────────────────────────────────────────
   Per-chain defaults (Phase 2). Sourced from public block-explorer
   averages around the date this file was written; conservative on
   `networkHashrate` (slightly *over*estimating the network so the
   user's slice of it is *under*estimated — better than the other way
   around).

   When `live-difficulty.ts` is wired in Phase 3, `networkHashrate`
   gets overridden; the other fields stay constants because they're
   protocol-level (block reward + block time don't change between
   forks for these chains).
   ────────────────────────────────────────────────────────────────── */

const POOL_FEE_DEFAULT = 0.01;

export const NETWORK_PARAMS_DEFAULT: Partial<Record<ChainType, NetworkParams>> = {
  // Numbers calibrated 2026-04-30 against Kryptex's projection for an
  // RTX 5060 Ti (octopus = $3.83/mo) + Kryptex's 11.75 KH/s baseline
  // for a 13900K on RandomX. Sources: minerstat.com network stats,
  // localmonero.co get_stats, miningpoolstats.stream/conflux,
  // miningpoolstats.stream/ravencoin. Verified by reverse-solving
  // earnings = 0 for the reference rig, then sanity-checked against
  // a second one (RX 6700 XT = ~$2.5-3/mo on octopus).
  //
  // The live `useNetworkHashrate` hook overrides `networkHashrate` for
  // XMR + RVN; ZEPH + CFX always use the constants here.
  monero: {
    blockReward: 0.6,           // tail emission, post-2022
    blockTimeSecs: 120,
    networkHashrate: 7_000_000_000, // ~7 GH/s (was 5.4 GH/s — XMR network grew)
    poolFeePct: POOL_FEE_DEFAULT,
  },
  zephyr: {
    blockReward: 6.0,           // mainnet schedule
    blockTimeSecs: 120,
    networkHashrate: 90_000_000, // ~90 MH/s (was 60 MH/s — chain grew)
    poolFeePct: POOL_FEE_DEFAULT,
  },
  /**
   * Zano (ProgPowZ, GPU). Added 2026-08-28 from live sources read that day:
   *
   *   - miningpoolstats.stream/zano: `Emission (24h) : 1295 ZANO`,
   *     `Avg. Block Time : 61.3s`, `Network 398.76 GH/s`, ZANO/USD 8.14
   *   - zano.herominers.com: `Network 438.21 GH/s`, `Block Time: 50.13 s`
   *
   * `blockReward` is DERIVED, and this is the number to distrust first:
   * 86400 / 61.3 = 1409 blocks/day, and 1295 / 1409 = 0.919 ZANO per block.
   * But Zano is a hybrid PoW/PoS chain and that 24h emission covers BOTH,
   * while a miner here only earns the PoW share. Halved to 0.46 on the
   * assumption of a roughly even split — which follows this table's stated
   * convention of erring toward UNDER-estimating the user's take, and is the
   * field to replace first if ZANO earnings read low against a real payout.
   *
   * `networkHashrate` rounds the higher of the two observed figures UP, same
   * convention: over-estimate the network so the user's slice is not
   * flattered.
   */
  zano: {
    blockReward: 0.46,
    blockTimeSecs: 61.3,
    networkHashrate: 450_000_000_000, // ~450 GH/s (observed 398-438)
    poolFeePct: POOL_FEE_DEFAULT,
  },
  ravencoin: {
    blockReward: 2500,          // post-halving 2024
    blockTimeSecs: 60,
    networkHashrate: 4_000_000_000_000, // ~4 TH/s (was 7.5 TH — actually lower)
    poolFeePct: POOL_FEE_DEFAULT,
  },
  conflux: {
    blockReward: 2.0,           // approximate net-of-PoS
    blockTimeSecs: 0.5,         // sub-second avg, smoothed
    networkHashrate: 8_400_000_000_000, // ~8.4 TH/s (was 1.5 TH — way too low)
    poolFeePct: POOL_FEE_DEFAULT,
  },
};

/**
 * Compute expected earnings per period given the user's current
 * hashrate and the chain's network params. Pure function — no side
 * effects, returns NaN-free numbers.
 *
 * Returns coin-units per period. To convert to USD, multiply each
 * value by `pricesByTicker[ticker]`.
 */
export function estimateEarnings(
  myHashrate: number,
  params: NetworkParams
): EarningsEstimate {
  if (
    !Number.isFinite(myHashrate) ||
    myHashrate <= 0 ||
    !Number.isFinite(params.networkHashrate) ||
    params.networkHashrate <= 0 ||
    !Number.isFinite(params.blockTimeSecs) ||
    params.blockTimeSecs <= 0
  ) {
    return { hour: 0, day: 0, week: 0, month: 0 };
  }
  const myShare = myHashrate / params.networkHashrate;
  const coinPerSec =
    (myShare * params.blockReward) / params.blockTimeSecs;
  const grossPerDay = coinPerSec * 86_400;
  const netPerDay = grossPerDay * (1 - params.poolFeePct);
  return {
    hour: netPerDay / 24,
    day: netPerDay,
    week: netPerDay * 7,
    month: netPerDay * 30,
  };
}

/**
 * Convenience wrapper — looks up the chain's default params,
 * optionally overrides any subset of (`networkHashrate`,
 * `blockReward`, `blockTimeSecs`) with live values, and returns the
 * full estimate or null if the chain isn't supported.
 *
 * Two call shapes for backwards compat:
 *   - `estimateEarningsForChain(chain, hashrate, networkHashrate)` —
 *     legacy; only the network-hashrate override.
 *   - `estimateEarningsForChain(chain, hashrate, partialParams)` —
 *     v2; pass any subset of NetworkParams as a third arg. Used by
 *     the WhatToMine integration to also override block reward +
 *     block time when they drift (halvings, PoS adjustments).
 */
export function estimateEarningsForChain(
  chain: ChainType,
  myHashrate: number,
  override?: number | Partial<NetworkParams>
): EarningsEstimate | null {
  const base = NETWORK_PARAMS_DEFAULT[chain];
  if (!base) return null;
  let params: NetworkParams = base;
  if (typeof override === "number") {
    params = { ...base, networkHashrate: override };
  } else if (override && typeof override === "object") {
    params = {
      blockReward: override.blockReward ?? base.blockReward,
      blockTimeSecs: override.blockTimeSecs ?? base.blockTimeSecs,
      networkHashrate: override.networkHashrate ?? base.networkHashrate,
      poolFeePct: override.poolFeePct ?? base.poolFeePct,
    };
  }
  return estimateEarnings(myHashrate, params);
}

/**
 * Format a coin-amount estimate for the SESSION tile / per-period rows.
 * Picks a sensible decimal place count: high-value coins (XMR ~0.001
 * per day at hobby hashrate) need 5+ decimals; low-value (DOGE) need
 * fewer.
 */
export function formatCoinAmount(amount: number, ticker: string): string {
  if (!Number.isFinite(amount) || amount === 0) return "0";
  // Per-coin display precision. Thresholds mirror what most pools use
  // in their own earnings displays.
  const dp =
    amount >= 1000
      ? 0
      : amount >= 1
        ? 4
        : amount >= 0.001
          ? 5
          : amount >= 0.000_001
            ? 8
            : 10;
  const fixed = amount.toFixed(dp);
  // Trim trailing zeros only when there's a fractional part, so
  // "1.0000" → "1", but "120" stays "120".
  const trimmed = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
  return `${trimmed} ${ticker}`;
}
