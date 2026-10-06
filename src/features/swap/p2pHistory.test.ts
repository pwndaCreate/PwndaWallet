/**
 * Peer-to-peer (BasicSwap) swaps in the swap history (operator request,
 * 2026-10-01): "Is it possible to have the p2p swaps also tracked inside the
 * swaps and recent swaps sections?"
 *
 * Until this change nothing that placed or followed a P2P bid wrote
 * `swapHistory`, so neither SWAPS in Activity nor RECENT SWAPS / HISTORY on
 * the Swap tab ever showed one. These tests pin:
 *  - the bid state -> history status mapping, for every state the tracker
 *    knows, from both legs;
 *  - the row written when a bid is placed (the API stubbed);
 *  - the backfill from the node's sent bids (no duplicates);
 *  - the status updates from the tracker's reads, and which transaction is
 *    "what you sent" and which "what you received";
 *  - the details a P2P row opens.
 *
 * Bid ids, offer ids, addresses and txids are invented, in the real layouts
 * (56-hex object ids, 64-hex txids, `describeBid`'s field names).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ── I/O boundaries ──────────────────────────────────────────────────────
// History: an in-memory stand-in for tauri-plugin-store, as in
// swap-history-store.test.ts.
const mem = new Map<string, unknown>();
let saveCount = 0;
vi.mock("../../store", () => ({
  getStore: async () => ({
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: unknown) => {
      mem.set(k, v);
    },
    save: async () => {
      saveCount += 1;
    },
  }),
}));

// The opt-in flag `submitSidecarBid` checks first (its own plugin-store file).
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (k: string) => (k === "pwnda.swapSidecarOptedInAt" ? 1_790_000_000_000 : undefined),
    set: async () => undefined,
    save: async () => undefined,
    delete: async () => undefined,
  }),
}));

// The swap node: nothing here may reach a real one.
vi.mock("../../api/basicswap", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/basicswap")>();
  return {
    ...real,
    swapSidecarPlaceBid: vi.fn(),
    fetchSentBids: vi.fn(),
    fetchBid: vi.fn(),
    // 2026-10-01: the received half of the book, and the read that lists a
    // bid's transactions.
    fetchBids: vi.fn(),
    fetchBidTxns: vi.fn(),
  };
});

import * as api from "../../api/basicswap";
import type {
  BasicSwapActiveSwap,
  BasicSwapBidDetail,
  BasicSwapBidSummary,
} from "../../api/basicswap";
import {
  loadSwapHistory,
  onSwapHistoryChange,
  type SwapHistoryEntry,
} from "./swap-history-store";
import {
  applyP2PObservation,
  backfillP2PHistory,
  bidTxnsFrom,
  createP2PHistorySink,
  observeBidRead,
  p2pBidStateToHistoryStatus,
  p2pHistoryId,
  p2pLegTransactions,
  p2pStageView,
  P2P_HISTORY_PROVIDER,
} from "./p2p-history";
import { swapRouteOf } from "./swap-details";
import { SwapDetailsModal } from "./SwapDetailsModal";
import {
  submitSidecarBid,
  requestSidecarTracker,
  OPEN_SIDECAR_TRACKER_EVENT,
  type SidecarQuote,
  type SidecarSwapHandle,
  type SidecarTrackerRequest,
} from "../swap-sidecar/useSidecarSwap";
import { formatAmount } from "../swap-sidecar/types";
import {
  ALL_BID_STATE_NAMES,
  BID_STATE_IDS,
  BID_STATE_WIRE_LABELS,
  type BidStateName,
} from "../swap-sidecar/bidStates";
import { swapHashSet } from "../activity/swap-history-merge";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

// Invented ids with the engine's layout: 28-byte object ids, 32-byte txids.
const objId = (fill: string) => "00000000" + fill.repeat(24);
const BID = objId("b1");
const BID_2 = objId("b2");
const BID_3 = objId("b3");
const OFFER = objId("0f");
const txid = (fill: string) => fill.repeat(32);

const CREATED = 1_790_100_000; // unix seconds, 2026-09-22

beforeEach(() => {
  mem.clear();
  saveCount = 0;
  vi.mocked(api.swapSidecarPlaceBid).mockReset();
  vi.mocked(api.fetchSentBids).mockReset();
  vi.mocked(api.fetchBid).mockReset();
  vi.mocked(api.fetchBids).mockReset();
  vi.mocked(api.fetchBidTxns).mockReset();
  // The sink backfills on its first in-progress answer; by default the node
  // has sent nothing else, and received nothing.
  vi.mocked(api.fetchSentBids).mockResolvedValue([]);
  vi.mocked(api.fetchBids).mockResolvedValue([]);
  // A node without the transactions read: the history falls back to the
  // plain GET. Tests of the transactions say otherwise.
  vi.mocked(api.fetchBidTxns).mockRejectedValue(new Error("no transactions read in this test"));
});

/** A tracked bid the way the confirm modal hands it to `adopt`: the node
 *  names coins, so `sendCoin` is "Monero", not a ticker. */
function handle(over: Partial<SidecarSwapHandle> = {}): SidecarSwapHandle {
  return {
    bidId: BID,
    offerId: OFFER,
    sendCoin: "Monero",
    receiveCoin: "Litecoin",
    sendAmount: "0.010000000000",
    receiveAmount: "0.09990000",
    createdAt: CREATED,
    ...over,
  };
}

/** `describeBid(..., for_api=True)` for a bid this node sent on an
 *  LTC-for-XMR offer: it SENDS XMR, so it is on the scriptless leg. */
function detail(over: Partial<BasicSwapBidDetail> & Record<string, unknown> = {}): BasicSwapBidDetail {
  return {
    offer_id: OFFER,
    coin_from: "Litecoin",
    coin_to: "Monero",
    amt_from: "0.09990000",
    amt_to: "0.010000000000",
    bid_rate: "0.100100100100",
    ticker_from: "LTC",
    ticker_to: "XMR",
    bid_state: "Scriptless coin locked",
    bid_state_ind: 11,
    state_description: "Both lock txs confirmed, waiting for offerer to release the LTC lock tx",
    itx_state: "None",
    ptx_state: "None",
    addr_from: "pInventedOwnBidAddrXXXXXXXXXXXXXXXX",
    created_at_timestamp: CREATED,
    expired_at: CREATED + 3600,
    was_sent: true,
    // What upstream sends on a bid this node sent: null, not false.
    was_received: null as unknown as boolean,
    can_abandon: false,
    reverse_bid: false,
    ...over,
  } as BasicSwapBidDetail;
}

async function rows(): Promise<SwapHistoryEntry[]> {
  return loadSwapHistory();
}

async function rowFor(bidId: string): Promise<SwapHistoryEntry | undefined> {
  return (await rows()).find((r) => r.bidId === bidId);
}

// ═══════════════════════════════════════════════════════════════════════
// The mapping
// ═══════════════════════════════════════════════════════════════════════

type Triple = [scripted: string, scriptless: string, unknownLeg: string];

/**
 * Every state `bidStates.ts` names, spelled out, so a change to the
 * tracker's table shows up here as a decision to make, not a silent drift.
 */
const EXPECTED: Record<BidStateName, Triple> = {
  BID_SENT: ["pending", "pending", "pending"],
  BID_RECEIVING: ["pending", "pending", "pending"],
  BID_RECEIVED: ["pending", "pending", "pending"],
  BID_RECEIVING_ACC: ["pending", "pending", "pending"],
  BID_ACCEPTED: ["pending", "pending", "pending"],
  SWAP_INITIATED: ["pending", "pending", "pending"],
  SWAP_PARTICIPATING: ["pending", "pending", "pending"],
  SWAP_COMPLETED: ["success", "success", "success"],
  XMR_SWAP_SCRIPT_COIN_LOCKED: ["pending", "pending", "pending"],
  XMR_SWAP_HAVE_SCRIPT_COIN_SPEND_TX: ["pending", "pending", "pending"],
  XMR_SWAP_NOSCRIPT_COIN_LOCKED: ["pending", "pending", "pending"],
  XMR_SWAP_LOCK_RELEASED: ["pending", "pending", "pending"],
  XMR_SWAP_SCRIPT_TX_REDEEMED: ["pending", "pending", "pending"],
  // Refunding (scripted) / waiting on the timelock (scriptless): neither done.
  XMR_SWAP_SCRIPT_TX_PREREFUND: ["pending", "pending", "pending"],
  XMR_SWAP_NOSCRIPT_TX_REDEEMED: ["pending", "pending", "pending"],
  XMR_SWAP_NOSCRIPT_TX_RECOVERED: ["refunded", "refunded", "refunded"],
  XMR_SWAP_FAILED_REFUNDED: ["refunded", "refunded", "refunded"],
  // The one state whose two readings are opposite outcomes: the swiper was
  // paid, the other side's lock was taken. Without the leg: pending.
  XMR_SWAP_FAILED_SWIPED: ["failed", "success", "pending"],
  XMR_SWAP_FAILED: ["pending", "pending", "pending"],
  SWAP_DELAYING: ["pending", "pending", "pending"],
  SWAP_TIMEDOUT: ["failed", "failed", "failed"],
  BID_ABANDONED: ["failed", "failed", "failed"],
  BID_ERROR: ["pending", "pending", "pending"],
  BID_STALLED_FOR_TEST: ["pending", "pending", "pending"],
  BID_REJECTED: ["failed", "failed", "failed"],
  BID_STATE_UNKNOWN: ["pending", "pending", "pending"],
  XMR_SWAP_MSG_SCRIPT_LOCK_TX_SIGS: ["pending", "pending", "pending"],
  XMR_SWAP_MSG_SCRIPT_LOCK_SPEND_TX: ["pending", "pending", "pending"],
  BID_REQUEST_SENT: ["pending", "pending", "pending"],
  BID_REQUEST_ACCEPTED: ["pending", "pending", "pending"],
  BID_EXPIRED: ["failed", "failed", "failed"],
  BID_AACCEPT_DELAY: ["pending", "pending", "pending"],
  BID_AACCEPT_FAIL: ["pending", "pending", "pending"],
  CONNECT_REQ_SENT: ["pending", "pending", "pending"],
  // "Mercy used": the scripted leg (the only one that reaches it) claimed the
  // coin it was buying with the swiper's key share. Delivered. It was
  // ["refunded" x3] until 2026-10-01, following the tracker's old reading.
  XMR_SWAP_FAILED_SWIPED_USED_MERCY: ["success", "success", "success"],
  XMR_SWAP_FAILED_SWIPED_USING_MERCY: ["pending", "pending", "pending"],
  XMR_SWAP_FAILED_SWIPED_MERCY_UNUSED: ["failed", "failed", "failed"],
  XMR_SWAP_FAILED_SWIPED_SENDING_MERCY: ["pending", "pending", "pending"],
};

describe("p2pBidStateToHistoryStatus: every state the tracker knows", () => {
  it("the table above names every BidStates member, no more, no fewer", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_BID_STATE_NAMES].sort());
  });

  it.each(ALL_BID_STATE_NAMES.map((n) => [n] as const))("%s", (name) => {
    const [scripted, scriptless, unknown] = EXPECTED[name];
    // The int (`bid_state_ind`), upstream's display string and the protocol
    // name are the three forms the node hands over; all must agree.
    for (const form of [BID_STATE_IDS[name], BID_STATE_WIRE_LABELS[name], name]) {
      expect(p2pBidStateToHistoryStatus(form, "scripted"), `${String(form)} scripted`).toBe(scripted);
      expect(p2pBidStateToHistoryStatus(form, "scriptless"), `${String(form)} scriptless`).toBe(scriptless);
      expect(p2pBidStateToHistoryStatus(form, "unknown"), `${String(form)} unknown`).toBe(unknown);
      expect(p2pBidStateToHistoryStatus(form), `${String(form)} default`).toBe(unknown);
    }
  });

  it("a state this build does not know never looks finished", () => {
    for (const v of [35, 99, -1, "", "Some future state", null, undefined]) {
      expect(p2pBidStateToHistoryStatus(v)).toBe("pending");
      expect(p2pBidStateToHistoryStatus(v, "scriptless")).toBe("pending");
    }
  });
});

/**
 * State 36 on a row (operator request, 2026-10-01). The one taker who can
 * reach it: on a REVERSE offer (the maker sells XMR), the taker sends the
 * scripted coin and is the scripted leg. In 36 the swiper has its LTC and
 * this taker claimed the XMR it was buying with the swiper's key share
 * (deployed engine; see bidStates.test.ts). The row said "refunded" and the
 * details "Refunded. The timelock returned your funds".
 */
describe("state 36 on the row of a taker who sent LTC for XMR", () => {
  const reverseTaker = () =>
    detail({
      // The offer's frame: the maker sells XMR (coin_from) for LTC.
      coin_from: "Monero",
      coin_to: "Litecoin",
      ticker_from: "XMR",
      ticker_to: "LTC",
      bid_state: "Failed, swiped, recovered",
      bid_state_ind: 36,
      state_description: "",
      reverse_bid: true,
    });
  const ltcForXmr = () =>
    handle({ sendCoin: "Litecoin", receiveCoin: "Monero", sendAmount: "0.20000000", receiveAmount: "0.019800000000" });

  it("is read on the scripted leg, and finishes as a delivered swap", () => {
    const obs = observeBidRead(ltcForXmr(), reverseTaker());
    expect(obs.leg).toBe("scripted");
    const row = applyP2PObservation(undefined, obs, new Date(CREATED * 1000).toISOString());
    expect(row?.status).toBe("success");
    expect(row?.bidLeg).toBe("scripted");
  });

  it("the details name the coin it bought, not a refund", () => {
    const row = applyP2PObservation(
      undefined,
      observeBidRead(ltcForXmr(), reverseTaker()),
      new Date(CREATED * 1000).toISOString(),
    )!;
    const view = p2pStageView(row);
    expect(view.key).toBe("claimed-after-swipe");
    expect(view.label).toBe("Settled by the timelock");
    expect(view.label).not.toBe("Refunded");
    expect(view.description).toContain("the coin you were buying");
    expect(view.description.toLowerCase()).not.toContain("refund");
    expect(view.terminal).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The row written when a bid is placed
// ═══════════════════════════════════════════════════════════════════════

/** Just the quote fields `submitSidecarBid` reads. */
function quote(): SidecarQuote {
  return {
    offer: { offerId: OFFER, sendCoin: "Monero", receiveCoin: "Litecoin", effectiveRate: 0.1001001 },
    sendAmount: 0.01,
    receiveAmount: 0.0999,
    sendDecimals: 12,
    receiveDecimals: 8,
  } as unknown as SidecarQuote;
}

describe("a row when the bid is placed", () => {
  it("submitSidecarBid answers ok, adopt hands the handle over, and history has a pending row", async () => {
    vi.mocked(api.swapSidecarPlaceBid).mockResolvedValue(BID);
    const q = quote();
    const result = await submitSidecarBid({ quote: q, addrTo: "ltc1qinventedpayout000000000000000000000" });
    // Since 2026-10-06 the answer also says where the bid asked to be paid
    // (`payoutDestination.test.ts` pins which).
    expect(result).toMatchObject({ ok: true, bidId: BID });
    if (!result.ok) return;

    // The handle exactly as SidecarConfirmModal builds it for `onSubmitted`.
    const placed: SidecarSwapHandle = {
      bidId: result.bidId,
      offerId: q.offer.offerId,
      sendCoin: q.offer.sendCoin,
      receiveCoin: q.offer.receiveCoin,
      sendAmount: formatAmount(q.sendAmount, q.sendDecimals),
      receiveAmount: formatAmount(q.receiveAmount, q.receiveDecimals),
      createdAt: CREATED,
      payoutAddress: "ltc1qinventedpayout000000000000000000000",
    };
    const sink = createP2PHistorySink();
    await sink.placed(placed);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: p2pHistoryId(BID),
      bidId: BID,
      offerId: OFFER,
      provider: P2P_HISTORY_PROVIDER,
      // Tickers, not the node's coin names: the lists' coin icons and the
      // explorer links key on tickers.
      fromAsset: "XMR",
      toAsset: "LTC",
      // Exactly the amounts the confirm modal showed and submitted.
      fromAmount: placed.sendAmount,
      toAmount: placed.receiveAmount,
      status: "pending",
      bidState: "BID_SENT",
      sourceTxHash: "",
      createdAt: new Date(CREATED * 1000).toISOString(),
    });
    // Placing asked the node for nothing else.
    expect(api.fetchBid).not.toHaveBeenCalled();
    expect(api.fetchSentBids).not.toHaveBeenCalled();
    expect(swapRouteOf(all[0])).toBe("p2p");
  });

  it("is wired: adopt reports the placement, and App hands the tracker this sink", () => {
    const hook = read("../swap-sidecar/useSidecarSwap.ts");
    const adopt = hook.slice(hook.indexOf("const adopt = useCallback"), hook.indexOf("// ── a bid nobody answered"));
    expect(adopt).toContain("tellHistory((h) => h.placed(handle))");
    // Both placing paths go through adopt.
    const modal = read("../swap-sidecar/SidecarConfirmModal.tsx");
    expect(modal).toMatch(/submitSidecarBid\(\{[^}]*\}\);\s*if \(result\.ok\) \{\s*onSubmitted\(\{/);
    const retry = hook.slice(hook.indexOf("const attemptAutoRetry"), hook.indexOf("const openTracker = useCallback"));
    expect(retry).toMatch(/submitSidecarBid\([\s\S]*adopt\(\{/);
    const app = read("../../App.tsx");
    expect(app).toMatch(/useSidecarSwap\(\{\s*enabled: isLoggedIn,\s*history: p2pSwapHistory\s*\}\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Backfill from the node's sent bids
// ═══════════════════════════════════════════════════════════════════════

/** A `/json/sentbids` row: a bid this node sent, in the OFFER's frame. */
function sentBid(over: Partial<BasicSwapBidSummary>): BasicSwapBidSummary {
  return {
    bid_id: BID,
    offer_id: OFFER,
    created_at: CREATED,
    expire_at: CREATED + 3600,
    coin_from: "Litecoin",
    coin_to: "Monero",
    amount_from: "0.09990000",
    amount_to: "0.010000000000",
    bid_rate: "0.100100100100",
    bid_state: "Scriptless coin locked",
    addr_from: "pInventedOwnBidAddrXXXXXXXXXXXXXXXX",
    addr_to: "pInventedNetworkAddrXXXXXXXXXXXXXXX",
    tx_state_a: "Confirmed",
    tx_state_b: "Confirmed",
    ...over,
  };
}

const NEAR_ROW: SwapHistoryEntry = {
  id: "near-1",
  fromAsset: "LTC",
  toAsset: "USDC-POL",
  fromAmount: "0.25",
  toAmount: "16.80",
  status: "success",
  sourceTxHash: txid("5a"),
  sourceExplorerUrl: "",
  provider: "NEAR Intents · 1Click",
  createdAt: "2026-09-30T12:20:00.000Z",
  depositAddress: "LInventedDeposit0000000000000000000",
};

describe("backfill", () => {
  function deps() {
    const fetchSentBids = vi.fn(async () => [
      // Finished two weeks ago, before this change: never in history.
      sentBid({ bid_id: BID_2, created_at: CREATED - 14 * 86400, bid_state: "Completed" }),
      // In flight, and ALREADY in history from its placement.
      sentBid({ bid_id: BID, bid_state: "Scriptless coin locked" }),
      // A bid nobody accepted.
      sentBid({ bid_id: BID_3, created_at: CREATED - 86400, bid_state: "Expired" }),
    ]);
    const fetchBid = vi.fn(async (id: string) => {
      if (id === BID_2) return detail({ bid_state: "Completed", bid_state_ind: 8 });
      if (id === BID) return detail();
      // One read failing does not lose the bid: the list row is enough.
      throw new Error("the swap node is not running");
    });
    return { fetchSentBids, fetchBid };
  }

  it("writes the bids history lacks, merges the one it has, and leaves other routes alone", async () => {
    mem.set("swapHistory", [NEAR_ROW]);
    await createP2PHistorySink().placed(handle({ sendAmount: "0.0100", receiveAmount: "0.0999" }));
    const d = deps();
    const looked = await backfillP2PHistory(d);
    expect(looked).toBe(3);
    // Read-only toward the node: the list, newest first, then each bid.
    expect(d.fetchSentBids).toHaveBeenCalledWith({ limit: 100, sort_by: "created_at", sort_dir: "desc" });
    expect(d.fetchBid.mock.calls.map((c) => c[0]).sort()).toEqual([BID, BID_2, BID_3].sort());

    const all = await rows();
    expect(all.filter((r) => r.bidId === BID)).toHaveLength(1);
    expect(all.find((r) => r.id === "near-1")).toEqual(NEAR_ROW);

    const done = all.find((r) => r.bidId === BID_2)!;
    expect(done).toMatchObject({
      fromAsset: "XMR",
      toAsset: "LTC",
      fromAmount: "0.010000000000",
      toAmount: "0.09990000",
      status: "success",
      bidState: 8,
      bidLeg: "scriptless",
      provider: P2P_HISTORY_PROVIDER,
      createdAt: new Date((CREATED - 14 * 86400) * 1000).toISOString(),
    });
    expect(done.completedAt).toBeTruthy();

    // The placed row kept the amounts the user reviewed and learned the rest.
    const placed = all.find((r) => r.bidId === BID)!;
    expect(placed).toMatchObject({
      fromAmount: "0.0100",
      toAmount: "0.0999",
      status: "pending",
      bidState: 11,
      bidLeg: "scriptless",
    });

    // The failed detail read fell back to the list row's display string.
    expect(all.find((r) => r.bidId === BID_3)).toMatchObject({ status: "failed", bidState: "Expired" });

    // Newest first in the store too, so the 200-row cap drops the oldest.
    const stored = mem.get("swapHistory") as SwapHistoryEntry[];
    expect(stored.map((r) => r.createdAt)).toEqual([...stored.map((r) => r.createdAt)].sort().reverse());
  });

  it("a swap that ended unwatched is dated by the node's state time, not by the read", async () => {
    // Sandbox, 2026-10-01: a backfilled swap that finished two days earlier
    // read "just now" in the lists, because `completedAt` was the time the
    // wallet first saw it finished. The bid's own record says when it
    // reached that state (`state_time_timestamp`, basicswap ui/util.py:376).
    const finishedAt = CREATED - 14 * 86400 + 41 * 60;
    const d = deps();
    d.fetchBid.mockImplementation(async (id: string) => {
      if (id === BID_2) {
        return detail({ bid_state: "Completed", bid_state_ind: 8, state_time_timestamp: finishedAt });
      }
      if (id === BID) return detail();
      throw new Error("the swap node is not running");
    });
    await backfillP2PHistory(d);
    const all = await rows();
    expect(all.find((r) => r.bidId === BID_2)!.completedAt).toBe(new Date(finishedAt * 1000).toISOString());
    // A read with no state time (the list row only) still gets a date.
    expect(all.find((r) => r.bidId === BID_3)!.completedAt).toBeTruthy();
  });

  it("a second pass adds nothing, re-reads only the unfinished, and writes nothing", async () => {
    const d = deps();
    await backfillP2PHistory(d);
    const first = await rows();
    const saves = saveCount;
    d.fetchBid.mockClear();
    await backfillP2PHistory(d);
    const second = await rows();
    expect(second).toEqual(first);
    for (const id of [BID, BID_2, BID_3]) {
      expect(second.filter((r) => r.bidId === id)).toHaveLength(1);
    }
    // BID_2 (success) and BID_3 (failed) are finished: not asked again.
    expect(d.fetchBid.mock.calls.map((c) => c[0])).toEqual([BID]);
    expect(saveCount).toBe(saves);
  });

  it("the sink backfills on the node's first answer, and tries again after a refusal", async () => {
    const fetchSentBids = vi
      .fn()
      .mockResolvedValueOnce({ error: "Wallet must be unlocked to view bids.", locked: true })
      .mockResolvedValue([sentBid({ bid_id: BID_2, bid_state: "Completed" })]);
    const fetchBid = vi.fn(async () => detail({ bid_state: "Completed", bid_state_ind: 8 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = createP2PHistorySink({ fetchSentBids, fetchBid });
    await sink.activeRead([]);
    expect(fetchSentBids).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(0);
    await sink.activeRead([]);
    expect(fetchSentBids).toHaveBeenCalledTimes(2);
    expect((await rowFor(BID_2))?.status).toBe("success");
    // Done for this session...
    await sink.activeRead([]);
    expect(fetchSentBids).toHaveBeenCalledTimes(2);
    // ...until the tracker is switched off and on again.
    sink.reset();
    await sink.activeRead([]);
    expect(fetchSentBids).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Status updates from the tracker
// ═══════════════════════════════════════════════════════════════════════

/** The `/json/active` row of the same bid, in the offer's frame. */
function activeRow(over: Partial<BasicSwapActiveSwap> = {}): BasicSwapActiveSwap {
  return {
    bid_id: BID,
    offer_id: OFFER,
    created_at: CREATED,
    expire_at: CREATED + 3600,
    bid_state: "Scriptless coin locked",
    coin_from: "Litecoin",
    coin_to: "Monero",
    amount_from: "0.09990000",
    amount_to: "0.010000000000",
    was_sent: true,
    ...over,
  };
}

const SHOW_TXNS_COMPLETED = [
  // `describeBid`'s order: A lock, A lock spend, B lock, B lock spend.
  { type: "Chain A Lock", txid: txid("a1"), confirms: 12 },
  { type: "Chain A Lock Spend", txid: txid("a2") },
  { type: "Chain B Lock", txid: txid("b1"), confirms: 20 },
  { type: "Chain B Lock Spend", txid: txid("b2") },
];

describe("status updates from the tracker's reads", () => {
  it("follows a swap from placement to completion, and names what you sent and received", async () => {
    const sink = createP2PHistorySink();
    await sink.placed(handle());
    await sink.bidRead(handle(), detail());
    expect(await rowFor(BID)).toMatchObject({ status: "pending", bidState: 11, bidLeg: "scriptless" });

    // The engine's internal pause holds the last real state, as the tracker does.
    await sink.bidRead(handle(), detail({ bid_state: "Delaying", bid_state_ind: 20 }));
    expect((await rowFor(BID))?.bidState).toBe(11);

    await sink.bidRead(
      handle(),
      detail({ bid_state: "Completed", bid_state_ind: 8, txns: SHOW_TXNS_COMPLETED }),
    );
    const row = (await rowFor(BID))!;
    expect(row.status).toBe("success");
    expect(row.completedAt).toBeTruthy();
    // This node sent XMR, the scriptless coin: its lock is chain B, and it was
    // paid by spending the other user's chain-A (LTC) lock.
    expect(row.sourceTxHash).toBe(txid("b1"));
    expect(row.sourceExplorerUrl).toBe(`https://xmrchain.net/tx/${txid("b1")}`);
    expect(row.destTxHash).toBe(txid("a2"));
    expect(row.destExplorerUrl).toMatch(new RegExp(`^https://.+${txid("a2")}`));
    expect(row.bidTxns).toHaveLength(4);
  });

  it("an answer read before the swap ended never moves a finished row back", async () => {
    const sink = createP2PHistorySink();
    await sink.bidRead(handle(), detail({ bid_state: "Completed", bid_state_ind: 8 }));
    await sink.activeRead([activeRow({ bid_state: "Script tx redeemed" })]);
    expect(await rowFor(BID)).toMatchObject({ status: "success", bidState: 8 });
  });

  it("an unchanged answer writes nothing and tells no list", async () => {
    const sink = createP2PHistorySink();
    await sink.bidRead(handle(), detail());
    const saves = saveCount;
    let told = 0;
    const off = onSwapHistoryChange(() => {
      told += 1;
    });
    await sink.bidRead(handle(), detail());
    // The same state from the in-progress list, in its display-string form.
    await sink.activeRead([activeRow()]);
    off();
    expect(saveCount).toBe(saves);
    expect(told).toBe(0);
    expect((await rowFor(BID))?.bidState).toBe(11);
  });

  it("the swipe: paid on the scriptless leg, lost on the scripted one, undecided without a leg", async () => {
    const sink = createP2PHistorySink();
    // The in-progress list has no leg, so 18 stays pending...
    await sink.activeRead([activeRow({ bid_state: "Failed, swiped" })]);
    expect((await rowFor(BID))?.status).toBe("pending");
    expect(p2pStageView((await rowFor(BID))!).key).toBe("timelock-undecided");
    // ...until a read of the bid says which coin this node locked.
    await sink.bidRead(handle(), detail({ bid_state: "Failed, swiped", bid_state_ind: 18 }));
    expect(await rowFor(BID)).toMatchObject({ status: "success", bidLeg: "scriptless" });
    expect(p2pStageView((await rowFor(BID))!).label).toBe("Settled by the timelock");

    // The same state on a bid where this node locked the SCRIPTED coin.
    await sink.bidRead(
      handle({ bidId: BID_2, sendCoin: "Litecoin", receiveCoin: "Monero" }),
      detail({ bid_state: "Failed, swiped", bid_state_ind: 18, reverse_bid: true }),
    );
    expect(await rowFor(BID_2)).toMatchObject({ status: "failed", bidLeg: "scripted" });
  });

  // "A bid this node RECEIVED is not a row" stood here until 2026-10-06, with
  // `was_sent: false`, a value the engine never sends for a received bid (it
  // sends `null`, below). The operator asked for those swaps to be listed:
  // see "swaps where this node was the maker".
});

// ═══════════════════════════════════════════════════════════════════════
// The transactions of an adaptor swap (2026-10-01)
// ═══════════════════════════════════════════════════════════════════════

describe("the transactions of an adaptor swap (2026-10-01)", () => {
  /**
   * The engine lists them only for a read with `show_extra`
   * (`js_server.py:845-846`, deployed tree), which the tracker's GET cannot
   * send. `fetchBidTxns` is that read (`swap_bid.rs::swap_sidecar_bid_txns`).
   * Before it, every adaptor swap's details said the node had not reported
   * its transactions, and `sourceTxHash`/`destTxHash` stayed empty.
   */
  it("a bid read fetches the transactions, and the row names what you sent and received", async () => {
    vi.mocked(api.fetchBidTxns).mockResolvedValue(
      detail({ bid_state: "Completed", bid_state_ind: 8, txns: SHOW_TXNS_COMPLETED }),
    );
    const sink = createP2PHistorySink();
    await sink.placed(handle());
    // The GET carries no `txns`.
    await sink.bidRead(handle(), detail({ bid_state: "Completed", bid_state_ind: 8 }));
    expect(api.fetchBidTxns).toHaveBeenCalledWith(BID);
    const row = (await rowFor(BID))!;
    expect(row.bidTxns).toHaveLength(4);
    expect(row.sourceTxHash).toBe(txid("b1"));
    expect(row.destTxHash).toBe(txid("a2"));
  });

  it("reads once per state the bid reaches, never while it is still being requested", async () => {
    vi.mocked(api.fetchBidTxns).mockResolvedValue(detail());
    const sink = createP2PHistorySink();
    await sink.bidRead(handle(), detail({ bid_state: "Sent", bid_state_ind: 1 }));
    expect(api.fetchBidTxns).not.toHaveBeenCalled();
    await sink.bidRead(handle(), detail());
    await sink.bidRead(handle(), detail());
    expect(api.fetchBidTxns).toHaveBeenCalledTimes(1);
    await sink.bidRead(handle(), detail({ bid_state: "Script tx redeemed", bid_state_ind: 13 }));
    expect(api.fetchBidTxns).toHaveBeenCalledTimes(2);
    // A new session reads again.
    sink.reset();
    await sink.bidRead(handle(), detail({ bid_state: "Script tx redeemed", bid_state_ind: 13 }));
    expect(api.fetchBidTxns).toHaveBeenCalledTimes(3);
  });

  it("a read that fails is tried again on the next poll", async () => {
    const locks = [
      { type: "Chain A Lock", txid: txid("a1"), confirms: 3 },
      { type: "Chain B Lock", txid: txid("b1"), confirms: 1 },
    ];
    vi.mocked(api.fetchBidTxns)
      .mockRejectedValueOnce(new Error("the swap node is not running"))
      .mockResolvedValue(detail({ txns: locks }));
    const sink = createP2PHistorySink();
    await sink.bidRead(handle(), detail());
    expect((await rowFor(BID))!.bidTxns).toBeUndefined();
    await sink.bidRead(handle(), detail());
    expect(api.fetchBidTxns).toHaveBeenCalledTimes(2);
    expect((await rowFor(BID))!.bidTxns).toHaveLength(2);
  });

  it("the backfill reads each bid with its transactions, and falls back to the plain read", async () => {
    const fetchSentBids = vi.fn(async () => [
      sentBid({ bid_id: BID_2, bid_state: "Completed" }),
      sentBid({ bid_id: BID_3, bid_state: "Completed" }),
    ]);
    const fetchBidTxns = vi.fn(async (id: string) => {
      if (id === BID_2) return detail({ bid_state: "Completed", bid_state_ind: 8, txns: SHOW_TXNS_COMPLETED });
      // An older Rust build: no such command.
      throw new Error("Command swap_sidecar_bid_txns not found");
    });
    const fetchBid = vi.fn(async (_id: string) => detail({ bid_state: "Completed", bid_state_ind: 8 }));
    await backfillP2PHistory({ fetchSentBids, fetchBidTxns, fetchBid });
    expect((await rowFor(BID_2))!.bidTxns).toHaveLength(4);
    expect(fetchBid.mock.calls.map((c) => c[0])).toEqual([BID_3]);
    expect(await rowFor(BID_3)).toMatchObject({ status: "success", bidState: 8 });
  });

  it("the details' refresh fills a row that ended unwatched, and never makes one", async () => {
    vi.mocked(api.fetchBidTxns).mockResolvedValue(
      detail({ bid_state: "Completed", bid_state_ind: 8, txns: SHOW_TXNS_COMPLETED }),
    );
    const sink = createP2PHistorySink();
    expect(await sink.refreshTxns(BID)).toBe("read");
    expect(await rows()).toHaveLength(0);
    await sink.placed(handle());
    expect(await sink.refreshTxns(BID)).toBe("read");
    expect((await rowFor(BID))!.bidTxns).toHaveLength(4);
    vi.mocked(api.fetchBidTxns).mockResolvedValue({ error: "Unknown bid id" });
    expect(await sink.refreshTxns(BID)).toBe("failed");
  });

  it("the details ask the swap node nothing before P2P is switched on (2026-10-06)", async () => {
    // `swap-sidecar/index.ts`: nothing invokes a `swap_sidecar_*` command until
    // the user has accepted the setup screen. The details open on any P2P row,
    // switched on or not, so their read checks first.
    vi.mocked(api.fetchBidTxns).mockResolvedValue(
      detail({ bid_state: "Completed", bid_state_ind: 8, txns: SHOW_TXNS_COMPLETED }),
    );
    const optedIn = vi.fn(async () => false);
    const sink = createP2PHistorySink({ optedIn });
    await sink.placed(handle());
    vi.mocked(api.fetchBidTxns).mockClear();
    vi.mocked(api.fetchBid).mockClear();
    expect(await sink.refreshTxns(BID)).toBe("off");
    expect(optedIn).toHaveBeenCalledTimes(1);
    expect(api.fetchBidTxns).not.toHaveBeenCalled();
    expect(api.fetchBid).not.toHaveBeenCalled();
    expect((await rowFor(BID))!.bidTxns).toBeUndefined();
    // And the details say so, rather than "the node did not answer".
    expect(read("P2PSwapDetails.tsx")).toMatch(
      /case "off":\s*return "Peer-to-peer swaps are switched off/,
    );
  });

  it("the details ask once when they open, and say why the list is empty", async () => {
    const src = read("P2PSwapDetails.tsx");
    expect(src).toMatch(
      /useEffect\(\(\) => \{[\s\S]*?p2pSwapHistory\.refreshTxns\(bidId\)[\s\S]*?\}, \[bidId\]\);/,
    );
    await createP2PHistorySink().placed(handle());
    const html = renderToStaticMarkup(
      createElement(SwapDetailsModal, { entry: (await rowFor(BID))!, onClose: () => {} }),
    );
    expect(html).toContain('data-p2p-no-txns="reading"');
    expect(html).not.toContain("has not reported this swap");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Swaps where this node was the maker (2026-10-01)
// ═══════════════════════════════════════════════════════════════════════

/** `/json/active`'s row of a bid this node RECEIVED: the engine leaves
 *  `was_sent` unset on one (`processXmrBid`, deployed `basicswap.py:13033`),
 *  so the row says `null`. */
function receivedActiveRow(over: Partial<BasicSwapActiveSwap> = {}): BasicSwapActiveSwap {
  return activeRow({ was_sent: null as unknown as boolean, ...over });
}

/** `describeBid` of a bid this node received on its own LTC-for-XMR offer: a
 *  normal bid, so this node, the offerer, locked chain A (the scripted leg). */
function receivedDetail(over: Partial<BasicSwapBidDetail> & Record<string, unknown> = {}): BasicSwapBidDetail {
  return detail({ was_sent: null as unknown as boolean, was_received: true, ...over });
}

describe("swaps where this node was the maker (2026-10-01)", () => {
  it("a received swap in progress is a row, the maker's legs the right way round", async () => {
    // Operator: "Swaps where you were the maker (someone took your offer)
    // aren't listed." Before this, the in-progress list's `was_sent: null`
    // read as "sent", and the row came out in the taker's frame, legs swapped.
    await createP2PHistorySink().activeRead([receivedActiveRow()]);
    expect(await rowFor(BID)).toMatchObject({
      bidRole: "maker",
      // The offer sold LTC for XMR: the maker sent the LTC, received the XMR.
      fromAsset: "LTC",
      toAsset: "XMR",
      fromAmount: "0.09990000",
      toAmount: "0.010000000000",
      status: "pending",
    });
  });

  it("its record names the maker's leg: the offerer of a normal offer locked chain A", async () => {
    const sink = createP2PHistorySink();
    await sink.activeRead([receivedActiveRow()]);
    await sink.bidRead(
      handle({ sendCoin: "Litecoin", receiveCoin: "Monero", sendAmount: "0.09990000", receiveAmount: "0.010000000000" }),
      receivedDetail(),
    );
    expect(await rowFor(BID)).toMatchObject({ bidRole: "maker", bidLeg: "scripted", fromAsset: "LTC", toAsset: "XMR" });
  });

  it("a bid not yet accepted is a request, not a swap: no row; an error with coins locked is one", async () => {
    const sink = createP2PHistorySink();
    await sink.activeRead([
      receivedActiveRow({ bid_id: BID, bid_state: "Received" }),
      receivedActiveRow({ bid_id: BID_2, bid_state: "Auto accept delay" }),
      receivedActiveRow({ bid_id: BID_3, bid_state: "Error" }),
    ]);
    expect(await rows()).toHaveLength(0);
    await sink.activeRead([receivedActiveRow({ bid_id: BID_3, bid_state: "Error", tx_state_a: "Confirmed" })]);
    expect(await rowFor(BID_3)).toMatchObject({ bidRole: "maker", status: "pending" });
  });

  it("the backfill finds finished maker swaps on the received list, and reads only swaps", async () => {
    const fetchSentBids = vi.fn(async () => [sentBid({ bid_id: BID })]);
    const fetchBids = vi.fn(async () => [
      sentBid({ bid_id: BID_2, bid_state: "Completed", tx_state_a: "Redeemed", tx_state_b: "Redeemed" }),
      // A request nobody accepted: `strTxState` of no lock reads "Unknown".
      sentBid({ bid_id: BID_3, bid_state: "Expired", tx_state_a: "Unknown", tx_state_b: "Unknown" }),
      // On both lists: a bid this node sent and received itself.
      sentBid({ bid_id: BID }),
    ]);
    const fetchBidTxns = vi.fn(async (id: string) =>
      id === BID_2
        ? receivedDetail({ bid_state: "Completed", bid_state_ind: 8, txns: SHOW_TXNS_COMPLETED })
        : detail(),
    );
    await backfillP2PHistory({ fetchSentBids, fetchBids, fetchBidTxns });
    expect(fetchBids).toHaveBeenCalledWith({ limit: 100, sort_by: "created_at", sort_dir: "desc" });
    expect(fetchBidTxns.mock.calls.map((c) => c[0]).sort()).toEqual([BID, BID_2].sort());

    const maker = (await rowFor(BID_2))!;
    expect(maker).toMatchObject({
      bidRole: "maker",
      fromAsset: "LTC",
      toAsset: "XMR",
      fromAmount: "0.09990000",
      toAmount: "0.010000000000",
      status: "success",
      bidLeg: "scripted",
    });
    // The maker locked chain A (LTC) and claimed the taker's chain-B lock (XMR).
    expect(maker.sourceTxHash).toBe(txid("a1"));
    expect(maker.destTxHash).toBe(txid("b2"));
    expect(await rowFor(BID_3)).toBeUndefined();
    expect((await rows()).filter((r) => r.bidId === BID)).toHaveLength(1);
    expect(await rowFor(BID)).toMatchObject({ bidRole: "taker", fromAsset: "XMR", toAsset: "LTC" });
  });

  it("a row written in the taker's frame before this change is turned round, once", async () => {
    // What the in-progress reading wrote for a received bid until 2026-10-06.
    mem.set("swapHistory", [
      {
        id: p2pHistoryId(BID),
        fromAsset: "XMR",
        toAsset: "LTC",
        fromAmount: "0.010000000000",
        toAmount: "0.09990000",
        status: "pending",
        sourceTxHash: "",
        sourceExplorerUrl: "",
        provider: P2P_HISTORY_PROVIDER,
        createdAt: new Date(CREATED * 1000).toISOString(),
        bidId: BID,
        bidState: "Scriptless coin locked",
      } satisfies SwapHistoryEntry,
    ]);
    vi.mocked(api.fetchBidTxns).mockResolvedValue(receivedDetail());
    const sink = createP2PHistorySink();
    expect(await sink.refreshTxns(BID)).toBe("read");
    const fixed = (await rowFor(BID))!;
    expect(fixed).toMatchObject({
      bidRole: "maker",
      fromAsset: "LTC",
      toAsset: "XMR",
      fromAmount: "0.09990000",
      toAmount: "0.010000000000",
    });
    const saves = saveCount;
    expect(await sink.refreshTxns(BID)).toBe("read");
    expect(saveCount).toBe(saves);
    expect(await rowFor(BID)).toEqual(fixed);
  });

  it("the details tell the maker's side of acceptance and call the offer theirs", async () => {
    await createP2PHistorySink().activeRead([receivedActiveRow({ bid_state: "Accepted" })]);
    const row = (await rowFor(BID))!;
    expect(p2pStageView(row).description).toContain("Your node accepted the other user's bid");
    const html = renderToStaticMarkup(createElement(SwapDetailsModal, { entry: row, onClose: () => {} }));
    expect(html).toContain("your offer");
    expect(html).not.toContain("the other user&#x27;s offer");
  });

  it("history keeps the licence fee out of it: nothing here reads or writes one", () => {
    // The interface fee is a TAKER's (`sidecar_fees` sweeps `sentbids`
    // only). A maker row must not grow one.
    expect(read("p2p-history.ts")).not.toMatch(/sidecarFees|licenceFee|sidecar_fees_/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Where the bought coin was paid (2026-10-01)
// ═══════════════════════════════════════════════════════════════════════

describe("where the bought coin was paid (2026-10-01)", () => {
  const render = (entry: SwapHistoryEntry) =>
    renderToStaticMarkup(createElement(SwapDetailsModal, { entry, onClose: () => {} }));

  it("a bid that carried the user's address records it as the swap's payout address", async () => {
    const ltc = "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh";
    await createP2PHistorySink().placed(handle({ payoutAddress: ltc, payoutTo: "address" }));
    const row = (await rowFor(BID))!;
    expect(row).toMatchObject({ payoutTo: "address", recipient: ltc, bidRole: "taker" });
    expect(render(row)).toContain("payout address");
  });

  it("one that left it to the node says so, and names no address", async () => {
    await createP2PHistorySink().placed(
      handle({ payoutAddress: "LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez", payoutTo: "node-wallet" }),
    );
    const row = (await rowFor(BID))!;
    expect(row.payoutTo).toBe("node-wallet");
    expect(row.recipient).toBeUndefined();
    const html = render(row);
    expect(html).toContain('data-p2p-payout="node-wallet"');
    expect(html).toContain("your swap node&#x27;s LTC wallet");
  });
});

describe("which transaction is which", () => {
  const p2pRow = (over: Partial<SwapHistoryEntry>): SwapHistoryEntry => ({
    id: p2pHistoryId(BID),
    fromAsset: "XMR",
    toAsset: "LTC",
    fromAmount: "0.01",
    toAmount: "0.0999",
    status: "pending",
    sourceTxHash: "",
    sourceExplorerUrl: "",
    provider: P2P_HISTORY_PROVIDER,
    createdAt: new Date(CREATED * 1000).toISOString(),
    bidId: BID,
    ...over,
  });
  const roles = (r: SwapHistoryEntry) =>
    Object.fromEntries(p2pLegTransactions(r).map((t) => [t.txid, `${t.role} ${t.asset}`]));

  it("scripted leg (sent LTC for XMR): your chain-A lock, then your claim of their chain-B lock", () => {
    const r = p2pRow({ fromAsset: "LTC", toAsset: "XMR", bidTxns: SHOW_TXNS_COMPLETED });
    expect(roles(r)).toEqual({
      [txid("a1")]: "you-locked LTC",
      [txid("a2")]: "they-claimed LTC",
      [txid("b1")]: "they-locked XMR",
      [txid("b2")]: "you-claimed XMR",
    });
  });

  it("scriptless leg refunded: the chain-B spend is your own coin back, not a payout", () => {
    const txns = [
      { type: "Chain A Lock", txid: txid("a1") },
      { type: "Chain B Lock", txid: txid("b1") },
      { type: "Chain B Lock Spend", txid: txid("b2") },
      { type: "Chain A Lock Refund Tx", txid: txid("c1") },
      { type: "Chain A Lock Refund Spend Tx", txid: txid("c2") },
    ];
    const r = p2pRow({ bidTxns: txns, status: "refunded" });
    expect(roles(r)).toEqual({
      [txid("a1")]: "they-locked LTC",
      [txid("b1")]: "you-locked XMR",
      [txid("b2")]: "you-refunded XMR",
      [txid("c1")]: "pre-refund LTC",
      [txid("c2")]: "they-refunded LTC",
    });
    const next = applyP2PObservation(r, { bidId: BID, mayCreate: true }, "2026-10-01T00:00:00.000Z")!;
    expect(next.sourceTxHash).toBe(txid("b1"));
    expect(next.destTxHash).toBeUndefined();
  });

  it("the swipe pays the scriptless leg: that is what it received", () => {
    const txns = [
      { type: "Chain A Lock", txid: txid("a1") },
      { type: "Chain B Lock", txid: txid("b1") },
      { type: "Chain A Lock Refund Tx", txid: txid("c1") },
      { type: "Chain A Lock Refund Swipe Tx", txid: txid("c3") },
    ];
    const next = applyP2PObservation(p2pRow({}), { bidId: BID, txns, mayCreate: true }, "x")!;
    expect(next.destTxHash).toBe(txid("c3"));
  });

  it("a pair with no XMR, ZEPH or ZANO takes its chains from the bid's leg", () => {
    // The engine puts DOGE on chain B (`is_reverse_ads_bid`, deployed
    // `basicswap.py:3992`), and on BTC↔LTC chain A is whichever coin the offer
    // sells: no coin list can say which lock is whose. The leg can. Before
    // 2026-10-01 these rows named every transaction "other".
    const r = p2pRow({ fromAsset: "BTC", toAsset: "DOGE", bidLeg: "scripted", bidTxns: SHOW_TXNS_COMPLETED });
    expect(roles(r)).toEqual({
      [txid("a1")]: "you-locked BTC",
      [txid("a2")]: "they-claimed BTC",
      [txid("b1")]: "they-locked DOGE",
      [txid("b2")]: "you-claimed DOGE",
    });
    const flipped = p2pRow({ fromAsset: "LTC", toAsset: "BTC", bidLeg: "scriptless", bidTxns: SHOW_TXNS_COMPLETED });
    expect(roles(flipped)[txid("b1")]).toBe("you-locked LTC");
    expect(roles(flipped)[txid("a2")]).toBe("you-claimed BTC");
  });

  it("a scripted-to-scripted swap reports its two locks with the chain's ticker", () => {
    const d = detail({
      coin_from: "Bitcoin",
      coin_to: "Litecoin",
      initiate_tx: `${txid("1a")} BTC`,
      participate_tx: `${txid("2b")} LTC`,
    });
    expect(bidTxnsFrom(d)).toEqual([
      { type: "Initiate Tx", txid: txid("1a"), ticker: "BTC" },
      { type: "Participate Tx", txid: txid("2b"), ticker: "LTC" },
    ]);
    // "None" (upstream's not-yet) and anything that is not a txid are ignored.
    expect(bidTxnsFrom(detail({ initiate_tx: "None", participate_tx: "<b>x</b> LTC" }))).toEqual([]);
    const r = p2pRow({ fromAsset: "LTC", toAsset: "BTC", bidTxns: bidTxnsFrom(d) });
    expect(roles(r)).toEqual({ [txid("1a")]: "they-locked BTC", [txid("2b")]: "you-locked LTC" });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The open-tracker request
// ═══════════════════════════════════════════════════════════════════════

describe("Open live tracker", () => {
  it("reaches a listener and reports whether anyone heard it", () => {
    const target = new EventTarget();
    expect(requestSidecarTracker({ bidId: BID }, target)).toBe(false);
    const outcomes: string[] = [];
    target.addEventListener(OPEN_SIDECAR_TRACKER_EVENT, (e) => {
      const req = (e as CustomEvent<SidecarTrackerRequest>).detail;
      req.received = true;
      req.respond?.("opened");
    });
    expect(requestSidecarTracker({ bidId: BID, respond: (o) => outcomes.push(o) }, target)).toBe(true);
    expect(outcomes).toEqual(["opened"]);
    expect(requestSidecarTracker({ bidId: BID }, null)).toBe(false);
  });

  it("the tracker listens while enabled, and asks the opt-in before following an unknown bid", () => {
    const hook = read("../swap-sidecar/useSidecarSwap.ts");
    expect(hook).toContain("window.addEventListener(OPEN_SIDECAR_TRACKER_EVENT, onRequest)");
    const watch = hook.slice(hook.indexOf("const openOrWatch"), hook.indexOf("const tracked = useMemo"));
    expect(watch.indexOf("await assertOptedIn()")).toBeGreaterThan(0);
    expect(watch.indexOf("await assertOptedIn()")).toBeLessThan(watch.indexOf("setSwaps("));
    // Never a bid this session placed: no maker cool-down, no re-bid.
    expect(watch).toContain("retriedRef.current.add(req.bidId)");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The details a P2P row opens, and the lists
// ═══════════════════════════════════════════════════════════════════════

describe("the swap details of a P2P row", () => {
  const render = (entry: SwapHistoryEntry) =>
    renderToStaticMarkup(createElement(SwapDetailsModal, { entry, onClose: () => {} }));

  it("an unfinished swap: the stage in the tracker's words, the offer, and the way to the tracker", async () => {
    const sink = createP2PHistorySink();
    await sink.placed(handle());
    await sink.bidRead(handle(), detail());
    const html = render((await rowFor(BID))!);
    expect(html).toContain(`data-p2p-details="${BID}"`);
    expect(html).toContain('data-p2p-stage="waiting-counterparty"');
    expect(html).toContain("Waiting for the other user");
    expect(html).toContain("data-p2p-open-tracker");
    expect(html).toContain("Open live tracker");
    expect(html).toContain(OFFER);
    expect(html).toContain("the other user&#x27;s offer");
    // GET reads carry no txids for an adaptor swap: said, not left blank.
    expect(html).toContain("data-p2p-no-txns");
    expect(html).toContain(`>Grove P2P<`);
    // The live stage is the P2P section, so the NEAR-Intents-only line that
    // says there is none does not show (combining the branches, 2026-10-01).
    expect(html).not.toContain("Live status not available");
  });

  it("a finished swap: both legs with the wallet's explorer links, and no tracker button", async () => {
    const sink = createP2PHistorySink();
    await sink.bidRead(
      handle(),
      detail({ bid_state: "Completed", bid_state_ind: 8, txns: SHOW_TXNS_COMPLETED }),
    );
    const html = render((await rowFor(BID))!);
    expect(html).toContain('data-p2p-stage="done"');
    expect(html).not.toContain("Open live tracker");
    expect(html).toContain("you locked · XMR");
    expect(html).toContain("they locked · LTC");
    expect(html).toContain("you claimed · LTC");
    expect(html).toContain("they claimed · XMR");
    expect(html).toContain(`data-explorer-url="https://xmrchain.net/tx/${txid("b1")}"`);
    expect(html).not.toContain("data-p2p-no-txns");
  });

  it("is mounted by SwapDetailsModal for the p2p route only", () => {
    const src = read("SwapDetailsModal.tsx");
    expect(src).toContain('{route === "p2p" && <P2PSwapDetails row={shown} onClose={onClose} />}');
    expect(renderToStaticMarkup(createElement(SwapDetailsModal, { entry: NEAR_ROW, onClose: () => {} }))).not.toContain(
      "data-p2p-details",
    );
  });
});

describe("the lists show P2P rows and open their details", () => {
  it("every swap list reads the whole history: nothing filters a route out", () => {
    for (const rel of [
      "SwapLandscapeView.tsx",
      "SwapView.tsx",
      "../activity/ActivityLandscapeView.tsx",
      "../activity/ActivityViewPortrait.tsx",
    ]) {
      const src = read(rel);
      // Rows come from the store (directly or through Activity's hook)…
      expect(src, rel).toMatch(/loadSwapHistory\(\)|useSwapHistory\(\)/);
      // …and each opens the shared details (landscapeRouterParity pins the
      // mounts; this is the per-row half).
      expect(src, rel).toMatch(/\{\.\.\.swapRowOpenProps\(/);
      // No list singles out a route.
      expect(src, rel).not.toMatch(/\.filter\([^)]*(bidId|provider|depositAddress)/);
    }
  });

  it("a P2P row is in the history the lists load, in date order with the others", async () => {
    mem.set("swapHistory", [NEAR_ROW]);
    // Placed 2026-09-22, before the NEAR Intents swap of 2026-09-30.
    await createP2PHistorySink().placed(handle());
    expect((await rows()).map((r) => r.id)).toEqual(["near-1", p2pHistoryId(BID)]);
  });

  it("a P2P status change tells the lists, and Activity's list listens (it read once, before)", async () => {
    const sink = createP2PHistorySink();
    await sink.placed(handle());
    let told = 0;
    const off = onSwapHistoryChange(() => {
      told += 1;
    });
    await sink.bidRead(handle(), detail({ bid_state: "Completed", bid_state_ind: 8 }));
    off();
    expect(told).toBe(1);
    // The Swap tab's two lists subscribed on 2026-09-30; Activity's hook did
    // not, so a swap finishing while the user watched Activity stayed
    // "pending" there until they left the tab.
    const hook = read("../activity/swap-history-merge.ts");
    const body = hook.slice(hook.indexOf("export function useSwapHistory"), hook.indexOf("export function swapHashSet"));
    expect(body).toMatch(/useEffect\(\(\) => onSwapHistoryChange\(\(\) => setTick\(/);
  });

  it("Activity's chain-tx dedup knows a P2P swap's hashes", async () => {
    const sink = createP2PHistorySink();
    await sink.bidRead(
      handle(),
      detail({ bid_state: "Completed", bid_state_ind: 8, txns: SHOW_TXNS_COMPLETED }),
    );
    const set = swapHashSet(await rows());
    expect(set.has(txid("b1"))).toBe(true);
    expect(set.has(txid("a2"))).toBe(true);
  });
});
