/**
 * Active-mining-session store — remembers the UI context (coin,
 * algorithm, miner, pool) of each *currently running* miner so the
 * Mining view can rehydrate after the React app reloads out from under
 * a live session.
 *
 * ## Why this exists
 *
 * Mining is **backend-owned** — the xmrig / SRBMiner / lolMiner
 * subprocesses live in the Rust process and survive a WebView2 reload.
 * But the mining UI state (`miningHardware`, `miningCoin`,
 * `gpuAlgorithm`, `runningGpuMiner`, active pool) is ephemeral React
 * `useState` with no persistence. When the renderer reloads — most
 * visibly via the `mem_guard` memory circuit-breaker mid-session (see
 * [[webview2-memory-management]] Round 13) — that state resets to its
 * defaults (`miningHardware = "cpu"`, `miningCoin = "monero"`). The
 * derived `isMining` then reads the *wrong* hardware lane and the panel
 * looks idle even though the GPU is still hashing.
 *
 * This store closes that gap: `saveActiveSession` records the descriptor
 * at start, `clearActiveSession` drops it at stop (or when the backend
 * reports the lane went idle), and the Mining hook rehydrates from it on
 * mount **only when the backend confirms that lane is still mining**.
 *
 * ## Storage
 *
 * `tauri-plugin-store` file `mining-prefs.dat` (shared with
 * [[pool-preference-store]]), key `activeSessions`. Plaintext, holds no
 * keys or addresses — just the coin/algo/pool selection needed to redraw
 * the running view. Separate from the wallet vault.
 *
 * One descriptor per hardware lane (`cpu` / `gpu`) because the two
 * miners run as independent OS processes and can be active concurrently.
 */

import { Store } from "@tauri-apps/plugin-store";
import type { ChainType } from "../../wallets";
import type {
  CpuAlgorithm,
  GpuAlgorithm,
  MiningHardware,
} from "../../types/mining";
import type { PoolId } from "./pools";

const STORE_FILE = "mining-prefs.dat";
const STORE_KEY = "activeSessions";

/** The minimal UI context needed to redraw the "running" view for a
 *  lane after a reload. Persisted at `startMining`, cleared at stop. */
export interface MiningSessionDescriptor {
  hardware: MiningHardware;
  coin: ChainType;
  /** Present on the CPU lane (xmrig). */
  cpuAlgorithm?: CpuAlgorithm;
  /** Present on the GPU lane. */
  gpuAlgorithm?: GpuAlgorithm;
  /** GPU miner binary, so the snapshot poll parses the right JSON shape
   *  without guessing from a (possibly reset) algorithm value. */
  miner?: "SRBMiner-MULTI" | "lolMiner";
  /** The pool the miner is actually talking to. */
  poolId: PoolId;
}

export type ActiveSessions = Partial<
  Record<MiningHardware, MiningSessionDescriptor>
>;

let _storePromise: Promise<Store> | null = null;
async function getStore(): Promise<Store> {
  if (!_storePromise) _storePromise = Store.load(STORE_FILE);
  return _storePromise;
}

/**
 * Load both lanes' descriptors. Returns `{}` on any failure (missing
 * file, corruption, non-Tauri dev surface). The caller gates every
 * restore on the backend's `is_mining` / `is_gpu_mining` truth, so a
 * stale descriptor here can never resurrect a session that isn't
 * actually running.
 */
export async function loadActiveSessions(): Promise<ActiveSessions> {
  try {
    const store = await getStore();
    const raw = await store.get<unknown>(STORE_KEY);
    if (!raw || typeof raw !== "object") return {};
    return raw as ActiveSessions;
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.warn("[active-session] load failed; starting fresh:", e);
    return {};
  }
}

/**
 * Record (or overwrite) the descriptor for one hardware lane. Fire-and-
 * forget — a lost write at worst means the post-reload view falls back
 * to the lane-boolean-only rehydration (running hero shows, but with
 * default coin/pool labels until the user re-picks).
 */
export async function saveActiveSession(
  hardware: MiningHardware,
  descriptor: MiningSessionDescriptor,
): Promise<void> {
  try {
    const store = await getStore();
    const current = ((await store.get<ActiveSessions>(STORE_KEY)) ?? {}) as ActiveSessions;
    const next: ActiveSessions = { ...current, [hardware]: descriptor };
    await store.set(STORE_KEY, next);
    await store.save();
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.warn("[active-session] save failed:", e);
  }
}

/**
 * Drop the descriptor for one hardware lane (on stop, or when the
 * backend reports the lane went idle). Fire-and-forget.
 */
export async function clearActiveSession(
  hardware: MiningHardware,
): Promise<void> {
  try {
    const store = await getStore();
    const current = ((await store.get<ActiveSessions>(STORE_KEY)) ?? {}) as ActiveSessions;
    if (!(hardware in current)) return;
    const next: ActiveSessions = { ...current };
    delete next[hardware];
    await store.set(STORE_KEY, next);
    await store.save();
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.warn("[active-session] clear failed:", e);
  }
}
