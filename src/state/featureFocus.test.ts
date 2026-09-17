/**
 * Node-manager sub-views in landscape (2026-09-15).
 *
 * `View` gained "zano-nodes" when Zano was added, but the three places that
 * list the landscape Settings sub-views did not: `deriveFeatureFocus` here and
 * both view-sync effects in `useLayout`. Read from the code (not observed in a
 * running app): the second `useLayout` effect sets `view` back to "settings"
 * for any Settings-tab view missing from its list, so the Zano node view was
 * replaced by the Settings panel as it opened, and `useZanoNodes`' focus gate
 * never matched. Xelis would have repeated it. All three now read the sets in
 * `featureFocus.ts`, and this file fails when `View` gains a `*-nodes` id that
 * those sets do not hold.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deriveFeatureFocus,
  LANDSCAPE_SETTINGS_SUBVIEWS,
  NODE_MANAGER_VIEWS,
} from "./featureFocus";
import type { View } from "../types/view";

const ROOT = resolve(__dirname, "..", "..");
const viewSrc = readFileSync(resolve(ROOT, "src/types/view.ts"), "utf8");
const layoutSrc = readFileSync(resolve(ROOT, "src/features/landscape/useLayout.ts"), "utf8");

/** Every `"<name>-nodes"` member of the `View` union, read from its source. */
const nodeViews = [...viewSrc.matchAll(/"([a-z]+-nodes)"/g)].map((m) => m[1] as View);

describe("node-manager views in landscape", () => {
  it("positive control: the View union was parsed", () => {
    expect(nodeViews).toEqual(
      expect.arrayContaining(["monero-nodes", "zephyr-nodes", "zano-nodes", "xelis-nodes"]),
    );
  });

  it("every *-nodes view is a node-manager sub-view of the Settings tab", () => {
    for (const view of nodeViews) {
      expect(NODE_MANAGER_VIEWS.has(view), view).toBe(true);
      expect(LANDSCAPE_SETTINGS_SUBVIEWS.has(view), view).toBe(true);
    }
  });

  it.each(nodeViews)("%s keeps its own focus under the landscape Settings tab", (view) => {
    expect(deriveFeatureFocus({ layout: "landscape", view, landscapeTab: "settings" })).toBe(view);
  });

  it("portrait focus is still the view itself", () => {
    expect(
      deriveFeatureFocus({ layout: "portrait", view: "xelis-nodes", landscapeTab: "wallet" }),
    ).toBe("xelis-nodes");
  });

  it("useLayout reads the shared sets rather than a list of its own", () => {
    expect(layoutSrc).toContain("NODE_MANAGER_VIEWS.has(view)");
    expect(layoutSrc).toContain("LANDSCAPE_SETTINGS_SUBVIEWS.has(view)");
    expect(layoutSrc).not.toMatch(/"(monero|zephyr|zano|xelis)-nodes"/);
  });
});
