/**
 * Swap-form preferences persisted via `tauri-plugin-store`.
 *
 * - `slippagePercent` — slippage tolerance, percent points (default 2)
 * - `preferredRouter` — which routing system to query: 'auto' | 'swapkit'
 *   | 'intents' | 'pwnda-desk'. Default 'intents' during the testing phase
 *   since SwapKit upstream is still mocked.
 *
 * Lives in the same `wallet.dat` file as the vault and history so we
 * don't fork persistence stores.
 */
import { useCallback, useEffect, useState } from "react";
import { getStore } from "../../store";
import {
  ROUTER_PREFERENCE_OPTIONS,
  type RouterPreference,
} from "../swap/router-modes";

const STORE_KEY = "swapSettings";
const DEFAULT_SLIPPAGE_PERCENT = 2;
const DEFAULT_PREFERRED_ROUTER: RouterPreference = "intents";

export interface SwapSettings {
  /** Slippage tolerance, in percent points (e.g. 2 = 2%). Default 2. */
  slippagePercent: number;
  /** Which routing system to query for quotes. */
  preferredRouter: RouterPreference;
}

/**
 * Accepted `preferredRouter` values, DERIVED from the shared options list
 * rather than hand-listed.
 *
 * This was a hand-written `new Set(["auto","swapkit","intents"])` until
 * 2026-07-19, which made adding a router a silent two-place change: both
 * `SettingsView` and `SwapForm` already render their pickers by mapping
 * `ROUTER_PREFERENCE_OPTIONS`, so a new entry there produced a button that
 * looked live but whose `setPreferredRouter` call was dropped by the
 * membership check below — no type error, no console warning, and the load
 * path silently reset a persisted value back to the default. Deriving the
 * set means the picker and the validator can never disagree again.
 */
const VALID_ROUTERS: ReadonlySet<string> = new Set(
  ROUTER_PREFERENCE_OPTIONS.map((o) => o.value)
);

export function useSwapSettings() {
  const [settings, setSettings] = useState<SwapSettings>({
    slippagePercent: DEFAULT_SLIPPAGE_PERCENT,
    preferredRouter: DEFAULT_PREFERRED_ROUTER,
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const store = await getStore();
        const persisted = await store.get<Partial<SwapSettings>>(STORE_KEY);
        if (!cancel && persisted) {
          setSettings({
            slippagePercent: Number.isFinite(persisted.slippagePercent)
              ? clampPercent(persisted.slippagePercent as number)
              : DEFAULT_SLIPPAGE_PERCENT,
            preferredRouter:
              typeof persisted.preferredRouter === "string" &&
              VALID_ROUTERS.has(persisted.preferredRouter)
                ? (persisted.preferredRouter as RouterPreference)
                : DEFAULT_PREFERRED_ROUTER,
          });
        }
      } catch {
        /* fall back to defaults */
      } finally {
        if (!cancel) setLoaded(true);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const persist = useCallback(async (next: SwapSettings) => {
    setSettings(next);
    try {
      const store = await getStore();
      await store.set(STORE_KEY, next);
      await store.save();
    } catch {
      /* silent — UI keeps the value in memory until next load */
    }
  }, []);

  const setSlippagePercent = useCallback(
    async (percent: number) => {
      const clamped = clampPercent(percent);
      await persist({ ...settings, slippagePercent: clamped });
    },
    [persist, settings]
  );

  const setPreferredRouter = useCallback(
    async (next: RouterPreference) => {
      if (!VALID_ROUTERS.has(next)) return;
      await persist({ ...settings, preferredRouter: next });
    },
    [persist, settings]
  );

  return {
    slippagePercent: settings.slippagePercent,
    /** As a fraction for use in the SwapKit quote request. */
    slippageFraction: settings.slippagePercent / 100,
    setSlippagePercent,
    preferredRouter: settings.preferredRouter,
    setPreferredRouter,
    loaded,
  };
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return DEFAULT_SLIPPAGE_PERCENT;
  if (p < 0) return 0;
  if (p > 50) return 50;
  return p;
}
