/**
 * End-to-end over the path the browser sandbox cannot exercise:
 *
 *   public snapshot JSON
 *     → parseSnapshot            (liveness filter, drop-don't-default)
 *     → marketOfferToBasicSwapOffer   (SMSG wire shape → our offer shape)
 *     → estimateRoute            (rank, fill, two hops)
 *     → a number
 *
 * # Why this test exists rather than a screenshot
 *
 * The Mine hero multiplies a **mined XMR balance**, and Monero needs a
 * wallet-RPC unlock the dev bypass cannot perform, so `dev:sandbox` always
 * renders the `—` branch no matter which fixture is loaded. Everything from
 * the adapter onwards is therefore unverifiable by looking, and the adapter is
 * the newest, most assumption-heavy link in the chain: it maps a third-party
 * feed's field names onto a shape the taker pipeline trusts.
 *
 * The individual pieces are covered elsewhere (`marketsSnapshot.test.ts`,
 * `routeEstimate.test.ts`). What is proven HERE is that they compose — that a
 * realistic payload from the real publisher survives every stage and produces
 * a rate. A per-stage green with a broken seam between them is exactly the
 * shape that ships.
 *
 * The payload below uses the field names and magnitudes of a live capture
 * taken 2026-08-28, including the deliberately awkward parts: an expired
 * offer, a malformed record, `rate` as a float in scientific notation, and
 * `active_offers` disagreeing with the records.
 */
import { describe, it, expect } from "vitest";
import {
  marketOfferToBasicSwapOffer,
  parseSnapshot,
} from "../../swap-sidecar/marketsSnapshot";
import { estimateRoute } from "../routeEstimate";

const NOW = 1_787_953_958;

function rawOffer(over: Record<string, unknown> = {}) {
  return {
    msg_id: "000000006a91f19b212b101c6a5d2aeaf04d2a38d3a70c7ed8daf5c9",
    timestamp: NOW - 600,
    protocol_version: 5,
    coin_from: "LTC",
    coin_to: "XMR",
    amount_from_str: "100.00000000",
    amount_to_str: "16.000000000000",
    amount_from: 10_000_000_000,
    amount_to: 16_000_000_000_000,
    min_bid_amount_str: "1.00000000",
    swap_type: 5,
    lock_type: 2,
    lock_value: 86400,
    fee_rate_from: 26000,
    fee_rate_to: 3452,
    amount_negotiable: true,
    rate_negotiable: false,
    auto_accept_type: 1,
    time_valid: 14400,
    rate: 0.16,
    proof_address: "",
    addr_from: "PbAiK3mVpQr7sTuvWxYzGBTB",
    bid_count: 0,
    highest_bid: null,
    ...over,
  };
}

const payload = {
  timestamp: NOW - 300,
  updated_at: "2026-08-28 21:52:38 UTC",
  num_offers: 4,
  // Disagrees with the records on purpose — the publisher's own count is not
  // reproducible from its own offers, and nothing downstream may rely on it.
  active_offers: 99,
  unique_makers: 132,
  unique_pairs: 15,
  stats: { revokes_seen: 3, revokes_matched_offer: 0 },
  offers: [
    rawOffer(),
    rawOffer({
      msg_id: "bch-offer",
      coin_from: "BCH",
      amount_from_str: "40.00000000",
      amount_to_str: "16.000000000000",
      addr_from: "Ps9GtYuIoPaSdFgHjKlZJism",
    }),
    // Past its validity window — must be filtered before it can price anything.
    rawOffer({ msg_id: "expired", timestamp: NOW - 90_000, time_valid: 3600 }),
    // Malformed — no amount strings. Must be dropped, not defaulted.
    { msg_id: "malformed", timestamp: NOW - 100, coin_from: "LTC", coin_to: "XMR", time_valid: 14400 },
  ],
};

const prices = { XMR: 145.8, LTC: 91.2, BCH: 244.0, SOL: 212.5 };

describe("public snapshot → route estimate, end to end", () => {
  const snap = parseSnapshot(payload, NOW);

  it("survives the liveness filter and the malformed record", () => {
    expect(snap.liveOffers.map((o) => o.id).sort()).toEqual([
      "000000006a91f19b212b101c6a5d2aeaf04d2a38d3a70c7ed8daf5c9",
      "bch-offer",
    ]);
  });

  it("adapts into offers the taker pipeline can rank", () => {
    const adapted = snap.liveOffers.map((o) => marketOfferToBasicSwapOffer(o, NOW));
    // The fields the pipeline actually reads must survive the rename.
    const ltc = adapted.find((o) => o.coin_from === "LTC")!;
    expect(ltc.offer_id).toBe(snap.liveOffers[0].id);
    expect(ltc.amount_from).toBe("100.00000000");
    expect(ltc.amount_to).toBe("16.000000000000");
    expect(ltc.min_bid_amount).toBe("1.00000000");
    expect(ltc.amount_negotiable).toBe(true);
    // `expire_at` is DERIVED — the feed has no such field.
    expect(ltc.expire_at).toBe(snap.liveOffers[0].postedAt + 14400);
    // The float rate is deliberately not carried; the pipeline recomputes it
    // from the decimal-string amounts.
    expect(ltc.rate).toBe("");
  });

  it("produces a rate priced from the book, not from USD", () => {
    const adapted = snap.liveOffers.map((o) => marketOfferToBasicSwapOffer(o, NOW));
    const { estimate, failure } = estimateRoute({
      sourceAmount: 2,
      targetTicker: "SOL",
      offersByHop: {
        LTC: adapted.filter((o) => o.coin_from === "LTC"),
        BCH: adapted.filter((o) => o.coin_from === "BCH"),
      },
      coins: null,
      prices,
      source: "public-snapshot",
      bookAgeSec: snap.ageSec,
    });
    expect(failure).toBeNull();
    expect(estimate).not.toBeNull();

    // LTC book: 100 LTC per 16 XMR = 6.25 LTC/XMR → $570/XMR
    // BCH book:  40 BCH per 16 XMR = 2.50 BCH/XMR → $610/XMR  ← better
    expect(estimate!.routeHop).toBe("BCH");
    expect(estimate!.hop1.receiveAmount).toBeCloseTo(5, 6); // 2 XMR * 2.5
    expect(estimate!.source).toBe("public-snapshot");
    expect(estimate!.bookAgeSec).toBe(300);

    // And the number is NOT the USD cross, which would have been
    // 2 * 145.8 / 212.5 = 1.372 SOL before fees.
    const usdCross = (2 * prices.XMR) / prices.SOL;
    expect(Math.abs(estimate!.targetAmount - usdCross)).toBeGreaterThan(0.05);
  });

  it("never reports the publisher's own offer count", () => {
    // Their 99 is unreproducible from their own records; ours is 2.
    expect(snap.publisherClaimed.activeOffers).toBe(99);
    expect(snap.liveOffers).toHaveLength(2);
  });
});
