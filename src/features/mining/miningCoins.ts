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
 * `HOUSE_DEFAULT_POOL` in `pools.ts`) — followed by the remaining GPU coins.
 * RVN/CFX/ERG moving behind the fold is intentional, not a demotion by
 * omission: they are still fully mineable via "3 more ▾", same as ZANO was
 * before this change.
 */
import type { ChainType } from "../../wallets";

export interface MiningCoinOption {
  sym: string;
  chain: ChainType;
  algo: string;
  /**
   * Which lane mines this coin.
   *
   * Declared per coin rather than inferred at each call site. Until
   * 2026-08-28 four separate places asked
   * `ticker === "RVN" || ticker === "CFX" || ticker === "ERG"`, and adding
   * ZANO put a GPU coin outside all four lists at once: picking it left the
   * hardware on CPU, so the pool lookup asked for `zano/randomx`, found
   * nothing, and the console showed "No pools for this coin/algo" and
   * "Setup miners first" for a coin that was perfectly mineable. A required
   * field makes the next coin declare its lane instead of inheriting a
   * silent default.
   */
  hardware: "cpu" | "gpu";
}

export const MINING_COINS: MiningCoinOption[] = [
  { sym: "XMR",  chain: "monero",    algo: "RandomX",    hardware: "cpu" },
  { sym: "ZANO", chain: "zano",      algo: "ProgPowZ",   hardware: "gpu" },
  { sym: "ZEPH", chain: "zephyr",    algo: "RandomX",    hardware: "cpu" },
  { sym: "RVN",  chain: "ravencoin", algo: "KAWPOW",     hardware: "gpu" },
  { sym: "CFX",  chain: "conflux",   algo: "Octopus",    hardware: "gpu" },
  { sym: "ERG",  chain: "ergo",      algo: "Autolykos2", hardware: "gpu" },
];

/**
 * Which lane mines this coin. `true` = GPU.
 *
 * The single answer to a question four call sites used to answer for
 * themselves with a hardcoded ticker list. An unknown coin is treated as CPU
 * — the conservative direction, since a CPU lane always exists.
 */
export function isGpuCoin(chain: ChainType): boolean {
  return MINING_COINS.find((c) => c.chain === chain)?.hardware === "gpu";
}
