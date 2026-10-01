/**
 * What the P2P tracker shows each side of a swap the timelock ended with a
 * swipe (2026-10-01, found while closing the state-36 open item).
 *
 * The deployed engine publishes the swipe on the SCRIPTLESS leg (`if
 * was_sent:`, `basicswap.py:9030-9073`) and pays it to that side
 * (`createCoinALockRefundSwipeTx`, `:17483-17530`). So in state 18 the
 * scriptless side was paid the coin it was buying, and the SCRIPTED side's
 * coin is what the swipe took; with the swiper's key share the scripted side
 * then claims the coin it was buying (36).
 *
 * The step panel had the scripted side's 18 right ("Recovered by the other
 * user"), and right below it `refundStage` put "refund complete. your coins
 * are back" on the same screen. And 36 read "Refunded" until the fix of the
 * same day. Rendered here, so both lines are checked where the user reads
 * them.
 *
 * Invented ids and amounts in the engine's layouts; nothing reaches a node.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { BasicSwapBidDetail } from "../../api/basicswap";
import { classifyBidState, swapLegOf } from "./bidStates";
import { SidecarSwapTracker } from "./SidecarSwapTracker";
import type { SidecarSwapState, SidecarTrackedSwap } from "./useSidecarSwap";

const objId = (fill: string) => "00000000" + fill.repeat(24);
const CREATED = 1_790_100_000;

/** `describeBid` for a bid this node SENT. `reverse_bid` picks the leg: on a
 *  normal offer the taker sends XMR (scriptless), on a reverse one it sends
 *  LTC (scripted). */
function sentBid(state: number, wire: string, reverse: boolean, prose: string): BasicSwapBidDetail {
  return {
    offer_id: objId("0f"),
    coin_from: reverse ? "Monero" : "Litecoin",
    coin_to: reverse ? "Litecoin" : "Monero",
    amt_from: reverse ? "0.019800000000" : "0.09990000",
    amt_to: reverse ? "0.20000000" : "0.010000000000",
    bid_rate: "0.100100100100",
    ticker_from: reverse ? "XMR" : "LTC",
    ticker_to: reverse ? "LTC" : "XMR",
    bid_state: wire,
    bid_state_ind: state,
    state_description: prose,
    itx_state: "None",
    ptx_state: "None",
    addr_from: "pInventedOwnBidAddrXXXXXXXXXXXXXXXX",
    created_at_timestamp: CREATED,
    expired_at: CREATED + 3600,
    was_sent: true,
    was_received: null as unknown as boolean,
    can_abandon: false,
    reverse_bid: reverse,
  } as BasicSwapBidDetail;
}

function tracked(detail: BasicSwapBidDetail): SidecarTrackedSwap {
  const reverse = detail.reverse_bid;
  return {
    bidId: objId("b1"),
    offerId: detail.offer_id,
    sendCoin: reverse ? "Litecoin" : "Monero",
    receiveCoin: reverse ? "Monero" : "Litecoin",
    sendAmount: reverse ? "0.20000000" : "0.010000000000",
    receiveAmount: reverse ? "0.019800000000" : "0.09990000",
    createdAt: CREATED,
    detail,
    stage: classifyBidState(detail.bid_state_ind, swapLegOf(detail)),
    lastPolledAt: (CREATED + 7200) * 1000,
    error: null,
  };
}

function screen(swap: SidecarTrackedSwap): string {
  const noop = () => {};
  const state: SidecarSwapState = {
    swaps: [swap],
    tracked: swap,
    trackerOpen: true,
    transport: "poll",
    checking: false,
    rebids: {},
    adopt: noop,
    openTracker: noop,
    closeTracker: noop,
    refresh: noop,
  };
  return renderToStaticMarkup(createElement(SidecarSwapTracker, { state }))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

const SWIPED_PROSE = "Swap failed, the other party claimed the refund";

describe("state 18 (FAILED_SWIPED) on each side", () => {
  it("the scripted side lost its coin: no 'refund complete' under 'Recovered by the other user'", () => {
    const detail = sentBid(18, "Failed, swiped", true, SWIPED_PROSE);
    expect(swapLegOf(detail)).toBe("scripted");
    const text = screen(tracked(detail));
    expect(text).toContain("Recovered by the other user");
    expect(text).not.toContain("refund complete");
    expect(text).not.toContain("your coins are back");
    expect(text).not.toContain("Your coins came back");
  });

  it("the swiper was paid: 'Settled by the timelock', and no refund either", () => {
    const detail = sentBid(18, "Failed, swiped", false, SWIPED_PROSE);
    expect(swapLegOf(detail)).toBe("scriptless");
    const text = screen(tracked(detail));
    expect(text).toContain("Settled by the timelock");
    expect(text).not.toContain("refund complete");
    // The node's own prose is the other side's story here, and stays hidden.
    expect(text).not.toContain(SWIPED_PROSE);
  });
});

describe("state 36 (FAILED_SWIPED_USED_MERCY): the scripted side claimed the coin it was buying", () => {
  it("reads as settled with the coin bought, not as a refund", () => {
    const detail = sentBid(36, "Failed, swiped, recovered", true, "");
    expect(swapLegOf(detail)).toBe("scripted");
    const text = screen(tracked(detail));
    expect(text).toContain("Settled by the timelock");
    expect(text).toContain("the coin you were buying");
    expect(text).not.toContain("Refunded");
    expect(text).not.toContain("returned your funds");
    expect(text).not.toContain("refund complete");
  });
});

describe("a real refund still says so", () => {
  it("17 (FAILED_REFUNDED): refund complete, coins back", () => {
    const detail = sentBid(17, "Failed, refunded", false, "Swap failed, locked coins were refunded");
    const text = screen(tracked(detail));
    expect(text).toContain("refund complete");
    expect(text).toContain("Your coins came back");
  });
});
