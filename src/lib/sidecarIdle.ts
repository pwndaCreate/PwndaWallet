/**
 * Idle-stop for the wallet's own chain sidecars (RAM plan 3.1, 2026-09-25).
 *
 * Every wallet-rpc (Monero, Zephyr, Zano simplewallet, Xelis) is started at
 * unlock and used to run until Lock or exit, whatever the user was doing - up
 * to four processes resident all session. The operator chose (2026-09-25)
 * "idle-stop + periodic wake" over a strict lazy start, so the first screen
 * after unlock is unchanged:
 *
 *  - a chain whose wallet is SYNCED and that nothing has used for
 *    {@link IDLE_AFTER_MS} is put to sleep - its session released exactly as
 *    Lock releases it - and its dashboard row keeps the last real balance,
 *    marked paused;
 *  - opening that chain (its details, Send/Receive live there), the Activity
 *    feed or the Swap tab wakes it;
 *  - every {@link PERIODIC_WAKE_MS} a sleeping chain wakes on its own, syncs,
 *    lets the balance sweep read it, and sleeps again after
 *    {@link PERIODIC_SETTLE_MS} - so incoming funds reach the dashboard within
 *    about an hour;
 *  - a chain the swap node may be holding is never put to sleep, and is woken
 *    if the node starts while it sleeps (Zano's engine activation needs the
 *    wallet already running). "Holding" is judged conservatively - see
 *    `swapHold` in App.tsx.
 *
 * The decision is a pure function of time, the chain's state and four
 * booleans, so every rule above is pinned in `sidecarIdle.test.ts`. App owns
 * the inputs and performs the actions through each session hook's
 * `sleep`/`wake`.
 */
import { useSyncExternalStore } from "react";
import type { ChainType } from "../wallets";

/** The chains with a local wallet sidecar this module manages. */
export type IdleChain = "monero" | "zephyr" | "zano" | "xelis";
export const IDLE_CHAINS: readonly IdleChain[] = ["monero", "zephyr", "zano", "xelis"];
/** Chains the swap node can hold (host wallet / lease / claim). Xelis cannot. */
export const SWAP_CAPABLE: ReadonlySet<IdleChain> = new Set<IdleChain>(["monero", "zephyr", "zano"]);

export const IDLE_AFTER_MS = 15 * 60_000;
export const PERIODIC_WAKE_MS = 60 * 60_000;
/** After a periodic wake reaches synced: long enough for the balance sweep. */
export const PERIODIC_SETTLE_MS = 60_000;
/** How often App re-evaluates. Cheap: no I/O unless an action is due. */
export const IDLE_TICK_MS = 30_000;

export type WakeReason = "use" | "periodic" | "swap";

export interface IdleChainState {
  /** Last tick the chain was in use (or woken for use). */
  lastUsedAt: number;
  /** When it was put to sleep; null while awake. */
  dormantSince: number | null;
  /** Why it was last woken; null if it never slept. */
  wake: { reason: WakeReason; at: number } | null;
  /** When the current synced stretch began; null while not synced. */
  syncedAt: number | null;
}

export interface IdleInputs {
  /** The session is synced (XMR/ZEPH/XEL "synced", Zano "ready"). */
  synced: boolean;
  /** Something on screen is using this chain. */
  inUse: boolean;
  /** The swap node may be holding it - never sleep, and wake if asleep. */
  swapHold: boolean;
}

export type IdleAction = "sleep" | "wake" | null;

export function initialIdleState(now: number): IdleChainState {
  return { lastUsedAt: now, dormantSince: null, wake: null, syncedAt: null };
}

/**
 * One scheduler step for one chain. Returns the action to perform (if any)
 * and the state to keep. Callers apply `next` only once the action has been
 * carried out - or keep it regardless if they treat a failed action as done;
 * App keeps it, and relies on the hook to report the real session state on
 * the next tick.
 */
export function decideIdle(
  now: number,
  st: IdleChainState,
  inp: IdleInputs,
): { action: IdleAction; next: IdleChainState } {
  const next: IdleChainState = { ...st };
  if (inp.inUse) next.lastUsedAt = now;

  if (st.dormantSince !== null) {
    const reason: WakeReason | null = inp.inUse
      ? "use"
      : inp.swapHold
        ? "swap"
        : now - st.dormantSince >= PERIODIC_WAKE_MS
          ? "periodic"
          : null;
    if (!reason) return { action: null, next };
    return {
      action: "wake",
      next: {
        ...next,
        dormantSince: null,
        wake: { reason, at: now },
        // A periodic wake is not use: the idle clock keeps its old value, and
        // the settle rule below decides when it sleeps again.
        lastUsedAt: reason === "periodic" ? next.lastUsedAt : now,
        syncedAt: null,
      },
    };
  }

  next.syncedAt = inp.synced ? (st.syncedAt ?? now) : null;
  if (!inp.synced || inp.inUse || inp.swapHold) return { action: null, next };

  const periodic = st.wake?.reason === "periodic" && st.wake.at > st.lastUsedAt;
  const due = periodic
    ? now - (next.syncedAt as number) >= PERIODIC_SETTLE_MS
    : now - next.lastUsedAt >= IDLE_AFTER_MS;
  if (!due) return { action: null, next };
  return { action: "sleep", next: { ...next, dormantSince: now, syncedAt: null } };
}

/**
 * Should the balance sweep leave this chain's last value alone? While it
 * sleeps its adapter answers "Syncing…" (no session), and a periodic wake is
 * not synced yet either - writing that over the real number would make the
 * dashboard flicker every hour and persist the placeholder to the cache.
 */
export function holdsBalance(st: IdleChainState | undefined, synced: boolean): boolean {
  if (!st) return false;
  if (st.dormantSince !== null) return true;
  return st.wake?.reason === "periodic" && st.wake.at > st.lastUsedAt && !synced;
}

// ---------------------------------------------------------------------------
// Paused-chain store: App writes, the asset rows read (both layouts), without
// threading a prop through ViewRouter / LandscapeRoot.

let paused: ReadonlyMap<ChainType, number> = new Map();
const listeners = new Set<() => void>();

export function setPausedChains(next: ReadonlyMap<ChainType, number>): void {
  if (next.size === paused.size && [...next].every(([c, t]) => paused.get(c) === t)) return;
  paused = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Chains currently asleep, with the time each went to sleep. */
export function usePausedChains(): ReadonlyMap<ChainType, number> {
  return useSyncExternalStore(subscribe, () => paused, () => paused);
}
