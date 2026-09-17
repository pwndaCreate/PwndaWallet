import type { View } from "../types/view";
import type { LandscapeTab } from "../features/landscape/LandscapeShell";

/**
 * Layout-agnostic identifier for "what feature does the user have in focus
 * right now?". Hooks gate their lifecycle effects on this rather than on
 * `view` directly so that landscape mode (which has its own tab bar) can
 * focus a feature without round-tripping through `setView()`.
 *
 * The string values intentionally mirror the `view` enum so existing hooks
 * keep working when their `view` parameter is replaced with `focus`. Only
 * additions are landscape-only states (`activity`, `swap`) which no
 * lifecycle hook currently gates on, but having them in the type means
 * future hooks can.
 *
 * Source-of-truth doc: [[layout-parity-plan]] §2b.
 */
export type FeatureFocus =
  | View
  | "activity"
  | "swap";

/**
 * Node-manager sub-views, one per sidecar chain. In landscape each opens under
 * the Settings tab, and leaving that tab closes it (`useLayout`).
 *
 * ONE list, read by `deriveFeatureFocus` below and by both view-sync effects in
 * `useLayout`. Until 2026-09-15 those three places each kept a literal list,
 * and none of the three had gained `"zano-nodes"` when Zano was added. Pinned
 * by `featureFocus.test.ts`, which also fails when `View` gains a `*-nodes` id
 * this set does not hold.
 */
export const NODE_MANAGER_VIEWS: ReadonlySet<View> = new Set<View>([
  "monero-nodes",
  "zephyr-nodes",
  "zano-nodes",
  "xelis-nodes",
]);

/** Every view that renders as a sub-view of the landscape Settings tab. */
export const LANDSCAPE_SETTINGS_SUBVIEWS: ReadonlySet<View> = new Set<View>([
  ...NODE_MANAGER_VIEWS,
  "wallet-details",
  "miner-setup",
]);

/**
 * Derive the current focus from the three pieces of layout state that
 * App.tsx owns: `layout` (portrait vs landscape), `view` (the portrait
 * route enum), and `landscapeTab` (the landscape sidebar selection).
 *
 * - **Portrait** is 1:1 with `view`. Nothing else to consult.
 * - **Landscape** lets sub-views (`LANDSCAPE_SETTINGS_SUBVIEWS`: the node
 *   managers, wallet-details, miner-setup) override the tab when the user
 *   drills into them, then
 *   falls back to a tab → focus mapping. The mapping makes `wallet`,
 *   `swap`, `activity` all imply the user is on the wallet view (focus
 *   = `dashboard`) for hook-gating purposes — none of the
 *   currently-existing hooks distinguish them. If a future hook does
 *   need to (e.g. an Activity-tab specific poll), bump those tabs out
 *   to their own `FeatureFocus` value.
 */
export function deriveFeatureFocus(args: {
  layout: "portrait" | "landscape";
  view: View;
  landscapeTab: LandscapeTab;
}): FeatureFocus {
  if (args.layout === "portrait") {
    return args.view;
  }

  // Landscape sub-views override the tab when active.
  if (LANDSCAPE_SETTINGS_SUBVIEWS.has(args.view)) {
    return args.view;
  }

  switch (args.landscapeTab) {
    case "wallet": return "dashboard";
    case "swap": return "dashboard";
    case "mine": return "mining";
    // EARN reads the XMR balance and the live mining snapshot, so it wants
    // the same polls the dashboard runs — NOT `mining`, which would let the
    // miner's high-frequency hashrate poll run while the user is only
    // looking at a conversion projection.
    case "earn": return "dashboard";
    case "activity": return "dashboard";
    case "settings": return "settings";
  }
}
