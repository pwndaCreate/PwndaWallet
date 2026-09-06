/**
 * Portrait / landscape surface parity.
 *
 * ## Why this exists
 *
 * The two layouts are separate component trees — `ViewRouter` → `DashboardView`
 * for portrait, `LandscapeRoot` → `WalletLandscapeView` for landscape. They
 * don't share a render path, so nothing connects them: adding a surface to one
 * and forgetting the other compiles, passes every test, and ships.
 *
 * That happened three times in one session (2026-08-13):
 *   1. Monero/Zephyr were missing from the landscape asset list
 *   2. Onboarding was skipped entirely in landscape (wallets never persisted)
 *   3. The derivation finder shipped portrait-only and was therefore invisible
 *
 * Each time the code was "done" and each time most users saw nothing, because
 * LANDSCAPE IS THE DEFAULT LAYOUT. A portrait-only feature is, in practice, a
 * feature that doesn't exist.
 *
 * ## What this enforces
 *
 * Every wallet surface must be declared below, with an explicit answer for
 * both layouts. Two failure modes are caught:
 *
 *   - a registered surface that stops rendering in one layout
 *   - a NEW surface rendered in either root but not registered here
 *
 * The second is the important one: it means you cannot add a panel without
 * being asked "and what does landscape do?". A legitimate answer is
 * `landscapeEquivalent` — the layouts genuinely differ, and forcing pixel
 * parity would make one of them worse. What's not acceptable is answering by
 * accident.
 *
 * ## What this does NOT do
 *
 * It doesn't check that a surface looks right, or is reachable, or is wired to
 * live data — only that both layouts render something for it. It's a
 * completeness check, not a correctness one.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const PORTRAIT = read("src/features/wallet/DashboardView.tsx");
const LANDSCAPE = read("src/features/wallet/WalletLandscapeView.tsx");

interface Surface {
  /** Component rendered in the portrait dashboard. */
  name: string;
  /**
   * What landscape renders instead, when it isn't the same component.
   *
   * `null` means landscape must render the SAME component. A string names the
   * landscape-specific stand-in — used where the layouts genuinely need
   * different presentations of the same capability.
   */
  landscapeEquivalent: string | null;
  /** Why the layouts differ, when they do. Required for an equivalent. */
  note?: string;
}

/**
 * Every wallet surface, and its answer for both layouts.
 *
 * Adding a panel? Add it here. The "unregistered surface" test below will
 * fail until you do, which is the point.
 */
const SURFACES: Surface[] = [
  { name: "DerivationInfoCard", landscapeEquivalent: null },
  { name: "BtcLegacyPanel", landscapeEquivalent: null },
  { name: "AdaLegacyPanel", landscapeEquivalent: null },
  { name: "CardanoDerivationPanel", landscapeEquivalent: null },
  { name: "SolanaDerivationPanel", landscapeEquivalent: null },
  { name: "LitecoinDerivationPanel", landscapeEquivalent: null },
  { name: "AlgorandDerivationPanel", landscapeEquivalent: null },
  { name: "ZephyrAssetsCard", landscapeEquivalent: null },
  { name: "ZephyrProtocolStatsCard", landscapeEquivalent: null },
  {
    name: "XmrImportPanel",
    landscapeEquivalent: "importPanelSlot",
    note:
      "Landscape receives the built element as a prop rather than importing " +
      "the panel — App.tsx already owns all six of its data props, so this " +
      "adds one prop instead of eight. Same component, different delivery.",
  },
  {
    name: "ZphImportPanel",
    landscapeEquivalent: "importPanelSlot",
    note: "Same slot as XmrImportPanel; App.tsx picks which to build.",
  },
  {
    name: "XmrSyncCard",
    landscapeEquivalent: "SyncStatusPanel",
    note:
      "Landscape has a dedicated sync rail shared by XMR and ZPH; portrait " +
      "stacks a card per chain. Different presentation, same information.",
  },
  {
    name: "ZphSyncCard",
    landscapeEquivalent: "SyncStatusPanel",
    note: "See XmrSyncCard.",
  },
  { name: "SourceAddressesCard", landscapeEquivalent: null },

  // --- Added on the origin/main merge (2026-09-03). These surfaces landed on
  // the swap-desk line while this registry was being written on main, so they
  // reached both layouts without ever passing through it. Each entry below is
  // the explicit landscape answer the registry exists to force.
  {
    name: "ZanoImportPanel",
    landscapeEquivalent: "zanoCenterSlot",
    note:
      "Landscape receives Zano's whole centre column as one built node from " +
      "LandscapeRoot — import panel when no wallet, sync + assets once there " +
      "is one — rendered INLINE in the focal column like monero/zephyr rather " +
      "than as a detached footer. Same components, different delivery.",
  },
  {
    name: "ZanoSyncCard",
    landscapeEquivalent: "zanoCenterSlot",
    note: "Same slot as ZanoImportPanel; LandscapeRoot picks which to build.",
  },
  {
    name: "ZanoAssetsCard",
    landscapeEquivalent: "zanoCenterSlot",
    note: "See ZanoImportPanel.",
  },
  {
    name: "HederaSetupPanel",
    landscapeEquivalent: "HederaSetupPanel",
    note:
      "Genuinely shared — both roots import and render the same component. " +
      "Hedera has no account until one is created ON-NETWORK, so without it a " +
      "user reads 'No account (create on network)' as a balance and assumes " +
      "the wallet is broken. That is not a portrait-only concern.",
  },
  {
    name: "UtxoAccountCard",
    landscapeEquivalent: "UtxoAccountCard",
    note: "Genuinely shared — same component imported by both roots.",
  },
];

/** Does `src` render `<Name` anywhere? */
const renders = (src: string, name: string) =>
  new RegExp(`<${name}[\\s/>]`).test(src);

/** Does `src` reference a non-component surface (a slot prop)? */
const references = (src: string, token: string) =>
  new RegExp(`\\b${token}\\b`).test(src);

describe("portrait renders every registered surface", () => {
  it.each(SURFACES)("$name", ({ name }) => {
    expect(
      renders(PORTRAIT, name),
      `${name} is registered but DashboardView doesn't render it`
    ).toBe(true);
  });
});

describe("landscape renders every registered surface", () => {
  it.each(SURFACES)("$name", ({ name, landscapeEquivalent, note }) => {
    if (landscapeEquivalent === null) {
      expect(
        renders(LANDSCAPE, name),
        `${name} renders in portrait but NOT in landscape — and landscape is ` +
          `the default layout, so this feature is invisible to most users. ` +
          `Either render it there too, or declare a landscapeEquivalent in ` +
          `SURFACES explaining why the layouts differ.`
      ).toBe(true);
      return;
    }
    expect(note, `${name} declares an equivalent but no note explaining why`).toBeTruthy();
    expect(
      renders(LANDSCAPE, landscapeEquivalent) ||
        references(LANDSCAPE, landscapeEquivalent),
      `${name} declares landscape equivalent "${landscapeEquivalent}", but ` +
        `WalletLandscapeView doesn't use it`
    ).toBe(true);
  });
});

describe("no unregistered surfaces", () => {
  // Components whose name matches this shape but which are layout furniture,
  // not wallet surfaces — they're expected to differ between the two designs.
  const LAYOUT_FURNITURE = new Set([
    "Card",
    "MiniSpark",
    "CoinIcon",
    "AccountCard",
    "WalletTxHistorySubview",
    "PortfolioHeader",
    "AssetsList",
    "ChainPickerGrid",
    "ChainTile",
    "Row",
    "GenericDerivationFinder", // rendered BY DerivationInfoCard, not a root
  ]);

  const found = (src: string) =>
    new Set(
      [...src.matchAll(/<([A-Z]\w*(?:Panel|Card|View|Grid))[\s/>]/g)]
        .map((m) => m[1])
        .filter((n) => !LAYOUT_FURNITURE.has(n))
    );

  const registered = new Set(SURFACES.map((s) => s.name));

  it("portrait renders nothing unregistered", () => {
    const extra = [...found(PORTRAIT)].filter((n) => !registered.has(n));
    expect(
      extra,
      `DashboardView renders ${extra.join(", ")} which isn't in SURFACES. ` +
        `Add it — the entry forces an explicit answer for landscape, which is ` +
        `how the three parity bugs on 2026-08-13 would have been caught.`
    ).toEqual([]);
  });

  it("landscape renders nothing unregistered", () => {
    const equivalents = new Set(
      SURFACES.map((s) => s.landscapeEquivalent).filter((x): x is string => !!x)
    );
    const extra = [...found(LANDSCAPE)].filter(
      (n) => !registered.has(n) && !equivalents.has(n)
    );
    expect(
      extra,
      `WalletLandscapeView renders ${extra.join(", ")} which isn't in ` +
        `SURFACES. Add it, and give portrait the same surface.`
    ).toEqual([]);
  });
});

/**
 * Settings surfaces.
 *
 * SettingsView (portrait) and SettingsLandscapeView (landscape) are a second
 * pair of divergent roots with the same failure mode as the wallet views —
 * and the same consequence, since landscape is the default. Covered here
 * rather than in a separate file so there is ONE place to look when adding a
 * settings card.
 *
 * Slot-delivered surfaces (built once in App.tsx and handed to both roots as
 * a prop) are the strongest form of parity available: there's a single
 * element, so the layouts cannot render different things. Asserting the prop
 * appears in both is what keeps that true.
 */
const SETTINGS_PORTRAIT = read("src/features/settings/SettingsView.tsx");
const SETTINGS_LANDSCAPE = read("src/features/settings/SettingsLandscapeView.tsx");

const SETTINGS_SURFACES: Array<{ token: string; slot: boolean }> = [
  { token: "scanDateSlot", slot: true },
  { token: "DataLocations", slot: false },
];

describe("settings parity", () => {
  it.each(SETTINGS_SURFACES)("$token appears in both settings views", ({ token }) => {
    expect(
      SETTINGS_PORTRAIT.includes(token),
      `${token} missing from portrait SettingsView`
    ).toBe(true);
    expect(
      SETTINGS_LANDSCAPE.includes(token),
      `${token} missing from landscape SettingsLandscapeView — and landscape ` +
        `is the default layout, so the setting is unreachable for most users`
    ).toBe(true);
  });

  it("removal actions use one verb across both layouts", () => {
    // "Remove Zephyr Wallet" (red bold heading) sitting beside a red "Forget
    // Zephyr" button read as two buttons, one of which did nothing when
    // clicked — so removal looked like it had failed. Everything else in the
    // app says "Remove"; "Forget" was the outlier for exactly these two chains.
    for (const src of [SETTINGS_PORTRAIT, SETTINGS_LANDSCAPE]) {
      expect(/Forget (Monero|Zephyr)/.test(src)).toBe(false);
    }

    // Updated on the 2026-09-03 merge. The per-chain "Remove <chain> Wallet"
    // buttons this originally asserted on were retired on 2026-08-21: one
    // `WalletsCard` list now removes any wallet by id, including the primary
    // XMR/ZPH pair, and does the same session teardown.
    //
    // The assertion moves rather than relaxes, because the bug it guards is
    // unchanged in kind and DID recur: that 2026-08-21 change deleted
    // portrait's buttons and pointed users at "Settings ▸ Wallets", but
    // mounted the card in landscape only — so portrait had no removal path at
    // all for thirteen days, and this test is what caught it. Both roots must
    // mount the shared card.
    for (const src of [SETTINGS_PORTRAIT, SETTINGS_LANDSCAPE]) {
      expect(src).toContain("<WalletsCard");
    }
  });
});
