/**
 * src/features/mining/miningCoins.ts
 *
 * The mineable-coin roster the Mine tab offers, in display order.
 *
 * Extracted from `MineLandscapeView` 2026-08-28 so the SIMPLE view
 * (`MineSimpleView`) can render the same list without importing the landscape
 * console — the two are alternate renderings of one page, and a second copy of
 * this array is a second place for a coin to go missing.
 *
 * Order is deliberate, not alphabetical, and it drives more than display:
 * `MineSimpleView`'s collapsed "MINING TARGET" list shows exactly the first
 * `TARGETS_COLLAPSED` (3) entries before the "N more ▾" expander, so this
 * array's first three ARE the three a fresh user sees without an extra click.
 *
 * As of 2026-08-29: XMR, ZANO, ZEPH lead — the pwnda-pool-backed coins (see
 * `HOUSE_DEFAULT_POOL` in `pools.ts`) — followed by the remaining coins.
 * RVN/CFX/ERG moving behind the fold is intentional, not a demotion by
 * omission: they are still fully mineable via "N more ▾", same as ZANO was
 * before that change. XEL (added 2026-09-15) is the first coin behind the
 * fold. It gained a house pool on 2026-09-16 (`pwnda-xelis`) and was left
 * here: the top three are full, and which coin gives up its slot is the
 * operator's call.
 *
 * 2026-09-18: RVN/CFX/ERG retired from mining (lolMiner no longer shipped).
 * The roster is the four pwnda-pool coins and `TARGETS_COLLAPSED` is 4, so
 * SIMPLE shows every coin with no expander.
 */
import type { ChainType } from "../../wallets";
import type {
  CpuAlgorithm,
  GpuAlgorithm,
  MiningHardware,
} from "../../types/mining";

/**
 * The algorithm each lane mines a coin with. A present key means the coin
 * mines on that lane.
 *
 * The union makes "at least one lane" a type fact: `{}` does not type-check.
 */
export type LaneAlgorithms =
  | { cpu: CpuAlgorithm; gpu?: GpuAlgorithm }
  | { cpu?: CpuAlgorithm; gpu: GpuAlgorithm };

export interface MiningCoinOption {
  sym: string;
  chain: ChainType;
  /** Display label for the coin's algorithm. */
  algo: string;
  /**
   * Which lanes mine this coin, and with which algorithm on each.
   *
   * Declared per coin rather than inferred at each call site. Until
   * 2026-08-28 four separate places asked
   * `ticker === "RVN" || ticker === "CFX" || ticker === "ERG"`, and adding
   * ZANO put a GPU coin outside all four lists at once: picking it left the
   * hardware on CPU, so the pool lookup asked for `zano/randomx`, found
   * nothing, and the console showed "No pools for this coin/algo" and
   * "Setup miners first" for a coin that was perfectly mineable.
   *
   * 2026-09-15: this replaced a single `hardware: "cpu" | "gpu"` field, which
   * could not describe Xelis — a coin that mines on BOTH lanes at once, as two
   * separate SRBMiner processes. Carrying the algorithm per lane also removes
   * the coin→algorithm if/else chains `useMiner` used to keep in sync by hand.
   */
  algorithms: LaneAlgorithms;
}

export const MINING_COINS: readonly MiningCoinOption[] = [
  { sym: "XMR",  chain: "monero",    algo: "RandomX",      algorithms: { cpu: "randomx" } },
  { sym: "ZANO", chain: "zano",      algo: "ProgPowZ",     algorithms: { gpu: "progpowz" } },
  { sym: "ZEPH", chain: "zephyr",    algo: "RandomX",      algorithms: { cpu: "randomx" } },
  { sym: "XEL",  chain: "xelis",     algo: "XelisHash v3", algorithms: { cpu: "xelishashv3", gpu: "xelishashv3" } },
  // RVN (KAWPOW), CFX (Octopus, the only lolMiner coin) and ERG (Autolykos2)
  // were retired from mining 2026-09-18 — see `RETIRED_GPU_ALGORITHMS`. Their
  // pools, pool-stats readers and earnings tables are kept as archived data;
  // the wallet still sends and receives all three.
];

const LANE_ORDER: readonly MiningHardware[] = ["cpu", "gpu"];

function findCoin(chain: ChainType): MiningCoinOption | undefined {
  return MINING_COINS.find((c) => c.chain === chain);
}

/**
 * The lanes that can mine this coin, CPU first.
 *
 * An unknown coin is treated as CPU-only — the conservative direction, since
 * a CPU lane always exists. (`algorithmFor` still returns `null` for it, so
 * nothing can actually start mining an unrostered coin.)
 */
export function coinLanes(chain: ChainType): readonly MiningHardware[] {
  const coin = findCoin(chain);
  if (!coin) return ["cpu"];
  return LANE_ORDER.filter((lane) => coin.algorithms[lane] !== undefined);
}

/** Whether `lane` can mine `chain`. */
export function coinMinesOn(chain: ChainType, lane: MiningHardware): boolean {
  return coinLanes(chain).includes(lane);
}

/** True for a coin that mines on both lanes (XEL). */
export function isDualLaneCoin(chain: ChainType): boolean {
  return coinLanes(chain).length > 1;
}

/**
 * The algorithm `lane` mines `chain` with, or `null` when that lane cannot mine
 * it (or the coin is not on the roster).
 */
export function algorithmFor(chain: ChainType, lane: "cpu"): CpuAlgorithm | null;
export function algorithmFor(chain: ChainType, lane: "gpu"): GpuAlgorithm | null;
export function algorithmFor(
  chain: ChainType,
  lane: MiningHardware,
): CpuAlgorithm | GpuAlgorithm | null;
export function algorithmFor(
  chain: ChainType,
  lane: MiningHardware,
): CpuAlgorithm | GpuAlgorithm | null {
  const coin = findCoin(chain);
  if (!coin) return null;
  return (lane === "cpu" ? coin.algorithms.cpu : coin.algorithms.gpu) ?? null;
}

/** `"CPU"`, `"GPU"` or `"CPU/GPU"` — for tooltips and row captions. */
export function lanesLabel(chain: ChainType): string {
  return coinLanes(chain)
    .map((lane) => lane.toUpperCase())
    .join("/");
}
