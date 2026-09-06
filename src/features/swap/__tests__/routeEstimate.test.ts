/**
 * The two-hop route estimator behind the Mine hero and the EARN tab.
 *
 * # Why this replaced a price cross, and what that means for the tests
 *
 * The first version priced XMR→target through USD and deducted flat fees. On
 * this network that is not an approximation, it is a different answer: the
 * public book routinely carries BTC/LTC at a 19% spread. So hop 1 is priced
 * from actual offers, size-aware, through the SAME ranker and fill rule the
 * live taker flow uses — and the tests below are mostly about that sameness,
 * because the failure mode is subtle: a second ranking path that agrees today
 * and drifts later would make the number shown BEFORE opting in diverge from
 * the one shown after. That number is the argument for opting in.
 *
 * The fixtures are `BasicSwapOffer` records because that is what BOTH sources
 * become — the live node natively, the public snapshot via
 * `marketOfferToBasicSwapOffer`.
 */
import { describe, it, expect } from "vitest";
import type { BasicSwapOffer } from "../../../api/basicswap";
import {
  ROUTE_SOURCE,
  estimateRoute,
  estimateProvenance,
  estimateFailureSentence,
  NEAR_FEE_FRACTION,
} from "../routeEstimate";

const NOW = 1_787_953_958;

/**
 * One offer, in the taker's frame.
 *
 * `coin_from` is what the OFFERER sends (what the taker receives) and
 * `coin_to` is what the offerer wants (what the taker sends). Getting this
 * backwards returns the other side of the book, which is the mistake
 * `fetchSidecarQuote`'s own comment warns about.
 */
function offer(over: Partial<BasicSwapOffer> = {}): BasicSwapOffer {
  return {
    offer_id: "o1",
    swap_type: 5,
    addr_from: "Pmaker",
    addr_to: "",
    created_at: NOW - 300,
    expire_at: NOW + 3600,
    // Taker receives LTC, sends XMR.
    coin_from: "LTC",
    coin_to: "XMR",
    amount_from: "100",
    amount_to: "16",
    rate: "",
    min_bid_amount: "1",
    is_expired: false,
    is_own_offer: false,
    is_revoked: false,
    is_public: true,
    // Real offers on this network are overwhelmingly amount-negotiable — the
    // live feed capture shows `"amount_negotiable": true`. The first cut of
    // this fixture omitted it, and every estimate came back
    // `no-fillable-offer`: a NON-negotiable offer must be taken whole, so a
    // 1 XMR conversion cannot touch a 16 XMR offer. The estimator was right
    // and the fixture was wrong, which is the correct way round.
    amount_negotiable: true,
    rate_negotiable: false,
    ...over,
  } as BasicSwapOffer;
}

const prices = { XMR: 145.8, LTC: 91.2, BCH: 244.0, SOL: 212.5, ETH: 3247.5 };

const base = {
  coins: null,
  prices,
  source: "public-snapshot" as const,
  bookAgeSec: 300,
};

describe("estimateRoute — hop 1 comes from the book, not from prices", () => {
  it("prices XMR→LTC at the OFFER's rate, not the USD cross", () => {
    // The offer pays 100 LTC for 16 XMR — 6.25 LTC per XMR. The USD cross
    // would say 145.8/91.2 = 1.598 LTC per XMR. They are wildly different on
    // purpose: if this test ever reports the USD figure, the estimator has
    // quietly stopped reading the book.
    const { estimate } = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "LTC",
      offersByHop: { LTC: [offer()] },
    });
    expect(estimate).not.toBeNull();
    expect(estimate!.hop1.receiveAmount).toBeCloseTo(6.25, 6);
    expect(estimate!.targetAmount).toBeCloseTo(6.25, 6);
    // Single hop: the target IS the intermediate, so no NEAR leg and no fee.
    expect(estimate!.routeHop).toBeNull();
    expect(estimate!.hop2).toBeNull();
    expect(estimate!.hop2Basis).toBe("not-needed");
  });

  it("adds the NEAR leg for a target beyond the intermediate", () => {
    const { estimate } = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [offer()] },
    });
    expect(estimate).not.toBeNull();
    const usd = 6.25 * prices.LTC;
    expect(estimate!.targetAmount).toBeCloseTo(
      (usd * (1 - NEAR_FEE_FRACTION)) / prices.SOL,
      9,
    );
    expect(estimate!.routeHop).toBe("LTC");
    expect(estimate!.hop2Basis).toBe("estimated-from-prices");
  });

  it("reports the rate per XMR, which is what the hero renders", () => {
    const { estimate } = estimateRoute({
      ...base,
      sourceAmount: 4,
      targetTicker: "LTC",
      offersByHop: { LTC: [offer()] },
    });
    expect(estimate!.ratePerSource).toBeCloseTo(6.25, 6);
    expect(estimate!.hop1.sendAmount).toBe(4);
  });
});

describe("hop 2: a real quote wins, and the basis is never misreported", () => {
  it("uses the quote when one is supplied", () => {
    const { estimate } = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [offer()] },
      // A deliberately non-price-cross answer, so it cannot be confused with
      // the fallback arithmetic.
      hop2QuotedOut: () => 42,
    });
    expect(estimate!.targetAmount).toBe(42);
    expect(estimate!.hop2Basis).toBe("quoted");
  });

  it("falls back to the price cross AND says so when the quote is unavailable", () => {
    const { estimate } = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [offer()] },
      hop2QuotedOut: () => null,
    });
    expect(estimate!.hop2Basis).toBe("estimated-from-prices");
    // The number must be the cross, not zero: a failed quote degrades the
    // basis, it does not delete the estimate.
    const usd = 6.25 * prices.LTC;
    expect(estimate!.targetAmount).toBeCloseTo(
      (usd * (1 - NEAR_FEE_FRACTION)) / prices.SOL,
      9,
    );
  });

  it("never labels a cross as quoted", () => {
    const noQuote = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [offer()] },
    });
    expect(noQuote.estimate!.hop2Basis).not.toBe("quoted");
  });
});

describe("estimateRoute — choosing the intermediate", () => {
  it("picks the hop with the better FINAL amount, not the better hop-1 rate", () => {
    // LTC pays generously on hop 1 but LTC is cheap; BCH pays less on hop 1
    // but BCH is worth far more. The route must be chosen on what lands in
    // the wallet — comparing hop-1 rates would pick LTC and be wrong.
    const ltc = offer({ offer_id: "ltc", coin_from: "LTC", coin_to: "XMR", amount_from: "100", amount_to: "16" }); // 6.25 LTC/XMR -> $570/XMR
    const bch = offer({ offer_id: "bch", coin_from: "BCH", coin_to: "XMR", amount_from: "50", amount_to: "16" });  // 3.125 BCH/XMR -> $762/XMR
    const { estimate } = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [ltc], BCH: [bch] },
    });
    expect(estimate!.routeHop).toBe("BCH");
    expect(estimate!.hop1OfferId).toBe("bch");
  });

  it("survives one book being empty", () => {
    const { estimate } = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { BCH: [offer({ coin_from: "BCH", coin_to: "XMR" })] },
    });
    expect(estimate!.routeHop).toBe("BCH");
  });
});

describe("the estimate may not quote a route the pipeline cannot run", () => {
  /**
   * The estimator can price BCH. `useConvertPipeline.beginHop1` seeds XMR->LTC
   * and nothing else. An estimate that picked BCH would promise an outcome
   * the CONVERT button cannot deliver — so callers narrow `allowedHops` to
   * what they can execute, and `CONVERT_PIPELINE_HOPS` derives that from
   * `CONVERT_ROUTE_HOP` so the two cannot drift apart in separate edits.
   */
  it("honours allowedHops even when the excluded book is better", () => {
    const ltc = offer({ offer_id: "ltc", coin_from: "LTC", coin_to: "XMR", amount_from: "100", amount_to: "16" });
    const bch = offer({ offer_id: "bch", coin_from: "BCH", coin_to: "XMR", amount_from: "50", amount_to: "16" });
    const both = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [ltc], BCH: [bch] },
    });
    expect(both.estimate!.routeHop).toBe("BCH");

    const ltcOnly = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [ltc], BCH: [bch] },
      allowedHops: ["LTC"],
    });
    expect(ltcOnly.estimate!.routeHop).toBe("LTC");
    expect(ltcOnly.estimate!.hop1OfferId).toBe("ltc");
    // And it is genuinely a worse number — which is the point: the honest
    // one is what the pipeline will actually produce.
    expect(ltcOnly.estimate!.targetAmount).toBeLessThan(both.estimate!.targetAmount);
  });

  it("the pipeline hop list is derived, not written twice", async () => {
    const { CONVERT_PIPELINE_HOPS } = await import("../useRouteEstimate");
    const { CONVERT_ROUTE_HOP } = await import("../useConvertPipeline");
    expect(CONVERT_PIPELINE_HOPS).toEqual([CONVERT_ROUTE_HOP]);
  });
});

describe("estimateRoute — refusals are reported, never guessed around", () => {
  /**
   * Corrected 2026-08-28. This asserted `no-book` for an empty offer map,
   * which is the defect it should have caught: an EMPTY map means the read
   * succeeded and found nothing, while `no-book` means the read failed. The
   * two rendered the same sentence — "the order book could not be read" —
   * and the operator reported it against a node that was synced and serving
   * offers in the console.
   *
   * `no-book` is now the CALLER's to report (`useRouteEstimate` sets it when
   * a fetch throws or returns an API error) and never inferred from emptiness
   * here.
   */
  it("an empty map is an EMPTY book, not an unreadable one", () => {
    const r = estimateRoute({ ...base, sourceAmount: 1, targetTicker: "SOL", offersByHop: {} });
    expect(r.estimate).toBeNull();
    expect(r.failure).toBe("empty-book");
  });

  it("the two failures do not share a sentence", () => {
    const empty = estimateFailureSentence("empty-book");
    const unread = estimateFailureSentence("no-book");
    expect(empty).not.toBe(unread);
    // The empty one must not claim a read failure.
    expect(empty).not.toMatch(/could not be read/i);
    expect(unread).toMatch(/could not be read/i);
  });

  it("refuses when nothing on the book can fill the size", () => {
    // A 1000 XMR conversion against an offer that can only take 16.
    const r = estimateRoute({
      ...base,
      sourceAmount: 1000,
      targetTicker: "LTC",
      offersByHop: { LTC: [offer()] },
    });
    expect(r.estimate).toBeNull();
    expect(r.failure).toBe("no-fillable-offer");
  });

  it("refuses when the target has no price", () => {
    const r = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "DOGE",
      offersByHop: { LTC: [offer()] },
    });
    expect(r.estimate).toBeNull();
    expect(r.failure).toBe("no-target-price");
  });

  it("refuses a zero or negative amount rather than returning zero", () => {
    for (const amt of [0, -1, Number.NaN]) {
      const r = estimateRoute({ ...base, sourceAmount: amt, targetTicker: "LTC", offersByHop: { LTC: [offer()] } });
      expect(r.estimate).toBeNull();
      expect(r.failure).toBe("invalid-amount");
    }
  });

  it("skips offers the taker cannot actually take", () => {
    // Expired and revoked offers must not price anything. `toTakerOffers`
    // marks them untradable; this asserts the estimator honours that rather
    // than ranking on price alone.
    const r = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "LTC",
      offersByHop: {
        LTC: [
          offer({ offer_id: "dead", is_expired: true }),
          offer({ offer_id: "revoked", is_revoked: true }),
          offer({ offer_id: "mine", is_own_offer: true }),
        ],
      },
    });
    expect(r.estimate).toBeNull();
  });
});

describe("provenance is carried, so the UI can name the book", () => {
  it("says which book priced it", () => {
    const snap = estimateRoute({
      ...base,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [offer()] },
    }).estimate!;
    expect(snap.source).toBe("public-snapshot");
    expect(snap.bookAgeSec).toBe(300);
    expect(estimateProvenance(snap)).toContain("public order book");
    expect(estimateProvenance(snap)).toContain("via LTC");

    const live = estimateRoute({
      ...base,
      source: "live-node",
      bookAgeSec: 0,
      sourceAmount: 1,
      targetTicker: "SOL",
      offersByHop: { LTC: [offer()] },
    }).estimate!;
    expect(estimateProvenance(live)).toContain("your node's order book");
  });

  it("names the source coin as the one mining produces", () => {
    expect(ROUTE_SOURCE).toBe("XMR");
  });
});
