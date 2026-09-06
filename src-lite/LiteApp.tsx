import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useMiner } from "../src/features/mining/useMiner";
import { toMiningFocus } from "../src/features/mining/featureFocus";
import { useMemoryTracker, usePeriodicGc } from "../src/features/mining/useMemoryTrace";
import { LiteMiningView } from "./views/LiteMiningView";
import { LiteSettingsView } from "./views/LiteSettingsView";
import { LiteTitleBar } from "./views/LiteTitleBar";
import { LiteBottomNav } from "./views/LiteBottomNav";
import { useAppStateLite } from "./state/AppStateLite";
import { fetchUsdPrices } from "../src/wallets/usd-prices";

/**
 * Root component for PwndaLite — the mining-only product variant.
 *
 * Two tabs: Mine (shared `MiningView` with an `addressFor` callback that
 * reads the user-typed paste field) and Settings (paste-an-address inputs
 * plus the same Defender / miner-download / hardware-profile UI the full
 * wallet exposes via MinerSetupView).
 *
 * The mining state machine is `useMiner` from `src/features/mining/`,
 * imported as-is. Nothing about the hook is lite-specific — it's the
 * same code path the full wallet runs. See [[pwnda-lite-plan]].
 */
export function LiteApp() {
  const {
    view,
    setView,
    persistedMiningCoin,
    persistMiningCoin,
    addressFor,
  } = useAppStateLite();

  // Pwnda Lite's `focus` maps 1:1 to `view` because there's no landscape
  // layout to coordinate with. `toMiningFocus` collapses anything that
  // isn't `"mining"` or `"miner-setup"` to `"other"`; lite never uses
  // `miner-setup` as a route (the setup UI is the Settings tab body) so
  // we pass `"mining"` when on the Mine tab and `"other"` when on
  // Settings. This still lets the hashrate / dev-fee / pool-stats
  // pollers idle while the user is in Settings.
  const miner = useMiner({
    focus: toMiningFocus(view === "mining" ? "mining" : "settings"),
    addressFor,
  });

  // 2026-05-28 — Memory tracker. Polls `performance.memory` once per
  // minute and persists samples to localStorage so the user can leave
  // the app running through a long mining session and inspect the V8
  // heap growth curve afterward via `<MemoryTraceCard>` in Settings.
  // Mounted at the shell level (not inside any tab) so it runs
  // continuously regardless of which view is on screen — the
  // `view` arg is what gets labeled into each sample for post-mortem
  // correlation. Hook is a no-op outside Chromium / WebView2.
  useMemoryTracker({ view: `lite-${view}` });
  // Periodic forced GC to reclaim the WebView2 renderer native-memory creep
  // (MS WebView2Feedback #3678). Paired with `--expose-gc` in the lite
  // window's additionalBrowserArgs. Mining-aware (45 s while mining vs 4 min
  // idle) — the chart-repaint leak is ~22× faster during a session. See
  // useMemoryTrace.ts::usePeriodicGc.
  usePeriodicGc(miner.isAnyMining);

  // ── miningCoin lifecycle ──────────────────────────────────────────
  // The miner hook owns the canonical `miningCoin`. AppStateLite holds
  // a write-through copy purely for localStorage persistence. We seed
  // the miner from the persisted value ONCE on mount (`seededRef`
  // guards re-seeding from React StrictMode's double-mount), and after
  // that the data flow is strictly one-way: miner.miningCoin →
  // persistMiningCoin → localStorage. The two-way `useEffect` sync that
  // lived here previously caused an infinite render loop — fixed
  // 2026-05-13.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (miner.miningCoin !== persistedMiningCoin) {
      miner.setMiningCoin(persistedMiningCoin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    persistMiningCoin(miner.miningCoin);
  }, [miner.miningCoin, persistMiningCoin]);

  // ── USD prices for the per-coin $/day prediction strip ────────────
  // The shared `MiningView` accepts an optional `pricesByTicker` and uses
  // it for the profitability tiles. Fetch via the same module the full
  // wallet uses; it's purely fetch-and-cache, no wallet/vault coupling.
  const [pricesByTicker, setPricesByTicker] = useState<Record<string, number>>(
    {}
  );

  useEffect(() => {
    let cancelled = false;
    const tickers = ["XMR", "ZEPH", "RVN", "CFX"];
    const refresh = async () => {
      try {
        const prices = await fetchUsdPrices(tickers);
        if (!cancelled) setPricesByTicker(prices);
      } catch {
        /* keep the previous values on failure — never fake prices */
      }
    };
    refresh();
    const id = setInterval(refresh, 90_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ── Window controls — Tauri's "decorations: false" window needs us to
  //    wire min / close manually. Same pattern as the full wallet. ────
  const handleMin = useCallback(async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      /* ignore */
    }
  }, []);
  const handleClose = useCallback(async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore */
    }
  }, []);

  // `MiningView` expects an `onBack` callback but lite uses tab nav, so
  // routing "back" just lands on Settings. Mining is the root view —
  // there's nothing else to back into.
  const noBack = useCallback(() => setView("settings"), [setView]);

  return (
    <div className="window-shell">
      <LiteTitleBar onMin={handleMin} onClose={handleClose} />
      <div
        className="app"
        style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}
      >
        {view === "mining" && (
          <LiteMiningView
            miner={miner}
            addressFor={addressFor}
            pricesByTicker={pricesByTicker}
            onBack={noBack}
          />
        )}
        {view === "settings" && (
          <LiteSettingsView miner={miner} pricesByTicker={pricesByTicker} />
        )}
      </div>
      <LiteBottomNav tab={view} setTab={setView} />
    </div>
  );
}
