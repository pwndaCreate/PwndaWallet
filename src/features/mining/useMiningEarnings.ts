/**
 * src/features/mining/useMiningEarnings.ts
 *
 * The earnings estimate for a live session, priced from the same live chain
 * parameters on every Mine surface.
 *
 * Until 2026-09-16 there were three copies of this. Portrait PRO and landscape
 * PRO fed `useCoinStats` (WhatToMine → explorer → constants) into
 * `estimateEarningsForChain`; SIMPLE passed `{}`, i.e. the hardcoded
 * `NETWORK_PARAMS_DEFAULT` only. So flipping SIMPLE ⇄ PRO on one running
 * session could show two different "per day" figures, and SIMPLE's was the
 * staler one. One hook, one input path.
 */
import { useMemo } from "react";
import type { ChainType } from "../../wallets";
import { estimateEarningsForChain, type EarningsEstimate } from "./earnings";
import { useCoinStats, type CoinStatsResult } from "./useCoinStats";

export interface MiningEarnings {
  /** `null` when there is no hashrate to price, or the chain has no model. */
  earnings: EarningsEstimate | null;
  /** The live parameters behind the estimate, for provenance captions. */
  coinStats: CoinStatsResult;
}

/**
 * @param hashrate the rate to price, in the algorithm's base unit. Pass `null`
 *   (not the last sample) when the caller's lane is not mining.
 */
export function useMiningEarnings(
  coin: ChainType,
  hashrate: number | null,
): MiningEarnings {
  const coinStats = useCoinStats(coin);
  const { networkHashrate, blockReward, blockTimeSecs } = coinStats;
  const earnings = useMemo(
    () =>
      hashrate != null && hashrate > 0
        ? estimateEarningsForChain(coin, hashrate, {
            networkHashrate: networkHashrate ?? undefined,
            blockReward: blockReward ?? undefined,
            blockTimeSecs: blockTimeSecs ?? undefined,
          })
        : null,
    [coin, hashrate, networkHashrate, blockReward, blockTimeSecs],
  );
  return { earnings, coinStats };
}
