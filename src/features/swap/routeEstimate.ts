/**
 * src/features/swap/routeEstimate.ts
 *
 * "If I convert this mined XMR, what do I end up holding?" — priced from an
 * order book, not from a USD cross.
 *
 * # What this replaces, and why it had to change
 *
 * The first cut of the Mine tab's projected balance multiplied the mined XMR
 * by `sourcePriceUsd / targetPriceUsd` and deducted flat 1% / 0.3% fees. That
 * is a *price*, not a *route*: it says what the coins are worth, not what the
 * swap would actually return. On this network the difference is not small —
 * the public book routinely carries BTC/LTC at a **19% spread** and LTC/WOW
 * at 155%. A projection that ignores the book can be wrong by more than every
 * fee in the route combined, in the user's disfavour, on the screen whose
 * entire job is to tell them whether converting is worth it.
 *
 * So hop 1 is priced from real offers, size-aware, through the same ranking
 * and fill rules the live taker flow uses.
 *
 * # The route
 *
 *   XMR ──(BasicSwap P2P, real offers)──▶ LTC or BCH ──(NEAR Intents)──▶ target
 *
 * The intermediate is whichever of the route hops the book prices better for
 * this size — not a hardcoded LTC. When the target IS the route hop there is
 * no second leg, and the estimate says so.
 *
 * # Two books, one ranker
 *
 * Hop 1's offers come from one of two places, chosen by whether the user has
 * opted into running a node:
 *
 *   - **opted in** — their own node's `/json/offers`. Authoritative: it sees
 *     revocations, it is current, and it is the book they would actually bid
 *     into.
 *   - **not opted in** — the public `markets.basicswapdex.com` snapshot,
 *     adapted into the same `BasicSwapOffer` shape. Minutes old, and blind to
 *     revocations.
 *
 * Both then run through `toTakerOffers` → `rankOffers` →
 * `pickOfferForSendAmount`. Writing a second ranker for the snapshot would
 * mean the number shown BEFORE opting in could drift from the number shown
 * after — the worst place for a discrepancy, since that number is the argument
 * for opting in.
 *
 * # Hop 2 is an estimate and says so
 *
 * The NEAR leg is not quoted here. A real `quoteIntents` call is a network
 * round-trip per amount, and this runs behind a mining screen that recomputes
 * whenever prices tick. Hop 2 is therefore priced from spot USD with the
 * NEAR fee applied, and {@link RouteEstimate.hop2Basis} records that it was
 * estimated rather than quoted. EARN still fires a real quote at confirm time,
 * where the user is committing to a number rather than reading one.
 */
import type { BasicSwapCoin, BasicSwapOffer } from "../../api/basicswap";
import {
  filterOffersForDirection,
  rankOffers,
  toTakerOffers,
  type TakerOffer,
} from "../swap-sidecar/offers";
import { pickOfferForSendAmount } from "../swap-sidecar/useSidecarSwap";

/** The coin mining produces, and the only asset this route starts from. */
export const ROUTE_SOURCE = "XMR";

/**
 * Candidate intermediates, best-priced one wins.
 *
 * Both are BasicSwap counterparty coins with real XMR liquidity. LTC is
 * usually deeper; BCH is included because the operator asked for it and
 * because a two-candidate route survives one book going empty.
 */
export const ROUTE_HOPS = ["LTC", "BCH"] as const;
export type RouteHop = (typeof ROUTE_HOPS)[number];

/** Where hop 1's offers came from. Carried all the way to the UI. */
export type RouteSource = "live-node" | "public-snapshot";

/** How hop 2 was priced. */
/**
 * How hop 2 was priced. Carried to the UI because the two are not equally
 * trustworthy: a dry 1Click quote reflects solver spread and bridge fees,
 * while the price cross ignores both and is only a fallback for when the
 * quote could not be obtained.
 */
export type Hop2Basis =
  | "not-needed"
  | "quoted"
  | "estimated-from-prices";

export interface RouteHopEstimate {
  fromTicker: string;
  toTicker: string;
  /** Amount entering this hop, in `fromTicker` units. */
  sendAmount: number;
  /** Amount leaving it, in `toTicker` units. */
  receiveAmount: number;
}

export interface RouteEstimate {
  targetTicker: string;
  /** The intermediate actually chosen, or `null` for a single-hop route. */
  routeHop: RouteHop | null;
  hop1: RouteHopEstimate;
  hop2: RouteHopEstimate | null;
  /** Final amount in `targetTicker` units. */
  targetAmount: number;
  /** Target units per 1 XMR, after everything. The Mine hero's rate. */
  ratePerSource: number;
  source: RouteSource;
  hop2Basis: Hop2Basis;
  /** The offer hop 1 was priced against, for "you'd take this one" displays. */
  hop1OfferId: string;
  /**
   * Seconds since the book this was priced from was current. `0` for a live
   * node; the snapshot's age otherwise. Surfaces as "N old" beside the number.
   */
  bookAgeSec: number;
}

/** Why an estimate could not be produced. Rendered, never swallowed. */
export type RouteEstimateFailure =
  | "no-book"
  | "empty-book"
  | "no-fillable-offer"
  | "no-target-price"
  | "invalid-amount";

export interface RouteEstimateResult {
  estimate: RouteEstimate | null;
  failure: RouteEstimateFailure | null;
  /**
   * The engine's own sentence for why, when it has one.
   *
   * Preferred over {@link estimateFailureSentence}'s generic text: it names
   * the actual rule that refused (a maker minimum, a protocol floor, an offer
   * maximum) with the numbers in it.
   */
  failureDetail?: string | null;
}

/** NEAR Intents' advisory fee, matching `useConvertPipeline`. */
export const NEAR_FEE_FRACTION = 0.003;

/**
 * Price hop 1 for one candidate intermediate.
 *
 * Returns `null` when this book cannot fill the size, so the caller can try
 * the other hop rather than reporting the whole route dead.
 */
export function estimateHop1(args: {
  offers: readonly BasicSwapOffer[];
  coins: readonly BasicSwapCoin[] | null;
  sendAmount: number;
  hop: RouteHop;
}): {
  receiveAmount: number;
  offerId: string;
  offer: TakerOffer;
} | { failure: string } | null {
  const { offers, coins, sendAmount, hop } = args;
  const taker = toTakerOffers(offers as BasicSwapOffer[], coins);
  // The taker SENDS XMR and RECEIVES the hop coin. Getting this pair backwards
  // returns the other side of the book — offers that look like better prices
  // and cannot be taken from this side at all.
  const directional = filterOffersForDirection(taker, {
    sendCoin: ROUTE_SOURCE,
    receiveCoin: hop,
    coins,
  });
  const ranked = rankOffers(directional.filter((o) => o.tradable));
  if (ranked.length === 0) return null;

  const picked = pickOfferForSendAmount(ranked, sendAmount, coins);
  if (!picked) return null;
  if (!picked.validation.ok) {
    /**
     * Hand back the engine's OWN sentence rather than a guess.
     *
     * `validateBid` mirrors the server's bid rules and its `message` is
     * documented as "safe to render directly under the amount field". The
     * generic fallback this replaced said "No current offer is large enough
     * to convert this amount", which is backwards for the most common case:
     * `below-offer-minimum` means the user's amount is too SMALL for any
     * maker's floor. Telling someone with 0.046 XMR that offers are too small
     * sends them looking for the wrong problem.
     */
    return { failure: picked.validation.message };
  }

  // `effectiveRate` is send-per-receive, so dividing gives the receive leg —
  // the same arithmetic `pickOfferForSendAmount` validated against.
  const receiveAmount = sendAmount / picked.offer.effectiveRate;
  if (!Number.isFinite(receiveAmount) || receiveAmount <= 0) return null;
  return {
    receiveAmount,
    offerId: picked.offer.offerId,
    offer: picked.offer,
  };
}

/**
 * The whole route.
 *
 * Pure: every input is passed in, so this is testable without a node, a
 * network or a React tree — which matters because the populated result cannot
 * be reached in the browser sandbox (Monero needs a wallet-RPC unlock the dev
 * bypass cannot perform).
 */
export function estimateRoute(args: {
  /** XMR to convert. */
  sourceAmount: number;
  /**
   * Which intermediates the CALLER can actually execute through.
   *
   * Defaults to every hop this module can price. Callers whose downstream
   * pipeline is narrower must narrow this to match — `useConvertPipeline`
   * currently routes through LTC only, and an estimate that quoted a BCH
   * route would promise an outcome the CONVERT button cannot deliver. The
   * estimator knowing how to price BCH is a capability; whether it may is
   * the caller's to say.
   */
  allowedHops?: readonly RouteHop[];
  /** UPPERCASE ticker the user wants to end up holding. */
  targetTicker: string;
  /** Hop-1 offer books, keyed by candidate intermediate. */
  offersByHop: Partial<Record<RouteHop, readonly BasicSwapOffer[]>>;
  coins: readonly BasicSwapCoin[] | null;
  /** Spot USD prices for hop 2. */
  prices: Record<string, number>;
  source: RouteSource;
  bookAgeSec: number;
  /**
   * A real quote for the second leg, when one has been fetched.
   *
   * `(hop, amountIn) => amountOut | null`. Synchronous by design: this
   * function stays pure and testable, and the caller owns the async fetch and
   * its cache (`hop2Quote.ts`). `null` means "not quoted", and the estimate
   * falls back to the price cross AND says so via `hop2Basis` — it does not
   * silently present one basis as the other.
   */
  hop2QuotedOut?: (hop: RouteHop, amountIn: number) => number | null;
}): RouteEstimateResult {
  const {
    sourceAmount,
    offersByHop,
    coins,
    prices,
    source,
    bookAgeSec,
  } = args;
  const targetTicker = args.targetTicker.toUpperCase();

  if (!Number.isFinite(sourceAmount) || sourceAmount <= 0) {
    return { estimate: null, failure: "invalid-amount" };
  }

  const allowed = args.allowedHops ?? ROUTE_HOPS;
  const books = allowed.filter((h) => (offersByHop[h]?.length ?? 0) > 0);
  if (books.length === 0) {
    /**
     * `empty-book`, NOT `no-book`.
     *
     * Reaching here means the caller handed over an offer map with nothing on
     * the allowed hops. If the READ had failed the caller says so via its own
     * `failure` and never calls this. Reporting "could not be read" for a
     * successful-but-empty read is precisely what produced the operator's
     * "why is the estimator saying that the order book could not be read if
     * my swap node is synced?" — it had been read.
     */
    return { estimate: null, failure: "empty-book", failureDetail: null };
  }

  /**
   * Try every candidate intermediate and keep the best OUTCOME.
   *
   * Deliberately compared on the final target amount, not on hop 1's rate: a
   * better XMR→LTC price is not better if LTC→target is worse. The route is
   * chosen the way the user experiences it — by what lands in their wallet.
   */
  let best: RouteEstimate | null = null;
  let sawBook = false;
  let sawFillable = false;
  let detail: string | null = null;

  for (const hop of books) {
    sawBook = true;
    const h1 = estimateHop1({
      offers: offersByHop[hop] ?? [],
      coins,
      sendAmount: sourceAmount,
      hop,
    });
    if (!h1) continue;
    if ("failure" in h1) {
      // Keep the first concrete reason; a later hop may still succeed and
      // make it moot.
      detail ??= h1.failure;
      continue;
    }
    sawFillable = true;

    const singleHop = targetTicker === hop;
    let targetAmount: number;
    let hop2: RouteHopEstimate | null = null;
    let hop2Basis: Hop2Basis = "not-needed";

    if (singleHop) {
      targetAmount = h1.receiveAmount;
    } else {
      const quoted = args.hop2QuotedOut?.(hop, h1.receiveAmount) ?? null;
      if (quoted != null && quoted > 0) {
        targetAmount = quoted;
        hop2 = {
          fromTicker: hop,
          toTicker: targetTicker,
          sendAmount: h1.receiveAmount,
          receiveAmount: quoted,
        };
        hop2Basis = "quoted";
        const candidateQ: RouteEstimate = {
          targetTicker,
          routeHop: hop,
          hop1: {
            fromTicker: ROUTE_SOURCE,
            toTicker: hop,
            sendAmount: sourceAmount,
            receiveAmount: h1.receiveAmount,
          },
          hop2,
          targetAmount,
          ratePerSource: targetAmount / sourceAmount,
          source,
          hop2Basis,
          hop1OfferId: h1.offerId,
          bookAgeSec,
        };
        if (!best || candidateQ.targetAmount > best.targetAmount) best = candidateQ;
        continue;
      }
      const hopPrice = prices[hop] ?? null;
      const targetPrice =
        targetTicker === "USD" ? 1 : (prices[targetTicker] ?? null);
      if (hopPrice == null || targetPrice == null || targetPrice <= 0) {
        // No price for this target — try another intermediate; if none has
        // one, the caller reports `no-target-price` rather than a number.
        continue;
      }
      const usd = h1.receiveAmount * hopPrice;
      targetAmount = (usd * (1 - NEAR_FEE_FRACTION)) / targetPrice;
      hop2 = {
        fromTicker: hop,
        toTicker: targetTicker,
        sendAmount: h1.receiveAmount,
        receiveAmount: targetAmount,
      };
      hop2Basis = "estimated-from-prices";
    }

    if (!Number.isFinite(targetAmount) || targetAmount <= 0) continue;

    const candidate: RouteEstimate = {
      targetTicker,
      routeHop: singleHop ? null : hop,
      hop1: {
        fromTicker: ROUTE_SOURCE,
        toTicker: hop,
        sendAmount: sourceAmount,
        receiveAmount: h1.receiveAmount,
      },
      hop2,
      targetAmount,
      ratePerSource: targetAmount / sourceAmount,
      source,
      hop2Basis,
      hop1OfferId: h1.offerId,
      bookAgeSec,
    };
    if (!best || candidate.targetAmount > best.targetAmount) best = candidate;
  }

  if (best) return { estimate: best, failure: null, failureDetail: null };
  if (!sawBook) return { estimate: null, failure: "no-book", failureDetail: detail };
  if (!sawFillable) {
    return { estimate: null, failure: "no-fillable-offer", failureDetail: detail };
  }
  return { estimate: null, failure: "no-target-price", failureDetail: detail };
}

/** One sentence naming what the number came from. Always rendered with it. */
export function estimateProvenance(e: RouteEstimate): string {
  const book =
    e.source === "live-node"
      ? "your node's order book"
      : "the public order book";
  const hop = e.routeHop
    ? `via ${e.routeHop}`
    : "direct";
  return `${hop} · priced from ${book}`;
}

/** Why there is no number, in the user's terms. */
export function estimateFailureSentence(f: RouteEstimateFailure): string {
  switch (f) {
    case "no-book":
      // Reserved for a read that actually FAILED. An empty result is
      // `empty-book` and says something quite different.
      return "The order book could not be read, so there is nothing to price this against.";
    case "empty-book":
      return (
        "No one is offering to swap Monero for " +
        "Litecoin right now. The book was read; it is empty on this pair."
      );
    case "no-fillable-offer":
      // Generic, and deliberately non-committal about the DIRECTION: the
      // usual cause is an amount below the makers' minimums, not above their
      // size. `failureDetail` carries the engine's exact sentence when there
      // is one, and callers render that in preference to this.
      return "No offer on the book can be taken at this amount right now.";
    case "no-target-price":
      return "No price is available for that coin right now.";
    case "invalid-amount":
      return "Nothing mined yet.";
  }
}
