/**
 * Routing-mode config for the swap form.
 *
 * Two upstream routers — SwapKit (aggregator) and NEAR Intents 1Click — are
 * surfaced separately in the UI during the testing phase because exactly
 * one of them is currently mocked (SwapKit) and the other is live with
 * real funds (NEAR Intents). Mistaking one for the other while signing
 * could either broadcast nonsense to mainnet (mock SwapKit responses) or
 * miss the actual settlement venue.
 *
 * `RouterPreference` drives the user's *intent*. The actual displayed
 * source (SwapKit vs Intents) comes from the resolved quote's `source`
 * field — `auto` resolves to whichever returned the better expectedReceive.
 *
 * `ROUTER_MODES` exposes the build-time live/mock flags so the UI can
 * paint banners without leaking env-reads everywhere.
 *
 * Mock detection: the mock SwapKit server returns a deterministic
 * `routeId`. If we see that in a response, force the yellow banner +
 * mock button text regardless of the env flag — defence in depth.
 */
import type { SwapKitRoute } from "../../lib/proxy-types";

/** User's preferred routing system. Persisted in `swapSettings`. */
export type RouterPreference =
  | "auto"
  | "swapkit"
  | "intents"
  | "pwnda-desk"
  | "basicswap";

/** The discriminator on a resolved quote — which upstream actually answered. */
export type RouterSource =
  | "swapkit"
  | "intents"
  | "pwnda-desk"
  | "basicswap";

export interface RouterModeConfig {
  label: string;
  /** Build-time flag — true when the upstream is the real, money-moving
   *  service. Default false for SwapKit (mocked), true for NEAR Intents. */
  isLive: boolean;
  bannerLive: string;
  bannerMock: string;
}

const swapkitLive = readEnvBool(import.meta.env.VITE_SWAPKIT_LIVE, false);
const intentsLive = readEnvBool(import.meta.env.VITE_INTENTS_LIVE, true);
const swapkitCanary = readEnvBool(import.meta.env.VITE_SWAPKIT_CANARY, false);
// Defaults FALSE, deliberately. The swap desk is dev-conformance + testnet
// only; mainnet with live funds is a separate, gated cutover. Until that
// gate opens the UI must paint the mock/testing affordances, and the
// execute path must hard-stop before broadcast (same convention as the
// mocked SwapKit route — see MockSwapAttemptedError).
const deskLive = readEnvBool(import.meta.env.VITE_DESK_LIVE, false);
// Defaults FALSE, on the desk's precedent and for the same reason: a build
// that has not been deliberately configured must paint the testing affordance
// rather than claim a live venue. The flag is about the WALLET'S posture, not
// about whether the local BasicSwap node happens to be running — the node's
// own liveness is `SidecarStatus.phase`, surfaced by the sidecar feature, and
// the two must not be conflated. In particular this flag is NEVER consulted to
// decide whether a swap may proceed; see `SidecarConfirmModal`.
const basicswapLive = readEnvBool(import.meta.env.VITE_BASICSWAP_LIVE, true);

/**
 * Canary banner gate for the 2026-05-25 SwapKit live cutover. When true,
 * the SwapForm renders a yellow "test with a small amount first" banner
 * directly above the Swap button. Independent of VITE_SWAPKIT_LIVE — the
 * banner is informational, not a defense; pairs with the [[MOCK_UUID]]
 * hard-stop in useSwapQuote.ts / swap-execute.ts. Flip to false in a
 * follow-up commit once the first canary swap has settled.
 */
export const SWAPKIT_CANARY_ACTIVE: boolean = swapkitCanary;

// Per UXS-20260516-104 the on-panel banner now reads as
// information-first ("here's the route, here's what it does, nothing
// moves until you confirm") rather than alarm-first ("real funds will
// move"). The harsh "real funds will move" copy is reserved for the
// confirm modal, where it actually applies to the user's next click.
// Live banners are rendered with `bannerColor: "info"` so they pick up
// the neutral grey treatment in `RouterBanner` instead of the accent
// green that was conflicting with the alarming wording.
export const ROUTER_MODES: Record<RouterSource, RouterModeConfig> = {
  swapkit: {
    label: "SwapKit",
    isLive: swapkitLive,
    bannerLive:
      "Routing through SwapKit. Quotes are live; nothing moves until you confirm a swap.",
    bannerMock:
      "SwapKit testing mode (mock data) — no real swap will execute",
  },
  intents: {
    label: "NEAR Intents",
    isLive: intentsLive,
    bannerLive:
      "Routing through NEAR Intents (cross-chain bridge). Quotes are live; nothing moves until you confirm a swap.",
    bannerMock:
      "NEAR Intents testing mode (mock data) — no real swap will execute",
  },
  "pwnda-desk": {
    label: "Pwnda Desk",
    isLive: deskLive,
    bannerLive:
      "Routing through the Pwnda swap desk (non-custodial atomic swap — your keys never leave this device). Quotes are live; nothing moves until you confirm a swap.",
    bannerMock:
      "Pwnda Desk testing mode (dev conformance / testnet) — no real swap will execute",
  },
  basicswap: {
    label: "BasicSwap",
    isLive: basicswapLive,
    // COPY IS A COMPLIANCE SURFACE HERE, not a tone choice
    // (`CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` §2-3). Three things this string
    // must keep saying, and one it must never say:
    //   - the counterparty is ANOTHER USER on an open network. pwnda is not
    //     the counterparty, does not hold the funds, and does not settle the
    //     swap. Never "we will swap that for you".
    //   - the offers are what other users have already posted; the wallet
    //     ranks them on price alone.
    //   - nothing moves until the user confirms.
    // And it must never quote demand, fill rates or "N others viewing" —
    // there is no endpoint that could supply any of those (bids are
    // point-to-point encrypted), so any such number would be invented.
    bannerLive:
      "Routing through BasicSwap — a peer-to-peer offer book. You swap directly with another user on an open network; pwnda is not the counterparty and never holds your coins. Offers are ranked on price alone, and nothing moves until you confirm.",
    bannerMock:
      "BasicSwap testing mode — offers shown are from the local test book, and no real swap will execute",
  },
};

/**
 * The mock SwapKit proxy returns this deterministic `routeId`. When we see
 * it, force the mock UI affordances regardless of `VITE_SWAPKIT_LIVE` — a
 * safety net for the case where the env flag is misconfigured.
 */
export const MOCK_SWAPKIT_ROUTE_ID = "00000000-0000-4000-8000-000000000001";

export function isMockSwapKitResponse(route: SwapKitRoute | undefined): boolean {
  if (!route) return false;
  return route.routeId === MOCK_SWAPKIT_ROUTE_ID;
}

/**
 * Effective live/mock state for a resolved quote.
 *
 * Logic:
 *   - For NEAR Intents: trust VITE_INTENTS_LIVE.
 *   - For SwapKit: live ONLY when VITE_SWAPKIT_LIVE is true *and* the
 *     route id isn't the mock UUID. Either signal alone forces mock.
 */
export function effectiveModeForSource(
  source: RouterSource,
  swapKitRoute?: SwapKitRoute
): { isLive: boolean; mockDetected: boolean; banner: string; bannerColor: "amber" | "info" } {
  if (source === "intents") {
    const live = ROUTER_MODES.intents.isLive;
    return {
      isLive: live,
      mockDetected: false,
      banner: live
        ? ROUTER_MODES.intents.bannerLive
        : ROUTER_MODES.intents.bannerMock,
      // UXS-20260516-104: live = "info" (neutral) not "green" (success).
      // The confirm modal owns the genuine "money will move" warning.
      bannerColor: live ? "info" : "amber",
    };
  }
  if (source === "pwnda-desk") {
    // There is no response-shaped mock tell for the desk the way there is
    // for SwapKit's MOCK_SWAPKIT_ROUTE_ID — the `-dev` desk speaks the
    // identical wire protocol to a production one (that is the whole point
    // of the conformance oracle). So the env flag is the only signal, and
    // it defaults to false: an unconfigured build shows the testing banner
    // rather than claiming to be live.
    const live = ROUTER_MODES["pwnda-desk"].isLive;
    return {
      isLive: live,
      mockDetected: !live,
      banner: live
        ? ROUTER_MODES["pwnda-desk"].bannerLive
        : ROUTER_MODES["pwnda-desk"].bannerMock,
      bannerColor: live ? "info" : "amber",
    };
  }
  if (source === "basicswap") {
    // Same reasoning as the desk: there is no response-shaped mock tell. A
    // real node and the sandbox's mock book emit the identical `/json/offers`
    // payload (deliberately — the mock is transcribed from upstream's
    // `js_offers`), so the env flag is the only signal and it defaults false.
    const live = ROUTER_MODES.basicswap.isLive;
    return {
      isLive: live,
      mockDetected: !live,
      banner: live
        ? ROUTER_MODES.basicswap.bannerLive
        : ROUTER_MODES.basicswap.bannerMock,
      bannerColor: live ? "info" : "amber",
    };
  }
  // source === 'swapkit'
  const flagLive = ROUTER_MODES.swapkit.isLive;
  const mockDetected = isMockSwapKitResponse(swapKitRoute);
  const live = flagLive && !mockDetected;
  return {
    isLive: live,
    mockDetected,
    banner: live ? ROUTER_MODES.swapkit.bannerLive : ROUTER_MODES.swapkit.bannerMock,
    bannerColor: live ? "info" : "amber",
  };
}

/**
 * UI-friendly tuple for the segmented control labels. Order is fixed so
 * the segmented control renders Auto first.
 */
/**
 * Quick-pair shortcuts for a given route — the ONE definition both the portrait
 * and landscape swap views render.
 *
 * Every quick pair must be routable on the route the user is actually on.
 * Until 2026-08-19 each view hardcoded its own list and both were wrong, in
 * different ways:
 *   - portrait offered ETH→XMR and XMR→ZEPH under NEAR Intents, which carries
 *     neither asset (a live catalog pull returns 77 symbols, no XMR, no ZEPH);
 *   - landscape offered ETH→XMR, XMR→ZEPH and SOL→ETH regardless of route —
 *     and ETH→XMR is routable on NOTHING, since BasicSwap pairs exactly one
 *     Monero-family coin with one of BTC/LTC/DOGE/DASH/BCH, and ETH is not a
 *     BasicSwap coin at all. XMR→ZEPH is likewise unroutable: ZEPH is a
 *     fork-phase coin upstream BasicSwap does not carry.
 * Tapping one of those set the form to a pair the selected route could never
 * quote, which reads to the user as the wallet being broken.
 *
 * Keeping this here — beside the router definitions it depends on — is what
 * stops the two surfaces drifting again.
 */
export function quickPairsFor(router: RouterPreference): readonly string[] {
  // BasicSwap is the ONLY route carrying XMR/ZEPH, so the privacy pairs live
  // here and nowhere else. Both legs must be real BasicSwap coins.
  if (router === "basicswap") {
    return ["XMR→LTC", "LTC→XMR", "XMR→BTC", "BTC→XMR"] as const;
  }
  // NEAR Intents (and `auto`, which resolves to it): majors that are actually
  // in the 1Click catalog.
  return ["ETH→BTC", "BTC→ETH", "ETH→SOL", "SOL→ETH", "BTC→USDC"] as const;
}

export const ROUTER_PREFERENCE_OPTIONS: Array<{
  value: RouterPreference;
  label: string;
  hint: string;
}> = [
  { value: "auto", label: "Auto best", hint: "Query all, pick the better quote" },
  // SwapKit RETIRED from the user-facing router (operator decision
  // 2026-08-19): the wallet routes cross-chain through NEAR Intents only.
  //
  // Deliberately ARCHIVED, not deleted. The `"swapkit"` arm still exists in
  // `RouterPreference`/`RouterSource`, in `ROUTER_MODES`, and in
  // `useSwapQuote`'s dispatch, because:
  //   - a user's persisted `swapSettings.preferredRouter` may still say
  //     "swapkit"; `VALID_ROUTERS` is derived from THIS list, so dropping the
  //     entry makes that persisted value invalid and it falls back to the
  //     default — which is the migration, and it only works if the type still
  //     admits the string;
  //   - `normalizeSwapKit` and the mock-route defences are still referenced by
  //     tests that pin real historical incidents.
  // Removing the option here is what makes it unreachable for users: the strip
  // renders from this array, and `auto` no longer fans out to it (see
  // `useSwapQuote`).
  // { value: "swapkit", label: "SwapKit", hint: "SwapKit aggregator only" },
  { value: "intents", label: "NEAR", hint: "NEAR Intents only" },
  // Desk ARCHIVED, not deleted, 2026-08-22 — same treatment as SwapKit above.
  // The `"pwnda-desk"` arm still exists in `RouterPreference`/`RouterSource`,
  // in `ROUTER_MODES`, and in `useSwapQuote`'s dispatch: a persisted
  // `swapSettings.preferredRouter` of "pwnda-desk" must keep validating
  // (`VALID_ROUTERS` derives from this list) and must fail gracefully through
  // the explicit branch rather than crash. `useSwapQuote`'s `DESK_RETIRED`
  // flag independently forces the auto-routing fan-out to skip it, mirroring
  // `SWAPKIT_RETIRED`. Landscape derives its tab strip from this array, so
  // removing the entry here is enough for that surface; portrait's
  // `SwapView.tsx` keeps its own separate (non-derived) tab list and needed
  // the same line removed there too.
  // { value: "pwnda-desk", label: "Desk", hint: "Pwnda atomic-swap desk only" },
  {
    value: "basicswap",
    label: "BasicSwap",
    hint: "BasicSwap peer-to-peer offer book — the only route for XMR and ZEPH",
  },
];

function readEnvBool(v: string | undefined, fallback: boolean): boolean {
  if (typeof v !== "string") return fallback;
  const norm = v.trim().toLowerCase();
  if (norm === "true" || norm === "1" || norm === "yes") return true;
  if (norm === "false" || norm === "0" || norm === "no" || norm === "") return false;
  return fallback;
}
