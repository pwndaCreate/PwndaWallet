/**
 * src/features/swap/components/swap-mode-tabs.ts
 *
 * The ONE source of the swap surface's mode tabs.
 *
 * # Why this file exists
 *
 * Before 2026-08-28 the strip existed in four places with two idioms
 * (`design-surface-map` §12, finding F2):
 *
 * | where | derived? | tabs |
 * |---|---|---|
 * | `SwapForm.tsx` | yes | never rendered — both roots suppress it |
 * | `SettingsView.tsx` | yes | the correct 3 |
 * | `SwapView.tsx` | **hardcoded** | 6, two of them dead |
 * | `SwapLandscapeView.tsx` | derived + literal | 4 |
 *
 * Portrait's `SwapKit` and `Desk` tabs called `setPreferredRouter`, which
 * begins `if (!VALID_ROUTERS.has(next)) return;` — so clicking them changed
 * nothing, highlighted nothing, and reported nothing. A tab that silently
 * does nothing is worse than a missing one: the user concludes the app is
 * broken, not that the route is retired.
 *
 * The fix is not "delete those two entries from the portrait array" — that
 * leaves four arrays that can drift again. It is this: one list, derived
 * from `ROUTER_PREFERENCE_OPTIONS` (which is what `setPreferredRouter`
 * validates against), so a retired router cannot come back as a tab without
 * first becoming a real router again.
 */
import {
  ROUTER_PREFERENCE_OPTIONS,
  type RouterPreference,
} from "../router-modes";
import type { SwapModeTab } from "./swap-ui";

/** The Zephyr pseudo-router: a mode, not a `RouterPreference`. */
export const ZEPHYR_TAB_ID = "zephyr";

/** Glyphs per frame 1b. Auto ◎ · NEAR ◇ · P2P ◆ · Zephyr ↺ */
const ICONS: Record<string, string> = {
  auto: "◎",
  intents: "◇",
  basicswap: "◆",
  [ZEPHYR_TAB_ID]: "↺",
};

/** Short labels — the mock's, which are shorter than the option labels. */
const LABELS: Record<string, string> = {
  auto: "Auto",
  intents: "NEAR",
  basicswap: "P2P",
  [ZEPHYR_TAB_ID]: "Zephyr",
};

/**
 * Build the tab list: every live router, then Zephyr.
 *
 * `ROUTER_PREFERENCE_OPTIONS` is the same array `useSwapSettings` derives
 * `VALID_ROUTERS` from, so every tab here is guaranteed to be a value the
 * setter accepts. That is the invariant this module exists to hold.
 */
export function buildSwapModeTabs(): SwapModeTab[] {
  const routers: SwapModeTab[] = ROUTER_PREFERENCE_OPTIONS.map((o) => ({
    id: o.value,
    icon: ICONS[o.value] ?? "◇",
    label: LABELS[o.value] ?? o.label,
    title: o.hint,
  }));
  return [
    ...routers,
    {
      id: ZEPHYR_TAB_ID,
      icon: ICONS[ZEPHYR_TAB_ID],
      label: LABELS[ZEPHYR_TAB_ID],
      title:
        "Zephyr in-protocol swap (ZEPH ↔ ZEPHUSD ↔ ZEPHRSV ↔ ZEPHYRS)",
    },
  ];
}

/** The tab id currently active, given the two pieces of state that decide it. */
export function activeSwapModeTab(
  swapMode: "cross" | "zephyr",
  preferredRouter: RouterPreference,
): string {
  return swapMode === "zephyr" ? ZEPHYR_TAB_ID : preferredRouter;
}
