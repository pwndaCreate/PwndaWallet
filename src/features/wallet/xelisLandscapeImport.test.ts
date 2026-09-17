/**
 * Landscape must offer the Xelis import / generate panel when there is no Xelis
 * wallet — and the chain has to be selectable in the first place.
 *
 * Two Zano incidents this pins for Xelis before they can repeat:
 *  - 2026-09-13: `LandscapeRoot` built `zanoCenterSlot` for the no-wallet case,
 *    but `WalletLandscapeView` rendered that slot only inside its
 *    HAS-A-WALLET branch, so landscape showed "No Zano wallet imported." and
 *    no panel. The layout-parity registry stayed green: it records WHERE a
 *    landscape equivalent lives, not whether every branch reaches it.
 *  - 2026-08-28: portrait's asset list left ZANO out of `CANONICAL_DEFAULTS`,
 *    so the chain could never become active and its panel was unreachable for a
 *    day, in both layouts. (That hand list was replaced on 2026-09-16 by the
 *    shared `importableChains` / `isAlwaysListed`, keyed on the adapter flag.)
 *
 * Source assertions, like `layout-parity.test.ts`: these views need a full app
 * context to render.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importableChains, isAlwaysListed } from "./wallet-surface";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

const view = read("WalletLandscapeView.tsx");
const root = read("../landscape/LandscapeRoot.tsx");
const dashboard = read("DashboardView.tsx");

describe("landscape reaches the Xelis import panel with no Xelis wallet", () => {
  const importSlotAt = view.indexOf(") : importPanelSlot ? (");
  const emptyAt = view.indexOf("wallet imported.`}");

  it("positive control: the no-wallet branches were located", () => {
    expect(importSlotAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(importSlotAt);
  });

  it("renders xelisCenterSlot in the no-wallet branch, before the empty message", () => {
    const noWalletBranches = view.slice(importSlotAt, emptyAt);
    expect(noWalletBranches).toMatch(/activeChain === "xelis" && xelisCenterSlot \? \(/);
    expect(noWalletBranches).toMatch(/\{xelisCenterSlot\}/);
  });

  it("LandscapeRoot builds the import panel into that slot when there is no wallet", () => {
    const slot = root.slice(root.indexOf("xelisCenterSlot={"));
    expect(slot).toMatch(/!walletsByChain\.xelis \? \(\s*<XelisImportPanel/);
  });

  it("portrait mounts the same panel on the same condition", () => {
    expect(dashboard).toMatch(
      /activeChain === "xelis" && !walletsByChain\.xelis \? \(\s*<XelisImportPanel/,
    );
  });
});

describe("Xelis can be selected in the first place", () => {
  // Until 2026-09-16 the first assertion here read portrait's hand-kept
  // `CANONICAL_DEFAULTS` ticker set for "XEL". That set is gone: both layouts
  // now list a not-yet-imported Xelis through the same helper, and portrait's
  // collapse keeps a held one by the same adapter flag. So the reachability
  // this pins is now the helper's behaviour plus both views calling it.
  it("the shared helper offers an import row for Xelis until a wallet exists", () => {
    expect(importableChains({})).toContain("xelis");
    expect(
      importableChains({
        xelis: { chain: "xelis", address: "", mnemonic: "", privateKey: "" },
      }),
    ).not.toContain("xelis");
    // A held Xelis wallet with no balance is never collapsed away in portrait.
    expect(isAlwaysListed("xelis")).toBe(true);
  });

  it("both layouts render those rows", () => {
    for (const src of [view, dashboard]) {
      expect(src).toContain("importableChains(walletsByChain)");
      expect(src).toMatch(/<ImportableAssetRow[\s/>]/);
    }
  });

  it("the helper keys on usesIndependentSeed, which the Xelis adapter declares", () => {
    // Keyed on the flag rather than on chain names, so Xelis is listed as soon
    // as its adapter says so — which is why this checks the adapter, not a
    // hard-coded rail entry.
    expect(read("wallet-surface.ts")).toMatch(/usesIndependentSeed && !walletsByChain\[c\]/);
    expect(read("../../wallets/xelis-wallet.ts")).toMatch(/usesIndependentSeed:\s*true/);
  });
});
