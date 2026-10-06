/**
 * The browser sandbox shows P2P rows in the swap lists (2026-10-01).
 *
 * `npm run dev:sandbox` with `VITE_MOCK_STATE=swap_swiped` (or
 * `swap_refunding`, `swap_sidecar_active`) runs `useSidecarSwap` against the
 * mock swap node: its `/json/active` read reaches the history sink, and the
 * sink's first-answer backfill reads `/json/sentbids` and each bid's record.
 * These tests run that same data path through the real dispatcher (`getMock`,
 * as `sidecarMockShapes.test.ts` does), so what the lead sees in the sandbox
 * is already pinned: the scenario's in-flight bid AND one finished swap that
 * only the backfill can find.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, unknown>();
vi.mock("../../store", () => ({
  getStore: async () => ({
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: unknown) => {
      mem.set(k, v);
    },
    save: async () => undefined,
  }),
}));

import { loadSwapHistory } from "./swap-history-store";
import { createP2PHistorySink, P2P_HISTORY_PROVIDER } from "./p2p-history";
import type {
  BasicSwapActiveSwap,
  BasicSwapBidDetail,
  BasicSwapBidSummary,
  BidQuery,
} from "../../api/basicswap";

let getMock: <T = unknown>(cmd: string, args?: unknown) => T;

beforeAll(async () => {
  vi.stubEnv("VITE_MOCK_STATE", "swap_swiped");
  ({ getMock } = await import("../../lib/tauri-mocks"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  mem.clear();
});

/** The reads `api/basicswap.ts` makes, answered by the sandbox. Since
 *  2026-10-01 the received half of the book and the transactions read too. */
const deps = {
  fetchSentBids: async (query: BidQuery = {}) =>
    getMock<BasicSwapBidSummary[]>("swap_sidecar_api_post", {
      path: "sentbids",
      body: { with_extra_info: true, ...query },
    }),
  fetchBids: async (query: BidQuery = {}) =>
    getMock<BasicSwapBidSummary[]>("swap_sidecar_api_post", {
      path: "bids",
      body: { with_extra_info: true, ...query },
    }),
  fetchBid: async (bidId: string) =>
    getMock<BasicSwapBidDetail>("swap_sidecar_api_get", { path: `bids/${bidId}` }),
  fetchBidTxns: async (bidId: string) => getMock<BasicSwapBidDetail>("swap_sidecar_bid_txns", { bidId }),
};

describe("the sandbox's swap node feeds the swap lists", () => {
  it("the in-flight bid, a finished one and a maker's swap only the backfill knows become rows", async () => {
    const active = getMock<BasicSwapActiveSwap[]>("swap_sidecar_api_get", { path: "active" });
    expect(active).toHaveLength(1);
    await createP2PHistorySink(deps).activeRead(active);

    const rows = await loadSwapHistory();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.provider).toBe(P2P_HISTORY_PROVIDER);

    // The live 2026-09-08 shape: this node sent XMR and swiped the LTC lock
    // after the deadline. Its own record names the leg, so the row is the
    // success it was for this side, not the neutral "recovered by the other
    // user".
    const swiped = rows.find((r) => r.bidId === active[0].bid_id)!;
    expect(swiped).toMatchObject({
      fromAsset: "XMR",
      toAsset: "LTC",
      status: "success",
      bidState: 18,
      bidLeg: "scriptless",
    });

    // The swipe's transactions, from the transactions read (2026-10-01):
    // this node sent XMR, so its lock is chain B, and the swipe paid it.
    expect(swiped.bidTxns?.map((t) => t.type)).toEqual([
      "Chain A Lock",
      "Chain B Lock",
      "Chain A Lock Refund Tx",
      "Chain A Lock Refund Swipe Tx",
    ]);
    expect(swiped.sourceTxHash).toBe(swiped.bidTxns![1].txid);
    expect(swiped.destTxHash).toBe(swiped.bidTxns![3].txid);

    // The finished swap from two days ago, from `/json/sentbids` alone.
    const backfilled = rows.find((r) => r.bidId !== active[0].bid_id && r.bidRole === "taker")!;
    expect(backfilled).toMatchObject({
      fromAsset: "XMR",
      toAsset: "LTC",
      fromAmount: "0.025000000000",
      toAmount: "0.24650000",
      status: "success",
      bidState: 8,
    });
    expect(backfilled.bidTxns).toHaveLength(4);

    // The maker's swap from three days ago, from `/json/bids` alone: this node
    // posted the offer, so it SENT the LTC and RECEIVED the XMR.
    const maker = rows.find((r) => r.bidRole === "maker")!;
    expect(maker).toMatchObject({
      fromAsset: "LTC",
      toAsset: "XMR",
      fromAmount: "0.30000000",
      toAmount: "0.030000000000",
      status: "success",
      bidLeg: "scripted",
    });
    expect(maker.bidTxns).toHaveLength(4);
    expect(maker.sourceTxHash).toBe(maker.bidTxns!.find((t) => t.type === "Chain A Lock")!.txid);
  });

  it("the transactions read refuses what Rust refuses", () => {
    expect(() => getMock("swap_sidecar_bid_txns", { bidId: "new" })).toThrow("not a valid bid id");
    // Rust's allow-list: no key share, no view key, no event log.
    const active = getMock<BasicSwapActiveSwap[]>("swap_sidecar_api_get", { path: "active" });
    const rec = getMock<Record<string, unknown>>("swap_sidecar_bid_txns", { bidId: active[0].bid_id });
    for (const k of ["events", "addr_from", "xmr_b_half_privatekey", "debug_ui"]) {
      expect(rec[k], k).toBeUndefined();
    }
  });

  it("the finished swaps are not in-flight ones to the shared-coin send guard", () => {
    const all = getMock<BasicSwapBidSummary[]>("swap_sidecar_api_post", {
      path: "sentbids",
      body: { with_extra_info: true },
    });
    const inFlight = getMock<BasicSwapBidSummary[]>("swap_sidecar_api_post", {
      path: "sentbids",
      body: { with_extra_info: true, with_available_or_active: true },
    });
    expect(all).toHaveLength(2);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0].bid_state).toBe("Failed, swiped");
    // The received half: the maker's finished swap, and nothing in flight.
    expect(
      getMock<BasicSwapBidSummary[]>("swap_sidecar_api_post", { path: "bids", body: {} }),
    ).toHaveLength(1);
    expect(
      getMock<BasicSwapBidSummary[]>("swap_sidecar_api_post", {
        path: "bids",
        body: { with_available_or_active: true },
      }),
    ).toHaveLength(0);
  });
});
