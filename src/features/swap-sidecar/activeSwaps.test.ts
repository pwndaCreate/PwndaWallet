import { describe, expect, it } from "vitest";
import { activeSwapToTracked, mergeActiveSwaps } from "./activeSwaps";
import type { BasicSwapActiveSwap } from "../../api/basicswap";
import type { SidecarTrackedSwap } from "./useSidecarSwap";

/** The live row from `/json/active`, 2026-09-05, verbatim. */
const LIVE: BasicSwapActiveSwap = {
  bid_id: "000000006a9c9d9693ce89ef18912ce6480d0b264233cdffd59bb980",
  offer_id: "000000006a9c9aaaf823c809261893a3da8a9df2e2e1fc7f6f30b335",
  created_at: 1_788_648_853,
  expire_at: 1_788_652_453,
  bid_state: "Scriptless coin locked",
  coin_from: "Litecoin",
  coin_to: "Monero",
  amount_from: "0.09992627",
  amount_to: "0.009999971468",
  was_sent: true,
};

describe("activeSwapToTracked", () => {
  /**
   * The row is in the OFFER's frame, so the legs depend on the role. Getting
   * this backwards would show the user sending the coin they are receiving —
   * and the live row is the one to check against, because the operator's own
   * swap sent 0.00999997 XMR to receive 0.09992627 LTC.
   */
  it("reads the legs from the taker's side of an offer-framed row", () => {
    const s = activeSwapToTracked(LIVE);
    expect(s.sendCoin).toBe("Monero");
    expect(s.sendAmount).toBe("0.009999971468");
    expect(s.receiveCoin).toBe("Litecoin");
    expect(s.receiveAmount).toBe("0.09992627");
    expect(s.bidId).toBe(LIVE.bid_id);
    expect(s.createdAt).toBe(1_788_648_853);
  });

  it("flips them when this node is the MAKER", () => {
    const s = activeSwapToTracked({ ...LIVE, was_sent: false });
    expect(s.sendCoin).toBe("Litecoin");
    expect(s.sendAmount).toBe("0.09992627");
    expect(s.receiveCoin).toBe("Monero");
    expect(s.receiveAmount).toBe("0.009999971468");
  });

  it("resolves the wire label into a real stage", () => {
    const s = activeSwapToTracked(LIVE);
    expect(s.stage.state).toBe("XMR_SWAP_NOSCRIPT_COIN_LOCKED");
    expect(s.stage.stage).toBe("waiting-counterparty");
    expect(s.stage.terminal).toBe(false);
  });

  /**
   * The node does not report a payout address, and its absence is load-bearing:
   * `shouldAutoRetry`'s caller refuses to re-bid without one, so a swap this
   * app did not place itself can never be auto-re-bid to an address the user
   * never reviewed.
   */
  it("carries no payout address, which is what blocks an auto re-bid", () => {
    expect(activeSwapToTracked(LIVE).payoutAddress).toBeUndefined();
  });
});

describe("mergeActiveSwaps", () => {
  function local(over: Partial<SidecarTrackedSwap> = {}): SidecarTrackedSwap {
    return {
      ...activeSwapToTracked(LIVE),
      payoutAddress: "ltc1qexample",
      ...over,
    };
  }

  it("adds what the node knows and this app does not", () => {
    const out = mergeActiveSwaps([], [activeSwapToTracked(LIVE)]);
    expect(out).toHaveLength(1);
    expect(out[0].bidId).toBe(LIVE.bid_id);
  });

  /**
   * The reason this is a merge and not a replace. A locally-adopted swap
   * carries a payout address, polled detail and retry bookkeeping that
   * `/json/active` has none of; overwriting it would silently disable the
   * auto-retry and blank the tracker's detail on every sync.
   */
  it("never lets the node's row overwrite what the app already knows", () => {
    const mine = local({
      detail: { bid_state_ind: 11 } as SidecarTrackedSwap["detail"],
      lastPolledAt: 1_788_650_000_000,
      retryOf: "origin-bid",
      retryAttempt: 1,
    });
    const out = mergeActiveSwaps([mine], [activeSwapToTracked(LIVE)]);
    expect(out).toHaveLength(1);
    expect(out[0].payoutAddress).toBe("ltc1qexample");
    expect(out[0].detail).not.toBeNull();
    expect(out[0].retryOf).toBe("origin-bid");
    expect(out[0].lastPolledAt).toBe(1_788_650_000_000);
  });

  it("does take the node's stage for a swap the app has not polled yet", () => {
    const unpolled = local({
      stage: activeSwapToTracked({ ...LIVE, bid_state: "Bid Sent" }).stage,
      detail: null,
      lastPolledAt: null,
    });
    const out = mergeActiveSwaps([unpolled], [activeSwapToTracked(LIVE)]);
    expect(out[0].stage.state).toBe("XMR_SWAP_NOSCRIPT_COIN_LOCKED");
    // ...and still keeps the local half.
    expect(out[0].payoutAddress).toBe("ltc1qexample");
  });

  it("drops nothing local, including a swap the node has finished with", () => {
    const finished = local({ bidId: "00000000finished" });
    const out = mergeActiveSwaps([finished], [activeSwapToTracked(LIVE)]);
    expect(out.map((s) => s.bidId)).toContain("00000000finished");
    expect(out).toHaveLength(2);
  });

  it("is a no-op when the node reports nothing", () => {
    const mine = local();
    expect(mergeActiveSwaps([mine], [])).toEqual([mine]);
  });
});
