/**
 * Landscape must offer the Zano import / generate panel when no Zano wallet
 * exists.
 *
 * Reported 2026-09-13 (operator, Linux — but the code is shared, so Windows too):
 * selecting Zano with no wallet showed "No Zano wallet imported." and nothing
 * else. `LandscapeRoot` builds `ZanoImportPanel` into `zanoCenterSlot` when
 * there is no wallet, but `WalletLandscapeView` rendered that slot ONLY inside
 * its has-a-wallet branch, so the panel was built and never shown. Portrait's
 * `DashboardView` mounts the panel directly and was unaffected, which is why
 * the layout-parity registry (it records WHERE a landscape equivalent lives,
 * not whether every branch reaches it) stayed green.
 *
 * Source assertions, like `layout-parity.test.ts`: the view needs a full app
 * context to render.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const view = readFileSync(
  resolve(__dirname, "WalletLandscapeView.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("landscape reaches the Zano import panel with no Zano wallet", () => {
  const importSlotAt = view.indexOf(") : importPanelSlot ? (");
  const emptyAt = view.indexOf("wallet imported.`}");

  it("positive control: the no-wallet branches were located", () => {
    expect(importSlotAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(importSlotAt);
  });

  it("renders zanoCenterSlot in the no-wallet branch, before the empty message", () => {
    const noWalletBranches = view.slice(importSlotAt, emptyAt);
    expect(noWalletBranches).toMatch(/activeChain === "zano" && zanoCenterSlot \? \(/);
    expect(noWalletBranches).toMatch(/\{zanoCenterSlot\}/);
  });

  it("LandscapeRoot still builds the import panel into that slot when there is no wallet", () => {
    const root = readFileSync(
      resolve(__dirname, "../landscape/LandscapeRoot.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const slot = root.slice(root.indexOf("zanoCenterSlot={"));
    expect(slot).toMatch(/!walletsByChain\.zano \? \(\s*<ZanoImportPanel/);
  });
});
