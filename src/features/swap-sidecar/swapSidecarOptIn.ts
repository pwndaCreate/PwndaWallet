import { useCallback, useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";

/**
 * BasicSwap-sidecar opt-in flag — the single gate that turns the wallet's
 * swap-sidecar subsystem from **dormant** to available
 * ([[basicswap-sidecar-ultracode-plan]] Phase 1.1).
 *
 * A fresh install ships no swap node: **nothing downloads, prepares, spawns
 * or `invoke`s** until the user completes `SidecarSetupWizard`, which writes
 * this key. Until then the app layer must not mount any surface that calls a
 * `swap_sidecar_*` command — exactly how `App.tsx` gates mining on
 * `miningOptIn.ts`.
 *
 * Deliberately a **byte-for-byte mirror** of
 * `src/features/mining/miningOptIn.ts`: a **plaintext** key in `wallet.dat`
 * (the same tauri-plugin-store file the encrypted vault lives in — different
 * key, no encryption). Plaintext is the point: it is a non-secret UX flag and
 * it must be readable/writable *before* the vault is unlocked, with no session
 * password. Value is the unix-millis timestamp of opt-in, or absent.
 *
 * # This is the SECOND of two opt-in records, and that is intentional
 *
 * The Rust side keeps its own consent record — `swap_sidecar_opt_in` writes
 * `<app_data>/swap-sidecar/opt-in.json`, and `swap_sidecar_start` **refuses**
 * to prepare or spawn without it (`swap_sidecar.rs::swap_sidecar_start`'s
 * first guard). That file is the authority, because the backend is what must
 * refuse to act. This store key is the *frontend* gate: it exists so the UI
 * can decide what to mount **without invoking anything**, which a backend read
 * could not do. Keep them in sync by writing the backend record first and this
 * one second (see `SidecarSetupWizard`) — if the backend write fails, the UI
 * gate stays closed and the user simply retries.
 *
 * **PwndaLite never touches this key** — Lite is mining-only and has no swap
 * surface at all ([[pwnda-mining-modularization]]).
 */

export const SWAP_SIDECAR_OPT_IN_STORE_KEY = "pwnda.swapSidecarOptedInAt";

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load("wallet.dat", { defaults: {} });
  }
  return storeInstance;
}

/** Read the opt-in timestamp. `null` if the user has never opted in. */
export async function readSwapSidecarOptIn(): Promise<number | null> {
  const store = await getStore();
  const v = await store.get<unknown>(SWAP_SIDECAR_OPT_IN_STORE_KEY);
  return typeof v === "number" ? v : null;
}

/** Persist `Date.now()` as the opt-in timestamp (idempotent — keeps the
 *  earliest opt-in if one already exists). */
export async function enableSwapSidecarOptIn(): Promise<void> {
  const store = await getStore();
  const existing = await store.get<unknown>(SWAP_SIDECAR_OPT_IN_STORE_KEY);
  if (typeof existing === "number") return;
  await store.set(SWAP_SIDECAR_OPT_IN_STORE_KEY, Date.now());
  await store.save();
}

/** Clear the opt-in flag — returns the wallet's swap-sidecar subsystem to
 *  dormant. (Does not stop a running node; the caller stops it first, and
 *  should also clear the backend record via `swap_sidecar_opt_in(false)`.) */
export async function disableSwapSidecarOptIn(): Promise<void> {
  const store = await getStore();
  await store.delete(SWAP_SIDECAR_OPT_IN_STORE_KEY);
  await store.save();
}

/**
 * Reactive opt-in state for the app layer. `optedIn` is `null` while the
 * initial read is in flight — **treat `null` as "not yet enabled"** so no
 * `swap_sidecar_*` invoke fires before the flag is known. Own this hook at the
 * App level (a single instance) so `enable()`/`disable()` re-render the whole
 * view tree, flipping the swap surface between the wizard and the live view.
 */
export function useSwapSidecarOptIn() {
  const [optedIn, setOptedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readSwapSidecarOptIn().then((ts) => {
      if (!cancelled) setOptedIn(ts != null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    await enableSwapSidecarOptIn();
    setOptedIn(true);
  }, []);

  const disable = useCallback(async () => {
    await disableSwapSidecarOptIn();
    setOptedIn(false);
  }, []);

  return { optedIn, enable, disable };
}
