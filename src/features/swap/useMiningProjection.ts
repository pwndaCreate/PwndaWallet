/**
 * src/features/swap/useMiningProjection.ts
 *
 * The XMR→target rate the Mine tab's SIMPLE view renders its balance in.
 *
 * # This is now a thin adapter over the route estimator
 *
 * The first version priced the route through a USD cross —
 * `sourcePriceUsd / targetPriceUsd` with flat 1% / 0.3% fees. That answers
 * "what are these coins worth", not "what would this swap return", and on the
 * BasicSwap book those are different questions: the public feed routinely
 * carries BTC/LTC at a **19% spread**. A hero priced on the USD cross can be
 * wrong by more than every fee in the route combined, in the user's disfavour,
 * on the screen whose whole job is to say whether converting is worth it.
 *
 * So the rate now comes from {@link useRouteEstimate}, which prices hop 1 from
 * a real order book — the user's own node when they have opted in, the public
 * `markets.basicswapdex.com` snapshot when they have not — and reports which.
 * This module keeps only the display-coin bookkeeping.
 *
 * # What it still is not
 *
 * Not a quote. Hop 2 is estimated from spot prices (a live `quoteIntents` per
 * render is a network round-trip behind a mining screen), and hop 1 is a
 * snapshot of a book that moves. Every surface renders it behind `≈` with the
 * mandatory `PROJECTED · NOT CONVERTED YET` chip, and EARN still fires a real
 * quote at confirm time.
 */
import { useMemo } from "react";
import type { MiningProjection } from "../../types/mining";
import { CONVERT_SOURCE } from "./useConvertPipeline";
import { useRouteEstimate } from "./useRouteEstimate";
import { estimateFailureSentence } from "./routeEstimate";

/** Where the Mine tab's own display-coin choice is remembered. */
const DISPLAY_COIN_KEY = "pwnda.mine.displayCoin";

/**
 * Rate cache lifetime.
 *
 * The handoff asks for ≤ 60s. Prices themselves are cached inside
 * `usd-prices.ts`; this is the recompute interval for the derived rate, which
 * is pure arithmetic over prices App already refreshes. Kept as a named
 * constant so the "≤ 60s" requirement is checkable rather than buried.
 */
export const PROJECTION_MAX_AGE_MS = 60_000;

export function readMineDisplayCoin(): string | null {
  try {
    return window.localStorage.getItem(DISPLAY_COIN_KEY);
  } catch {
    return null;
  }
}

export function writeMineDisplayCoin(ticker: string | null): void {
  try {
    if (ticker == null) window.localStorage.removeItem(DISPLAY_COIN_KEY);
    else window.localStorage.setItem(DISPLAY_COIN_KEY, ticker.toUpperCase());
  } catch {
    /* private mode — the choice just does not persist */
  }
}

export interface MiningProjectionArgs {
  /** The user's Mine-tab display choice, when they have made one. */
  displayCoin: string | null;
  /** The EARN pipeline's saved target, used as the default. */
  earnTargetCoin: string | null;
  prices: Record<string, number>;
  /** Mined balance being projected. The estimate is size-aware. */
  minedAmount: number | null;
  /** Whether the user has opted into running a node — picks the book. */
  optedIn: boolean;
  /** Only fetch a book while a surface that renders this is on screen. */
  enabled: boolean;
  /** Resolves NEAR asset ids to wallet addresses, so hop 2 can be quoted. */
  addressForAsset?: (assetId: string) => string;
}

/**
 * Produce the {@link MiningProjection} the Mine views consume.
 *
 * Lives in `features/swap` and is passed DOWN into mining as a prop —
 * `features/mining` may not import this file, by design. See the type's own
 * doc for why that boundary exists.
 */
export function useMiningProjection({
  displayCoin,
  earnTargetCoin,
  prices,
  minedAmount,
  optedIn,
  enabled,
  addressForAsset,
}: MiningProjectionArgs): MiningProjection {
  /**
   * The default display coin is the EARN target when the user has not chosen
   * one on the Mine tab, per the handoff. It is a DEFAULT, not a mirror: once
   * they pick something here, changing the EARN target must not silently
   * relabel their mining balance.
   */
  const targetTicker = (
    displayCoin ??
    earnTargetCoin ??
    CONVERT_SOURCE
  ).toUpperCase();
  const fromEarnTarget = displayCoin == null && earnTargetCoin != null;
  const isNative = targetTicker === CONVERT_SOURCE;

  /**
   * USD is a unit of account, not a swap target.
   *
   * Reported 2026-08-28: picking `$ USD` rendered a blank hero while the
   * sub-row directly beneath it read `$21.77` — the same quantity, from the
   * same price, one line apart. The cause was routing USD through the order
   * book: there is no XMR->LTC->USD trade, `chainsForSymbol("USD")` is empty,
   * so the estimator correctly answered 'no route' and the hero correctly
   * rendered nothing. Correct, and useless.
   *
   * Denominating in USD is not a conversion, so it does not go through the
   * route at all and is not charged route fees: mined XMR times the XMR
   * price, which is exactly what the sub-row already computes. The two lines
   * can no longer disagree because they are now the same arithmetic.
   */
  const isUsd = targetTicker === "USD";

  const route = useRouteEstimate({
    // Neither the identity case nor a USD valuation needs a route, and
    // neither must fetch a book for one.
    enabled: enabled && !isNative && !isUsd,
    optedIn,
    sourceAmount: minedAmount,
    targetTicker,
    prices,
    addressForAsset,
  });

  return useMemo(
    () => ({
      targetTicker,
      // The identity case is 1 by definition, and is charged no fees: a
      // conversion that is not happening must not be billed for, or this
      // screen and the wallet disagree about the balance.
      ratePerXmr: isNative
        ? 1
        : isUsd
          ? (prices[CONVERT_SOURCE] ?? null)
          : (route.estimate?.ratePerSource ?? null),
      xmrPriceUsd: prices[CONVERT_SOURCE] ?? null,
      fromEarnTarget,
      route: isNative || isUsd ? null : route.estimate,
      routeFailure: isNative || isUsd ? null : route.failure,
      /**
       * A sentence the hero can print instead of a bare `—`.
       *
       * Reported 2026-08-28: "sol asset wont come up when I click on it. Why
       * is that?" — the estimate had failed, the reason was known, and the UI
       * rendered nothing but a dash. Prefers the engine's own wording (a maker
       * minimum, a protocol floor) over the generic one.
       */
      routeFailureText:
        isNative || isUsd || !route.failure
          ? null
          : (route.failureDetail ?? estimateFailureSentence(route.failure)),
      routeLoading: !isNative && !isUsd && route.loading,
      routeSource: route.source,
      /**
       * Named on screen whenever the number did not come from the user's own
       * node. A public, minutes-old, revocation-blind book standing in for
       * the node's is fine — passing it off as the node's is not.
       */
      routeSourceNote:
        isNative || isUsd
          ? null
          : route.fellBackFromLive
            ? "your node's book could not be read — showing the public book"
            : route.source === "public-snapshot"
              ? "priced from the public order book"
              : null,
      /** Re-read the book and re-price. Wired to the hero's RETRY. */
      retryRoute: route.refresh,
    }),
    [targetTicker, isNative, isUsd, route.estimate, route.failure, route.failureDetail, route.loading, route.source, route.fellBackFromLive, route.refresh, prices, fromEarnTarget],
  );
}
