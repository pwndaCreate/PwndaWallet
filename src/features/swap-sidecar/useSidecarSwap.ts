/**
 * The BasicSwap route's I/O layer: pair routability, book-derived quotes, the
 * bid submit path, and the in-flight swap tracker.
 *
 * Everything that touches the sidecar API for a *swap* lives here. The three
 * pure modules it builds on — `offers.ts` (mirroring + price-only ranking),
 * `spread.ts` (the safety core), `bidStates.ts` (protocol state → plain
 * stages) — stay pure and are not re-implemented here.
 *
 * ## Why this route exists at all
 *
 * NEAR Intents carries neither XMR, ZEPH nor ZANO (`asset-capabilities.ts`
 * has `nearIntentsAsset: null` and `swapKitAsset: null` on all three), and
 * the `pwnda-desk` route only settles the `ada-xmr` engine — i.e. an ADA
 * leg. So for a user who wants a CryptoNote-family coin against a
 * bitcoin-family coin, the local BasicSwap node is **the only route in the
 * wallet**. That is why {@link isBasicswapRoutable} is strict about the
 * scriptless leg — strict down to the coins in `SIDECAR_SCRIPTLESS_TICKERS`
 * (`types.ts`), not "any Monero-family coin the wallet happens to hold".
 *
 * **History that still matters for how strict to be about a new coin.**
 * ZEPH was removed entirely 2026-08-22 after the operator asked why it
 * appeared here at all, and the answer at the time was that it shouldn't
 * have — upstream BasicSwap had no Zephyr chainclient, so a ZEPH pair on
 * this route could never do anything but hold a permanently empty book.
 * That backend gap closed 2026-09-03 (Grove expansion plan Phase B, patches
 * 13-17): ZEPH and ZANO both now have real BasicSwap chainclient modules,
 * so both are legitimate scriptless legs — but ONLY opposite BTC, LTC or
 * BCH (never DOGE, DASH, XMR, or each other — see
 * `FOLLOWER_COUNTERPARTY_TICKERS` below and
 * `grove-expansion-master-plan.md` § 1). The lesson from the 2026-08-22
 * incident still applies to any FUTURE coin added here: widening this list
 * is only safe once the backend chainclient genuinely exists, never on the
 * assumption that "it's a Monero fork, it'll behave the same".
 *
 * **BasicSwap is NOT the only route for a bitcoin-family↔bitcoin-family
 * pair** (SwapKit/NEAR carry BTC↔LTC too) — but it is the only PEER-TO-PEER
 * one, and until 2026-08-22 the picker refused to offer it at all:
 * `isBasicswapRoutable` required exactly one scriptless leg unconditionally,
 * when that requirement is the `XMR_SWAP` protocol's alone. BasicSwap's
 * older scripted↔scripted protocol needs no Monero-family coin — see
 * `BASICSWAP_COUNTERPARTY_TICKERS`'s doc for the fix and what was verified
 * before widening it.
 *
 * ## Four constraints in this file that are NOT style choices
 *
 * 1. **Ranking is price-only.** {@link rankOffers} is the only ordering, and
 *    nothing here re-sorts, boosts or filters on maker identity. The
 *    feasibility filter in {@link pickOfferForSendAmount} is a correctness
 *    filter (can this offer fill this size at all), the same kind as
 *    `filterOffersForDirection` — not a preference.
 * 2. **No taker feed.** No endpoint exposes other users' bids or swaps, so
 *    nothing here derives fill rates, demand or popularity. The data does not
 *    exist; inventing it is a posture violation.
 * 3. **Advisory data degrades, never blocks.** A dead price feed, a `{error}`
 *    fee estimate and an unreachable `/json/coins` each drop their own line
 *    and leave the rest of the quote intact. The one thing an unusable price
 *    feed DOES do is force the spread band to red/cannot-verify — which is a
 *    typed override away, not a wall (see `spread.ts`'s header for why those
 *    two rules are compatible).
 * 4. **The fee never gates.** Nothing in this module reads, computes or
 *    branches on the pwnda licence fee. A swap must run and settle identically
 *    whether a fee is ever paid.
 *
 * ## The write path — OPEN since 2026-08-22, through its own door
 *
 * `bids/new` is still deny-listed and still absent from `check_endpoint`'s
 * allow-list: the generic API proxy has NOT been widened, and must not be. It
 * is a pass-through, so reaching `bids/new` through it would let a compromised
 * renderer post an arbitrary bid body.
 *
 * Instead {@link submitSidecarBid} calls `swap_sidecar_place_bid`, a dedicated
 * Rust command (`src-tauri/src/swap_bid.rs`) that pins the path to a constant,
 * builds the body itself, **re-reads the offer from the engine**, and re-checks
 * the amount and rate against the engine's own copy before writing. That last
 * check is the point: it is what stops a renderer from showing one price and
 * submitting another. The engine still re-validates everything after us and
 * remains the authority.
 *
 * {@link SIDECAR_WRITE_DENIED_MARKER} and the `write-path-unavailable` result
 * are KEPT, not deleted — a build whose Rust side predates the command, or a
 * future endpoint that is still refused, must still classify cleanly rather
 * than reading as a generic rejection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  JANITOR_EVENT,
  type JanitorReport,
  fetchCoins,
  fetchOffers,
  fetchOfferFeeEstimate,
  fetchWallets,
  fetchBid,
  fetchSentBids,
  isApiError,
  swapSidecarPlaceBid,
  swapSidecarStatus,
  type BasicSwapBidDetail,
  type BasicSwapCoin,
  type BasicSwapFeeEstimate,
  fetchActiveSwaps,
} from "../../api/basicswap";
import { fetchUsdPrices } from "../../wallets/usd-prices";
import {
  applyCooldown,
  coolDown,
  loadCooldowns,
  COOLDOWN_REASON_EXPIRED,
} from "./offerCooldown";
import { activeSwapToTracked, mergeActiveSwaps } from "./activeSwaps";
import { AUTO_RETRY_MAX_ATTEMPTS, shouldAutoRetry } from "./autoRetry";
import { readSwapSidecarOptIn } from "./swapSidecarOptIn";
import {
  filterOffersForDirection,
  rankOffers,
  snapDown,
  ceilTo,
  toTakerOffers,
  validateBid,
  assessBidFunding,
  assessWalletSeedReadiness,
  protocolFloorForPair,
  type BidValidation,
  type FundingVerdict,
  type WalletSeedVerdict,
  type TakerOffer,
  minFillableReceive,
} from "./offers";
import {
  computeSpread,
  marketRateFromPrices,
  type SpreadAssessment,
} from "./spread";
import {
  classifyBidState,
  type BidStateClassification,
} from "./bidStates";
import {
  decimalsForCoin,
  formatAmount,
  normalizeCoinKey,
  parseAmount,
  tickerForCoin,
  SIDECAR_SCRIPTLESS_TICKERS,
} from "./types";

// =========================================================================
// Routability
// =========================================================================

/**
 * The scriptless legs. The `XMR_SWAP` protocol (`SwapTypes.XMR_SWAP`, see
 * `offers.ts`) needs exactly ONE scriptless side, so a pair with two of
 * these (e.g. XMR↔ZEPH, ZEPH↔ZANO) is not a swap that protocol can make.
 *
 * Derived from {@link SIDECAR_SCRIPTLESS_TICKERS} (`types.ts`), NOT
 * `SIDECAR_ONLY_TICKERS` — the two constants answer different questions,
 * see `types.ts`'s doc comments on both. This is the one that actually
 * governs `XMR_SWAP` eligibility.
 */
const SCRIPTLESS_KEYS: ReadonlySet<string> = new Set(
  SIDECAR_SCRIPTLESS_TICKERS.map((t) => normalizeCoinKey(t)),
);

/**
 * XMR's own normalised key — the one scriptless coin that is (a) exempt
 * from the follower counterparty narrowing below, and (b) exempt from the
 * `liveEnabled` gate in {@link basicswapPickerTickers} (it ships
 * `DEFAULT_ENABLED_COINS`; ZEPH/ZANO do not — see that function's doc).
 */
const XMR_KEY = normalizeCoinKey("XMR");

/**
 * Coins this wallet can trade on BasicSwap — either as the SCRIPTED leg
 * opposite XMR/ZEPH (the `XMR_SWAP` protocol, adaptor-signature), or against
 * EACH OTHER directly (BasicSwap's original scripted-to-scripted protocol —
 * an ordinary two-sided HTLC, NOT an adaptor-signature swap, since both
 * chains can script a refund and neither needs Monero's scriptless
 * machinery — see `basicswap-mainnet-taker-operations.md`'s roles table:
 * "BTC->LTC ... not an adaptor swap (both scripted -> HTLC)", from the
 * operator's own 2026-08-21 mainnet run). Restricted to the ones this
 * wallet also derives an address for. Upstream supports more (NMC, DCR,
 * FIRO, PIVX, NAV, PART); they are omitted because a route the wallet
 * cannot pay from or receive into is not a route the user can take, and
 * offering it would produce a quote that dead-ends at the confirm step.
 *
 * **Scripted↔scripted was refused here until 2026-08-22.** Fixed after the
 * operator flagged it, backed by a screenshot of the node's own console
 * showing live BTC↔LTC offers on the real book — `basicswapLegsFor` was
 * requiring exactly one scriptless leg unconditionally, which is the
 * `XMR_SWAP` protocol's rule, not a rule of the route as a whole. Verified
 * before widening it that nothing downstream assumes XMR-swap-only:
 * `toTakerOffer`'s amount/rate math reads `amount_from`/`amount_to`/`rate`
 * generically (no swap_type branch), `protocolFloorForPair` derives its
 * floor from each coin's own decimals, and `swap_bid.rs::build_bid_body`
 * sends the same generic `{offer_id, amount_from, rate, addr_to}` body
 * upstream's `bids/new` accepts for every swap type. The one place this
 * genuinely degrades: `bidStates.ts` only names `XMR_SWAP_*` stage strings,
 * so a scripted↔scripted bid's OWN protocol states (not researched — a
 * different name space upstream) fall through to `bidStates.ts`'s existing
 * `"unknown"` stage, which reads "Status not recognised... The swap itself
 * is unaffected" rather than crashing or lying. Acceptable to ship this way
 * — the swap still runs and settles — but naming those states properly is
 * the honest follow-up, not assumed done here.
 *
 * Widening this list further is a deliberate change: add the ticker to
 * `asset-capabilities.ts` first, so `addressForTicker` can resolve it.
 *
 * This is XMR's counterparty set specifically. ZEPH and ZANO use the
 * narrower {@link FOLLOWER_COUNTERPARTY_TICKERS} instead — see that
 * constant's doc for why the two lists diverge.
 */
export const BASICSWAP_COUNTERPARTY_TICKERS: readonly string[] = [
  "BTC",
  "LTC",
  "DOGE",
  "DASH",
  "BCH",
];

const COUNTERPARTY_KEYS: ReadonlySet<string> = new Set(
  BASICSWAP_COUNTERPARTY_TICKERS.map((t) => normalizeCoinKey(t)),
);

/**
 * The counterparty tickers ZEPH and ZANO ("followers", per the Grove
 * expansion plan's own term) may pair with — a strict SUBSET of
 * {@link BASICSWAP_COUNTERPARTY_TICKERS}. Hard product rule, not a
 * bandwidth/liquidity call this file gets to relax:
 * `grove-expansion-master-plan.md` § 1 "Standing decisions" — "Followers
 * only: ZEPH/ZANO pair with BTC, LTC, BCH, PART. Never XMR, each other,
 * DOGE, DASH."
 *
 * **PART is deliberately omitted here too**, even though the plan's own
 * wording names it. This wallet has no Particl `ChainType` / wallet
 * adapter at all — the swap node's OWN Particl wallet exists only to carry
 * SMSG offer/bid messages (`DexParticlCard.tsx`'s header: "PART is not a
 * coin the user chose to trade. It is the offer/bid transport") and is
 * explicitly excluded from `BASICSWAP_COUNTERPARTY_TICKERS` above for that
 * same "the wallet cannot pay from or receive into it" reason — see that
 * constant's own doc comment, which already lists PART among the coins
 * omitted on this basis, and `grove-expansion-master-plan.md` § 8 Q2's own
 * conclusion: "PART is the SMSG fee balance, not a rail." Offering a
 * ZEPH/PART or ZANO/PART pair here would repeat exactly the "route the
 * wallet cannot pay from or receive into" dead-end
 * `BASICSWAP_COUNTERPARTY_TICKERS`'s doc warns against, just for a
 * follower instead of XMR. If a first-party PART wallet adapter is ever
 * added, both this list and the base one should be revisited together.
 */
export const FOLLOWER_COUNTERPARTY_TICKERS: readonly string[] = [
  "BTC",
  "LTC",
  "BCH",
];

const FOLLOWER_COUNTERPARTY_KEYS: ReadonlySet<string> = new Set(
  FOLLOWER_COUNTERPARTY_TICKERS.map((t) => normalizeCoinKey(t)),
);

/**
 * Which counterparty set applies opposite a given scriptless leg —
 * XMR's own (wider) set, or the followers' narrower one. `scriptlessKey`
 * must already be a {@link normalizeCoinKey} output.
 */
function counterpartyKeysFor(scriptlessKey: string): ReadonlySet<string> {
  return scriptlessKey === XMR_KEY ? COUNTERPARTY_KEYS : FOLLOWER_COUNTERPARTY_KEYS;
}

export interface BasicswapLegs {
  /** Ticker the user sends. */
  sendTicker: string;
  /** Ticker the user receives. */
  receiveTicker: string;
}

/**
 * True when the local BasicSwap node could hold a book for this pair: either
 * an `XMR_SWAP` (exactly one scriptless leg — XMR, ZEPH or ZANO — and one
 * counterparty valid FOR THAT LEG; see {@link counterpartyKeysFor}) or a
 * scripted↔scripted swap (two DIFFERENT supported bitcoin-family coins,
 * neither of them CryptoNote-family) — in either direction.
 *
 * "Valid for that leg" matters: XMR's counterparty set is wider than ZEPH's
 * or ZANO's (see `FOLLOWER_COUNTERPARTY_TICKERS`'s doc), so e.g. XMR↔DOGE is
 * routable but ZEPH↔DOGE is not, even though DOGE is a counterparty either
 * way.
 *
 * Direction does not affect routability — it decides which side of the offer
 * book to read, which {@link basicswapLegsFor} carries.
 */
export function isBasicswapRoutable(from: string, to: string): boolean {
  return basicswapLegsFor(from, to) !== null;
}

/** The legs of a routable pair, or `null` when the pair is not routable. */
export function basicswapLegsFor(
  from: string,
  to: string,
): BasicswapLegs | null {
  const f = normalizeCoinKey(from);
  const t = normalizeCoinKey(to);
  if (!f || !t || f === t) return null;
  const fScriptless = SCRIPTLESS_KEYS.has(f);
  const tScriptless = SCRIPTLESS_KEYS.has(t);
  // Both scriptless (XMR↔ZEPH, ZEPH↔ZANO, XMR↔ZANO, ...): no protocol
  // variant makes this swap, and this is also how "never each other" for
  // ZEPH/ZANO falls out — no separate check needed.
  if (fScriptless && tScriptless) return null;
  if (fScriptless || tScriptless) {
    // XMR_SWAP: the non-scriptless side must be a counterparty valid FOR
    // THIS scriptless leg — XMR's own (wider) set, or the followers'
    // narrower one. See `counterpartyKeysFor`.
    const scriptlessKey = fScriptless ? f : t;
    const counterparty = fScriptless ? t : f;
    if (!counterpartyKeysFor(scriptlessKey).has(counterparty)) return null;
  } else {
    // Neither side is scriptless: only valid as a scripted<->scripted swap,
    // which needs BOTH sides to be supported bitcoin-family coins.
    if (!COUNTERPARTY_KEYS.has(f) || !COUNTERPARTY_KEYS.has(t)) return null;
  }
  return {
    sendTicker: from.toUpperCase(),
    receiveTicker: to.toUpperCase(),
  };
}

/**
 * The pair to switch to when landing on the BasicSwap route with a pair it
 * cannot hold a book for — `null` when the current pair is already fine.
 *
 * Bug, 2026-08-22 (operator screenshot: "ETH" showing on YOU SEND, on a
 * fresh boot, with the P2P tab already selected and green). Root cause: the
 * form's `fromCoin`/`toCoin` state always initialises to the aggregator's
 * hardcoded default ("ETH"/"BTC", `useState` in `SwapView.tsx` /
 * `SwapLandscapeView.tsx`), completely independent of which router is
 * selected — while `preferredRouter` is a genuinely PERSISTED preference
 * (`useSwapSettings`, `tauri-plugin-store`), loaded async and typically
 * resolving to whatever the user had open when they last closed the app.
 * Land on the app with P2P persisted from last session and the two states
 * disagree: router says P2P, coins say ETH/BTC, and ETH/BTC is not a pair
 * P2P can route — not a leak from another tab (NEAR sets nothing; ETH/BTC
 * is simply the app's one universal default, coincidentally always valid on
 * every OTHER router, since P2P is the only one with a narrow scriptless-leg
 * requirement). The same mismatch reproduces by hand: pick ETH/BTC on AUTO,
 * then click the P2P tab — nothing in `onPreferredRouterChange`'s call chain
 * corrects the pair either.
 *
 * Preserves whichever side is already legal for this route rather than
 * resetting both: `toCoin=BTC` (the common case, since BTC is the global
 * default) survives, and only the scriptless leg swaps to XMR.
 *
 * Deliberately always corrects TO XMR specifically, never to ZEPH/ZANO,
 * even after 2026-09-03's follower widening — XMR is a legal scriptless
 * partner for every counterparty in `BASICSWAP_COUNTERPARTY_TICKERS`
 * (including DOGE/DASH, which followers cannot pair with), so it is the
 * one correction that is always valid regardless of which counterparty
 * survived. Verified by the "every correction it proposes is itself
 * routable" property test in `correctedBasicswapPair.test.ts`, which
 * covers ZEPH/DASH-shaped inputs specifically for this reason.
 */
export function correctedBasicswapPair(
  fromCoin: string,
  toCoin: string,
): { from: string; to: string } | null {
  if (isBasicswapRoutable(fromCoin, toCoin)) return null;
  const fromKey = normalizeCoinKey(fromCoin);
  const toKey = normalizeCoinKey(toCoin);
  const fromIsScriptless = fromKey != null && SCRIPTLESS_KEYS.has(fromKey);
  const toIsScriptless = toKey != null && SCRIPTLESS_KEYS.has(toKey);
  const fromIsCounterparty = fromKey != null && COUNTERPARTY_KEYS.has(fromKey);
  const toIsCounterparty = toKey != null && COUNTERPARTY_KEYS.has(toKey);

  if (toIsCounterparty && !fromIsScriptless) return { from: "XMR", to: toCoin };
  if (fromIsCounterparty && !toIsScriptless) return { from: fromCoin, to: "XMR" };
  if (fromIsScriptless) return { from: fromCoin, to: "BTC" };
  if (toIsScriptless) return { from: "BTC", to: toCoin };
  return { from: "XMR", to: "BTC" };
}

/**
 * The coins the swap form's picker should offer while the BasicSwap route is
 * selected — narrowed further by whatever is already picked on the OTHER side.
 *
 * Audit finding, 2026-08-22: the picker was router-blind. On the P2P tab it
 * listed the NEAR Intents roster (ETH, SOL, BNB, ADA, AVAX, POL, XLM, SUI…),
 * none of which BasicSwap can settle, so a user could assemble ETH→BTC on a
 * route whose book can never hold it and only learn that from the strip below.
 *
 * The rule is {@link basicswapLegsFor}'s rule, applied one side at a time —
 * as of 2026-09-03 this function delegates to `basicswapLegsFor` directly
 * for a RECOGNISED `other` (a scriptless or counterparty coin), rather than
 * re-deriving the scriptless/counterparty logic, precisely so the
 * follower-narrowing rule (below) cannot drift between the two functions
 * the way the picker and the routability check already drifted once before
 * (the 2026-08-22 incidents this file documents at length). An
 * UNRECOGNISED `other` (below) is handled separately and deliberately does
 * NOT delegate — `basicswapLegsFor(candidate, "ETH")` is false for every
 * candidate, which would collapse the picker to empty instead of showing
 * everything:
 * - nothing picked opposite (or a non-BasicSwap coin left over from another
 *   tab) → every coin this route can carry, all families;
 * - a scriptless coin (XMR/ZEPH/ZANO) opposite → only counterparties valid
 *   FOR THAT LEG (XMR's wider set, or the followers' narrower one — see
 *   `FOLLOWER_COUNTERPARTY_TICKERS`);
 * - a counterparty opposite → every scriptless coin it can legally pair
 *   with, PLUS every other counterparty (scripted↔scripted). A DOGE/DASH
 *   counterparty opposite therefore offers XMR but NOT ZEPH/ZANO.
 *
 * Filters the caller's list rather than inventing one, so the picker's global
 * ordering and any coin the wallet does not derive an address for stay the
 * caller's concern. Pure.
 *
 * @param liveEnabled When given, a second, independent filter: the UPPERCASE
 *   tickers the local node currently reports `enabled && configured`
 *   (`CoinEnableStatus` from `swap_sidecar_coin_status`). BasicSwap's OWN
 *   protocol rule (which pairs the engine could ever match, above) and the
 *   NODE's live activation state (which of those the user has actually
 *   turned on, right now) are different questions — a coin can pass the
 *   first and fail the second (DOGE is a legal counterparty leg but sits off
 *   by default; XMR is always protocol-legal but reads not-enabled for the
 *   few seconds between opt-in and the node's first status reply). `null`/
 *   `undefined` skips this filter — the state hasn't loaded yet, or the
 *   caller doesn't have it — so the picker shows the protocol-legal roster
 *   rather than an empty one while waiting on a network round trip.
 *   Deliberately NOT gated on ONLY the XMR scriptless leg: it is
 *   `DEFAULT_ENABLED_COINS` and has no local chain to wait on, so gating it
 *   too would mean a split second of "no coins in this picker" on every
 *   fresh opt-in, for a coin that is in practice always on. ZEPH and ZANO
 *   are the opposite case — Grove ships neither in `DEFAULT_ENABLED_COINS`,
 *   both need the DEX-coins card's explicit host-wallet consent before the
 *   node will ever configure them (see `grove-expansion-master-plan.md`
 *   § 0's acceptance table row for each), so unlike XMR they stay gated
 *   exactly like an ordinary counterparty coin — offering them here before
 *   the user has consented would be the same "protocol-legal but not
 *   actually usable yet" gap `liveEnabled` exists to close for DOGE/DASH/BCH.
 */
export function basicswapPickerTickers(
  candidates: readonly string[],
  otherTicker: string | null | undefined,
  liveEnabled?: ReadonlySet<string> | null,
): string[] {
  // Only XMR bypasses the liveEnabled gate — see the param doc above.
  const isLiveGated = (key: string) => key !== XMR_KEY;
  const otherKey = otherTicker ? normalizeCoinKey(otherTicker) : null;
  // Nothing picked opposite, OR a ticker this route does not recognise AT
  // ALL (e.g. a leftover NEAR-Intents-only coin like ETH from another tab)
  // — both cases offer every BasicSwap coin, unnarrowed. This distinction
  // is load-bearing, not cosmetic: delegating straight to `basicswapLegsFor`
  // for an unrecognised `other` would ask "is (candidate, ETH) routable"
  // for every candidate, which is false for ALL of them (ETH is neither a
  // scriptless leg nor a counterparty), collapsing the picker to empty —
  // a real regression caught by this file's own
  // "non-BasicSwap coin left over opposite" test during C-T1's follower
  // widening (2026-09-03).
  const otherRecognized =
    otherKey != null && (SCRIPTLESS_KEYS.has(otherKey) || COUNTERPARTY_KEYS.has(otherKey));
  if (!otherRecognized) {
    return candidates.filter((t) => {
      const k = normalizeCoinKey(t);
      if (!SCRIPTLESS_KEYS.has(k) && !COUNTERPARTY_KEYS.has(k)) return false;
      if (isLiveGated(k) && liveEnabled && !liveEnabled.has(t.toUpperCase())) {
        return false;
      }
      return true;
    });
  }
  return candidates.filter((t) => {
    const k = normalizeCoinKey(t);
    // Delegates the whole "is this pair legal" question to
    // `basicswapLegsFor` — see the function doc above for why. This also
    // covers self-pairing (LTC opposite LTC) for free: `basicswapLegsFor`
    // already refuses `f === t`.
    if (!basicswapLegsFor(t, otherTicker as string)) return false;
    if (isLiveGated(k) && liveEnabled && !liveEnabled.has(t.toUpperCase())) {
      return false;
    }
    return true;
  });
}

// =========================================================================
// The quote
// =========================================================================

/** Advisory chain-cost line. Never a reason to block. */
export interface SidecarChainCost {
  /** Coin the estimate is denominated in, as the node named it. */
  coin: string;
  /** Decimal string, or `null` when the node could not price it. */
  fee: string | null;
  /** Why it is missing, when it is. Rendered verbatim, never as an error. */
  unavailableReason: string | null;
}

/**
 * Everything the BasicSwap route knows about one (pair, amount) request.
 *
 * Carries the whole book slice, not just the winner: the confirm surface shows
 * how many other offers exist at what price, which is the only honest way to
 * present "this is the best price" without a taker feed.
 */
export interface SidecarQuote {
  legs: BasicswapLegs;
  /** The offer the quote is priced against — best price that can fill. */
  offer: TakerOffer;
  /** Every tradable offer in this direction, price-ranked. */
  rankedOffers: TakerOffer[];
  /** Local mirror of the node's bid rules for the chosen size. */
  validation: BidValidation;
  /** Band + sentence, computed against the wallet's own price feed. */
  spread: SpreadAssessment;
  /** What the user sends, snapped to the send coin's precision. */
  sendAmount: number;
  /** What they receive, snapped DOWN to the receive coin's precision. */
  receiveAmount: number;
  sendDecimals: number;
  receiveDecimals: number;
  /** Advisory. `null` when the node declined to price it. */
  chainCost: SidecarChainCost | null;
  /** The live `/json/coins` table, when it loaded. */
  coins: BasicSwapCoin[] | null;
  /** Unix seconds — the chosen offer's own expiry. */
  expiresAt: number;
  /**
   * Whether the SWAP NODE can fund the send leg (audit 2026-08-22). Advisory
   * in the same sense the spread band is: `"unknown"` never blocks, `"short"`
   * is surfaced prominently and gates the confirm control, because a bid the
   * node cannot fund fails at lock time regardless.
   */
  funding: FundingVerdict;
  /**
   * Would the engine refuse this bid on `restrict_unknown_seed_wallets`
   * before ever sending it (incident 2026-08-22). Same gating rule as
   * `funding`: `"ok"` never blocks, `"not-ready"` is surfaced prominently
   * and gates the confirm control, because the engine's own
   * `checkCoinsReady` refuses it identically either way.
   */
  walletReadiness: WalletSeedVerdict;
  /** Non-fatal notes for the form to surface (spread band, missing advisory). */
  warnings: string[];
}

/** Why a book request produced nothing. Each is a plain sentence. */
export type SidecarQuoteFailure =
  | "not-routable"
  | "not-enabled"
  | "node-unavailable"
  | "empty-book"
  | "no-fillable-offer"
  | "invalid-amount";

export class SidecarQuoteError extends Error {
  readonly kind: SidecarQuoteFailure;
  /** The best-priced offer, when one existed but could not fill the size. */
  readonly offer: TakerOffer | null;
  /** The validation that explains a `no-fillable-offer`, when there is one. */
  readonly validation: BidValidation | null;

  constructor(
    kind: SidecarQuoteFailure,
    message: string,
    extra?: { offer?: TakerOffer | null; validation?: BidValidation | null },
  ) {
    super(message);
    this.name = "SidecarQuoteError";
    this.kind = kind;
    this.offer = extra?.offer ?? null;
    this.validation = extra?.validation ?? null;
  }
}

/**
 * The fresh-install gate, enforced HERE rather than only in the view.
 *
 * The rule is that no `swap_sidecar_*` command is invoked before the user has
 * opted in. `SwapView` gates what it *renders* on `useSwapSidecarOptIn`, but
 * the quote hook has no such gate — selecting the BasicSwap router with an
 * amount typed is enough to reach {@link fetchSidecarQuote}, and without this
 * check that would fire `swap_sidecar_api_post` on a wallet that never enabled
 * the subsystem. Rust would refuse it (nothing downloads, nothing spawns), so
 * the effect is harmless — but "harmless because the backend said no" is not
 * the contract, and a gate the caller can forget is not a gate.
 *
 * `readSwapSidecarOptIn` is a plaintext `tauri-plugin-store` read, NOT a
 * sidecar command, so calling it here does not itself breach the rule.
 */
async function assertOptedIn(): Promise<void> {
  let optedInAt: number | null;
  try {
    optedInAt = await readSwapSidecarOptIn();
  } catch {
    // Fail CLOSED. An unreadable store is not evidence of consent.
    optedInAt = null;
  }
  if (optedInAt == null) {
    throw new SidecarQuoteError(
      "not-enabled",
      "The peer-to-peer swap node is not enabled on this wallet. Turn it on in Settings — nothing is downloaded or started until you do.",
    );
  }
}

/** `/json/coins` changes only when the node restarts — cache it per session. */
let coinsCache: { at: number; coins: BasicSwapCoin[] } | null = null;
const COINS_TTL_MS = 5 * 60_000;

async function loadCoins(): Promise<BasicSwapCoin[] | null> {
  if (coinsCache && Date.now() - coinsCache.at < COINS_TTL_MS) {
    return coinsCache.coins;
  }
  try {
    const rv = await fetchCoins();
    if (isApiError(rv) || !Array.isArray(rv)) return null;
    coinsCache = { at: Date.now(), coins: rv };
    return rv;
  } catch {
    // Advisory: without the table we fall back to the static decimals map in
    // `types.ts`. A missing coin table must not fail a quote.
    return null;
  }
}

/** Test seam — drops the memoised `/json/coins` table. */
export function resetSidecarCoinCache(): void {
  coinsCache = null;
}

/**
 * Choose the offer to price against: the **best-priced** offer that can
 * actually fill the requested send amount.
 *
 * The scan is over `rankOffers` output in order, so the result is always the
 * cheapest feasible offer. Skipping an offer that cannot fill the size is a
 * correctness filter, not a preference — bidding outside an offer's own
 * min/max is rejected by the node, so an "available" offer that cannot take
 * this size is not an option the user has.
 */
export function pickOfferForSendAmount(
  ranked: readonly TakerOffer[],
  sendAmount: number,
  coins: readonly BasicSwapCoin[] | null,
): { offer: TakerOffer; validation: BidValidation } | null {
  let firstFailure: { offer: TakerOffer; validation: BidValidation } | null =
    null;
  for (const offer of ranked) {
    if (!offer.tradable) continue;
    const receiveDecimals = decimalsForCoin(offer.receiveCoin, coins);
    const sendDecimals = decimalsForCoin(offer.sendCoin, coins);
    // The user types the SEND amount; a bid is denominated in the RECEIVE leg.
    // Snap DOWN so the derived cost never exceeds what they typed.
    const desiredReceive = snapDown(
      sendAmount / offer.effectiveRate,
      receiveDecimals,
    );
    const validation = validateBid(offer, desiredReceive, {
      receiveDecimals,
      sendDecimals,
      coins,
    });
    if (validation.ok) return { offer, validation };
    if (!firstFailure) firstFailure = { offer, validation };
  }
  return firstFailure;
}

export interface FetchSidecarQuoteArgs {
  from: string;
  to: string;
  /** Exactly what the user typed, a decimal string in SEND-coin units. */
  amount: string;
  /**
   * Injected price map, for tests and for callers that already hold one.
   * Omitted in production so the module owns its own (cached) fetch.
   */
  prices?: Record<string, number> | null;
}

/**
 * Price a swap off the local offer book.
 *
 * Order of operations matters: the book read is the only step that may fail
 * the quote. The price feed and the fee estimate are advisory and are fetched
 * with their failures already absorbed — a dead CoinGecko must produce a RED
 * *band*, never a thrown quote.
 */
export async function fetchSidecarQuote(
  args: FetchSidecarQuoteArgs,
): Promise<SidecarQuote> {
  const legs = basicswapLegsFor(args.from, args.to);
  if (!legs) {
    throw new SidecarQuoteError(
      "not-routable",
      `${args.from.toUpperCase()} to ${args.to.toUpperCase()} is not a pair the swap node can hold a book for. ` +
        `A swap needs Monero (XMR) opposite one of ${BASICSWAP_COUNTERPARTY_TICKERS.join(", ")}, ` +
        `Zephyr (ZEPH) or Zano (ZANO) opposite one of ${FOLLOWER_COUNTERPARTY_TICKERS.join(", ")}, ` +
        `or two DIFFERENT coins from ${BASICSWAP_COUNTERPARTY_TICKERS.join(", ")}.`,
    );
  }

  const typed = parseAmount(args.amount);
  if (typed == null || typed <= 0) {
    throw new SidecarQuoteError(
      "invalid-amount",
      "Enter an amount greater than zero.",
    );
  }

  // Before ANY sidecar command. See `assertOptedIn`.
  await assertOptedIn();

  const coins = await loadCoins();

  // The offers filter speaks the OFFERER's frame: `coin_from` is what the
  // offerer sends, i.e. what the TAKER receives. Getting this pair backwards
  // returns the opposite side of the book — offers that look like worse
  // prices but are in fact not takeable from this side at all.
  let raw;
  try {
    raw = await fetchOffers({
      coin_from: legs.receiveTicker,
      coin_to: legs.sendTicker,
      sort_by: "rate",
      sort_dir: "asc",
    });
  } catch (e) {
    throw new SidecarQuoteError("node-unavailable", nodeErrorSentence(e));
  }
  if (isApiError(raw)) {
    throw new SidecarQuoteError("node-unavailable", nodeErrorSentence(raw.error));
  }
  if (!Array.isArray(raw)) {
    throw new SidecarQuoteError(
      "node-unavailable",
      "The swap node answered the offer book with something this wallet could not read.",
    );
  }

  const takerOffers = toTakerOffers(raw, coins);
  const directional = filterOffersForDirection(takerOffers, {
    sendCoin: legs.sendTicker,
    receiveCoin: legs.receiveTicker,
    coins,
  });
  // Skip makers that did not answer a recent bid — see `offerCooldown`. It
  // never empties a non-empty book, so this cannot turn "that maker is
  // asleep" into "there are no offers".
  const ranked = rankOffers(
    applyCooldown(directional.filter((o) => o.tradable), loadCooldowns(), Date.now())
      .offers,
  );

  if (ranked.length === 0) {
    throw new SidecarQuoteError(
      "empty-book",
      `No one is currently offering ${legs.receiveTicker} for ${legs.sendTicker}. ` +
        `Offers are posted by other users, so the book fills and empties on its own — try again later, or try the other direction.`,
    );
  }

  const picked = pickOfferForSendAmount(ranked, typed, coins);
  if (!picked) {
    throw new SidecarQuoteError(
      "no-fillable-offer",
      `No offer on the book can fill ${args.amount} ${legs.sendTicker} right now.`,
    );
  }
  if (!picked.validation.ok) {
    throw new SidecarQuoteError(
      "no-fillable-offer",
      picked.validation.message,
      { offer: picked.offer, validation: picked.validation },
    );
  }

  const { offer, validation } = picked;
  const receiveDecimals = decimalsForCoin(offer.receiveCoin, coins);
  const sendDecimals = decimalsForCoin(offer.sendCoin, coins);

  // ── advisory: the reference price ────────────────────────────────────
  // Resolved through the OFFER's coin names, not the form's tickers: the
  // offer is what the spread is being computed about, and `tickerForCoin`
  // is the mapping that turns "Monero" into the "XMR" key the price map uses.
  const sendTicker = tickerForCoin(offer.sendCoin, coins) ?? legs.sendTicker;
  const receiveTicker =
    tickerForCoin(offer.receiveCoin, coins) ?? legs.receiveTicker;
  const prices =
    args.prices !== undefined
      ? args.prices
      : await loadPricesQuietly([sendTicker, receiveTicker]);
  const marketRate = marketRateFromPrices(sendTicker, receiveTicker, prices);
  const spread = computeSpread(offer.effectiveRate, marketRate);

  // ── advisory: the chain cost ─────────────────────────────────────────
  const chainCost = await loadChainCostQuietly(offer);
  const nodeBalanceRows = await loadNodeBalancesQuietly();

  // Advisory: can the NODE fund this? Read from the same `/json/wallets`
  // table the balances card shows, so the two can never disagree. Absent or
  // unreadable data is `unknown`, never a refusal.
  const funding = assessBidFunding({
    sendTicker: tickerForCoin(offer.sendCoin, coins) ?? legs.sendTicker,
    sendAmount: validation.sendAmount,
    rows: nodeBalanceRows,
    sendDecimals,
  });

  // Advisory: would the engine's checkCoinsReady refuse this bid outright
  // (incident 2026-08-22)? Same rows `funding` just read, so the two checks
  // can never disagree about what the node currently reports.
  const walletReadiness = assessWalletSeedReadiness({
    sendTicker: tickerForCoin(offer.sendCoin, coins) ?? legs.sendTicker,
    receiveTicker: tickerForCoin(offer.receiveCoin, coins) ?? legs.receiveTicker,
    rows: nodeBalanceRows,
  });

  const warnings: string[] = [];
  if (funding.state === "short") warnings.push(funding.message);
  if (walletReadiness.state === "not-ready") warnings.push(walletReadiness.message);
  if (!spread.verified) {
    warnings.push(
      "The market price is unavailable, so the wallet could not check this rate against a reference.",
    );
  } else if (spread.band !== "green") {
    warnings.push(spread.sentence);
  }
  if (!chainCost || chainCost.fee === null) {
    warnings.push(
      "The swap node could not estimate the on-chain cost of this swap. The swap is unaffected.",
    );
  }
  if (validation.snapped) {
    warnings.push(
      `Amount rounded to ${formatAmount(validation.receiveAmount, receiveDecimals)} ${offer.receiveCoin}, the smallest step this coin can move.`,
    );
  }

  return {
    legs,
    offer,
    rankedOffers: ranked,
    validation,
    spread,
    sendAmount: validation.sendAmount,
    receiveAmount: validation.receiveAmount,
    sendDecimals,
    receiveDecimals,
    chainCost,
    coins,
    expiresAt: offer.expireAt,
    funding,
    walletReadiness,
    warnings,
  };
}

/** What {@link fetchMinFillableAmount} found. */
export interface MinFillableAmount {
  /** The SEND-coin amount to fill the amount field with, already snapped to
   *  `sendDecimals`. */
  sendAmount: number;
  sendDecimals: number;
  /** Offers actually considered after the outlier gate. */
  eligibleOfferCount: number;
  /** Every tradable offer in this direction, before the outlier gate. */
  totalOfferCount: number;
  /** False when no market price was available to gate outliers against —
   *  the result still stands (best-effort against the raw book), but the
   *  caller may want to say so, since MIN could not screen out bait. */
  outlierGateApplied: boolean;
  /**
   * The offer this minimum came from is all-or-nothing, so `sendAmount` is its
   * FULL size rather than a floor — the smallest fillable amount happens to be
   * the only fillable amount. Worth saying out loud: it can be far larger than
   * a "minimum" implies, and larger than the user's balance.
   */
  allOrNothing: boolean;
  /** At least one offer in the pool accepts a partial fill. When false, every
   *  offer on this book is take-it-all. */
  anyPartialFillOffered: boolean;
}

/**
 * The smallest amount worth typing for this pair right now — a "MIN" button
 * for the amount field, mirroring 25%/50%/75%/MAX which read the WALLET
 * balance the same way this reads the BOOK.
 *
 * Needs no new backend endpoint: `/json/offers` already returns every live
 * offer's own `min_bid_amount`, which is exactly what a maker requires to
 * fill at all — the same data `fetchSidecarQuote` already reads once an
 * amount exists. This reads it BEFORE an amount exists, which is the one
 * real difference: there is no user-picked size to validate a single offer
 * against, so the whole ranked/tradable book is scanned for the CHEAPEST
 * fillable minimum, not the best offer for one already-chosen amount.
 *
 * # The outlier gate
 *
 * "The lowest minimum on the book" is not automatically "the lowest minimum
 * worth taking" — a bait offer priced far off market can have a tiny
 * `min_bid_amount` specifically to look cheap to fill. Reuses the SAME
 * verified threshold the confirm-modal spread gate already enforces
 * (`computeSpread` from `spread.ts` — red means worse than
 * `SPREAD_AMBER_MAX_PCT` against the live market feed): a red-band offer is
 * excluded before picking the minimum. Unlike a bid SUBMISSION, a missing
 * price feed does
 * NOT disqualify every offer here — MIN only fills in a number for the user
 * to review before anything is reviewed or sent, so a feed outage degrades
 * to "best-effort against the raw book" (`outlierGateApplied: false`) rather
 * than refusing to suggest anything at all.
 */
export async function fetchMinFillableAmount(args: {
  from: string;
  to: string;
  prices?: Record<string, number> | null;
}): Promise<MinFillableAmount> {
  const legs = basicswapLegsFor(args.from, args.to);
  if (!legs) {
    throw new SidecarQuoteError(
      "not-routable",
      `${args.from.toUpperCase()} to ${args.to.toUpperCase()} is not a pair the swap node can hold a book for.`,
    );
  }

  await assertOptedIn();
  const coins = await loadCoins();

  let raw;
  try {
    raw = await fetchOffers({
      coin_from: legs.receiveTicker,
      coin_to: legs.sendTicker,
      sort_by: "rate",
      sort_dir: "asc",
    });
  } catch (e) {
    throw new SidecarQuoteError("node-unavailable", nodeErrorSentence(e));
  }
  if (isApiError(raw)) {
    throw new SidecarQuoteError("node-unavailable", nodeErrorSentence(raw.error));
  }
  if (!Array.isArray(raw)) {
    throw new SidecarQuoteError(
      "node-unavailable",
      "The swap node answered the offer book with something this wallet could not read.",
    );
  }

  const takerOffers = toTakerOffers(raw, coins);
  const directional = filterOffersForDirection(takerOffers, {
    sendCoin: legs.sendTicker,
    receiveCoin: legs.receiveTicker,
    coins,
  });
  // Skip makers that did not answer a recent bid — see `offerCooldown`. It
  // never empties a non-empty book, so this cannot turn "that maker is
  // asleep" into "there are no offers".
  const ranked = rankOffers(
    applyCooldown(directional.filter((o) => o.tradable), loadCooldowns(), Date.now())
      .offers,
  );
  if (ranked.length === 0) {
    throw new SidecarQuoteError(
      "empty-book",
      `No one is currently offering ${legs.receiveTicker} for ${legs.sendTicker}. ` +
        `Offers are posted by other users, so the book fills and empties on its own — try again later, or try the other direction.`,
    );
  }

  const prices =
    args.prices !== undefined
      ? args.prices
      : await loadPricesQuietly([legs.sendTicker, legs.receiveTicker]);
  const marketRate = marketRateFromPrices(legs.sendTicker, legs.receiveTicker, prices);

  const outlierGateApplied = marketRate != null;
  const eligible = outlierGateApplied
    ? ranked.filter((o) => computeSpread(o.effectiveRate, marketRate).band !== "red")
    : ranked;
  // Never end up with nothing to offer just because every offer happened to
  // gate out — fall back to the raw book rather than refusing outright.
  const pool = eligible.length > 0 ? eligible : ranked;

  let best: number | null = null;
  let bestIsAllOrNothing = false;
  let anyPartialFillOffered = false;
  for (const offer of pool) {
    const offerSendDecimals = decimalsForCoin(offer.sendCoin, coins);
    const offerReceiveDecimals = decimalsForCoin(offer.receiveCoin, coins);
    const floor = protocolFloorForPair({
      sendCoin: offer.sendCoin,
      receiveCoin: offer.receiveCoin,
      rate: offer.effectiveRate,
      sendDecimals: offerSendDecimals,
      receiveDecimals: offerReceiveDecimals,
      coins,
    });
    if (offer.amountNegotiable) anyPartialFillOffered = true;
    // The binding minimum for THIS offer, negotiability included: an
    // all-or-nothing offer fills at exactly one amount however small its
    // advertised `min_bid_amount` is. See `minFillableReceive`.
    const bindingReceive = minFillableReceive(offer, floor.receiveFloor);
    const sendAmount = ceilTo(bindingReceive * offer.effectiveRate, offerSendDecimals);
    if (best == null || sendAmount < best) {
      best = sendAmount;
      bestIsAllOrNothing = !offer.amountNegotiable;
    }
  }
  if (best == null) {
    // Unreachable given `pool.length > 0` above, guarded anyway rather than
    // asserting — a `number | null` reduction is one refactor away from
    // being wrong, and this function's whole job is producing a number.
    throw new SidecarQuoteError(
      "no-fillable-offer",
      "No offer on the book could be sized to a minimum.",
    );
  }

  return {
    sendAmount: best,
    sendDecimals: decimalsForCoin(legs.sendTicker, coins),
    eligibleOfferCount: pool.length,
    totalOfferCount: ranked.length,
    outlierGateApplied,
    allOrNothing: bestIsAllOrNothing,
    anyPartialFillOffered,
  };
}

/**
 * The swap node's own per-coin balances, keyed by UPPERCASE ticker, with the
 * failure absorbed. `{}` means "could not read", which `assessBidFunding`
 * turns into `unknown` rather than a refusal.
 *
 * Reads `/json/wallets` — the SAME endpoint `useSidecarBalances` renders — so
 * the funding verdict and the balances card can never contradict each other.
 */
async function loadNodeBalancesQuietly(): Promise<
  Record<
    string,
    { balance: string | null; locked?: boolean; expectedSeed?: boolean | null }
  >
> {
  try {
    const rv = await fetchWallets();
    if (isApiError(rv) || !rv || typeof rv !== "object") return {};
    const out: Record<
      string,
      { balance: string | null; locked?: boolean; expectedSeed?: boolean | null }
    > = {};
    for (const [key, info] of Object.entries(rv)) {
      if (!info || typeof info !== "object") continue;
      const w = info as {
        balance?: unknown;
        locked?: unknown;
        ticker?: unknown;
        expected_seed?: unknown;
      };
      const ticker = String(w.ticker ?? key).toUpperCase();
      out[ticker] = {
        balance: typeof w.balance === "string" ? w.balance : null,
        locked: w.locked === true,
        expectedSeed: typeof w.expected_seed === "boolean" ? w.expected_seed : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Price feed with its failure already absorbed. `{}` reads as cannot-verify. */
async function loadPricesQuietly(
  tickers: string[],
): Promise<Record<string, number>> {
  try {
    return await fetchUsdPrices(tickers);
  } catch {
    // `marketRateFromPrices` turns an empty map into `null`, which
    // `computeSpread` turns into RED + `verified: false`. That is the
    // intended path, so there is nothing to log loudly here.
    return {};
  }
}

/**
 * The node's own chain-fee estimate for the scripted leg.
 *
 * `offerfeeestimate` takes the OFFER's coin pair (the offerer's frame), which
 * is why it is fed `offer.raw.coin_from` / `coin_to` rather than the taker's
 * send/receive. A `{error}` body, a null `fee`, or a thrown call all collapse
 * to the same thing: an unavailable advisory line.
 */
async function loadChainCostQuietly(
  offer: TakerOffer,
): Promise<SidecarChainCost | null> {
  let rv: BasicSwapFeeEstimate;
  try {
    rv = await fetchOfferFeeEstimate({
      coin_from: offer.raw.coin_from,
      coin_to: offer.raw.coin_to,
    });
  } catch {
    return {
      coin: offer.raw.coin_from,
      fee: null,
      unavailableReason:
        "The swap node did not answer the fee estimate for this pair.",
    };
  }
  if (isApiError(rv)) {
    return {
      coin: offer.raw.coin_from,
      fee: null,
      unavailableReason: rv.error,
    };
  }
  if (rv.fee == null) {
    return {
      coin: rv.coin_from ?? offer.raw.coin_from,
      fee: null,
      unavailableReason:
        rv.error ?? "The swap node could not price this pair's chain fee.",
    };
  }
  return {
    coin: rv.coin_from ?? offer.raw.coin_from,
    fee: rv.fee,
    unavailableReason: null,
  };
}

function nodeErrorSentence(e: unknown): string {
  const msg =
    typeof e === "string"
      ? e
      : ((e as { message?: unknown })?.message ?? String(e));
  const text = String(msg);
  if (/not running/i.test(text)) {
    return "The swap node is not running, so its offer book cannot be read. Start it from Settings and try again.";
  }
  return `The swap node could not be reached: ${text}`;
}

// =========================================================================
// The bid submit path
// =========================================================================

/**
 * The substring both of `swap_sidecar.rs`'s refusal messages share
 * (`allow_api_path`'s denylist wording and `check_endpoint::deny`'s). Matching
 * on it is a deliberate coupling to a Rust string that has unit tests pinning
 * it — `wallet_subcommands_including_withdraw_are_refused` and the `bids/new`
 * cases in `swap_sidecar.rs`'s test module — so it cannot drift silently.
 */
export const SIDECAR_WRITE_DENIED_MARKER = "is not reachable through the wallet";

export type SidecarBidResult =
  | { ok: true; bidId: string }
  /**
   * The Rust side refused the endpoint outright. No longer the normal outcome
   * (the reviewed command landed 2026-08-22) but kept as a distinct kind: a
   * frontend running against an older Rust build still gets an honest,
   * specific message instead of a generic rejection.
   */
  | { ok: false; kind: "write-path-unavailable"; message: string }
  /** The node accepted the call and declined the bid, or the call failed. */
  | { ok: false; kind: "rejected"; message: string };

export interface SubmitSidecarBidArgs {
  quote: SidecarQuote;
  /**
   * Where the bought coin should land. Optional: upstream defaults to the
   * node's own wallet address for the receive coin when omitted, which is the
   * correct behaviour for a sidecar whose wallets the user controls.
   */
  addrTo?: string;
}

/**
 * Submit the bid the confirm modal has already gated.
 *
 * Amounts are sent as **strings at the coin's own precision** —
 * `formatAmount` rather than `String(n)`, because `String(1e-7)` is `"1e-7"`
 * and upstream's amount parser rejects exponent notation. `amount_from` is the
 * RECEIVE leg (upstream denominates a bid in `coin_from`); sending the send-leg
 * number here would ask for a swap orders of magnitude off.
 */
export async function submitSidecarBid(
  args: SubmitSidecarBidArgs,
): Promise<SidecarBidResult> {
  const { quote } = args;
  try {
    // Same gate as the quote path. Unreachable in practice — a quote had to
    // succeed to get here — but this function is exported and a future caller
    // should not be able to skip it.
    await assertOptedIn();
    // LIVE since 2026-08-22. Routed through the dedicated `swap_sidecar_place_bid`
    // Rust command, NOT the generic API proxy: `bids/new` is still deny-listed
    // and still off `check_endpoint`'s allow-list. Rust re-reads the offer from
    // the engine and re-checks amount + rate against the engine's own copy
    // before it writes, so what this function sends cannot differ from what the
    // user reviewed. See `src-tauri/src/swap_bid.rs`.
    const bidId = await swapSidecarPlaceBid({
      offerId: quote.offer.offerId,
      amountFrom: formatAmount(quote.receiveAmount, quote.receiveDecimals),
      // Pinned to the offer's own rate. Upstream rejects a bid more than
      // `RATE_TOLERANCE_FRACTION` (0.01%) away, and the user reviewed THIS rate.
      rate: formatAmount(quote.offer.effectiveRate, quote.sendDecimals),
      addrTo: args.addrTo,
      validForSeconds: 3600,
    });
    const trimmed = (bidId ?? "").trim();
    if (!trimmed) {
      return {
        ok: false,
        kind: "rejected",
        message:
          "The swap node accepted the bid but did not return a bid id, so this wallet cannot track it. Check the advanced console before retrying, so the same bid is not placed twice.",
      };
    }
    return { ok: true, bidId: trimmed };
  } catch (e) {
    const message =
      typeof e === "string"
        ? e
        : String((e as { message?: unknown })?.message ?? e);
    if (message.includes(SIDECAR_WRITE_DENIED_MARKER)) {
      return { ok: false, kind: "write-path-unavailable", message };
    }
    return { ok: false, kind: "rejected", message };
  }
}


// =========================================================================
// The tracker
// =========================================================================

/** What the confirm modal hands up so the tracker can adopt a fresh swap. */
export interface SidecarSwapHandle {
  bidId: string;
  offerId: string;
  sendCoin: string;
  receiveCoin: string;
  /** Decimal strings, already at each coin's precision. */
  sendAmount: string;
  receiveAmount: string;
  /** Unix seconds. */
  createdAt: number;
  /**
   * Where the receive leg pays out — the address the user reviewed.
   *
   * Carried so an automatic re-bid pays the SAME address they approved rather
   * than re-deriving one at retry time. Absent on a rehydrated swap (the bid
   * list does not carry it), which is exactly when a retry must not fire.
   */
  payoutAddress?: string;
  /**
   * `bidId` of the ORIGINAL user-approved bid this one descends from, and how
   * many automatic re-bids that original has produced. Both absent on a bid
   * the user placed themselves.
   */
  retryOf?: string;
  retryAttempt?: number;
}

/** One tracked swap: the handle plus whatever the last poll learned. */
export interface SidecarTrackedSwap extends SidecarSwapHandle {
  detail: BasicSwapBidDetail | null;
  stage: BidStateClassification;
  /** Unix millis of the last successful read, or `null` before the first. */
  lastPolledAt: number | null;
  /** Last poll failure, held so the tracker can say "not updating". */
  error: string | null;
}

/** How the tracker is currently learning about state changes. */
export type SidecarTransport = "websocket" | "poll";

export interface SidecarSwapState {
  swaps: SidecarTrackedSwap[];
  tracked: SidecarTrackedSwap | null;
  trackerOpen: boolean;
  /** Websocket when the node's event socket is connected; poll otherwise. */
  transport: SidecarTransport;
  /** A poll is in flight right now — what "Check now" shows while it works. */
  checking: boolean;
  /** Adopt a freshly-submitted swap. Opens the tracker. */
  adopt: (handle: SidecarSwapHandle) => void;
  openTracker: (bidId: string) => void;
  closeTracker: () => void;
  /** Force an immediate poll of every non-terminal swap. */
  refresh: () => void;
}

/** Poll cadence. Deliberately slow — a swap leg is 30-90 minutes. */
const POLL_MS = 15_000;
/**
 * How often the tracker re-reads the node's own in-progress list.
 *
 * Matches the per-swap poll: one small local request, and its whole job is to
 * be there when the node finally comes up — which on a cold start is a minute
 * or two after this hook first runs.
 */
const ACTIVE_SYNC_MS = 15_000;
/** How long "Checking…" stays on the button at minimum. See `pollAll`. */
export const CHECKING_MIN_VISIBLE_MS = 600;

/**
 * Owns in-flight BasicSwap swaps for the whole app session.
 *
 * ## Mount this ABOVE the view router
 *
 * A swap runs 30-90 minutes and `SwapView` unmounts the instant the user looks
 * at their wallet — a certainty over that span. So this hook and the tracker
 * modal belong next to `useDeskTracker` in `ViewRouter.tsx`, not inside the
 * swap view. `SidecarSwapTracker` is a pure view precisely because it gets
 * unmounted and remounted repeatedly.
 *
 * ## Websocket preferred, poll ALWAYS available
 *
 * The node's event socket is used as a *doorbell*, not a data source: any
 * frame triggers an immediate poll of `/json/bids/<id>`, which stays the single
 * source of truth. That is deliberate — the socket's payload shape is
 * upstream display plumbing, it carries no auth, and it is unreachable in the
 * browser-only sandbox. Treating it as a hint means a dead socket costs
 * latency and nothing else, and there is exactly one parsing path to get wrong.
 */
export function useSidecarSwap(opts: { enabled: boolean }): SidecarSwapState {
  const { enabled } = opts;
  const [swaps, setSwaps] = useState<SidecarTrackedSwap[]>([]);
  // `pollAll` used to learn the live ids by calling `setSwaps` with an
  // updater that returned `prev` unchanged. React may run such an updater
  // LATER (it is only eager when the queue is empty), so the manual "Check
  // now" path sometimes read an empty list and returned before polling —
  // exactly the "unresponsive" the operator reported (2026-09-05). A ref is
  // always current.
  const swapsRef = useRef<SidecarTrackedSwap[]>([]);
  useEffect(() => {
    swapsRef.current = swaps;
  }, [swaps]);
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [transport, setTransport] = useState<SidecarTransport>("poll");
  const [nonce, setNonce] = useState(0);
  const [checking, setChecking] = useState(false);
  /** Announce a rehydrated swap once per session, not on every refresh. */
  const rehydratedOnce = useRef(false);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // ── the bid janitor's doorbell (2026-09-04) ──────────────────────────
  // The supervisor settles or re-queues bids the engine parked in Error on
  // its own schedule (`swap_bid.rs::spawn_bid_janitor`). When it did
  // something, re-read: a row this screen shows as "Error" may now be
  // "Completed", and leaving it asserting the old state until the next
  // 15-second poll is exactly the "why is my old error swap still active"
  // experience this exists to end. `listen` rejects without a Tauri runtime
  // (the browser-only sandbox); that is not an error, just no doorbell.
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<JanitorReport>(JANITOR_EVENT, (event) => {
      const r = event.payload;
      if (!r) return;
      if (r.settled.length || r.requeued.length) refresh();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* no event bus (browser sandbox) — polling still covers it */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, refresh]);

  // ── rehydrate: swaps this node already sent, in flight from a past run ──
  useEffect(() => {
    if (!enabled) {
      setSwaps([]);
      rehydratedOnce.current = false;
      return;
    }
    let cancelled = false;
    // REPEATING, not once. The one-shot version asked at mount, and on a cold
    // start the node is not up for a minute or two — longer since the autostart
    // readiness gate waits for the host wallets on purpose. It threw, returned,
    // and nothing re-armed it: after a restart the upstream console showed a
    // swap in progress and this tab showed nothing (operator, 2026-09-05).
    //
    // `/json/active` rather than `sentbids?with_available_or_active`: it is the
    // same source the console's own "Swaps in Progress" table renders, it
    // carries BOTH roles, and it takes no filter argument to get wrong.
    const sync = async () => {
      let rows: Awaited<ReturnType<typeof fetchActiveSwaps>>;
      try {
        // `enabled` is the caller's gate; this is the module's own. This is the
        // one path that fires with no user action at all, so it is the one most
        // worth not letting slip past the opt-in contract.
        await assertOptedIn();
        rows = await fetchActiveSwaps();
      } catch {
        // The node is very often not running yet. An ordinary state, and the
        // reason this repeats instead of giving up.
        return;
      }
      if (cancelled || isApiError(rows) || !Array.isArray(rows)) return;
      const fromNode = rows.map(activeSwapToTracked);
      if (fromNode.length === 0) return;
      setSwaps((prev) => mergeActiveSwaps(prev, fromNode));
      // A swap that was mid-flight when the app closed is holding funds in a
      // joint lock with a timelock running. Finding that out only if the user
      // happens to open the Swap tab is not acceptable — but say it ONCE, or
      // every sync would yank the tracker open over whatever they are doing.
      if (!rehydratedOnce.current) {
        rehydratedOnce.current = true;
        setTrackedId((cur) => cur ?? fromNode[0].bidId);
        setTrackerOpen(true);
      }
    };
    void sync();
    const handle = setInterval(() => void sync(), ACTIVE_SYNC_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [enabled, nonce]);

  // ── poll every non-terminal swap ──────────────────────────────────────
  const pollIds = useCallback(async (ids: string[]) => {
    for (const bidId of ids) {
      try {
        const rv = await fetchBid(bidId);
        if (isApiError(rv)) {
          setSwaps((prev) =>
            prev.map((s) =>
              s.bidId === bidId ? { ...s, error: rv.error } : s,
            ),
          );
          continue;
        }
        setSwaps((prev) =>
          prev.map((s) => {
            if (s.bidId !== bidId) return s;
            // `bid_state_ind` is preferred over `bid_state`: the string is
            // upstream display text and can be reworded in any release, the
            // int is the protocol value.
            const next = classifyBidState(rv.bid_state_ind ?? rv.bid_state);
            // SWAP_DELAYING is not a place in the protocol — it is the engine
            // pausing before its NEXT action, from wherever it was. Its stage
            // is "internal" (no label), and rendering that emptied the
            // tracker's "current step" mid-finalise while the console said
            // "Delaying" (2026-09-05). Keep the stage the swap was in; the
            // detail (`state_description`, the event log) still updates.
            const stage =
              next.state === "SWAP_DELAYING" && s.stage.surface ? s.stage : next;
            return {
              ...s,
              detail: rv,
              stage,
              lastPolledAt: Date.now(),
              error: null,
            };
          }),
        );
      } catch (e) {
        const message = String((e as { message?: unknown })?.message ?? e);
        setSwaps((prev) =>
          prev.map((s) => (s.bidId === bidId ? { ...s, error: message } : s)),
        );
      }
    }
  }, []);

  const pollAll = useCallback(async () => {
    const ids = swapsRef.current
      .filter((s) => !s.stage.terminal)
      .map((s) => s.bidId);
    if (ids.length === 0) return;
    // Visible to the tracker: "Check now" looked unresponsive because a
    // sub-second poll changed nothing on screen but a timestamp (2026-09-05).
    // Held for a minimum beat — a loopback poll can finish inside one React
    // batch, in which case true→false never paints and the button still
    // looks dead. Sixty-fold shorter than the poll interval; long enough to
    // be seen.
    const startedAt = Date.now();
    setChecking(true);
    try {
      await pollIds(ids);
    } finally {
      const remaining = CHECKING_MIN_VISIBLE_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((res) => setTimeout(res, remaining));
      setChecking(false);
    }
  }, [pollIds]);


  const hasLive = useMemo(
    () => swaps.some((s) => !s.stage.terminal),
    [swaps],
  );

  useEffect(() => {
    if (!enabled || !hasLive) return;
    void pollAll();
    const handle = setInterval(() => void pollAll(), POLL_MS);
    return () => clearInterval(handle);
  }, [enabled, hasLive, pollAll, nonce]);

  // ── websocket doorbell ────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !hasLive) return;
    if (typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let closed = false;
    void (async () => {
      let wsPort: number;
      try {
        wsPort = (await swapSidecarStatus()).wsPort;
      } catch {
        return; // stay on poll; nothing to report
      }
      if (closed || !wsPort) return;
      try {
        socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      } catch {
        return;
      }
      socket.onopen = () => setTransport("websocket");
      // The frame is not parsed on purpose — see the hook's header. Any frame
      // means "something changed", and the poll is what reads it.
      socket.onmessage = () => void pollAll();
      socket.onerror = () => setTransport("poll");
      socket.onclose = () => setTransport("poll");
    })();
    return () => {
      closed = true;
      setTransport("poll");
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
    };
  }, [enabled, hasLive, pollAll]);

  const adopt = useCallback((handle: SidecarSwapHandle) => {
    setSwaps((prev) => [
      {
        ...handle,
        detail: null,
        // A bid that was just accepted by the node is, by definition, sent.
        stage: classifyBidState("BID_SENT"),
        lastPolledAt: null,
        error: null,
      },
      ...prev.filter((p) => p.bidId !== handle.bidId),
    ]);
    setTrackedId(handle.bidId);
    setTrackerOpen(true);
  }, []);

  // ── a bid nobody answered: cool the maker, then re-bid if it is free ──
  //
  // In the HOOK rather than in `SidecarSwapTracker`, deliberately. The tracker
  // renders only while its modal is mounted; this has to happen whether the
  // user is on the Swap tab, the Mine tab, or has the window minimised — which
  // is exactly when a bid quietly expires.
  const retriedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    // `cancelled` is BID_EXPIRED / BID_ABANDONED — the swap ended BEFORE any
    // funds were committed. A swap that stalled with coins locked is a
    // different stage and is never touched here: there is nothing to re-bid,
    // the protocol's own timelock is what resolves it.
    const dead = swaps.filter(
      (s) => s.stage.stage === "cancelled" && !retriedRef.current.has(s.bidId),
    );
    if (dead.length === 0) return;
    for (const swap of dead) {
      retriedRef.current.add(swap.bidId);
      coolDown(
        { offerId: swap.offerId, makerAddress: swap.detail?.addr_from ?? null },
        COOLDOWN_REASON_EXPIRED,
      );
      void attemptAutoRetry(swap);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, swaps]);

  /**
   * Re-bid the same pair and amount against a different maker, automatically,
   * but ONLY where the spread gate would not have asked the user anything —
   * see `shouldAutoRetry`. Every refusal is logged with its reason; silence
   * would be indistinguishable from the feature not existing.
   */
  const attemptAutoRetry = useCallback(async (dead: SidecarTrackedSwap) => {
    const attempt = (dead.retryAttempt ?? 0) + 1;
    const origin = dead.retryOf ?? dead.bidId;
    const payout = dead.payoutAddress;
    if (!payout) {
      console.warn(
        "[useSidecarSwap] auto-retry skipped: no payout address on this swap " +
          "(it was rehydrated from the node, which does not carry one)",
      );
      return;
    }
    let quote: SidecarQuote;
    try {
      quote = await fetchSidecarQuote({
        from: dead.sendCoin,
        to: dead.receiveCoin,
        amount: dead.sendAmount,
      });
    } catch (e) {
      console.warn(`[useSidecarSwap] auto-retry: no replacement quote — ${String((e as { message?: unknown })?.message ?? e)}`);
      return;
    }
    const decision = shouldAutoRetry({
      spread: quote.spread,
      offer: {
        offerId: quote.offer.offerId,
        tradable: quote.offer.tradable,
        isExpired: quote.offer.isExpired,
        isOwnOffer: quote.offer.isOwnOffer,
        makerAddress: quote.offer.raw?.addr_from ?? null,
      },
      cooldowns: loadCooldowns(),
      nowMs: Date.now(),
      sendAmount: quote.sendAmount,
      approvedSendAmount: Number(dead.sendAmount),
      attemptsSoFar: attempt - 1,
    });
    if (!decision.proceed) {
      console.warn(`[useSidecarSwap] auto-retry declined: ${decision.reason}`);
      return;
    }
    const result = await submitSidecarBid({ quote, addrTo: payout });
    if (!result.ok) {
      console.warn(`[useSidecarSwap] auto-retry bid refused: ${result.message}`);
      return;
    }
    console.warn(
      `[useSidecarSwap] auto-retry ${attempt}/${AUTO_RETRY_MAX_ATTEMPTS}: re-bid ` +
        `${dead.sendAmount} ${dead.sendCoin} against a different maker (${decision.reason})`,
    );
    adopt({
      bidId: result.bidId,
      offerId: quote.offer.offerId,
      sendCoin: quote.offer.sendCoin,
      receiveCoin: quote.offer.receiveCoin,
      sendAmount: formatAmount(quote.sendAmount, quote.sendDecimals),
      receiveAmount: formatAmount(quote.receiveAmount, quote.receiveDecimals),
      createdAt: Math.floor(Date.now() / 1000),
      payoutAddress: payout,
      retryOf: origin,
      retryAttempt: attempt,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTracker = useCallback((bidId: string) => {
    setTrackedId(bidId);
    setTrackerOpen(true);
  }, []);

  const closeTracker = useCallback(() => setTrackerOpen(false), []);

  const tracked = useMemo(
    () => swaps.find((s) => s.bidId === trackedId) ?? null,
    [swaps, trackedId],
  );

  return {
    swaps,
    tracked,
    trackerOpen,
    transport,
    checking,
    adopt,
    openTracker,
    closeTracker,
    refresh,
  };
}

// =========================================================================
// Display helpers shared by the confirm modal and the tracker
// =========================================================================

/**
 * "You send X A and receive Y B." — the one-line summary, built from the
 * snapped amounts so the sentence can never disagree with what gets submitted.
 */
export function sidecarSwapSentence(quote: SidecarQuote): string {
  return (
    `You send ${formatAmount(quote.sendAmount, quote.sendDecimals)} ${quote.offer.sendCoin} ` +
    `and receive ${formatAmount(quote.receiveAmount, quote.receiveDecimals)} ${quote.offer.receiveCoin}.`
  );
}

/**
 * How many other offers sit behind the chosen one, and the price gap to the
 * next. This is the honest substitute for a taker feed: it is derived only
 * from offers the node already published to us, and it says nothing about
 * other users' demand or activity.
 */
export function sidecarBookDepth(quote: SidecarQuote): {
  total: number;
  nextRate: number | null;
} {
  const others = quote.rankedOffers.filter(
    (o) => o.offerId !== quote.offer.offerId,
  );
  return {
    total: quote.rankedOffers.length,
    nextRate: others[0]?.effectiveRate ?? null,
  };
}
