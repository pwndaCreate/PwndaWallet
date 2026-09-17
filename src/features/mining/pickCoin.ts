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
 *
 * # Dual-lane coins (2026-09-15)
 *
 * XEL mines on BOTH lanes. "Its own lane is busy" stopped being one boolean:
 * a coin is locked only when EVERY lane that can mine it is busy, and a pick
 * lands on the displayed lane when that lane can take it, otherwise on the
 * first free lane that can. So with XEL already mining on CPU, clicking XEL
 * moves the display to the idle GPU lane with XEL selected — which is how the
 * second XEL session gets started.
 */
import type { ChainType } from "../../wallets";
import type { MiningHardware } from "../../types/mining";
import { coinLanes } from "./miningCoins";

/** The slice of `useMiner` a coin pick touches. */
export interface CoinPickerMiner {
  miningHardware: MiningHardware;
  setMiningHardware: (h: MiningHardware) => void;
  setMiningCoin: (c: ChainType) => void;
  isMiningCpu: boolean;
  isMiningGpu: boolean;
}

type LaneState = Pick<CoinPickerMiner, "isMiningCpu" | "isMiningGpu">;

function laneBusy(lane: MiningHardware, miner: LaneState): boolean {
  return lane === "cpu" ? miner.isMiningCpu : miner.isMiningGpu;
}

/**
 * Whether a coin's tile should be locked.
 *
 * Only its OWN lanes block it, and only when all of them are busy. CPU and GPU
 * are separate processes, so mining XMR must not prevent selecting a GPU coin,
 * and mining XEL on CPU must not prevent starting XEL on GPU.
 */
export function coinTileLocked(chain: ChainType, miner: LaneState): boolean {
  return coinLanes(chain).every((lane) => laneBusy(lane, miner));
}

/**
 * The lane a pick of `chain` would land on, or `null` when every lane that can
 * mine it is busy.
 *
 * Prefers the displayed lane, so picking XEL while looking at an idle GPU does
 * not yank the view over to the CPU.
 */
export function laneForPick(
  chain: ChainType,
  miner: Pick<CoinPickerMiner, "miningHardware" | "isMiningCpu" | "isMiningGpu">,
): MiningHardware | null {
  const lanes = coinLanes(chain);
  if (lanes.includes(miner.miningHardware) && !laneBusy(miner.miningHardware, miner)) {
    return miner.miningHardware;
  }
  return lanes.find((lane) => !laneBusy(lane, miner)) ?? null;
}

/**
 * Select a coin, moving the displayed hardware to the lane that will mine it.
 *
 * Refuses while no lane can take it — the same guard `coinTileLocked` renders,
 * repeated here because a disabled button is a UI affordance and this is the
 * actual rule.
 */
export function pickMiningCoin(chain: ChainType, miner: CoinPickerMiner): void {
  const lane = laneForPick(chain, miner);
  if (lane === null) return;
  if (miner.miningHardware !== lane) miner.setMiningHardware(lane);
  miner.setMiningCoin(chain);
}
