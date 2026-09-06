import type { SpreadAssessment } from "./spread";
import type { TakerOffer } from "./offers";
import type { CooldownEntry } from "./offerCooldown";
import { isCooledDown } from "./offerCooldown";

/**
 * Re-bidding automatically when a bid expires unanswered.
 *
 * # Why this is allowed to happen without a click
 *
 * A bid that is never accepted commits nothing: it reaches `BID_EXPIRED`, no
 * lock is funded, no coins move. The operator lost an hour to one on
 * 2026-09-05 and asked for the retry to be automatic. The objection to
 * automatic re-bidding is not that a bid is dangerous — it is that the PRICE
 * may have moved while nobody was looking, and the spread gate (green ≤1%,
 * amber ≤5%, red blocked behind a typed phrase) is the check that stands
 * between a user and a bad rate.
 *
 * So the rule is: **automatic only where the gate would not have asked
 * anything of the user anyway.** Green band, market-verified, at or under the
 * amount they already approved. Anything else — amber, red, unverified, a
 * bigger send, a cooled-down maker — stops and waits for a human, which is
 * where the whole book was before this existed.
 *
 * # Every condition is a refusal, and each one is separately falsifiable
 *
 * `shouldAutoRetry` returns a reason on every path, so the tracker can say
 * *why* it did not retry rather than silently doing nothing — the failure
 * mode that made the maker cooldown worth surfacing in the first place.
 */

/** How many automatic re-bids one original bid may produce. */
export const AUTO_RETRY_MAX_ATTEMPTS = 2;

/**
 * Two, and the number is argued rather than picked. One retry covers the
 * ordinary case (a single maker was asleep). A second covers the case the
 * cooldown creates — the next-best maker on a thin book is often the same
 * operator under a different address. Past that, three unanswered bids in a
 * row is not a maker problem, it is a book problem, and quietly working
 * through the order book on the user's behalf is not what they asked for.
 */
export interface AutoRetryInput {
  /** The band assessment for the REPLACEMENT quote, not the original. */
  spread: SpreadAssessment;
  /** The offer the replacement quote would take. */
  offer: Pick<TakerOffer, "offerId" | "tradable" | "isExpired" | "isOwnOffer"> & {
    makerAddress?: string | null;
  };
  /** Live cooldown entries, so a retry cannot pick a maker we just skipped. */
  cooldowns: readonly CooldownEntry[];
  nowMs: number;
  /** What the replacement would send, in send-coin units. */
  sendAmount: number;
  /** What the user approved on the original bid. The ceiling. */
  approvedSendAmount: number;
  /** Automatic re-bids already made for this original bid. */
  attemptsSoFar: number;
}

export interface AutoRetryDecision {
  proceed: boolean;
  /** Always set. Shown to the user when `proceed` is false. */
  reason: string;
}

export function shouldAutoRetry(input: AutoRetryInput): AutoRetryDecision {
  const {
    spread,
    offer,
    cooldowns,
    nowMs,
    sendAmount,
    approvedSendAmount,
    attemptsSoFar,
  } = input;

  if (attemptsSoFar >= AUTO_RETRY_MAX_ATTEMPTS) {
    return {
      proceed: false,
      reason: `already re-bid automatically ${attemptsSoFar} time(s) — the next one is yours to make`,
    };
  }
  if (!offer.tradable || offer.isExpired || offer.isOwnOffer) {
    return { proceed: false, reason: "the replacement offer is not takeable" };
  }
  if (isCooledDown(cooldowns, { offerId: offer.offerId, makerAddress: offer.makerAddress }, nowMs)) {
    // Belt and braces: the quote pool already filters these, but it declines
    // to empty a non-empty book, so a cooled maker CAN come back as the only
    // option — and an automatic bid is exactly the caller that must not take
    // it.
    return { proceed: false, reason: "the only offer left is the maker that just went quiet" };
  }
  if (!(sendAmount > 0) || !(approvedSendAmount > 0)) {
    return { proceed: false, reason: "no comparable amount to re-bid" };
  }
  if (sendAmount > approvedSendAmount) {
    return {
      proceed: false,
      reason: `the replacement would send ${sendAmount}, more than the ${approvedSendAmount} you approved`,
    };
  }
  // The gate, restated as a positive. `verified` is separate from `band` on
  // purpose: an unverifiable spread renders RED, but "we could not check the
  // market" is a different fact from "the price is bad", and neither is a
  // green light.
  if (!spread.verified) {
    return { proceed: false, reason: "the rate could not be checked against a market price" };
  }
  if (spread.band !== "green") {
    return {
      proceed: false,
      reason: `the replacement is in the ${spread.band} band, which is yours to accept`,
    };
  }
  return { proceed: true, reason: "at market, at or under the amount you approved" };
}
