/**
 * The pre-send check for a Grove-shared coin.
 *
 * Incident, 2026-09-12: an LTC send failed with no message because it was
 * routed THROUGH Grove while Grove was restarting (engine log `HTTP server
 * stopped.` 21:35:39 → `Starting BasicSwap` 21:38:44) and then came back
 * without the LTC account key. The send now signs locally; Grove is only asked
 * whether a swap is using the coin. These tests pin both directions of that
 * question: a definite in-flight swap refuses, and a Grove that cannot answer
 * never blocks an ordinary send.
 */
import { describe, it, expect, vi } from "vitest";
import {
  bidCoinMatches,
  checkSharedCoinSend,
  countInFlightBidsForCoin,
  inFlightBidsForCoin,
  sharedSendCoinFor,
  sharedSendRefusal,
  SHARED_SEND_ENGINE_COIN,
  type SharedSendDeps,
} from "./sharedCoinSendGuard";
import { SHARED_COIN_CHAINS } from "./sharedCoinBalance";

const row = (bid_id: string, coin_from: string, coin_to: string) => ({
  bid_id,
  coin_from,
  coin_to,
});

function deps(bids: unknown, sent: unknown): SharedSendDeps {
  return {
    fetchBids: vi.fn(async () => bids) as never,
    fetchSentBids: vi.fn(async () => sent) as never,
    timeoutMs: 200,
  };
}

describe("bidCoinMatches mirrors the Rust gate", () => {
  it("matches display names by normalised equality", () => {
    expect(bidCoinMatches("Litecoin", "litecoin")).toBe(true);
    expect(bidCoinMatches("Bitcoin Cash", "bitcoincash")).toBe(true);
  });

  it("never counts a Bitcoin Cash bid as Bitcoin (no prefix test)", () => {
    expect(bidCoinMatches("Bitcoin Cash", "bitcoin")).toBe(false);
  });

  it("counts the MWEB variant as Litecoin", () => {
    expect(bidCoinMatches("Litecoin MWEB", "litecoin")).toBe(true);
  });
});

describe("countInFlightBidsForCoin", () => {
  it("counts either leg and dedupes across bids + sentbids", () => {
    const a = [row("b1", "Litecoin", "Monero"), row("b2", "Monero", "Zano")];
    const b = [row("b1", "Litecoin", "Monero"), row("b3", "Bitcoin", "Litecoin")];
    expect(countInFlightBidsForCoin([a, b], "litecoin")).toBe(2);
  });

  it("an engine error object is unknown, not zero", () => {
    expect(
      countInFlightBidsForCoin([[], { error: "Wallet locked", locked: true }], "litecoin"),
    ).toBeNull();
  });

  it("positive control: empty lists are a real zero", () => {
    expect(countInFlightBidsForCoin([[], []], "litecoin")).toBe(0);
  });
});

describe("sharedSendRefusal", () => {
  it("refuses only on a definite non-zero count", () => {
    expect(sharedSendRefusal("LTC", 1)).toMatch(/1 swap in progress that uses LTC/);
    expect(sharedSendRefusal("LTC", 2)).toMatch(/2 swaps in progress that use LTC/);
  });

  it("sends when Grove answered zero or did not answer", () => {
    expect(sharedSendRefusal("LTC", 0)).toBeNull();
    expect(sharedSendRefusal("LTC", null)).toBeNull();
  });
});

describe("inFlightBidsForCoin never blocks on an absent Grove", () => {
  it("a stopped node (invoke rejects) reads as unknown", async () => {
    const d: SharedSendDeps = {
      fetchBids: vi.fn(async () => {
        throw new Error("the swap node is not running");
      }) as never,
      fetchSentBids: vi.fn(async () => []) as never,
    };
    expect(await inFlightBidsForCoin("litecoin", d)).toBeNull();
  });

  it("a hung node reads as unknown after the timeout", async () => {
    const d: SharedSendDeps = {
      fetchBids: vi.fn(() => new Promise(() => {})) as never,
      fetchSentBids: vi.fn(() => new Promise(() => {})) as never,
      timeoutMs: 20,
    };
    expect(await inFlightBidsForCoin("litecoin", d)).toBeNull();
  });
});

describe("checkSharedCoinSend", () => {
  it("refuses an LTC send while an LTC swap is active", async () => {
    const msg = await checkSharedCoinSend(
      "litecoin",
      deps([], [row("b9", "Litecoin", "Monero")]),
    );
    expect(msg).toMatch(/Nothing was sent/);
  });

  it("sends LTC while Grove is locked (the 2026-09-12 state)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg = await checkSharedCoinSend(
      "litecoin",
      deps({ error: "Wallet locked", locked: true }, []),
    );
    expect(msg).toBeNull();
    warn.mockRestore();
  });

  it("does not ask Grove about a chain it cannot share", async () => {
    const d = deps([], []);
    expect(await checkSharedCoinSend("ethereum", d)).toBeNull();
    expect(d.fetchBids).not.toHaveBeenCalled();
  });

  it("every shareable coin has an engine key, so none skips the check", () => {
    for (const [ticker, chain] of Object.entries(SHARED_COIN_CHAINS)) {
      expect(SHARED_SEND_ENGINE_COIN[ticker], ticker).toBeTruthy();
      expect(sharedSendCoinFor(chain)?.ticker).toBe(ticker);
    }
  });
});
