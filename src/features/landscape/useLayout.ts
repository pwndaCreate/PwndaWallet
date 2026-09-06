import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import type { LandscapeTab } from "./LandscapeShell";
import type { View } from "../../types/view";
import { deriveFeatureFocus, type FeatureFocus } from "../../state/featureFocus";

/**
 * Layout-mode orchestration hook. Owns:
 *   - The persisted `layout` state (portrait / landscape) backed by
 *     localStorage under `pwnda-layout`.
 *   - The active `landscapeTab` (wallet / swap / mine / activity / settings).
 *   - Window-resize side effects: portrait locks 560×860, landscape
 *     resizes to 1280×720. Tauri's `resizable: false` is briefly
 *     toggled to allow programmatic resize.
 *   - Mount-time resync — if the persisted layout is landscape, the
 *     window jumps to landscape size on app load.
 *   - View ↔ landscapeTab sync. The landscape tab bar only flips
 *     `landscapeTab`; the portrait BottomNav flips `view`. Several
 *     feature hooks gate their polling on `view === "mining"` etc.,
 *     so landscape-tab changes need to mirror onto `view` and vice
 *     versa to keep the lifecycle consistent.
 *
 * Also derives the chain-agnostic `featureFocus` from
 * (layout, view, landscapeTab) — feature hooks consume this rather
 * than `view` directly so landscape mode triggers them correctly.
 * See [[layout-parity-plan]] §2b and [[feature-parity-matrix]].
 */

const PORTRAIT_SIZE = { w: 560, h: 860 } as const;
const LANDSCAPE_SIZE = { w: 1280, h: 720 } as const;

export type LayoutMode = "portrait" | "landscape";

export function useLayout(args: {
  view: View;
  setView: (v: View) => void;
}): {
  layout: LayoutMode;
  setLayout: (next: LayoutMode) => void;
  landscapeTab: LandscapeTab;
  setLandscapeTab: (t: LandscapeTab) => void;
  featureFocus: FeatureFocus;
} {
  const { view, setView } = args;

  const [layout, setLayoutRaw] = useState<LayoutMode>(() => {
    // Landscape is the default layout (2026-06-20). Users who have explicitly
    // toggled to portrait keep their choice via the persisted localStorage key.
    return (
      (localStorage.getItem("pwnda-layout") as LayoutMode) || "landscape"
    );
  });
  const [landscapeTab, setLandscapeTab] = useState<LandscapeTab>("wallet");

  const applyWindowSize = useCallback(async (next: LayoutMode) => {
    const { w, h } = next === "landscape" ? LANDSCAPE_SIZE : PORTRAIT_SIZE;
    const win = getCurrentWindow();
    try {
      // tauri.conf.json declares resizable: false, which can block programmatic
      // setSize on some platforms. Briefly re-enable, resize, recenter, lock back.
      await win.setResizable(true);
      await win.setSize(new LogicalSize(w, h));
      await win.center();
      // Stay resizable — the window is user-resizable now (tauri.conf
      // `resizable: true`). This used to re-lock via setResizable(false).
    } catch {
      /* ignore — window may be in a state that rejects resize */
    }
  }, []);

  const setLayout = useCallback(
    (next: LayoutMode) => {
      setLayoutRaw(next);
      localStorage.setItem("pwnda-layout", next);
      void applyWindowSize(next);
    },
    [applyWindowSize]
  );

  // On mount, snap the window to the EFFECTIVE layout's ORIENTATION — but only
  // if it doesn't already match, so a user's manual resize within the same
  // orientation survives a reload (the window is user-resizable now).
  useEffect(() => {
    const saved = localStorage.getItem("pwnda-layout") as LayoutMode | null;
    const effective: LayoutMode = saved === "portrait" ? "portrait" : "landscape";
    const isWindowLandscape =
      typeof window !== "undefined" && window.innerWidth > window.innerHeight;
    if (effective === "landscape" && !isWindowLandscape) void applyWindowSize("landscape");
    else if (effective === "portrait" && isWindowLandscape) void applyWindowSize("portrait");
  }, [applyWindowSize]);

  // If the user navigates away from the landscape settings tab while the
  // Monero / Zephyr nodes sub-view is open, clear that sub-view so returning
  // later lands on the settings panel, not the (stale) nodes screen.
  useEffect(() => {
    if (layout !== "landscape") return;
    if (landscapeTab === "settings") return;
    if (view === "monero-nodes" || view === "zephyr-nodes") {
      setView("dashboard");
    }
  }, [layout, landscapeTab, view, setView]);

  // Landscape tab → view sync. The portrait BottomNav calls setView("mining")
  // when the user taps Mine, which is what the useMiner hook gates all its
  // lifecycle/poll effects on (`view === "mining"`). The landscape tab bar
  // only flipped `landscapeTab` without touching `view`, so the hook never
  // started polling — the user could "Start Mining" but isMining stayed false
  // and no hashrate / pool stats appeared. Mirror the portrait behaviour.
  useEffect(() => {
    if (layout !== "landscape") return;
    if (landscapeTab === "mine" && view !== "mining") {
      setView("mining");
    } else if (
      landscapeTab === "settings" &&
      view !== "settings" &&
      view !== "monero-nodes" &&
      view !== "zephyr-nodes" &&
      view !== "wallet-details" &&
      view !== "miner-setup"
    ) {
      setView("settings");
    } else if (
      (landscapeTab === "wallet" ||
        landscapeTab === "swap" ||
        landscapeTab === "activity") &&
      (view === "mining" ||
        view === "settings" ||
        view === "wallet-details" ||
        view === "miner-setup")
    ) {
      setView("dashboard");
    }
  }, [layout, landscapeTab, view, setView]);

  const featureFocus = deriveFeatureFocus({ layout, view, landscapeTab });

  return {
    layout,
    setLayout,
    landscapeTab,
    setLandscapeTab,
    featureFocus,
  };
}
