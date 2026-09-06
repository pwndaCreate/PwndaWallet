import { useCallback, useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";

/**
 * Mining opt-in flag — the single gate that turns the full wallet's mining
 * subsystem from **dormant** to active (pure-wallet cutover, 2026-07-06).
 *
 * A fresh install is a pure wallet: nothing mining-related runs, downloads,
 * elevates, or touches Defender until the user completes the
 * `MiningSetupWizard`, which writes this key. Until then the app layer
 * (`App.tsx`) forces the mining hook's focus to `"other"` and passes
 * `enabled:false`, so **no mining `invoke` fires**.
 *
 * Stored as a **plaintext** key in `wallet.dat` (the same tauri-plugin-store
 * file the encrypted vault lives in — different key, no encryption). Plaintext
 * is deliberate: it's a non-secret UX flag, and it must be readable/writable
 * *before* the vault is unlocked (the Mine tab is reachable pre-login) with no
 * session password. Mirrors the plaintext-ack pattern the removed
 * `devFeeAck.ts` used. Value is the unix-millis timestamp of opt-in, or absent.
 *
 * **PwndaLite never touches this key** — Lite is mining-only and always-on, so
 * `LiteApp.tsx` mounts `useMiner` without the gate (the `enabled` prop defaults
 * to `true`). The gate is full-app-only, living entirely in the app layer so
 * `useMiner`'s `{ addressFor }` contract stays shared and unchanged
 * ([[pwnda-mining-modularization]]).
 */

export const MINING_OPT_IN_STORE_KEY = "pwnda.miningOptedInAt";

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load("wallet.dat", { defaults: {} });
  }
  return storeInstance;
}

/** Read the opt-in timestamp. `null` if the user has never opted in. */
export async function readMiningOptIn(): Promise<number | null> {
  const store = await getStore();
  const v = await store.get<unknown>(MINING_OPT_IN_STORE_KEY);
  return typeof v === "number" ? v : null;
}

/** Persist `Date.now()` as the opt-in timestamp (idempotent — keeps the
 *  earliest opt-in if one already exists). */
export async function enableMiningOptIn(): Promise<void> {
  const store = await getStore();
  const existing = await store.get<unknown>(MINING_OPT_IN_STORE_KEY);
  if (typeof existing === "number") return;
  await store.set(MINING_OPT_IN_STORE_KEY, Date.now());
  await store.save();
}

/** Clear the opt-in flag — returns the full wallet's mining subsystem to
 *  dormant. (Does not stop an in-flight session; the caller stops mining
 *  first.) */
export async function disableMiningOptIn(): Promise<void> {
  const store = await getStore();
  await store.delete(MINING_OPT_IN_STORE_KEY);
  await store.save();
}

/**
 * Reactive opt-in state for the app layer. `optedIn` is `null` while the
 * initial read is in flight — treat `null` as "not yet enabled" so no mining
 * invoke fires before the flag is known. Own this hook at the App level (a
 * single instance) so `enable()`/`disable()` re-render the whole view tree,
 * flipping the Mine tab between the wizard and the live mining view.
 */
export function useMiningOptIn() {
  const [optedIn, setOptedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readMiningOptIn().then((ts) => {
      if (!cancelled) setOptedIn(ts != null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    await enableMiningOptIn();
    setOptedIn(true);
  }, []);

  const disable = useCallback(async () => {
    await disableMiningOptIn();
    setOptedIn(false);
  }, []);

  return { optedIn, enable, disable };
}
