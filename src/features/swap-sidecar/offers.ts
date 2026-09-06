/**
 * Offer normalisation, price-only ranking, and the pre-submit validation
 * mirror for the BasicSwap route.
 *
 * ## The rate-representation gotcha, resolved once
 *
 * A BasicSwap offer is written from the **offerer's** point of view: they send
 * `coin_from` and want `coin_to`. Everything a *taker* sees is therefore
 * mirrored, and upstream's own bid form is the proof — it labels `coin_to`
 * "Sending" and `coin_from` "Receiving" (`templates/offer.html`). So:
 *
 * ```
 *   offer.coin_to      →  the coin YOU SEND
 *   offer.coin_from    →  the coin YOU RECEIVE
 *   offer.amount_to    →  what a full fill COSTS you
 *   offer.amount_from  →  what a full fill PAYS you
 *   offer.rate         →  coin_to per 1 coin_from  =  YOUR PRICE (lower is better)
 *   offer.min_bid_amount → denominated in coin_from, i.e. the RECEIVE leg
 * ```
 *
 * Read `rate` as "what I get per unit sent" and every number on screen is
 * inverted — that is the trap this module exists to close. {@link toTakerOffer}
 * does the mirroring once, at the edge; nothing downstream should touch a raw
 * `BasicSwapOffer` again.
 *
 * Separately there is `bid_reversed`, which is a *different* thing and is
 * easily confused with the mirroring above: for an `XMR_SWAP` whose `coin_from`
 * is scriptless (XMR and friends), the on-chain ROLES swap — the scripted
 * "leader" leg becomes `coin_to`. That changes which chain carries the lock and
 * the fee, not which coin the taker sends. The offers payload does not include
 * it, so {@link deriveBidReversed} reproduces upstream's `is_reverse_ads_bid`.
 *
 * ## Ranking is price-only, and that is a compliance constraint
 *
 * {@link rankOffers} sorts by effective rate and breaks ties on offer id. There
 * is no maker-identity input to this function and there must never be one:
 * affiliated liquidity gets no routing preference, ever
 * (`CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` §2, the "vacuum" test). If a future
 * change wants to weight offers by anything other than the price and terms the
 * user is actually getting, that is the thing to escalate, not to implement.
 *
 * There is also no taker feed to rank against: bids are point-to-point
 * encrypted and **no endpoint exposes other users' bids or swaps**. Nothing
 * here computes fill rates, demand or popularity, because the data does not
 * exist.
 */

import type { BasicSwapCoin, BasicSwapOffer } from "../../api/basicswap";
import {
  DEFAULT_COIN_DECIMALS,
  decimalsForCoin,
  formatAmount,
  normalizeCoinKey,
  parseAmount,
  tickerForCoin,
} from "./types";

// =========================================================================
// Constants
// =========================================================================

/** `SwapTypes.XMR_SWAP` — the adaptor-signature protocol every XMR pair uses. */
export const SWAP_TYPE_XMR = 5;

/**
 * The rate a bid is allowed to differ from the offer's rate, as a fraction.
 * 0.01% — upstream rejects anything wider, so a UI that lets the user submit
 * outside it is a guaranteed round-trip failure.
 */
export const RATE_TOLERANCE_FRACTION = 0.0001;

/**
 * The protocol floor: **both legs of a swap must exceed 0.001 of their own
 * coin**, per upstream's per-chain `min_amount` (`chainparams`: XMR
 * `1000000000` at 12dp, LTC `100000` at 8dp — both exactly 0.001).
 *
 * The consequence users hit is that the *binding* leg is the more valuable
 * coin: 0.001 XMR is worth far more than 0.001 LTC, so on XMR/LTC the XMR side
 * sets the real floor for both. {@link protocolFloorForPair} computes it.
 */
export const PROTOCOL_MIN_COIN_AMOUNT = 0.001;

/**
 * Coins whose `coin_from` position makes an XMR_SWAP a "reverse ads bid"
 * upstream (`scriptless_coins + coins_without_segwit`), keyed by
 * {@link normalizeCoinKey} of both name and ticker. ZEPH is included ahead of
 * its own interface landing — it is a Monero fork and will be scriptless.
 */
const REVERSED_COIN_KEYS: ReadonlySet<string> = new Set([
  "XMR",
  "MONERO",
  "WOW",
  "WOWNERO",
  "PARTANON",
  "PARTICLANON",
  "FIRO",
  "DOGE",
  "DOGECOIN",
  "PIVX",
  "DASH",
  "ZEPH",
  "ZEPHYR",
]);

// =========================================================================
// Taker view of an offer
// =========================================================================

export interface TakerOffer {
  offerId: string;
  /** The coin the user SENDS (`offer.coin_to`), as the node names it. */
  sendCoin: string;
  /** The coin the user RECEIVES (`offer.coin_from`). */
  receiveCoin: string;
  /** Largest amount of the receive coin this offer can pay (`amount_from`). */
  maxReceive: number;
  /** What a full fill costs, in send-coin units (`amount_to`). */
  maxSend: number;
  /** Smallest receive-leg amount the maker will accept (`min_bid_amount`). */
  minReceive: number;
  /** Send-coin per 1 receive-coin. **LOWER IS BETTER** — this is the price. */
  effectiveRate: number;
  /** Receive-coin per 1 send-coin. The reciprocal, for "you get X" displays. */
  receivePerSend: number;
  amountNegotiable: boolean;
  rateNegotiable: boolean;
  isExpired: boolean;
  isOwnOffer: boolean;
  isRevoked: boolean;
  /** Whether a taker could actually bid on it right now. */
  tradable: boolean;
  /** Derived — see {@link deriveBidReversed}. Affects the legs, not the direction. */
  bidReversed: boolean;
  createdAt: number;
  expireAt: number;
  raw: BasicSwapOffer;
}

/**
 * Upstream's `is_reverse_ads_bid`, reproduced because the offers payload does
 * not carry `bid_reversed`.
 *
 * True when the swap is an `XMR_SWAP` **and** `coin_from` is one of the
 * scriptless / no-segwit coins. When true the scripted leg — the one that
 * carries the lock, the fee estimate and the pre-signed refund — is `coin_to`
 * rather than `coin_from`.
 */
export function deriveBidReversed(offer: {
  swap_type?: number;
  coin_from: string;
}): boolean {
  if (offer.swap_type !== SWAP_TYPE_XMR) return false;
  return REVERSED_COIN_KEYS.has(normalizeCoinKey(offer.coin_from));
}

/**
 * The smallest RECEIVE-leg amount this one offer will actually fill.
 *
 * Not simply `min_bid_amount`. Upstream's `validateBidAmount` runs three
 * checks, and the third overrides the first two:
 *
 * ```python
 * ensure(bid_amount >= offer.min_bid_amount, "Bid amount below minimum")
 * ensure(bid_amount <= offer.amount_from,    "Bid amount above offer amount")
 * if not offer.amount_negotiable:
 *     ensure(offer.amount_from == bid_amount, "Bid amount must match offer amount.")
 * ```
 *
 * So on an all-or-nothing offer the ONLY fillable amount is the whole thing,
 * whatever `min_bid_amount` says — and such offers do carry a small, misleading
 * `min_bid_amount`. The live BCH→XMR offer on 2026-09-05 advertised
 * `min_bid_amount: 0.001 XMR` against `amount_from: 1.5 XMR` with
 * `amount_negotiable: null`; MIN read the 0.001, filled the field with
 * 0.00215796 BCH, and the take path then found nothing to fill — "the swap
 * button wouldn't display or work" while the console plainly listed the offer.
 *
 * `floorReceive` is the protocol/dust floor for the pair, applied only where a
 * partial fill is allowed at all.
 */
export function minFillableReceive(
  offer: Pick<TakerOffer, "amountNegotiable" | "minReceive" | "maxReceive">,
  floorReceive = 0,
): number {
  if (!offer.amountNegotiable) return offer.maxReceive;
  return Math.min(offer.maxReceive, Math.max(offer.minReceive, floorReceive));
}

/**
 * Mirror one offer into the taker's frame. Returns `null` when the payload
 * cannot be read as a tradable quantity — a half-parsed offer priced at `NaN`
 * would sort to the front of the book, so it is dropped rather than defaulted.
 */
export function toTakerOffer(
  offer: BasicSwapOffer,
  coins?: readonly BasicSwapCoin[] | null,
): TakerOffer | null {
  const maxReceive = parseAmount(offer.amount_from);
  const maxSend = parseAmount(offer.amount_to);
  const minReceive = parseAmount(offer.min_bid_amount);
  const quotedRate = parseAmount(offer.rate);

  if (maxReceive == null || maxReceive <= 0) return null;

  // `rate` is authoritative; the amounts are the fallback when a node omits or
  // mangles it. They should agree — `amount_to = amount_from * rate` — and
  // when they don't, the quoted rate is what the maker will actually enforce.
  let effectiveRate: number | null = quotedRate != null && quotedRate > 0 ? quotedRate : null;
  if (effectiveRate == null && maxSend != null && maxSend > 0) {
    effectiveRate = maxSend / maxReceive;
  }
  if (effectiveRate == null || !Number.isFinite(effectiveRate) || effectiveRate <= 0) {
    return null;
  }

  const sendDecimals = decimalsForCoin(offer.coin_to, coins);
  const resolvedMaxSend =
    maxSend != null && maxSend > 0
      ? maxSend
      : ceilTo(maxReceive * effectiveRate, sendDecimals);

  const isExpired = offer.is_expired === true;
  const isOwnOffer = offer.is_own_offer === true;
  const isRevoked = offer.is_revoked === true;

  return {
    offerId: offer.offer_id,
    sendCoin: offer.coin_to,
    receiveCoin: offer.coin_from,
    maxReceive,
    maxSend: resolvedMaxSend,
    minReceive: minReceive != null && minReceive > 0 ? minReceive : 0,
    effectiveRate,
    receivePerSend: 1 / effectiveRate,
    amountNegotiable: offer.amount_negotiable === true,
    rateNegotiable: offer.rate_negotiable === true,
    isExpired,
    isOwnOffer,
    isRevoked,
    tradable: !isExpired && !isOwnOffer && !isRevoked,
    bidReversed: deriveBidReversed(offer),
    createdAt: offer.created_at,
    expireAt: offer.expire_at,
    raw: offer,
  };
}

/** Mirror a page of offers, silently dropping unreadable ones. */
export function toTakerOffers(
  offers: readonly BasicSwapOffer[],
  coins?: readonly BasicSwapCoin[] | null,
): TakerOffer[] {
  const out: TakerOffer[] = [];
  for (const o of offers) {
    const t = toTakerOffer(o, coins);
    if (t) out.push(t);
  }
  return out;
}

export interface DirectionFilter {
  /**
   * The coin the user wants to send. Accepts either upstream's display name
   * (`"Monero"`) or a ticker (`"XMR"`) — the wallet side of the app speaks
   * tickers while the offers payload speaks names, and forcing every caller to
   * translate first is how a filter silently matches nothing.
   */
  sendCoin: string;
  /** The coin the user wants to receive. Same name-or-ticker latitude. */
  receiveCoin: string;
  /** Default false — an expired offer cannot be bid on. */
  includeExpired?: boolean;
  /** Default false — you cannot bid on your own offer. */
  includeOwn?: boolean;
  /** Default false. */
  includeRevoked?: boolean;
  /** The live `/json/coins` table, when loaded. Improves name↔ticker resolution. */
  coins?: readonly BasicSwapCoin[] | null;
}

/** Whether two coin spellings name the same coin. */
function sameCoin(
  a: string,
  b: string,
  coins?: readonly BasicSwapCoin[] | null,
): boolean {
  if (normalizeCoinKey(a) === normalizeCoinKey(b)) return true;
  const ta = tickerForCoin(a, coins);
  const tb = tickerForCoin(b, coins);
  return ta != null && tb != null && ta === tb;
}

/**
 * Offers a user *in this direction* can actually take.
 *
 * The book also holds offers in the opposite orientation (someone selling the
 * coin you want to buy). Those are not "worse prices" — they are not takeable
 * at all from this side, because a bid only ever runs in the offer's own
 * direction. Filtering them out is correctness, not curation.
 */
export function filterOffersForDirection(
  offers: readonly TakerOffer[],
  filter: DirectionFilter,
): TakerOffer[] {
  return offers.filter((o) => {
    if (!sameCoin(o.sendCoin, filter.sendCoin, filter.coins)) return false;
    if (!sameCoin(o.receiveCoin, filter.receiveCoin, filter.coins)) return false;
    if (!filter.includeExpired && o.isExpired) return false;
    if (!filter.includeOwn && o.isOwnOffer) return false;
    if (!filter.includeRevoked && o.isRevoked) return false;
    return true;
  });
}

/**
 * **PRICE-ONLY RANKING.** Ascending effective rate (send per receive), ties
 * broken on offer id so the order is stable across refreshes.
 *
 * The tiebreak is deliberately an opaque protocol id and not, say, "newest
 * first" or "largest first" — anything correlated with who published the offer
 * is a routing preference wearing a different hat. Returns a new array.
 */
export function rankOffers(offers: readonly TakerOffer[]): TakerOffer[] {
  return [...offers].sort((a, b) => {
    if (a.effectiveRate !== b.effectiveRate) {
      return a.effectiveRate - b.effectiveRate;
    }
    return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
  });
}

/** The best-priced tradable offer, or `null` when the book has none. */
export function bestOffer(offers: readonly TakerOffer[]): TakerOffer | null {
  const ranked = rankOffers(offers.filter((o) => o.tradable));
  return ranked[0] ?? null;
}

// =========================================================================
// Amount arithmetic
// =========================================================================

/**
 * Round DOWN to a coin's precision.
 *
 * Partial fills always snap down — never up — because rounding a partial fill
 * *up* asks for more than the maker offered and the bid is rejected. Returns
 * the input unchanged when the scaled value would leave IEEE-754 safe integer
 * range, since silently mangling a huge amount is worse than not snapping it.
 */
export function snapDown(amount: number, decimals: number): number {
  if (!Number.isFinite(amount)) return 0;
  const d = clampDecimals(decimals);
  const factor = Math.pow(10, d);
  const scaled = amount * factor;
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    return amount;
  }
  // `1.23 * 100` is `122.99999999999999`; a bare floor would drop a whole unit
  // of the last decimal place. Nudge by a few ULPs first — a *fixed* relative
  // epsilon (1e-9 was the first attempt) is far larger than one unit once the
  // scaled value passes ~1e9, which would snap a 12dp amount down by a whole
  // atomic unit or more.
  return Math.floor(scaled + ulpEpsilon(scaled)) / factor;
}

/** Round UP to a coin's precision. Used for costs and floors, never for fills. */
export function ceilTo(amount: number, decimals: number): number {
  if (!Number.isFinite(amount)) return 0;
  const d = clampDecimals(decimals);
  const factor = Math.pow(10, d);
  const scaled = amount * factor;
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    return amount;
  }
  return Math.ceil(scaled - ulpEpsilon(scaled)) / factor;
}

/**
 * A few ULPs at the given magnitude — big enough to absorb the representation
 * error of `x * 10^d`, small enough never to cross a real boundary.
 */
function ulpEpsilon(scaled: number): number {
  return Math.max(Math.abs(scaled) * Number.EPSILON * 8, Number.EPSILON);
}

function clampDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return DEFAULT_COIN_DECIMALS;
  return Math.max(0, Math.min(18, Math.trunc(decimals)));
}

/**
 * What the user must send for a given receive amount, rounded UP to the send
 * coin's precision — matching upstream's own ceiling
 * (`(amount * rate + COIN - 1) // COIN`, `js_server.py`).
 */
export function computeSendAmount(
  receiveAmount: number,
  rate: number,
  sendDecimals: number,
): number {
  if (!Number.isFinite(receiveAmount) || !Number.isFinite(rate)) return 0;
  return ceilTo(receiveAmount * rate, sendDecimals);
}

/** Whether an achieved rate is inside {@link RATE_TOLERANCE_FRACTION} of the offer's. */
export function rateWithinTolerance(
  offerRate: number,
  achievedRate: number,
  tolerance: number = RATE_TOLERANCE_FRACTION,
): boolean {
  if (!Number.isFinite(offerRate) || offerRate <= 0) return false;
  if (!Number.isFinite(achievedRate) || achievedRate <= 0) return false;
  return Math.abs(achievedRate - offerRate) / offerRate <= tolerance;
}

// =========================================================================
// Protocol minimum
// =========================================================================

export interface PairFloor {
  sendCoin: string;
  receiveCoin: string;
  /** Smallest legal receive-leg amount, in receive-coin units. */
  receiveFloor: number;
  /** What that costs, in send-coin units. */
  sendFloor: number;
  /** Which leg set the floor. `null` when it could not be decided. */
  binding: "send" | "receive" | null;
  /** The coin named by `binding`. */
  bindingCoin: string | null;
  /**
   * True when the rate was unusable, so the *other* leg's contribution could
   * not be converted. The returned floors are then each coin's own 0.001 and
   * the real (larger) floor is unknown — say so, do not present it as final.
   */
  cannotJudge: boolean;
  /** Plain sentence naming the real floor for this pair. */
  sentence: string;
}

/**
 * The real minimum for a chosen pair.
 *
 * Both legs must clear 0.001 of their own coin, so the floor on the receive leg
 * is `max(0.001_receive, 0.001_send / rate)`. Whichever term wins is the
 * *binding* leg — and because `rate` is send-per-receive, that is always the
 * more valuable coin, which is why a user trying to swap "0.001 of something"
 * gets refused with a number they did not expect.
 */
export function protocolFloorForPair(args: {
  sendCoin: string;
  receiveCoin: string;
  /** Send-coin per 1 receive-coin — a `TakerOffer.effectiveRate`. */
  rate: number | null | undefined;
  sendMinimum?: number;
  receiveMinimum?: number;
  sendDecimals?: number;
  receiveDecimals?: number;
  coins?: readonly BasicSwapCoin[] | null;
}): PairFloor {
  const sendMin = args.sendMinimum ?? PROTOCOL_MIN_COIN_AMOUNT;
  const receiveMin = args.receiveMinimum ?? PROTOCOL_MIN_COIN_AMOUNT;
  const sendDecimals =
    args.sendDecimals ?? decimalsForCoin(args.sendCoin, args.coins);
  const receiveDecimals =
    args.receiveDecimals ?? decimalsForCoin(args.receiveCoin, args.coins);
  const rate = args.rate;

  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    const receiveFloor = ceilTo(receiveMin, receiveDecimals);
    return {
      sendCoin: args.sendCoin,
      receiveCoin: args.receiveCoin,
      receiveFloor,
      sendFloor: ceilTo(sendMin, sendDecimals),
      binding: null,
      bindingCoin: null,
      cannotJudge: true,
      sentence:
        `Each side of a swap must be at least ${formatAmount(receiveMin, receiveDecimals)} of its own coin. ` +
        `Without a price for this pair the wallet cannot work out which side sets the real minimum.`,
    };
  }

  const floorFromReceiveLeg = receiveMin;
  const floorFromSendLeg = sendMin / rate;
  const bindingIsSend = floorFromSendLeg > floorFromReceiveLeg;
  const receiveFloor = ceilTo(
    Math.max(floorFromReceiveLeg, floorFromSendLeg),
    receiveDecimals,
  );
  const sendFloor = ceilTo(receiveFloor * rate, sendDecimals);

  return {
    sendCoin: args.sendCoin,
    receiveCoin: args.receiveCoin,
    receiveFloor,
    sendFloor,
    binding: bindingIsSend ? "send" : "receive",
    bindingCoin: bindingIsSend ? args.sendCoin : args.receiveCoin,
    cannotJudge: false,
    sentence:
      `The smallest swap on this pair is ${formatAmount(sendFloor, sendDecimals)} ${args.sendCoin} ` +
      `for ${formatAmount(receiveFloor, receiveDecimals)} ${args.receiveCoin}. ` +
      `Both sides of an atomic swap have to be at least ${formatAmount(receiveMin, receiveDecimals)} of their own coin, ` +
      `and here the ${bindingIsSend ? args.sendCoin : args.receiveCoin} side is the one that binds.`,
  };
}

// =========================================================================
// Pre-submit validation mirror
// =========================================================================

export type BidValidationCode =
  | "ok"
  | "offer-unavailable"
  | "invalid-amount"
  | "not-negotiable-must-be-exact"
  | "below-offer-minimum"
  | "below-protocol-minimum"
  | "above-offer-maximum"
  | "rate-mismatch";

export interface BidValidation {
  ok: boolean;
  code: BidValidationCode;
  /** Plain sentence, safe to render directly under the amount field. */
  message: string;
  /** The receive amount that would actually be submitted — always snapped DOWN. */
  receiveAmount: number;
  /** What that costs, rounded up to the send coin's precision. */
  sendAmount: number;
  /** True when snapping changed the user's number. Never display the unsnapped one. */
  snapped: boolean;
  /** The floor for this pair, for the UI to show alongside. */
  floor: PairFloor;
}

export interface BidValidationOptions {
  receiveDecimals?: number;
  sendDecimals?: number;
  rateTolerance?: number;
  protocolMinimum?: number;
  coins?: readonly BasicSwapCoin[] | null;
}

/**
 * Mirror the server's bid rules locally so the user gets an answer while
 * typing instead of after a round trip.
 *
 * The rules, in the order they are checked:
 *
 * 1. the offer has to be takeable at all (not expired / revoked / your own);
 * 2. the amount snaps DOWN to the receive coin's precision — the snapped value
 *    is the only one that may ever be displayed;
 * 3. `amount_negotiable == false` means **exact fill only**: the sole legal
 *    amount is the offer's full size;
 * 4. the amount clears `max(min_bid_amount, protocol floor)` and does not
 *    exceed `amount_from`;
 * 5. the achieved rate stays inside {@link RATE_TOLERANCE_FRACTION} of the
 *    offer's rate.
 *
 * This is a *mirror*, never an authority. The node re-checks everything, and
 * where the two disagree the node is right.
 */
export function validateBid(
  offer: TakerOffer,
  desiredReceive: number,
  options: BidValidationOptions = {},
): BidValidation {
  const receiveDecimals =
    options.receiveDecimals ?? decimalsForCoin(offer.receiveCoin, options.coins);
  const sendDecimals =
    options.sendDecimals ?? decimalsForCoin(offer.sendCoin, options.coins);
  const protocolMinimum = options.protocolMinimum ?? PROTOCOL_MIN_COIN_AMOUNT;
  const tolerance = options.rateTolerance ?? RATE_TOLERANCE_FRACTION;

  const floor = protocolFloorForPair({
    sendCoin: offer.sendCoin,
    receiveCoin: offer.receiveCoin,
    rate: offer.effectiveRate,
    sendMinimum: protocolMinimum,
    receiveMinimum: protocolMinimum,
    sendDecimals,
    receiveDecimals,
    coins: options.coins,
  });

  const result = (
    code: BidValidationCode,
    message: string,
    receiveAmount: number,
    snapped: boolean,
  ): BidValidation => ({
    ok: code === "ok",
    code,
    message,
    receiveAmount,
    sendAmount: computeSendAmount(receiveAmount, offer.effectiveRate, sendDecimals),
    snapped,
    floor,
  });

  if (!offer.tradable) {
    const why = offer.isExpired
      ? "has expired"
      : offer.isRevoked
        ? "was withdrawn by the other user"
        : "is your own offer";
    return result(
      "offer-unavailable",
      `This offer ${why}, so it cannot be taken. Pick another offer from the book.`,
      0,
      false,
    );
  }

  if (!Number.isFinite(desiredReceive) || desiredReceive <= 0) {
    return result("invalid-amount", "Enter an amount greater than zero.", 0, false);
  }

  const snappedReceive = snapDown(desiredReceive, receiveDecimals);
  const snapped = snappedReceive !== desiredReceive;

  if (snappedReceive <= 0) {
    return result(
      "invalid-amount",
      `That is smaller than the smallest unit of ${offer.receiveCoin} this swap can move.`,
      0,
      snapped,
    );
  }

  if (!offer.amountNegotiable) {
    const exact = snapDown(offer.maxReceive, receiveDecimals);
    if (snappedReceive !== exact) {
      return result(
        "not-negotiable-must-be-exact",
        `This offer is all-or-nothing: the only amount it will fill is ` +
          `${formatAmount(exact, receiveDecimals)} ${offer.receiveCoin} for ` +
          `${formatAmount(computeSendAmount(exact, offer.effectiveRate, sendDecimals), sendDecimals)} ${offer.sendCoin}.`,
        exact,
        snapped,
      );
    }
  }

  if (snappedReceive > offer.maxReceive) {
    return result(
      "above-offer-maximum",
      `This offer only has ${formatAmount(offer.maxReceive, receiveDecimals)} ${offer.receiveCoin} available.`,
      snappedReceive,
      snapped,
    );
  }

  // Report whichever floor actually binds — telling someone to raise to the
  // protocol minimum when the maker's own minimum is higher just fails twice.
  const bindingMin = Math.max(offer.minReceive, floor.receiveFloor);
  if (snappedReceive < bindingMin) {
    const makerBinds = offer.minReceive >= floor.receiveFloor;
    return makerBinds
      ? result(
          "below-offer-minimum",
          `This offer will not fill less than ${formatAmount(offer.minReceive, receiveDecimals)} ${offer.receiveCoin}.`,
          snappedReceive,
          snapped,
        )
      : result("below-protocol-minimum", floor.sentence, snappedReceive, snapped);
  }

  const sendAmount = computeSendAmount(
    snappedReceive,
    offer.effectiveRate,
    sendDecimals,
  );
  const achievedRate = sendAmount / snappedReceive;
  if (!rateWithinTolerance(offer.effectiveRate, achievedRate, tolerance)) {
    return result(
      "rate-mismatch",
      `That amount cannot be priced at this offer's rate. Try a slightly larger amount of ${offer.receiveCoin}.`,
      snappedReceive,
      snapped,
    );
  }

  return result(
    "ok",
    `You send ${formatAmount(sendAmount, sendDecimals)} ${offer.sendCoin} and receive ` +
      `${formatAmount(snappedReceive, receiveDecimals)} ${offer.receiveCoin}. ` +
      `You are swapping with another user on an open network.`,
    snappedReceive,
    snapped,
  );
}

// =========================================================================
// Funding sufficiency (audit 2026-08-22)
// =========================================================================

/**
 * Whether the SWAP NODE can actually fund a bid of this size.
 *
 * The gap this closes, found in the 2026-08-22 audit: nothing in the quote or
 * submit path read any balance at all, and the form's own BAL / 25 / 50 / 75 /
 * MAX affordances read the **wallet's** balance. For a C8/C9-shared coin
 * (BTC/LTC via account key, XMR via the host wallet-rpc) the wallet and the
 * node are the same wallet, so that happened to be right. For DOGE, DASH, BCH
 * — or a deposit-mode LTC — the tradeable balance is the NODE's, and the two
 * are unrelated. A user could review, and now actually submit, a bid the node
 * has no coin to fund; the engine refuses it at lock time, which is a dead end
 * discovered late rather than a refusal offered early.
 *
 * Deliberately NOT a hard block on missing data. A row that never reported a
 * balance (`null`), a coin absent from the table, or a node that failed this
 * one read returns `"unknown"` — the same advisory-degrades-never-blocks rule
 * `spread.ts` follows. Only a balance that is present AND short returns
 * `"short"`. Inventing a refusal from absent data would strand a user whose
 * node is merely slow to answer.
 */
export type FundingVerdict =
  | { state: "ok" }
  | { state: "unknown"; reason: string }
  | { state: "short"; have: number; need: number; message: string };

export function assessBidFunding(args: {
  /** Ticker of the coin the user SENDS — the leg the node must fund. */
  sendTicker: string;
  /** What the bid costs, in send-coin units. */
  sendAmount: number;
  /** The node's own balance rows, keyed by UPPERCASE ticker. */
  rows: Readonly<Record<string, { balance: string | null; locked?: boolean }>>;
  sendDecimals?: number;
}): FundingVerdict {
  const key = args.sendTicker.toUpperCase();
  const row = args.rows[key];
  if (!row) {
    return {
      state: "unknown",
      reason: `The swap node has not reported a ${key} balance yet.`,
    };
  }
  if (row.locked) {
    return {
      state: "unknown",
      reason: `The swap node's ${key} wallet is locked, so its balance cannot be checked.`,
    };
  }
  const have = parseAmount(row.balance);
  if (have == null || !Number.isFinite(have)) {
    return {
      state: "unknown",
      reason: `The swap node did not report a readable ${key} balance.`,
    };
  }
  if (!Number.isFinite(args.sendAmount) || args.sendAmount <= 0) {
    return { state: "unknown", reason: "No amount to check yet." };
  }
  if (have >= args.sendAmount) return { state: "ok" };
  const dp = args.sendDecimals ?? DEFAULT_COIN_DECIMALS;
  return {
    state: "short",
    have,
    need: args.sendAmount,
    message:
      `The swap node holds ${formatAmount(have, dp)} ${key} and this swap needs ` +
      `${formatAmount(args.sendAmount, dp)} ${key}. Deposit to the node's ${key} address, ` +
      `or lower the amount — a bid it cannot fund is refused when the lock is built.`,
  };
}

export type WalletSeedVerdict =
  | { state: "ok" }
  | { state: "not-ready"; coin: string; message: string };

/**
 * Would the engine's own `checkCoinsReady` refuse this bid on
 * `restrict_unknown_seed_wallets` — before ever sending it, not after.
 *
 * Real incident, 2026-08-22: a bid on XMR<->LTC was refused at the node with
 * `'Litecoin has an unexpected wallet seed and "restrict_unknown_seed_wallets"
 * is enabled.'` — verbatim from `checkCoinsReady` (`basicswap.py:1729-1736`),
 * which runs `knownWalletSeed()` on BOTH legs of every bid. Nothing in the UI
 * said so beforehand: the wallet showed a real, positive LTC balance (from
 * pwnda's own adapter) while the ENGINE's own confirmation that its lean/C8
 * wallet was actually built from the pushed account key — `expected_seed` in
 * `/json/wallets`, the same field `knownWalletSeed()` reads — was still
 * `false`. The two reads come from different places and can disagree during
 * the warm-up window between "key pushed" and "engine confirmed it" (see
 * [[wallet-sharing-with-bsx]]), and only the second one is what the engine
 * actually checks before it will build a lock.
 *
 * Checks BOTH legs, matching `checkCoinsReady(coin_from, coin_to)` exactly —
 * the scriptless (XMR) leg is not exempt, even though in practice it settles
 * during C9 setup well before a coin newly joining `DEFAULT_ENABLED_COINS`
 * would.
 */
export function assessWalletSeedReadiness(args: {
  sendTicker: string;
  receiveTicker: string;
  rows: Readonly<Record<string, { expectedSeed?: boolean | null }>>;
}): WalletSeedVerdict {
  for (const ticker of [args.sendTicker, args.receiveTicker]) {
    const key = ticker.toUpperCase();
    const row = args.rows[key];
    if (row && row.expectedSeed === false) {
      return {
        state: "not-ready",
        coin: key,
        message:
          `The swap node hasn't finished confirming its ${key} wallet yet — the engine reports it as an ` +
          `unexpected seed, and will refuse a bid on either leg until that clears. This clears automatically ` +
          `in the background — no action needed. Opening the BasicSwap console below clears it immediately ` +
          `if you don't want to wait.`,
      };
    }
  }
  return { state: "ok" };
}
