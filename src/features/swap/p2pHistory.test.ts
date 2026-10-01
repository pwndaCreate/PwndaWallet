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
  // The sink backfills on its first in-progress answer; by default the node
  // has sent nothing else.
  vi.mocked(api.fetchSentBids).mockResolvedValue([]);
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
  // bidStates.ts reads "mercy used" as a refund; history follows the tracker.
  XMR_SWAP_FAILED_SWIPED_USED_MERCY: ["refunded", "refunded", "refunded"],
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
    expect(result).toEqual({ ok: true, bidId: BID });
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

  it("a bid this node RECEIVED is not a row", async () => {
    const sink = createP2PHistorySink();
    await sink.activeRead([activeRow({ was_sent: false })]);
    await sink.bidRead(handle(), detail({ was_sent: false, was_received: true }));
    expect(await rows()).toHaveLength(0);
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
