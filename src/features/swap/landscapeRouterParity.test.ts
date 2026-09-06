import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTER_PREFERENCE_OPTIONS } from "./router-modes";

/**
 * Landscape must offer every router portrait offers.
 *
 * The landscape swap view renders its OWN router strip (it passes
 * `suppressRouterStrip` to the shared `SwapForm`), and that strip used to
 * hardcode its own copy of the router list. The copy drifted in both directions
 * at once, discovered 2026-08-19:
 *
 *   - `basicswap` was missing, so the entire BasicSwap sidecar UI — the wallet's
 *     ONLY route for XMR and ZEPH — was unreachable in landscape while working
 *     fine in portrait. A portrait-only Playwright pass did not catch it.
 *   - `swapkit` was still listed after that route was retired, so landscape kept
 *     offering a route portrait had removed.
 *
 * The fix derives the strip from `ROUTER_PREFERENCE_OPTIONS`. This test pins
 * that: it fails if anyone re-introduces a hardcoded list, because a duplicated
 * route list has now demonstrably drifted and nothing else forces the two files
 * to change together.
 */
const PORTRAIT = resolve(process.cwd(), "src/features/swap/SwapView.tsx");

const LANDSCAPE = resolve(
  process.cwd(),
  "src/features/swap/SwapLandscapeView.tsx"
);

describe("landscape router parity", () => {
  const src = readFileSync(LANDSCAPE, "utf8");
  const portraitSrc = readFileSync(PORTRAIT, "utf8");

  /**
   * 2026-08-28 — this assertion was rewritten, and the reason matters.
   *
   * It used to require the literal string `ROUTER_PREFERENCE_OPTIONS.map` in
   * the landscape file, as a proxy for "this strip is derived, not re-listed".
   * The redesign moved the derivation into `components/swap-mode-tabs.ts`,
   * which both views now call — so the proxy went false while the property it
   * stands for got *stronger*: there is now ONE list feeding ONE strip
   * component, instead of two files each deriving their own.
   *
   * The test therefore checks the real invariant — both views build their
   * tabs from the shared module — rather than a string that happened to
   * co-occur with it. A test kept passing by loosening it would have been the
   * wrong repair; a test that pins the new seam is the right one.
   */
  it("builds its router tabs from the shared swap-mode-tabs module", () => {
    for (const [label, source] of [
      ["landscape", src],
      ["portrait", portraitSrc],
    ] as const) {
      expect(
        source.includes("buildSwapModeTabs"),
        `the ${label} strip must build its tabs from components/swap-mode-tabs.ts — ` +
          "a hardcoded copy silently dropped basicswap, kept a retired swapkit, " +
          "and (2026-08-28) shipped two tabs whose setter rejects them"
      ).toBe(true);
    }
  });

  /**
   * The dead-tab regression, pinned directly (finding F2).
   *
   * Portrait shipped `SwapKit` and `Desk` tabs long after both routers were
   * retired. `setPreferredRouter` rejects any value not in
   * `ROUTER_PREFERENCE_OPTIONS`, so clicking them changed nothing, showed
   * nothing, and reported nothing. Neither view may name a retired router.
   */
  it("names no retired router in either view's tab strip", () => {
    const live = new Set(ROUTER_PREFERENCE_OPTIONS.map((o) => o.value));
    const retired = ["swapkit", "pwnda-desk"].filter((r) => !live.has(r as never));
    for (const [label, source] of [
      ["landscape", src],
      ["portrait", portraitSrc],
    ] as const) {
      for (const r of retired) {
        expect(
          new RegExp(`value:\\s*"${r}"|id === "${r}"|"${r}",\\s*label`).test(source),
          `${label} still lists the retired router "${r}" as a tab — clicking it ` +
            "calls a setter that rejects it, which is a control that does nothing"
        ).toBe(false);
      }
    }
  });

  it("does not hardcode router values that could drift from portrait", () => {
    // The zephyr entry is legitimately literal: it flips `swapMode`, not
    // `preferredRouter`, so it is not a cross-chain router at all.
    const hardcoded = ROUTER_PREFERENCE_OPTIONS.map((o) => o.value).filter(
      (v) => new RegExp(`value:\\s*"${v}"`).test(src)
    );
    expect(
      hardcoded,
      `these router values are hardcoded in the landscape view and will drift ` +
        `from ROUTER_PREFERENCE_OPTIONS: ${hardcoded.join(", ")}`
    ).toEqual([]);
  });

  it("keeps XMR and P2P bitcoin-family pairs reachable in landscape by carrying the basicswap route", () => {
    // Guards the specific user-visible failure: BasicSwap is the only route
    // that carries XMR against a bitcoin-family coin, and the only
    // PEER-TO-PEER route for a bitcoin-family<->bitcoin-family pair, so if
    // landscape loses it those pairings become unreachable in that layout
    // with no error shown. ZEPH has its own dedicated route (the Zephyr
    // tab), not this one.
    const hasBasicswap = ROUTER_PREFERENCE_OPTIONS.some(
      (o) => o.value === "basicswap"
    );
    expect(hasBasicswap, "basicswap missing from the shared router list").toBe(
      true
    );
    expect(src.includes("basicswap")).toBe(true);
  });

  /**
   * A DEEPER, narrower version of the same lesson (2026-08-22): the tab
   * label existing is not the same claim as the route having a UI. This
   * exact gap shipped and went unnoticed for weeks — landscape's "P2P" tab
   * was selectable, `ROUTER_PREFERENCE_OPTIONS` had the entry, this test
   * file's OWN checks above all passed, and there was still no quote card,
   * no spread check, and no way to confirm a swap once selected. The three
   * checks above test the TAB; these test the CONTENT the tab is supposed
   * to lead to.
   */
  it("mounts BasicswapStrip — not just the router tab that points at it", () => {
    expect(
      src.includes("BasicswapStrip"),
      "landscape has the basicswap router tab but never renders the " +
        "offer-book/spread-check card the portrait view built for it"
    ).toBe(true);
  });

  it("mounts SidecarConfirmModal — the tab must lead somewhere real", () => {
    expect(
      src.includes("SidecarConfirmModal"),
      "landscape can select the basicswap route and get a quote, but has " +
        "no confirm modal to act on it"
    ).toBe(true);
  });

  it("imports BasicswapStrip from SwapView rather than a landscape-only fork", () => {
    // The whole point of exporting it (2026-08-22) was ONE implementation
    // reused by both surfaces, matching DeskConfirmModal's precedent —
    // not a second copy that can drift from the first the way the router
    // list itself once did.
    //
    // Matches the WHOLE `{ ... } from "./SwapView"` clause and checks
    // BasicswapStrip is one of the named imports, rather than requiring it
    // be the ONLY one — 2026-08-23 added a second shared import
    // (ActiveSidecarSwapsPanel) from the same file, which a braces-must-
    // contain-exactly-this-one-name regex would reject even though the
    // property this test actually cares about (imported, not reforked)
    // still holds.
    const swapViewImport = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/SwapView"/);
    const importedNames = swapViewImport
      ? swapViewImport[1].split(",").map((s) => s.trim())
      : [];
    expect(
      importedNames.includes("BasicswapStrip"),
      "BasicswapStrip must be imported from SwapView.tsx, not reimplemented " +
        "here — a landscape-local fork is the same drift risk this whole " +
        "test file exists to catch, just for a component instead of a list"
    ).toBe(true);
  });

  /**
   * DexCnWalletCard (Grove expansion plan, unit C-T2) — the CryptoNote-
   * follower (ZEPH/ZANO) disclosure/consent card.
   *
   * This is the SAME lesson as the two tests above, applied to a THIRD
   * component instead of the router tab list (2026-08-19) and BasicswapStrip
   * (2026-08-22): a component existing and being architecturally capable of
   * rendering in both layouts is not the same claim as it actually being
   * mounted in both. the contributor guide's own "Landscape-First Development" section
   * names this exact recurrence pattern and says future features should be
   * pinned here, not just built correctly once.
   *
   * Unlike BasicswapStrip (defined inside `SwapView.tsx`, landscape imports
   * it FROM there), `DexCnWalletCard` is its own file
   * (`./DexCnWalletCard.tsx`) that both views import as a sibling — so the
   * check here is symmetric: BOTH files must import it from that module,
   * neither may define or fork it locally.
   */
  // 2026-09-04: the views now mount `DexCnWalletSection` — the hook-owning
  // wrapper that gives the card a LIVE consent control — instead of the bare
  // card. The assertions moved with it, and gained a third: the section
  // itself must actually wire `onSetAck`, because "the card is mounted" and
  // "the toggle works" are different claims (the card spent 2026-09-03 to
  // 09-04 mounted in both layouts as disclosure-only).
  // 2026-09-05: the CN section and the sweep-back section LEFT the Swap tab
  // ("I only want things pertaining to any swaps") for Settings, through
  // ONE host — `settings/SwapNodeExtras.tsx` — that both Settings layouts
  // mount. The assertions moved with them and kept their shape: a component
  // that both layouts are architecturally able to render is not the same
  // claim as both layouts rendering it.
  it("the Swap views no longer render the node blocks that moved to Settings", () => {
    for (const [label, source] of [
      ["landscape", src],
      ["portrait", portraitSrc],
    ] as const) {
      for (const gone of ["<DexCnWalletSection", "<SweepBackSection", "<SwapBalancesCard"]) {
        expect(
          source.includes(gone),
          `${label} still renders ${gone} — it moved to Settings on 2026-09-05`
        ).toBe(false);
      }
    }
  });

  it("both Settings layouts mount SwapNodeExtras, and it really renders sweep-back", () => {
    const settingsPortrait = readFileSync(
      resolve(process.cwd(), "src/features/settings/SettingsView.tsx"),
      "utf8"
    );
    const settingsLandscape = readFileSync(
      resolve(process.cwd(), "src/features/settings/SettingsLandscapeView.tsx"),
      "utf8"
    );
    for (const [label, source] of [
      ["settings landscape", settingsLandscape],
      ["settings portrait", settingsPortrait],
    ] as const) {
      expect(
        source.includes("<SwapNodeExtras"),
        `${label} never renders <SwapNodeExtras> — the sweep-back surface has to ` +
          "actually appear on screen in both layouts"
      ).toBe(true);
    }
    const extras = readFileSync(
      resolve(process.cwd(), "src/features/settings/SwapNodeExtras.tsx"),
      "utf8"
    );
    expect(extras.includes("<SweepBackSection"), "the sweep-back section").toBe(true);
    // ...and the sweep list is handed the shared set, or it would offer a
    // user's own BCH/BTC/LTC/XMR back to them as "recovery".
    expect(extras.includes("sharedTickers={sharedTickers}"), "shared coins excluded").toBe(true);
  });

  /**
   * 2026-09-05 — the ZEPH/ZANO "Using my wallet" sections are GONE, on the
   * operator's instruction: *"It is redundant and unneeded to have that
   * section of text and the button ... since the pwnda wallet will
   * automatically use the wallet and there is no alternative."*
   *
   * They were right about the alternative. `shares_zph_host_wallet` reads
   * `opted_in && enabled && declined_at.is_none()`, so sharing is the DEFAULT
   * and the control could only ever be used to opt out of the one transport
   * those coins have — neither carries a local daemon or a light client, so
   * declining means the coin simply cannot trade.
   *
   * This asserts the removal STAYS a removal. The Rust half — that sharing is
   * still on with no UI to affirm it — is
   * `host_wallet_sharing_is_on_by_default_with_no_consent_ui` in
   * `swap_sidecar.rs`, and that is the assertion that would catch a real
   * regression here; this one only catches the surface coming back.
   */
  it("the ZEPH/ZANO consent sections are not mounted anywhere", () => {
    for (const rel of [
      "src/features/settings/SwapNodeExtras.tsx",
      "src/features/settings/SettingsView.tsx",
      "src/features/settings/SettingsLandscapeView.tsx",
      "src/features/swap/SwapView.tsx",
      "src/features/swap/SwapLandscapeView.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(
        src.includes("<DexCnWalletSection"),
        `${rel} mounts the CN consent section again — it was removed as redundant`
      ).toBe(false);
    }
  });

  /**
   * ...and so is the settings fee card. The disclosure moved INTO the quote
   * (`SidecarConfirmModal` + `licenceFee.ts`), which the Rust invariant
   * `collection_is_on_only_alongside_a_surface_that_shows_it` now points at —
   * so a fee card coming back is fine, but the quote line disappearing is not.
   */
  it("the licence fee is disclosed in the quote, not in a settings card", () => {
    for (const rel of [
      "src/features/settings/SettingsView.tsx",
      "src/features/settings/SettingsLandscapeView.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src.includes("<SwapFeeCard"), `${rel} still mounts the fee card`).toBe(false);
    }
    const modal = readFileSync(
      resolve(process.cwd(), "src/features/swap-sidecar/SidecarConfirmModal.tsx"),
      "utf8"
    );
    expect(modal).toMatch(/licenceFeeLabel\(licenceFee\)/);
    // The number must be FETCHED. A literal here is what said "not enabled"
    // for a day after collection was switched on.
    expect(modal).toMatch(/useLicenceFee\(/);
  });
});

// 2026-09-04: a tab switch reconciles the pair with the venue in BOTH
// layouts. Same shape as the picker gate above — a helper that one view
// imports and the other does not is the drift this file exists to catch.
describe("tab switch → pair reconciliation is wired in both layouts", () => {
  it("both swap views import coercePairForRouter and call it in the tab handler", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const file of ["SwapView.tsx", "SwapLandscapeView.tsx"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src, file).toMatch(/coercePairForRouter[^}]*\} from "\.\/routerPairs"/);
      expect(src, file).toMatch(/coercePairForRouter\(id as RouterPreference/);
    }
  });

  /**
   * ...and on MOUNT, not only on a click (2026-09-05).
   *
   * The click handler fixed a pair the user switched INTO and never one they
   * arrived at. With P2P remembered from a previous session the form mounted
   * on its initial `useState("ETH")`/`useState("BTC")` — a pair BasicSwap
   * cannot route — and offered "ETH → BTC" on the P2P tab with an Ethereum
   * network pill. Nothing had been clicked, so nothing coerced.
   */

  /**
   * The P2P button needs its opener, in BOTH layouts (2026-09-05).
   *
   * `SwapForm.basicswapReady` requires `onOpenBasicswapConfirm`. Neither view
   * passed it, so the form's CTA — the one directly under the amount — fell
   * through to "NO OFFER TO TAKE YET" for the entire life of the prop, against
   * any book. P2P swaps only ever worked through `BasicswapStrip`'s separate
   * button. Same "capable, not wired" shape this file exists for, one level
   * down: a PROP rather than a component.
   */
  it("both views hand SwapForm the P2P confirm opener", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const file of ["SwapView.tsx", "SwapLandscapeView.tsx"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src, `${file} never passes onOpenBasicswapConfirm — the P2P button cannot work without it`)
        .toMatch(/onOpenBasicswapConfirm=\{/);
    }
  });

  /** ...and the form still gates on it, so the check above stays meaningful. */
  /**
   * 2026-09-05. The operator ran a BCH -> XMR swap and asked for "a timer and
   * an estimate ... so the user knows it's still active". Both are in the
   * SHARED panel, so both layouts get them by construction -- and this pins
   * that, because a landscape fork of the panel is exactly how the P2P button
   * lost its opener one file above.
   */
  it("the in-flight card shows a live clock, and both layouts use the same card", () => {
    const portrait = readFileSync(
      resolve(process.cwd(), "src/features/swap/SwapView.tsx"),
      "utf8",
    );
    const landscape = readFileSync(
      resolve(process.cwd(), "src/features/swap/SwapLandscapeView.tsx"),
      "utf8",
    );
    expect(portrait).toMatch(/data-swap-elapsed/);
    expect(portrait).toMatch(/formatElapsed\(/);
    // The estimate replaced a hardcoded "30-90 min" that was the same string
    // for every pair, including the 20-minute LTC ones.
    expect(portrait).toMatch(/formatEtaRange\(/);
    // The in-flight footer's own hardcoded total, specifically -- the string
    // survives in prose elsewhere, and a whole-file match would have made
    // this assertion about comments rather than about the card.
    expect(portrait).not.toMatch(/. 30.90 min total/);
    // Landscape imports the panel rather than declaring its own.
    expect(landscape).toMatch(
      /import \{[^}]*ActiveSidecarSwapsPanel[^}]*\} from "\.\/SwapView"/s,
    );
    expect(landscape).not.toMatch(/function ActiveSidecarSwapsPanel/);
  });

  it("the tracker's clock ticks rather than freezing at first render", () => {
    const tracker = readFileSync(
      resolve(process.cwd(), "src/features/swap-sidecar/SidecarSwapTracker.tsx"),
      "utf8",
    );
    // `createdAt` never changes, so without a tick the label would be stuck at
    // whatever the parent last rendered -- the exact opposite of the liveness
    // signal it exists to give.
    expect(tracker).toMatch(/useNowTick\(/);
    expect(tracker).toMatch(/data-swap-clock/);
    expect(tracker).toMatch(/etaSentence\(/);
  });

  it("SwapForm's P2P readiness still depends on that prop", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "SwapForm.tsx"), "utf8");
    const ready = src.slice(src.indexOf("const basicswapReady ="));
    expect(ready.slice(0, 400)).toMatch(/onOpenBasicswapConfirm/);
  });

  it("both views also coerce the pair for the router they MOUNT on", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const file of ["SwapView.tsx", "SwapLandscapeView.tsx"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src, file).toMatch(/useRouterPairCoercion\(\{/);
      expect(src, file).toMatch(/router: preferredRouter/);
    }
  });
});
