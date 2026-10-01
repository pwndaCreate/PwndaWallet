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

/** The two reads `api/basicswap.ts` makes, answered by the sandbox. */
const deps = {
  fetchSentBids: async (query: BidQuery = {}) =>
    getMock<BasicSwapBidSummary[]>("swap_sidecar_api_post", {
      path: "sentbids",
      body: { with_extra_info: true, ...query },
    }),
  fetchBid: async (bidId: string) =>
    getMock<BasicSwapBidDetail>("swap_sidecar_api_get", { path: `bids/${bidId}` }),
};

describe("the sandbox's swap node feeds the swap lists", () => {
  it("the in-flight bid and a finished one only the backfill knows both become rows", async () => {
    const active = getMock<BasicSwapActiveSwap[]>("swap_sidecar_api_get", { path: "active" });
    expect(active).toHaveLength(1);
    await createP2PHistorySink(deps).activeRead(active);

    const rows = await loadSwapHistory();
    expect(rows).toHaveLength(2);
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

    // The finished swap from two days ago, from `/json/sentbids` alone.
    const backfilled = rows.find((r) => r.bidId !== active[0].bid_id)!;
    expect(backfilled).toMatchObject({
      fromAsset: "XMR",
      toAsset: "LTC",
      fromAmount: "0.025000000000",
      toAmount: "0.24650000",
      status: "success",
      bidState: 8,
    });
  });

  it("the finished swap is not an in-flight one to the shared-coin send guard", () => {
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
  });
});
