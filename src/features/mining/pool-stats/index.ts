import type { PoolId } from "../pools";
import type { PoolStatsAdapter } from "./types";
import { HASHVAULT_MONERO, HASHVAULT_ZEPHYR } from "./hashvault";
import {
  HEROMINERS_MONERO,
  HEROMINERS_CONFLUX,
  HEROMINERS_RAVENCOIN,
} from "./herominers";
import { NANOPOOL_CONFLUX } from "./nanopool";
import { WOOLYPOOLY_CONFLUX, WOOLYPOOLY_RAVENCOIN } from "./woolypooly";
import { NTMINERPOOL_ZEPHYR } from "./ntminerpool";
import {
  HEROMINERS_ERGO,
  WOOLYPOOLY_ERGO,
  NANOPOOL_ERGO_EU,
  NANOPOOL_ERGO_US,
} from "./ergo";

export type { MinerStats, PoolStatsAdapter } from "./types";
export { PoolStatsPanel } from "./PoolStatsPanel";

/**
 * Returns the stats adapter for a given pool ID, or null when:
 *   - the pool has no live-stats integration yet (PWNDA pools, Ntminer pre-Phase-2)
 *   - the pool ID is unknown.
 *
 * The UI hides `PoolStatsPanel` whenever this returns null.
 */
export function getStatsAdapter(poolId: PoolId | null): PoolStatsAdapter | null {
  if (!poolId) return null;
  return ADAPTERS[poolId] ?? null;
}

const ADAPTERS: Record<string, PoolStatsAdapter> = {
  [HASHVAULT_MONERO.id]: HASHVAULT_MONERO,
  [HASHVAULT_ZEPHYR.id]: HASHVAULT_ZEPHYR,
  [HEROMINERS_MONERO.id]: HEROMINERS_MONERO,
  [HEROMINERS_CONFLUX.id]: HEROMINERS_CONFLUX,
  [HEROMINERS_RAVENCOIN.id]: HEROMINERS_RAVENCOIN,
  [HEROMINERS_ERGO.id]: HEROMINERS_ERGO,
  [NANOPOOL_CONFLUX.id]: NANOPOOL_CONFLUX,
  [NANOPOOL_ERGO_EU.id]: NANOPOOL_ERGO_EU,
  [NANOPOOL_ERGO_US.id]: NANOPOOL_ERGO_US,
  [WOOLYPOOLY_CONFLUX.id]: WOOLYPOOLY_CONFLUX,
  [WOOLYPOOLY_RAVENCOIN.id]: WOOLYPOOLY_RAVENCOIN,
  [WOOLYPOOLY_ERGO.id]: WOOLYPOOLY_ERGO,
  [NTMINERPOOL_ZEPHYR.id]: NTMINERPOOL_ZEPHYR,
};
