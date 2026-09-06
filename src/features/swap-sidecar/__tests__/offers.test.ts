/**
 * Tests for offer mirroring, price-only ranking, the validation mirror and the
 * per-pair protocol floor.
 *
 * The ranking test is written adversarially on purpose: the offers are ordered
 * so that any tiebreak or weighting other than price would produce a different
 * answer.
 */
import { describe, expect, it } from "vitest";

import type { BasicSwapOffer } from "../../../api/basicswap";
import {
  PROTOCOL_MIN_COIN_AMOUNT,
  RATE_TOLERANCE_FRACTION,
  SWAP_TYPE_XMR,
  bestOffer,
  ceilTo,
  computeSendAmount,
  deriveBidReversed,
  filterOffersForDirection,
  protocolFloorForPair,
  rankOffers,
  rateWithinTolerance,
  snapDown,
  toTakerOffer,
  toTakerOffers,
  validateBid,
  type TakerOffer,
  minFillableReceive,
} from "../offers";

/**
 * A resting offer as `POST /json/offers` reports it. The offerer sends
 * `coin_from` (LTC) and wants `coin_to` (XMR), so a TAKER sends XMR and
 * receives LTC.
 */
function offer(overrides: Partial<BasicSwapOffer> = {}): BasicSwapOffer {
  return {
    offer_id: "a".repeat(56),
    swap_type: SWAP_TYPE_XMR,
    addr_from: "PmakerAddress",
    addr_to: "",
    created_at: 1_700_000_000,
    expire_at: 1_800_000_000,
    coin_from: "Litecoin",
    coin_to: "Monero",
    amount_from: "10.0",
    amount_to: "2.0",
    rate: "0.2",
    min_bid_amount: "1.0",
    is_expired: false,
    is_own_offer: false,
    is_revoked: false,
    is_public: true,
    amount_negotiable: true,
    rate_negotiable: false,
    ...overrides,
  };
}

function taker(overrides: Partial<BasicSwapOffer> = {}): TakerOffer {
  const t = toTakerOffer(offer(overrides));
  if (!t) throw new Error("fixture offer failed to mirror");
  return t;
}

describe("mirroring the offer into the taker's frame", () => {
  it("swaps coin_from / coin_to so the labels match what the user does", () => {
    const t = taker();
    // The offerer sends LTC and wants XMR; the taker is on the other side.
    expect(t.sendCoin).toBe("Monero");
    expect(t.receiveCoin).toBe("Litecoin");
    expect(t.maxReceive).toBe(10);
    expect(t.maxSend).toBe(2);
    expect(t.minReceive).toBe(1);
  });

  it("reads `rate` as send-per-receive, the taker's price", () => {
    const t = taker();
    expect(t.effectiveRate).toBe(0.2); // 0.2 XMR per LTC
    expect(t.receivePerSend).toBeCloseTo(5, 12); // 5 LTC per XMR
    // The mirrored amounts and the quoted rate agree.
    expect(t.maxReceive * t.effectiveRate).toBeCloseTo(t.maxSend, 12);
  });

  it("falls back to the amounts when the quoted rate is unusable", () => {
    const t = taker({ rate: "" });
    expect(t.effectiveRate).toBeCloseTo(0.2, 12);
  });

  it("drops an offer it cannot price rather than ranking a NaN to the front", () => {
    expect(toTakerOffer(offer({ rate: "", amount_to: "" }))).toBeNull();
    expect(toTakerOffer(offer({ amount_from: "0" }))).toBeNull();
    expect(toTakerOffers([offer(), offer({ amount_from: "junk" })])).toHaveLength(
      1,
    );
  });

  it("marks an offer untradable when it is expired, revoked, or our own", () => {
    expect(taker({ is_expired: true }).tradable).toBe(false);
    expect(taker({ is_revoked: true }).tradable).toBe(false);
    expect(taker({ is_own_offer: true }).tradable).toBe(false);
    expect(taker().tradable).toBe(true);
  });

  it("carries amount_negotiable through — it decides whether partials are legal", () => {
    expect(taker({ amount_negotiable: true }).amountNegotiable).toBe(true);
    expect(taker({ amount_negotiable: undefined }).amountNegotiable).toBe(false);
  });
});

describe("bid_reversed derivation", () => {
  it("is true for an XMR_SWAP whose coin_from is scriptless", () => {
    expect(
      deriveBidReversed({ swap_type: SWAP_TYPE_XMR, coin_from: "Monero" }),
    ).toBe(true);
    expect(
      deriveBidReversed({ swap_type: SWAP_TYPE_XMR, coin_from: "Particl Anon" }),
    ).toBe(true);
  });

  it("is false when the scripted coin leads", () => {
    expect(
      deriveBidReversed({ swap_type: SWAP_TYPE_XMR, coin_from: "Litecoin" }),
    ).toBe(false);
  });

  it("is false for a non-XMR swap type regardless of coin", () => {
    expect(deriveBidReversed({ swap_type: 1, coin_from: "Monero" })).toBe(false);
  });

  it("does not change which coin the taker sends", () => {
    const reversed = taker({ coin_from: "Monero", coin_to: "Litecoin" });
    expect(reversed.bidReversed).toBe(true);
    expect(reversed.sendCoin).toBe("Litecoin");
    expect(reversed.receiveCoin).toBe("Monero");
  });
});

describe("ranking is PRICE-ONLY", () => {
  // Deliberately adversarial: the cheapest offer is the newest, the smallest,
  // and last in the input — so size-, age- or arrival-weighting all lose.
  const cheap = taker({
    offer_id: "f".repeat(56),
    rate: "0.190",
    amount_from: "1.0",
    amount_to: "0.19",
    created_at: 1_799_999_999,
    addr_from: "PsomeOtherMaker",
  });
  const mid = taker({
    offer_id: "b".repeat(56),
    rate: "0.200",
    amount_from: "50.0",
    amount_to: "10.0",
    created_at: 1_700_000_000,
  });
  const dear = taker({
    offer_id: "c".repeat(56),
    rate: "0.230",
    amount_from: "500.0",
    amount_to: "115.0",
    created_at: 1_600_000_000,
  });

  it("sorts ascending by effective rate", () => {
    const ranked = rankOffers([mid, dear, cheap]);
    expect(ranked.map((o) => o.effectiveRate)).toEqual([0.19, 0.2, 0.23]);
  });

  it("ignores size, age and publisher entirely", () => {
    const ranked = rankOffers([dear, mid, cheap]);
    expect(ranked[0].offerId).toBe(cheap.offerId);
    // Re-running with a different input order gives the same ranking.
    expect(rankOffers([cheap, mid, dear]).map((o) => o.offerId)).toEqual(
      ranked.map((o) => o.offerId),
    );
  });

  it("breaks ties on offer id, not on anything correlated with the maker", () => {
    const a = taker({ offer_id: "1".repeat(56), addr_from: "Pzzz" });
    const b = taker({ offer_id: "2".repeat(56), addr_from: "Paaa" });
    expect(rankOffers([b, a]).map((o) => o.offerId)).toEqual([
      a.offerId,
      b.offerId,
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [dear, cheap, mid];
    const copy = [...input];
    rankOffers(input);
    expect(input).toEqual(copy);
  });

  it("bestOffer picks the cheapest tradable offer", () => {
    const expired = taker({ offer_id: "0".repeat(56), rate: "0.100", is_expired: true });
    expect(bestOffer([mid, expired, cheap, dear])?.offerId).toBe(cheap.offerId);
    expect(bestOffer([expired])).toBeNull();
    expect(bestOffer([])).toBeNull();
  });
});

describe("direction filtering", () => {
  const sendXmrGetLtc = taker(); // coin_to Monero, coin_from Litecoin
  const sendLtcGetXmr = taker({
    offer_id: "d".repeat(56),
    coin_from: "Monero",
    coin_to: "Litecoin",
    rate: "5.0",
    amount_from: "2.0",
    amount_to: "10.0",
  });

  it("keeps only offers takeable in the requested direction", () => {
    const got = filterOffersForDirection([sendXmrGetLtc, sendLtcGetXmr], {
      sendCoin: "Monero",
      receiveCoin: "Litecoin",
    });
    expect(got.map((o) => o.offerId)).toEqual([sendXmrGetLtc.offerId]);
  });

  it("matches tickers as well as display names", () => {
    // The offers payload says "Monero"; the wallet side says "XMR". Both work.
    expect(
      filterOffersForDirection([sendXmrGetLtc], {
        sendCoin: "XMR",
        receiveCoin: "LTC",
      }),
    ).toHaveLength(1);
    expect(
      filterOffersForDirection([sendXmrGetLtc], {
        sendCoin: "monero",
        receiveCoin: "LITECOIN",
      }),
    ).toHaveLength(1);
    // And it still refuses the wrong direction, ticker spelling or not.
    expect(
      filterOffersForDirection([sendXmrGetLtc], {
        sendCoin: "LTC",
        receiveCoin: "XMR",
      }),
    ).toHaveLength(0);
  });

  it("resolves through the live /json/coins table when one is supplied", () => {
    const coins = [
      { id: 6, ticker: "XMR", name: "Monero", active: true, decimal_places: 12 },
      { id: 3, ticker: "LTC", name: "Litecoin", active: true, decimal_places: 8 },
    ];
    expect(
      filterOffersForDirection([sendXmrGetLtc], {
        sendCoin: "XMR",
        receiveCoin: "LTC",
        coins,
      }),
    ).toHaveLength(1);
  });

  it("drops expired, revoked and own offers by default", () => {
    const bad = [
      taker({ offer_id: "e".repeat(56), is_expired: true }),
      taker({ offer_id: "9".repeat(56), is_revoked: true }),
      taker({ offer_id: "8".repeat(56), is_own_offer: true }),
    ];
    expect(
      filterOffersForDirection(bad, {
        sendCoin: "Monero",
        receiveCoin: "Litecoin",
      }),
    ).toHaveLength(0);
    expect(
      filterOffersForDirection(bad, {
        sendCoin: "Monero",
        receiveCoin: "Litecoin",
        includeExpired: true,
        includeRevoked: true,
        includeOwn: true,
      }),
    ).toHaveLength(3);
  });
});

describe("snapping", () => {
  it("rounds DOWN, never up", () => {
    expect(snapDown(1.239999, 2)).toBe(1.23);
    expect(snapDown(1.999999, 2)).toBe(1.99);
    expect(snapDown(0.00099999, 3)).toBe(0);
  });

  it("survives the classic binary-representation traps", () => {
    // 1.23 * 100 === 122.99999999999999 — a bare floor would give 1.22.
    expect(snapDown(1.23, 2)).toBe(1.23);
    expect(snapDown(0.29, 2)).toBe(0.29);
    expect(snapDown(0.07, 2)).toBe(0.07);
  });

  it("keeps 12-decimal Monero precision instead of collapsing to 8", () => {
    expect(snapDown(0.123456789012, 12)).toBeCloseTo(0.123456789012, 12);
    expect(snapDown(0.123456789012, 8)).toBeCloseTo(0.12345678, 12);
  });

  it("leaves an amount alone rather than mangling it past safe-integer range", () => {
    const huge = 1e12;
    expect(snapDown(huge, 12)).toBe(huge);
  });

  it("ceilTo rounds up, for costs and floors", () => {
    expect(ceilTo(1.231, 2)).toBe(1.24);
    expect(ceilTo(1.23, 2)).toBe(1.23);
    expect(ceilTo(0.0000001, 4)).toBe(0.0001);
  });
});

describe("send-amount arithmetic and rate tolerance", () => {
  it("rounds the cost UP, matching upstream's own ceiling", () => {
    expect(computeSendAmount(3, 0.2, 8)).toBeCloseTo(0.6, 12);
    expect(computeSendAmount(1.000000005, 0.2, 8)).toBe(0.20000001);
  });

  it("accepts a rate inside 0.01% and rejects one outside", () => {
    expect(RATE_TOLERANCE_FRACTION).toBe(0.0001);
    expect(rateWithinTolerance(0.2, 0.2)).toBe(true);
    expect(rateWithinTolerance(0.2, 0.20001)).toBe(true); // +0.005%
    expect(rateWithinTolerance(0.2, 0.2001)).toBe(false); // +0.05%
    expect(rateWithinTolerance(0, 0.2)).toBe(false);
    expect(rateWithinTolerance(0.2, NaN)).toBe(false);
  });
});

describe("protocol minimum per pair", () => {
  it("uses 0.001 of each coin as the base floor", () => {
    expect(PROTOCOL_MIN_COIN_AMOUNT).toBe(0.001);
  });

  it("binds on the more valuable coin — the send leg when it is worth more", () => {
    // Sending XMR to receive LTC at 0.2 XMR/LTC: the XMR side is 5x more
    // valuable per unit, so 0.001 XMR needs 0.005 LTC on the other side.
    const floor = protocolFloorForPair({
      sendCoin: "Monero",
      receiveCoin: "Litecoin",
      rate: 0.2,
    });
    expect(floor.binding).toBe("send");
    expect(floor.bindingCoin).toBe("Monero");
    expect(floor.receiveFloor).toBeCloseTo(0.005, 12);
    expect(floor.sendFloor).toBeCloseTo(0.001, 12);
    expect(floor.cannotJudge).toBe(false);
  });

  it("binds on the receive leg when THAT is the more valuable coin", () => {
    // Sending LTC to receive XMR at 5 LTC/XMR.
    const floor = protocolFloorForPair({
      sendCoin: "Litecoin",
      receiveCoin: "Monero",
      rate: 5,
    });
    expect(floor.binding).toBe("receive");
    expect(floor.bindingCoin).toBe("Monero");
    expect(floor.receiveFloor).toBeCloseTo(0.001, 12);
    expect(floor.sendFloor).toBeCloseTo(0.005, 12);
  });

  it("says so, rather than guessing, when there is no usable rate", () => {
    for (const rate of [null, undefined, 0, NaN]) {
      const floor = protocolFloorForPair({
        sendCoin: "Monero",
        receiveCoin: "Litecoin",
        rate: rate as number | null | undefined,
      });
      expect(floor.cannotJudge).toBe(true);
      expect(floor.binding).toBeNull();
      expect(floor.sentence).toContain("cannot work out");
    }
  });

  it("names the real floor in a plain sentence", () => {
    const floor = protocolFloorForPair({
      sendCoin: "Monero",
      receiveCoin: "Litecoin",
      rate: 0.2,
    });
    expect(floor.sentence).toContain("0.001 Monero");
    expect(floor.sentence).toContain("0.005 Litecoin");
  });
});

describe("pre-submit validation mirror", () => {
  it("accepts a legal partial fill and reports both legs", () => {
    const v = validateBid(taker(), 3);
    expect(v.ok).toBe(true);
    expect(v.code).toBe("ok");
    expect(v.receiveAmount).toBe(3);
    expect(v.sendAmount).toBeCloseTo(0.6, 12);
    expect(v.message).toContain("another user on an open network");
  });

  it("snaps a partial fill DOWN and flags that it did", () => {
    const v = validateBid(taker(), 3.123456789, { receiveDecimals: 8 });
    expect(v.snapped).toBe(true);
    expect(v.receiveAmount).toBeCloseTo(3.12345678, 12);
    expect(v.receiveAmount).toBeLessThan(3.123456789);
    expect(v.ok).toBe(true);
  });

  it("never returns an unsnapped amount for display", () => {
    const v = validateBid(taker(), 9.9999999999, { receiveDecimals: 8 });
    expect(v.receiveAmount).toBe(snapDown(9.9999999999, 8));
  });

  it("rejects below the maker's own minimum", () => {
    const v = validateBid(taker({ min_bid_amount: "1.0" }), 0.5);
    expect(v.ok).toBe(false);
    expect(v.code).toBe("below-offer-minimum");
    expect(v.message).toContain("1 Litecoin");
  });

  it("rejects below the protocol floor when that is what binds", () => {
    const v = validateBid(taker({ min_bid_amount: "0.0" }), 0.001);
    expect(v.ok).toBe(false);
    expect(v.code).toBe("below-protocol-minimum");
    expect(v.message).toContain("smallest swap on this pair");
  });

  it("rejects more than the offer holds", () => {
    const v = validateBid(taker({ amount_from: "10.0" }), 11);
    expect(v.ok).toBe(false);
    expect(v.code).toBe("above-offer-maximum");
    expect(v.message).toContain("10 Litecoin");
  });

  it("demands an exact fill when the offer is not amount-negotiable", () => {
    const fixed = taker({ amount_negotiable: false });
    const partial = validateBid(fixed, 3);
    expect(partial.ok).toBe(false);
    expect(partial.code).toBe("not-negotiable-must-be-exact");
    expect(partial.receiveAmount).toBe(10);
    expect(partial.message).toContain("all-or-nothing");

    const exact = validateBid(fixed, 10);
    expect(exact.ok).toBe(true);
  });

  it("refuses an offer that cannot be taken at all", () => {
    for (const bad of [
      taker({ is_expired: true }),
      taker({ is_revoked: true }),
      taker({ is_own_offer: true }),
    ]) {
      const v = validateBid(bad, 3);
      expect(v.ok).toBe(false);
      expect(v.code).toBe("offer-unavailable");
    }
  });

  it("rejects a non-positive or unreadable amount", () => {
    for (const bad of [0, -1, NaN]) {
      expect(validateBid(taker(), bad).code).toBe("invalid-amount");
    }
  });

  it("catches a rate that cannot be honoured within tolerance", () => {
    // A zero tolerance makes any rounding at all a mismatch — the backstop the
    // check exists to be.
    const v = validateBid(taker(), 3.00000001, {
      receiveDecimals: 8,
      sendDecimals: 8,
      rateTolerance: 0,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("rate-mismatch");
  });

  it("carries the pair floor on every result so the UI can show it", () => {
    const v = validateBid(taker(), 3);
    expect(v.floor.receiveFloor).toBeCloseTo(0.005, 12);
    expect(v.floor.bindingCoin).toBe("Monero");
  });
});

// ---------------------------------------------------------------------------
// minFillableReceive — the 2026-09-05 "no offer to take" incident
// ---------------------------------------------------------------------------

describe("minFillableReceive — an all-or-nothing offer has ONE fillable size", () => {
  /**
   * The live offer that produced the report, verbatim from `/json/offers`:
   *
   *   coin_from Monero, coin_to Bitcoin Cash, amount_from 1.5 XMR,
   *   amount_to 3.23693949 BCH, rate 2.15795966,
   *   min_bid_amount 0.001 XMR, amount_negotiable null
   *
   * MIN read the 0.001 and filled 0.00215796 BCH. Upstream's own
   * `validateBidAmount` then requires `offer.amount_from == bid_amount` for a
   * non-negotiable offer, so nothing could fill it — the console listed the
   * offer while the wallet said "NO OFFER TO TAKE YET".
   */
  const LIVE = {
    amountNegotiable: false, // `null` on the wire, and `=== true` is the read
    minReceive: 0.001,
    maxReceive: 1.5,
  };

  it("ignores a misleading min_bid_amount when the offer is take-it-all", () => {
    expect(minFillableReceive(LIVE)).toBe(1.5);
    // ...and the protocol floor cannot talk it down either.
    expect(minFillableReceive(LIVE, 0.0005)).toBe(1.5);
  });

  it("uses the maker's minimum when the offer IS negotiable", () => {
    expect(minFillableReceive({ ...LIVE, amountNegotiable: true })).toBe(0.001);
  });

  it("raises a negotiable offer's minimum to the protocol floor", () => {
    expect(minFillableReceive({ ...LIVE, amountNegotiable: true }, 0.01)).toBe(0.01);
  });

  it("never asks for more than the offer holds", () => {
    expect(
      minFillableReceive({ amountNegotiable: true, minReceive: 0.2, maxReceive: 0.1 }, 5),
    ).toBe(0.1);
  });
});
