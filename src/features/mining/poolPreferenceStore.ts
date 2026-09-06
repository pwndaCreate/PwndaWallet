/**
 * Pool-preference store — remembers how many times the user has
 * launched each pool per (coin, algorithm) so the mining tab can
 * auto-select their most-used pool on next load instead of falling
 * back to the static sort-order default.
 *
 * Storage: `tauri-plugin-store` file `mining-prefs.dat`. Plaintext,
 * never holds keys, separate from the wallet vault. Small map: at
 * most ~5 series × ~5 pools = 25 entries × ~30 bytes.
 *
 * The counter is bumped on every successful `start_xmrig` /
 * `start_gpu_miner` invocation, not on first-share — intent is what
 * we care about. A user who repeatedly clicks Start on the same pool
 * means "this is the pool I want", regardless of whether the session
 * happens to authenticate.
 *
 * See [[pool-preference-store]] for the architectural rationale.
 */

import { Store } from "@tauri-apps/plugin-store";
import type { ChainType } from "../../wallets";
import type { CpuAlgorithm, GpuAlgorithm } from "../../types/mining";
import type { PoolId } from "./pools";

const STORE_FILE = "mining-prefs.dat";
const STORE_KEY = "poolUseCounts";

type Algorithm = CpuAlgorithm | GpuAlgorithm;
export type PoolPrefSeriesKey = `${ChainType}/${Algorithm}`;

/** `{ "ergo/autolykos": { "woolypooly-ergo": 12, "herominers-ergo": 2 } }` */
export type PoolUseCounts = Partial<
  Record<PoolPrefSeriesKey, Record<PoolId, number>>
>;

function seriesKey(coin: ChainType, algo: Algorithm): PoolPrefSeriesKey {
  return `${coin}/${algo}` as PoolPrefSeriesKey;
}

let _storePromise: Promise<Store> | null = null;
async function getStore(): Promise<Store> {
  if (!_storePromise) _storePromise = Store.load(STORE_FILE);
  return _storePromise;
}

/**
 * Load the entire counts map from disk. Returns an empty object on
 * any failure (missing file, JSON corruption, type mismatch). The
 * caller never blocks on this — the mining tab works fine with no
 * preferences (falls through to the existing sort-order default).
 */
export async function loadPoolPreferences(): Promise<PoolUseCounts> {
  try {
    const store = await getStore();
    const raw = await store.get<unknown>(STORE_KEY);
    if (!raw || typeof raw !== "object") return {};
    return raw as PoolUseCounts;
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.warn("[pool-preferences] load failed; starting fresh:", e);
    return {};
  }
}

/**
 * Bump the counter for `(coin, algo, poolId)` by one and persist the
 * updated map. Returns the new in-memory map so callers can update
 * their local state without a round-trip read.
 *
 * Fire-and-forget from the caller's perspective — failures are
 * logged but never thrown. A lost write at worst means the user's
 * next session falls back to the sort-order default for one launch.
 */
export async function recordPoolUse(
  coin: ChainType,
  algo: Algorithm,
  poolId: PoolId,
): Promise<PoolUseCounts> {
  try {
    const store = await getStore();
    const current = ((await store.get<PoolUseCounts>(STORE_KEY)) ?? {}) as PoolUseCounts;
    const key = seriesKey(coin, algo);
    const bucket = { ...(current[key] ?? {}) };
    bucket[poolId] = (bucket[poolId] ?? 0) + 1;
    const next: PoolUseCounts = { ...current, [key]: bucket };
    await store.set(STORE_KEY, next);
    await store.save();
    return next;
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.warn("[pool-preferences] record failed:", e);
    return {};
  }
}

/**
 * Return the most-used pool id for a (coin, algo) pair, or `null` if
 * no preference has been recorded yet. Ties resolve to whichever
 * `Object.entries` visits first — fine for an "I just want my usual"
 * UX since both contenders are equally familiar.
 *
 * Caller is responsible for verifying the returned id is still in
 * the current `availablePools` (a pool may have been removed from
 * the registry since the preference was recorded).
 */
export function mostUsedPoolFor(
  prefs: PoolUseCounts,
  coin: ChainType,
  algo: Algorithm,
): PoolId | null {
  const bucket = prefs[seriesKey(coin, algo)];
  if (!bucket) return null;
  let bestId: PoolId | null = null;
  let bestCount = 0;
  for (const [id, count] of Object.entries(bucket)) {
    if (count > bestCount) {
      bestCount = count;
      bestId = id;
    }
  }
  return bestId;
}
