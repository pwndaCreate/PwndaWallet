/**
 * src/features/mining/pickCoin.ts
 *
 * Selecting a mining coin — one implementation, because there were three and
 * they disagreed.
 *
 * # The bug this exists to close
 *
 * Reported 2026-08-28: "the zano mine button in the simple miner page was
 * un-usable despite lighting up and then when I went to pro it gave me a
 * 'set-up miners' prompt on top."
 *
 * Two separate defects, both from the SIMPLE view having its own, simpler,
 * wrong version of a rule the PRO view already had right:
 *
 *   1. **Gating.** SIMPLE used `disabled={isMining}` — ANY session locks
 *      EVERY coin. PRO uses per-lane gating: a GPU coin stays selectable
 *      while a CPU session runs, because they are independent backend
 *      processes. So a user mining XMR on CPU could not pick ZANO at all.
 *   2. **The hardware flip.** SIMPLE called `setMiningCoin` and nothing else.
 *      ZANO is GPU-only, so selecting it left `miningHardware` on `cpu`, the
 *      pool lookup asked for `zano/randomx`, found nothing, and PRO rendered
 *      "No pools for this coin/algo" over "Setup miners first" — for a coin
 *      that was perfectly mineable. The two views were not showing different
 *      states of one selection; SIMPLE had made an invalid one.
 *
 * The lane rule now lives here and is used by all three surfaces, so SIMPLE
 * and PRO cannot make different selections from the same click again.
 */
import type { ChainType } from "../../wallets";
import { isGpuCoin } from "./miningCoins";

/** The slice of `useMiner` a coin pick touches. */
export interface CoinPickerMiner {
  miningHardware: "cpu" | "gpu";
  setMiningHardware: (h: "cpu" | "gpu") => void;
  setMiningCoin: (c: ChainType) => void;
  isMiningCpu: boolean;
  isMiningGpu: boolean;
}

/**
 * Whether a coin's tile should be locked.
 *
 * Only its OWN lane blocks it. CPU and GPU are separate processes, so mining
 * XMR must not prevent selecting a GPU coin.
 */
export function coinTileLocked(
  chain: ChainType,
  miner: Pick<CoinPickerMiner, "isMiningCpu" | "isMiningGpu">,
): boolean {
  return isGpuCoin(chain) ? miner.isMiningGpu : miner.isMiningCpu;
}

/**
 * Select a coin, moving the displayed hardware to the lane that can mine it.
 *
 * Refuses while that lane is busy — the same guard `coinTileLocked` renders,
 * repeated here because a disabled button is a UI affordance and this is the
 * actual rule.
 */
export function pickMiningCoin(
  chain: ChainType,
  miner: CoinPickerMiner,
): void {
  if (coinTileLocked(chain, miner)) return;
  const want: "cpu" | "gpu" = isGpuCoin(chain) ? "gpu" : "cpu";
  if (miner.miningHardware !== want) miner.setMiningHardware(want);
  miner.setMiningCoin(chain);
}
