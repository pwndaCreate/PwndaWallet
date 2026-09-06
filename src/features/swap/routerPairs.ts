/**
 * Which pair the swap form should show after the user switches router tabs.
 *
 * The four tabs (AUTO / NEAR / P2P / ZEPHYR) share one pair state, and until
 * 2026-09-04 nothing reconciled the two: switching from NEAR (ETH → BTC) to
 * P2P kept ETH → BTC on a tab whose venue has no ETH at all, so the picker
 * showed a coin the book cannot hold, MIN was disabled, and the quote said
 * "not a pair the swap node holds a book for" — the operator's report was
 * "the asset selection should switch when I switch tabs".
 *
 * Rule: if the current pair is routable on the new tab, keep it — the user's
 * choice wins whenever it can. Otherwise keep whichever side the new venue
 * knows and pick that venue's most-traded counterpart for the other side;
 * if neither side is known there, fall back to the venue's default pair.
 * Pure, so the rule is a unit test, not a click-through.
 */
import { useEffect } from "react";
import type { RouterPreference } from "./router-modes";
import { isBasicswapRoutable } from "../swap-sidecar";
import { isIntentsRoutable, isSwapKitRoutable } from "./swap-data";
import { isDeskRoutableFromRegistry } from "./asset-capabilities";

export interface Pair {
  from: string;
  to: string;
}

/** Counterparts tried in order when one side has to change. */
const P2P_COUNTERPARTS = ["XMR", "LTC", "BTC", "BCH", "DASH", "ZEPH", "ZANO"];
const P2P_DEFAULT: Pair = { from: "XMR", to: "LTC" };
const NEAR_COUNTERPARTS = ["BTC", "ETH", "SOL", "USDC", "XMR", "LTC"];
const NEAR_DEFAULT: Pair = { from: "ETH", to: "BTC" };
// The desk settles exactly two pairs today — XMR/ADA and ZEPH/ADA (one vendored
// engine, `asset-capabilities.test.ts`) — so ADA is the leader every follower
// needs.
const DESK_COUNTERPARTS = ["ADA", "XMR", "ZEPH"];
const DESK_DEFAULT: Pair = { from: "XMR", to: "ADA" };

type Routable = (from: string, to: string) => boolean;

function reconcile(
  pair: Pair,
  routable: Routable,
  counterparts: readonly string[],
  fallback: Pair,
): Pair | null {
  const from = pair.from.toUpperCase();
  const to = pair.to.toUpperCase();
  if (routable(from, to)) return null;
  // Keep the side the venue can use; replace the other with its best partner.
  for (const c of counterparts) {
    if (c !== to && routable(c, to)) return { from: c, to };
  }
  for (const c of counterparts) {
    if (c !== from && routable(from, c)) return { from, to: c };
  }
  return routable(fallback.from, fallback.to) ? { ...fallback } : null;
}

/**
 * The pair to switch to for `router`, or `null` when the current pair already
 * fits (or nothing routable exists — leave it alone rather than guess).
 */
export function coercePairForRouter(router: RouterPreference, pair: Pair): Pair | null {
  switch (router) {
    case "basicswap":
      return reconcile(pair, isBasicswapRoutable, P2P_COUNTERPARTS, P2P_DEFAULT);
    case "pwnda-desk":
      return reconcile(pair, isDeskRoutableFromRegistry, DESK_COUNTERPARTS, DESK_DEFAULT);
    case "swapkit":
      return reconcile(pair, isSwapKitRoutable, NEAR_COUNTERPARTS, NEAR_DEFAULT);
    case "intents":
      return reconcile(pair, isIntentsRoutable, NEAR_COUNTERPARTS, NEAR_DEFAULT);
    case "auto":
    default:
      // Auto can quote on any venue; a pair is "fine" if any of them takes it.
      return reconcile(
        pair,
        (f, t) =>
          isIntentsRoutable(f, t) || isSwapKitRoutable(f, t) || isBasicswapRoutable(f, t),
        NEAR_COUNTERPARTS,
        NEAR_DEFAULT,
      );
  }
}

/**
 * Keep the coin pair fitting the router that is actually selected.
 *
 * `coercePairForRouter` was wired to the tab's `onClick` only, so it fixed a
 * pair the user switched INTO and never one they arrived at. With P2P
 * remembered as the preference from a previous session, the form mounted on
 * its initial `useState("ETH")` / `useState("BTC")` — a pair BasicSwap cannot
 * route at all — and sat there offering "ETH → BTC" on the P2P tab with an
 * Ethereum network pill (reported 2026-09-05). Nothing had been clicked, so
 * nothing coerced.
 *
 * Runs on mount and on every router change, and only ever REPLACES a pair the
 * router cannot route: `coercePairForRouter` returns null when the current
 * pair is already fine, so a user's own choice is never overridden.
 */
export function useRouterPairCoercion(args: {
  router: RouterPreference | null | undefined;
  fromCoin: string;
  toCoin: string;
  setFromCoin: (c: string) => void;
  setToCoin: (c: string) => void;
}) {
  const { router, fromCoin, toCoin, setFromCoin, setToCoin } = args;
  useEffect(() => {
    if (!router) return;
    const next = coercePairForRouter(router, { from: fromCoin, to: toCoin });
    if (!next) return;
    if (next.from !== fromCoin) setFromCoin(next.from);
    if (next.to !== toCoin) setToCoin(next.to);
    // `fromCoin`/`toCoin` are deliberately NOT dependencies: this reacts to the
    // ROUTER changing, not to the user picking a coin. Including them would
    // re-coerce mid-edit and fight the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);
}
