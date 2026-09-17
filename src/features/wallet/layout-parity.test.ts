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
 * A legitimate answer is `landscapeEquivalent` — the layouts genuinely differ.
 * What's not acceptable is answering by accident.
 *
 * ## Checks that can fail (rewritten 2026-09-16)
 *
 * A portrait-vs-landscape audit found three assertions here that could not go
 * red for the reason they were written:
 *
 *   - `ZephyrAssetsCard` "rendered in landscape" because a COMMENT in
 *     `WalletLandscapeView` contained `<ZephyrAssetsCard>`. Landscape has never
 *     imported it.
 *   - `xelisCenterSlot` "was used" because the word appears in the prop
 *     destructure, so deleting the has-a-wallet render still passed.
 *   - `onOpenXelisNodes` "appeared in both settings views" because it appears
 *     in each prop declaration, whether or not any button used it.
 *
 * So every source is now read with comments stripped (and a control proves
 * the stripping works), a non-component equivalent names the exact JSX that
 * mounts it (`mount`), and the settings entries are checked inside the element
 * that renders them.
 *
 * It also pins the shared pieces both views must use (`WalletActionRow`,
 * `AssetRow`, `AssetMarketBlock`, the `wallet-surface.ts` rules), so a view
 * that forks one again goes red.
 *
 * ## What this does NOT do
 *
 * It doesn't check that a surface looks right or is wired to live data — only
 * that both layouts mount the same thing. Visual verification is separate.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const raw = (rel: string) =>
  readFileSync(resolve(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Comments removed, so prose can never satisfy an assertion. */
function stripComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Line comments, but not the "//" inside a URL or a quoted string.
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
  );
}
const code = (rel: string) => stripComments(raw(rel));

const PORTRAIT = code("src/features/wallet/DashboardView.tsx");
const LANDSCAPE = code("src/features/wallet/WalletLandscapeView.tsx");
const ACCOUNT_CARD = code("src/features/wallet/AccountCard.tsx");
const TX_SUBVIEW = code("src/features/wallet/WalletTxHistorySubview.tsx");
const LANDSCAPE_ROOT = code("src/features/landscape/LandscapeRoot.tsx");

/** Does `src` render `<Name` as JSX? */
const renders = (src: string, name: string) =>
  new RegExp(`<${name}[\\s/>]`).test(src);

describe("controls: the reader cannot be satisfied by prose", () => {
  it("strips a JSX mention inside a comment", () => {
    expect(renders(stripComments("/* <ZephyrAssetsCard> */ const x = 1;"), "ZephyrAssetsCard")).toBe(false);
    expect(renders(stripComments("// <ZephyrAssetsCard />\n"), "ZephyrAssetsCard")).toBe(false);
    expect(renders(stripComments("return <ZephyrAssetsCard />;"), "ZephyrAssetsCard")).toBe(true);
  });

  it("keeps a URL inside a string", () => {
    expect(stripComments('const u = "https://x.org/a";')).toContain("https://x.org/a");
  });

  it("the audit's false positive is real: the raw landscape source mentions ZephyrAssetsCard only in prose", () => {
    expect(raw("src/features/wallet/WalletLandscapeView.tsx")).toContain("ZephyrAssetsCard");
    expect(renders(LANDSCAPE, "ZephyrAssetsCard")).toBe(false);
  });
});

interface Surface {
  /** Component rendered in the portrait dashboard. */
  name: string;
  /**
   * What landscape renders instead, when it isn't the same component.
   * `null` means landscape must render the SAME component.
   */
  landscapeEquivalent: string | null;
  /**
   * For an equivalent that is not a component (a slot, a row renderer): the
   * pattern that only a real mount matches in comment-stripped source. A bare
   * name is not enough — it also appears in the prop destructure.
   */
  mount?: RegExp;
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
  {
    // Registered as `null` until 2026-09-16, and "passing" only because a
    // comment in the landscape view named the card.
    name: "ZephyrAssetsCard",
    landscapeEquivalent: "renderZphAssetRow",
    mount: /renderZphAssetRow\(item\.row\)/,
    note:
      "Landscape lists each held Zephyr asset (ZSD/ZRS/ZYS) as its own row in " +
      "the value-sorted asset rail, and selecting one scopes the focal panel's " +
      "Send/Receive/Swap to it. Portrait's column has no room for that, so it " +
      "keeps the per-asset card under ZEPH. Same data, different presentation.",
  },
  { name: "ZephyrProtocolStatsCard", landscapeEquivalent: null },
  {
    name: "XmrImportPanel",
    landscapeEquivalent: "importPanelSlot",
    mount: /\{importPanelSlot\}/,
    note:
      "Landscape receives the built element as a prop rather than importing " +
      "the panel — App.tsx already owns all six of its data props, so this " +
      "adds one prop instead of eight. Same component, different delivery.",
  },
  {
    name: "ZphImportPanel",
    landscapeEquivalent: "importPanelSlot",
    mount: /\{importPanelSlot\}/,
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

  // --- Added on the origin/main merge (2026-09-03). These surfaces landed on
  // the swap-desk line while this registry was being written on main, so they
  // reached both layouts without ever passing through it.
  {
    name: "ZanoImportPanel",
    landscapeEquivalent: "zanoCenterSlot",
    // The no-wallet branch. `zanoLandscapeImport.test.ts` pins its position.
    mount: /\{zanoCenterSlot\}/,
    note:
      "Landscape receives Zano's whole centre column as one built node from " +
      "LandscapeRoot — import panel when no wallet, sync + assets + history " +
      "once there is one — rendered INLINE in the focal column. Same " +
      "components, different delivery.",
  },
  {
    name: "ZanoSyncCard",
    landscapeEquivalent: "zanoCenterSlot",
    // The has-a-wallet branch: the only place the sync card can appear.
    mount: /activeChain === "zano" && zanoCenterSlot\}/,
    note: "Same slot as ZanoImportPanel; LandscapeRoot picks which to build.",
  },
  {
    name: "ZanoAssetsCard",
    landscapeEquivalent: "zanoCenterSlot",
    mount: /activeChain === "zano" && zanoCenterSlot\}/,
    note: "See ZanoImportPanel.",
  },
  // --- Xelis (2026-09-15). Same slot shape as Zano's.
  {
    name: "XelisImportPanel",
    landscapeEquivalent: "xelisCenterSlot",
    // The no-wallet branch. `xelisLandscapeImport.test.ts` pins its position.
    mount: /\{xelisCenterSlot\}/,
    note:
      "Landscape receives Xelis's whole centre column as one built node from " +
      "LandscapeRoot — import panel when there is no wallet, sync + history " +
      "once there is one — rendered inline in the focal column. Same " +
      "components, different delivery.",
  },
  {
    name: "XelisSyncCard",
    landscapeEquivalent: "xelisCenterSlot",
    // Until 2026-09-16 this matched the prop destructure, so deleting the
    // has-a-wallet render below still passed.
    mount: /activeChain === "xelis" && xelisCenterSlot\}/,
    note: "Same slot as XelisImportPanel; LandscapeRoot picks which to build.",
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

describe("portrait renders every registered surface", () => {
  it.each(SURFACES)("$name", ({ name }) => {
    expect(
      renders(PORTRAIT, name),
      `${name} is registered but DashboardView doesn't render it`
    ).toBe(true);
  });
});

describe("landscape renders every registered surface", () => {
  it.each(SURFACES)("$name", ({ name, landscapeEquivalent, mount, note }) => {
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
    if (mount) {
      expect(
        mount.test(LANDSCAPE),
        `${name}'s landscape equivalent "${landscapeEquivalent}" is not mounted ` +
          `(expected ${mount} in WalletLandscapeView)`
      ).toBe(true);
      return;
    }
    expect(
      renders(LANDSCAPE, landscapeEquivalent),
      `${name} declares landscape equivalent <${landscapeEquivalent}>, but ` +
        `WalletLandscapeView doesn't render it. A non-component equivalent ` +
        `needs a \`mount\` pattern.`
    ).toBe(true);
  });
});

describe("the Zano/Xelis slots are mounted in BOTH landscape branches", () => {
  const hasWallet = LANDSCAPE.slice(
    LANDSCAPE.indexOf("{activeWallet ? ("),
    LANDSCAPE.indexOf(") : importPanelSlot ? ("),
  );
  const noWallet = LANDSCAPE.slice(
    LANDSCAPE.indexOf(") : importPanelSlot ? ("),
    LANDSCAPE.indexOf("wallet imported.`}"),
  );

  it("positive control: both branches were located", () => {
    expect(hasWallet.length).toBeGreaterThan(1000);
    expect(noWallet.length).toBeGreaterThan(50);
  });

  it.each(["zano", "xelis"])("%s", (chain) => {
    expect(hasWallet).toContain(`activeChain === "${chain}" && ${chain}CenterSlot}`);
    expect(noWallet).toContain(`{${chain}CenterSlot}`);
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
 * Shared pieces (2026-09-16). Each of these was two implementations until the
 * audit, and each pair had drifted. Both views must use the one copy.
 */
describe("both wallet views use the shared pieces", () => {
  it.each(["WalletActionRow", "AssetRow", "ImportableAssetRow"])(
    "<%s> in both views",
    (name) => {
      expect(renders(PORTRAIT, name), `DashboardView does not render <${name}>`).toBe(true);
      expect(renders(LANDSCAPE, name), `WalletLandscapeView does not render <${name}>`).toBe(true);
    },
  );

  it("portrait renders <WalletActionRow compact>", () => {
    expect(PORTRAIT).toMatch(/<WalletActionRow\s+compact\b/);
  });

  it("<AssetMarketBlock> in landscape and in portrait's AccountCard", () => {
    expect(renders(LANDSCAPE, "AssetMarketBlock")).toBe(true);
    expect(ACCOUNT_CARD).toMatch(/<AssetMarketBlock\s+compact\b/);
    expect(renders(PORTRAIT, "AccountCard")).toBe(true);
  });

  it.each([
    "sendBlockedReason(activeChain, {",
    "swapBlockedReason(",
    "receiveBlockedReason(",
    "displayedReceiveAddress({",
    "importableChains(walletsByChain)",
  ])("both views call %s", (call) => {
    expect(PORTRAIT, `DashboardView does not call ${call}`).toContain(call);
    expect(LANDSCAPE, `WalletLandscapeView does not call ${call}`).toContain(call);
  });

  it("both views choose history with historySurfaceFor", () => {
    expect(LANDSCAPE).toContain("historySurfaceFor(activeChain)");
    expect(TX_SUBVIEW).toContain("historySurfaceFor(activeChain)");
    expect(renders(PORTRAIT, "WalletTxHistorySubview")).toBe(true);
  });

  it("neither view keeps a private copy of what was shared", () => {
    expect(LANDSCAPE).not.toMatch(/function ActionTile\b/);
    expect(LANDSCAPE).not.toMatch(/function fmtUsd\b/);
    expect(PORTRAIT).not.toMatch(/const formatUsd\s*=/);
    expect(PORTRAIT).not.toMatch(/const formatBalanceForRow\s*=/);
    // The Send gates that drifted: a hand-written sync check beside a Send.
    for (const src of [PORTRAIT, LANDSCAPE]) {
      expect(src).not.toMatch(/disabled=\{activeChain === "monero" && /);
    }
  });

  it.each([
    ["portrait", () => PORTRAIT],
    ["landscape", () => LANDSCAPE],
  ])("%s passes Zano's state to the Send gate and seeds Swap by registry key", (_l, src) => {
    // 2026-09-16: Zano had no Send gate in either layout, and both layouts
    // seeded the Swap tab with a bare ticker ("USDC", mainnet "ETH" for L2s).
    // The type system catches a missing `zano:`; this catches the seed.
    const gate = /sendBlockedReason\(activeChain, \{[\s\S]*?\}\)/.exec(src());
    expect(gate, "no sendBlockedReason(activeChain, { … }) call").not.toBeNull();
    expect(gate![0]).toMatch(/\bzano:/);
    expect(src()).toMatch(/swapAssetKeyFor\(activeChain\b/);
    expect(src()).toMatch(/swapBlockedReason\(activeChain\b/);
    expect(src()).not.toMatch(/onOpenSwapForAsset\?\.\([^)]*\.ticker\)/);
  });
});

describe("the asset list's always-shown set is not a hand list", () => {
  // 2026-08-28: ZANO was missing from portrait's CANONICAL_DEFAULTS and the
  // chain could not be selected. The rule is now the adapter flag.
  const tickerArray = /\[\s*(?:"[A-Z0-9]{2,8}"\s*,\s*){2,}"[A-Z0-9]{2,8}"/;

  it("control: the pattern catches the list it replaced", () => {
    expect(
      tickerArray.test('new Set<string>([\n    "BTC",\n    "ETH",\n    "XEL",\n  ])'),
    ).toBe(true);
  });

  it.each([
    ["portrait", PORTRAIT],
    ["landscape", LANDSCAPE],
  ])("%s has no ticker list and no CANONICAL_DEFAULTS", (_label, src) => {
    expect(src).not.toContain("CANONICAL_DEFAULTS");
    expect(src).not.toMatch(tickerArray);
  });

  it("portrait's collapse keeps rows by the shared flag", () => {
    expect(PORTRAIT).toContain("alwaysListed: isAlwaysListed(chain)");
    expect(PORTRAIT).toMatch(/r\.positiveBalance \|\| r\.chain === activeChain \|\| r\.alwaysListed/);
  });
});

describe("history is shown once per chain in landscape", () => {
  it("the Recent block renders only for Monero and the generic feed", () => {
    expect(LANDSCAPE).toMatch(
      /\(historySurface === "monero" \|\| historySurface === "generic"\) && \(/,
    );
    // The zano/xelis arms of the Recent block's empty copy are gone with it.
    expect(LANDSCAPE).not.toMatch(/activeChain === "xelis" && xelisSynced !== true/);
    expect(LANDSCAPE).not.toContain("zanoConnected");
  });

  it("LandscapeRoot mounts the Zano and Xelis history cards in every sync state", () => {
    // Control: the cards are still mounted at all.
    expect(renders(LANDSCAPE_ROOT, "ZanoTxHistoryCard")).toBe(true);
    expect(renders(LANDSCAPE_ROOT, "XelisTxHistoryCard")).toBe(true);
    // An idle gate would leave an idle wallet with no history surface now
    // that the generic list is gone for these chains.
    expect(LANDSCAPE_ROOT).not.toMatch(/!== "idle" && \(\s*<ZanoTxHistoryCard/);
    expect(LANDSCAPE_ROOT).not.toMatch(/!== "idle" && \(\s*<XelisTxHistoryCard/);
  });

  it("portrait's sub-view mounts its dedicated cards ungated as well", () => {
    expect(TX_SUBVIEW).toMatch(/surface === "zano" && \(\s*<ZanoTxHistoryCard/);
    expect(TX_SUBVIEW).toMatch(/surface === "xelis" && \(\s*<XelisTxHistoryCard/);
    expect(TX_SUBVIEW).toMatch(/surface === "monero" && \(\s*<XmrTxHistoryCard/);
  });
});

/**
 * Settings surfaces.
 *
 * SettingsView (portrait) and SettingsLandscapeView (landscape) are a second
 * pair of divergent roots with the same failure mode as the wallet views —
 * and the same consequence, since landscape is the default.
 *
 * Slot-delivered surfaces (built once in App.tsx and handed to both roots as
 * a prop) are the strongest form of parity available: there's a single
 * element, so the layouts cannot render different things.
 */
const SETTINGS_PORTRAIT = code("src/features/settings/SettingsView.tsx");
const SETTINGS_LANDSCAPE = code("src/features/settings/SettingsLandscapeView.tsx");
const NODE_ENTRY_LIST = code("src/features/settings/NodeEntryList.tsx");

/** The JSX of the first `<Name … />` element in `src`, or "". */
function element(src: string, name: string): string {
  const at = src.search(new RegExp(`<${name}[\\s/>]`));
  if (at === -1) return "";
  const end = src.indexOf("/>", at);
  return end === -1 ? "" : src.slice(at, end + 2);
}

const NODE_PROPS = [
  ["xmrSeedLoaded", "onOpenMoneroNodes"],
  ["zphSeedLoaded", "onOpenZephyrNodes"],
  ["zanoSeedLoaded", "onOpenZanoNodes"],
  ["xelisSeedLoaded", "onOpenXelisNodes"],
] as const;

describe("settings parity", () => {
  it.each([
    ["portrait", SETTINGS_PORTRAIT],
    ["landscape", SETTINGS_LANDSCAPE],
  ])("%s renders the scan-date slot and the data-locations list", (_label, src) => {
    expect(src).toMatch(/\{scanDateSlot\}/);
    expect(src).toMatch(/<DataLocations\w*[\s/>]/);
  });

  describe("node management entries", () => {
    it.each([
      ["portrait", SETTINGS_PORTRAIT],
      ["landscape", SETTINGS_LANDSCAPE],
    ])("%s mounts NodeEntryList with every chain wired", (label, src) => {
      const el = element(src, "NodeEntryList");
      expect(el, `${label} does not render <NodeEntryList>`).not.toBe("");
      for (const [loaded, open] of NODE_PROPS) {
        // Inside the element, so a prop declaration elsewhere cannot satisfy it.
        expect(el).toContain(`${loaded}={${loaded}}`);
        expect(el).toContain(`${open}={${open}}`);
      }
    });

    it("portrait uses the compact variant", () => {
      expect(element(SETTINGS_PORTRAIT, "NodeEntryList")).toMatch(/<NodeEntryList\s+compact\b/);
    });

    it("neither view keeps its own node buttons beside the shared list", () => {
      for (const src of [SETTINGS_PORTRAIT, SETTINGS_LANDSCAPE]) {
        for (const [, open] of NODE_PROPS) {
          expect(src).not.toContain(`onClick={${open}}`);
        }
        expect(src).not.toMatch(/function PrivacyNodeRow\b/);
      }
    });

    it("the shared list turns each handler into a Manage button", () => {
      for (const [loaded, open] of NODE_PROPS) {
        expect(NODE_ENTRY_LIST).toMatch(
          new RegExp(`loaded: !!${loaded}, onManage: ${open}`),
        );
      }
      expect(NODE_ENTRY_LIST).toContain("onClick={onManage}");
    });
  });

  it("removal actions use one verb across both layouts", () => {
    // "Remove Zephyr Wallet" (red bold heading) sitting beside a red "Forget
    // Zephyr" button read as two buttons, one of which did nothing when
    // clicked — so removal looked like it had failed.
    for (const src of [SETTINGS_PORTRAIT, SETTINGS_LANDSCAPE]) {
      expect(/Forget (Monero|Zephyr)/.test(src)).toBe(false);
    }

    // The per-chain "Remove <chain> Wallet" buttons were retired on
    // 2026-08-21: one `WalletsCard` list now removes any wallet by id. That
    // change mounted the card in landscape only, so portrait had no removal
    // path for thirteen days; this is what caught it. Both roots must mount it.
    for (const src of [SETTINGS_PORTRAIT, SETTINGS_LANDSCAPE]) {
      expect(src).toContain("<WalletsCard");
    }
  });
});
