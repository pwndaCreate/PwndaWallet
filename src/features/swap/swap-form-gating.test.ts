/**
 * Regression locks for the 2026-05-25 form-gating fix.
 *
 * Pre-fix bug: when the active pair was NEAR-Intents-routable but NOT
 * SwapKit-routable (e.g. AVAX → ADA — ADA's swapKitAsset is null because
 * SwapKit routes Cardano through NEAR Intents under the hood), the swap
 * form's gating predicates (`swapKitReady`, `atomicPreviewFallback`,
 * `swapEnabled`) only considered SwapKit-routability. Result: the user
 * saw a live NEAR Intents quote rendered in the form ("1 AVAX = 37.79
 * ADA · live", provider "NEAR Intents · solver-relay") but the Swap
 * button stayed disabled with "Atomic swap unavailable" — the legacy
 * Pwnda-Atomic placeholder branch fired silently.
 *
 * The fix widens three predicates to recognize Intents-routable pairs:
 *
 *   - `SwapView.tsx::confirmReady` — wraps SwapKit OR Intents
 *   - `SwapLandscapeView.tsx::swapKitReady` — same
 *   - `SwapForm.tsx::{intentsRoutable, intentsReady, atomicPreviewFallback,
 *      swapEnabled, handleSwap, button label}` — parallel Intents path
 *      alongside the existing SwapKit branch
 *
 * The modal (`SwapConfirmModal.tsx`) already dispatched on `quote.kind`
 * for both routers — only the form layer was gating-broken. The
 * underlying executor (`executeIntentsTrade`) was already wired.
 *
 * These tests exercise the routability primitives (`isSwapKitRoutable`,
 * `isIntentsRoutable`) and the SWAP_COIN_META values they read from.
 * Rendering-level tests for the actual button label live in the e2e
 * layer (Playwright sandbox); this file locks the gating contract
 * itself so a future change can't quietly disable NEAR Intents quotes
 * from reaching the modal again.
 */
import { describe, expect, it } from "vitest";
import { isDeskRoutableFromRegistry } from "./asset-capabilities";
import { isBasicswapRoutable } from "../swap-sidecar";
import {
  SWAP_COIN_META,
  isIntentsRoutable,
  isSwapKitRoutable,
} from "./swap-data";

describe("AVAX → ADA — the canary pair that surfaced the gating bug", () => {
  it("AVAX has both SwapKit and Intents asset ids", () => {
    expect(SWAP_COIN_META.AVAX.swapKitAsset).toBe("AVAX.AVAX");
    expect(SWAP_COIN_META.AVAX.nearIntentsAsset).toBeTruthy();
    expect(SWAP_COIN_META.AVAX.evmChainId).toBe(43114);
    expect(SWAP_COIN_META.AVAX.decimals).toBe(18);
  });

  it("ADA has Intents id but NOT SwapKit id (deliberate — Pwnda routes Cardano via NEAR)", () => {
    expect(SWAP_COIN_META.ADA.swapKitAsset).toBeNull();
    expect(SWAP_COIN_META.ADA.nearIntentsAsset).toBe(
      "nep141:cardano.omft.near"
    );
  });

  it("is Intents-routable, NOT SwapKit-routable", () => {
    expect(isIntentsRoutable("AVAX", "ADA")).toBe(true);
    expect(isSwapKitRoutable("AVAX", "ADA")).toBe(false);
  });

  it("is recognized as routable when both predicates are OR'd (the fix)", () => {
    const routable =
      isSwapKitRoutable("AVAX", "ADA") || isIntentsRoutable("AVAX", "ADA");
    expect(routable).toBe(true);
  });
});

describe("Other historically NEAR-Intents-only pairs that were affected", () => {
  it.each([
    ["ETH", "ADA"],
    ["BTC", "ADA"],
    ["SOL", "ADA"],
  ])("%s → %s is Intents-routable and NOT SwapKit-routable", (from, to) => {
    expect(isIntentsRoutable(from, to)).toBe(true);
    expect(isSwapKitRoutable(from, to)).toBe(false);
    // OR'd predicate (post-fix) recognizes it.
    expect(isSwapKitRoutable(from, to) || isIntentsRoutable(from, to)).toBe(
      true
    );
  });
});

describe("SwapKit-routable pairs are still recognized (no regression)", () => {
  it.each([
    ["AVAX", "ETH"],
    ["ETH", "BTC"],
    ["SOL", "ETH"],
  ])("%s → %s is SwapKit-routable", (from, to) => {
    expect(isSwapKitRoutable(from, to)).toBe(true);
    expect(isSwapKitRoutable(from, to) || isIntentsRoutable(from, to)).toBe(
      true
    );
  });
});

describe("Truly non-routable pairs still fall to the Atomic-preview branch", () => {
  // ZEPH / ZSD / ZRS / ZYS are Zephyr-ecosystem only — handled by the
  // zephRouteable branch upstream, not Intents/SwapKit. From the
  // perspective of `isSwapKitRoutable || isIntentsRoutable` they're
  // false-false, which is the correct signal to skip both routers and
  // (eventually) hit the Atomic-preview fallback.
  it("ZEPH → ZSD is not on Intents or SwapKit (handled by zephRouteable)", () => {
    expect(isSwapKitRoutable("ZEPH", "ZSD")).toBe(false);
    expect(isIntentsRoutable("ZEPH", "ZSD")).toBe(false);
  });

  // A coin that exists only as a destination via Intents has no source-
  // side asset id; the FROM side then can't be itself. A destination-only
  // ticker should fail isSourceCapable elsewhere — that gate lives outside
  // the routability predicates. Just confirm the route table itself
  // doesn't lie.
  it("ADA → AVAX is Intents-routable (ADA can be a source on NEAR too via the bridge)", () => {
    // Even though ADA is `sourceCapable: false` (no Rust source signer
    // in v1.x), the asset id IS in the catalog, so the routability
    // predicate returns true. The source-capability gate is enforced
    // separately by `isSourceCapable` on the FROM dropdown — see
    // cardano-destination.test.ts.
    expect(isIntentsRoutable("ADA", "AVAX")).toBe(true);
  });
});

describe("The fix preserves Zephyr-ecosystem routing (different code path)", () => {
  it("isZephyrEcosystemPair sees ZEPH↔ZSD; isSwapKit/isIntents see neither", () => {
    // Smoke check on the routing-independence boundary: Zephyr pairs are
    // handled by the form's separate `zephRouteable` predicate, which is
    // unchanged by this fix. Confirm the SwapKit/Intents predicates
    // correctly return false for ZEPH pairs so the OR'd "routable" check
    // doesn't accidentally suck Zephyr pairs into the Intents/SwapKit
    // branch.
    expect(isSwapKitRoutable("ZEPH", "ZSD")).toBe(false);
    expect(isIntentsRoutable("ZEPH", "ZSD")).toBe(false);
    expect(isSwapKitRoutable("ZSD", "ZEPH")).toBe(false);
    expect(isIntentsRoutable("ZSD", "ZEPH")).toBe(false);
  });
});

describe("SwapKit-mispicked predicate — 2026-05-26 fallback UX", () => {
  // The predicate the form uses to decide whether to show the
  // yellow "switch routing to continue" notice and disable the
  // swap button with that explanation. Three scenarios:
  //
  //   1. User picked SwapKit + pair NOT SwapKit-routable + alt
  //      router (NEAR or Zephyr) exists → show notice, disable
  //      button.
  //   2. User picked SwapKit + pair NOT SwapKit-routable + NO alt
  //      router → fall through to the existing Pwnda Atomic
  //      placeholder (different failure mode, different UI).
  //   3. User picked SwapKit + pair IS SwapKit-routable → normal
  //      quote flow.
  //
  // This mirrors the `swapKitMispicked` derived state in
  // `SwapForm.tsx` so a future change can't drift the logic
  // without flipping a test.
  const mispicked = (
    preferredRouter: "swapkit" | "intents" | "auto",
    from: string,
    to: string,
    numericFrom: number
  ): boolean => {
    return (
      preferredRouter === "swapkit" &&
      !isSwapKitRoutable(from, to) &&
      isIntentsRoutable(from, to) && // alt router exists
      numericFrom > 0
    );
  };

  it("SwapKit explicit + non-routable pair + alternative router exists → mispicked=true (AVAX→ADA)", () => {
    expect(mispicked("swapkit", "AVAX", "ADA", 0.1)).toBe(true);
  });

  it("SwapKit explicit + non-routable pair + NO alternative router → mispicked=false (falls to Pwnda Atomic)", () => {
    // FLR→XMR: FLR is SwapKit-routable but XMR isn't (XMR has
    // swapKitAsset=null AND nearIntentsAsset=null). Neither
    // router can finish the pair. The form correctly leaves this
    // to the existing Pwnda Atomic placeholder.
    expect(isSwapKitRoutable("FLR", "XMR")).toBe(false);
    expect(isIntentsRoutable("FLR", "XMR")).toBe(false);
    expect(mispicked("swapkit", "FLR", "XMR", 0.1)).toBe(false);
  });

  it("SwapKit explicit + routable pair → mispicked=false (normal quote flow)", () => {
    expect(isSwapKitRoutable("AVAX", "ETH")).toBe(true);
    expect(mispicked("swapkit", "AVAX", "ETH", 0.1)).toBe(false);
  });

  it("Auto Best + non-routable-via-SwapKit + Intents-routable → mispicked=false (Auto resolver does the picking)", () => {
    // In Auto mode the resolver picks whichever router can route
    // the pair. The user didn't pick SwapKit explicitly, so
    // there's nothing for them to switch. Don't show the notice.
    expect(mispicked("auto", "AVAX", "ADA", 0.1)).toBe(false);
  });

  it("NEAR explicit + Intents-routable pair → mispicked=false (no SwapKit involvement)", () => {
    expect(mispicked("intents", "AVAX", "ADA", 0.1)).toBe(false);
  });

  it("Amount=0 → mispicked=false even when other conditions hold (no quote in flight to gate on)", () => {
    expect(mispicked("swapkit", "AVAX", "ADA", 0)).toBe(false);
  });
});

/**
 * The pwnda-desk axis (2026-07-19).
 *
 * Two things are locked here. First, the routability rule itself: the desk
 * needs exactly one leader and one follower, unlike the aggregators which
 * need the same asset id on both sides. Second — and this is the one that
 * matters — a mirror of `atomicPreviewFallback`.
 *
 * That four-term predicate has now silently swallowed an entire router class
 * TWICE: NEAR Intents on 2026-05-25 (AVAX->ADA showed "Atomic swap
 * unavailable" under a live quote), and it would have done exactly the same
 * to the desk on XMR->ADA, its flagship pair. Nothing else in the suite
 * covers it, because the real predicate lives inside a component with no
 * render test. The mirror below is the tripwire for the third time.
 */
describe("pwnda-desk — the third routability axis", () => {
  it("routes leader<->follower in both directions, for the vendored engine", () => {
    expect(isDeskRoutableFromRegistry("XMR", "ADA")).toBe(true);
    expect(isDeskRoutableFromRegistry("ADA", "XMR")).toBe(true);
    expect(isDeskRoutableFromRegistry("ZEPH", "ADA")).toBe(true);
    expect(isDeskRoutableFromRegistry("ADA", "ZEPH")).toBe(true);
  });

  it("refuses a desk leader with no vendored client engine", () => {
    // LTC and AVAX are real desk leaders but different crypto (BasicSwap
    // DLEq / EVM escrow) and neither engine is vendored here. Offering them
    // would quote fine and then fail at accept - after reserving inventory.
    for (const l of ["LTC", "AVAX"]) {
      expect(isDeskRoutableFromRegistry("XMR", l)).toBe(false);
      expect(isDeskRoutableFromRegistry(l, "ZEPH")).toBe(false);
    }
  });

  it("refuses same-role pairs, which is why the AVAX->ADA canary is undisturbed", () => {
    expect(isDeskRoutableFromRegistry("XMR", "ZEPH")).toBe(false); // follower/follower
    expect(isDeskRoutableFromRegistry("ADA", "LTC")).toBe(false); // leader/leader
    expect(isDeskRoutableFromRegistry("AVAX", "ADA")).toBe(false); // leader/leader
  });

  it.each([
    ["XMR", "ADA"],
    ["ZEPH", "ADA"],
    ["ADA", "XMR"],
    ["ADA", "ZEPH"],
  ])(
    "%s -> %s is desk-routable and NOT aggregator-routable (disjointness)",
    (from, to) => {
      // This disjointness is what makes it safe to OR deskReady into the
      // dispatch chain without a precedence fight: today no pair can be
      // claimed by two venues at once. It is an emergent consequence of
      // XMR/ZEPH having null aggregator ids, so it is pinned rather than
      // assumed.
      expect(isDeskRoutableFromRegistry(from, to)).toBe(true);
      expect(isSwapKitRoutable(from, to)).toBe(false);
      expect(isIntentsRoutable(from, to)).toBe(false);
    }
  );

  /**
   * Hand-mirror of SwapForm.tsx::atomicPreviewFallback. Keep in lockstep with
   * the component — it has no structural link to it, which is precisely how it
   * drifted twice… and then a third time (2026-08-22): the BasicSwap route was
   * added to `RouterPreference` without adding a term HERE, so the mirror kept
   * passing while the real predicate painted "Atomic swap unavailable" under a
   * live P2P quote. The mirror can only catch drift in terms it was handed.
   * When a router is added, this function's arity is part of the change.
   */
  const atomicPreviewFallback = (
    zeph: boolean,
    sk: boolean,
    intents: boolean,
    desk: boolean,
    basicswap: boolean,
    amt: number
  ) => !zeph && !sk && !intents && !desk && !basicswap && amt > 0;

  it("does NOT fall to the atomic-preview placeholder for a desk pair", () => {
    // XMR -> ADA with an amount typed. Pre-fix this returned true, which set
    // atomicPreviewBlocked and painted "Atomic swap unavailable" beneath a
    // live desk quote.
    expect(
      atomicPreviewFallback(
        false,
        isSwapKitRoutable("XMR", "ADA"),
        isIntentsRoutable("XMR", "ADA"),
        isDeskRoutableFromRegistry("XMR", "ADA"),
        isBasicswapRoutable("XMR", "ADA"),
        1
      )
    ).toBe(false);
    expect(
      atomicPreviewFallback(
        false,
        isSwapKitRoutable("ZEPH", "ADA"),
        isIntentsRoutable("ZEPH", "ADA"),
        isDeskRoutableFromRegistry("ZEPH", "ADA"),
        isBasicswapRoutable("ZEPH", "ADA"),
        1
      )
    ).toBe(false);
  });

  it("does NOT fall to the atomic-preview placeholder for a BasicSwap pair (third occurrence, 2026-08-22)", () => {
    // XMR <-> LTC is the BasicSwap route's flagship pair. On 2026-08-22 a
    // live, reviewable P2P quote sat in the strip while the form's own button
    // read "Atomic swap unavailable" — in BOTH layouts — because this
    // predicate had no basicswap term. Both directions, because the route is
    // direction-agnostic for routability.
    for (const [a, b] of [
      ["XMR", "LTC"],
      ["LTC", "XMR"],
      ["XMR", "BCH"],
      ["DOGE", "XMR"],
    ] as const) {
      expect(isBasicswapRoutable(a, b), `${a}->${b} should be basicswap-routable`).toBe(true);
      expect(
        atomicPreviewFallback(
          false,
          isSwapKitRoutable(a, b),
          isIntentsRoutable(a, b),
          isDeskRoutableFromRegistry(a, b),
          isBasicswapRoutable(a, b),
          1
        ),
        `${a}->${b} must not fall to the placeholder`
      ).toBe(false);
    }
  });

  it("still falls to the placeholder for a genuinely unroutable pair", () => {
    expect(
      atomicPreviewFallback(
        false,
        isSwapKitRoutable("FLR", "XMR"),
        isIntentsRoutable("FLR", "XMR"),
        isDeskRoutableFromRegistry("FLR", "XMR"),
        isBasicswapRoutable("FLR", "XMR"),
        1
      )
    ).toBe(true);
  });

  it("never fires with no amount typed", () => {
    expect(atomicPreviewFallback(false, false, false, false, false, 0)).toBe(false);
  });
});
