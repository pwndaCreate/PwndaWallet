import { describe, expect, it } from "vitest";
import { AUTO_RETRY_MAX_ATTEMPTS, shouldAutoRetry, type AutoRetryInput } from "./autoRetry";
import { withCooldown } from "./offerCooldown";
import type { SpreadAssessment } from "./spread";

const NOW = 1_788_660_000_000;

function spread(over: Partial<SpreadAssessment> = {}): SpreadAssessment {
  return {
    band: "green",
    verified: true,
    spreadPct: 0.4,
    marketRate: 0.1,
    blocked: false,
    sentence: "This swap matches the market rate.",
    ...over,
  } as SpreadAssessment;
}

function input(over: Partial<AutoRetryInput> = {}): AutoRetryInput {
  return {
    spread: spread(),
    offer: {
      offerId: "00000000aaaa",
      tradable: true,
      isExpired: false,
      isOwnOffer: false,
      makerAddress: "PmAnotherMaker111",
    },
    cooldowns: [],
    nowMs: NOW,
    sendAmount: 0.00999999,
    approvedSendAmount: 0.00999999,
    attemptsSoFar: 0,
    ...over,
  };
}

describe("shouldAutoRetry", () => {
  it("proceeds at market, at the amount already approved", () => {
    const d = shouldAutoRetry(input());
    expect(d.proceed).toBe(true);
    expect(d.reason).toMatch(/at market/);
  });

  /**
   * The whole safety argument. Automatic re-bidding is allowed only where the
   * spread gate would not have asked the user anything — amber is a judgement
   * call and red is blocked behind a typed phrase, so neither may be taken on
   * their behalf.
   */
  it("refuses outside the green band", () => {
    for (const band of ["amber", "red"] as const) {
      const d = shouldAutoRetry(input({ spread: spread({ band, blocked: band === "red" }) }));
      expect(d.proceed, band).toBe(false);
      expect(d.reason).toContain(band);
    }
  });

  /**
   * `verified` is a different fact from `band`. An unverifiable spread renders
   * red, but "we could not check the market" must refuse on its own terms —
   * otherwise a price feed outage would read as a bad price, and a future
   * change to how unverified maps onto bands could silently open this path.
   */
  it("refuses when the rate could not be checked at all", () => {
    const d = shouldAutoRetry(input({ spread: spread({ verified: false, spreadPct: null }) }));
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/could not be checked/);
  });

  it("never sends more than the user approved", () => {
    expect(shouldAutoRetry(input({ sendAmount: 0.02, approvedSendAmount: 0.01 })).proceed).toBe(
      false,
    );
    // Less is fine — a thinner book can only cost them less than they agreed.
    expect(shouldAutoRetry(input({ sendAmount: 0.005, approvedSendAmount: 0.01 })).proceed).toBe(
      true,
    );
    expect(shouldAutoRetry(input({ sendAmount: 0, approvedSendAmount: 0.01 })).proceed).toBe(false);
  });

  /**
   * `applyCooldown` declines to empty a non-empty book, so the maker that just
   * went quiet CAN come back as the only quote available. A human may choose
   * to take it; an automatic bid may not.
   */
  it("refuses the maker that just went quiet, even when it is all that is left", () => {
    const cool = withCooldown([], { offerId: "00000000aaaa", makerAddress: "PmAnotherMaker111" }, NOW, "r");
    const d = shouldAutoRetry(input({ cooldowns: cool }));
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/went quiet/);
  });

  it("refuses an offer that is not takeable", () => {
    for (const over of [{ tradable: false }, { isExpired: true }, { isOwnOffer: true }]) {
      const d = shouldAutoRetry(input({ offer: { ...input().offer, ...over } }));
      expect(d.proceed, JSON.stringify(over)).toBe(false);
    }
  });

  it("stops after its budget — three unanswered bids is a book problem", () => {
    expect(shouldAutoRetry(input({ attemptsSoFar: AUTO_RETRY_MAX_ATTEMPTS - 1 })).proceed).toBe(
      true,
    );
    const d = shouldAutoRetry(input({ attemptsSoFar: AUTO_RETRY_MAX_ATTEMPTS }));
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/yours to make/);
  });

  it("always gives a reason, so a refusal is never silent", () => {
    for (const over of [
      {},
      { spread: spread({ band: "red" as const }) },
      { attemptsSoFar: 9 },
      { sendAmount: 99 },
    ]) {
      expect(shouldAutoRetry(input(over)).reason.length).toBeGreaterThan(10);
    }
  });
});
