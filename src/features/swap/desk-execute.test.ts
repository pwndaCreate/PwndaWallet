/**
 * Regression locks for the desk accept path.
 *
 * `deskAccept` is this flow's point of no return — it reserves desk inventory
 * and creates a persisted swap. The governing assertion in every test below is
 * therefore the same one `swap-execute.test.ts` makes about broadcast: when
 * anything fails, the irreversible call must NEVER have been attempted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deskAcceptMock = vi.fn();
const deskQuoteMock = vi.fn();

vi.mock("../../api/desk-rust", () => ({
  deskAccept: (...a: unknown[]) => deskAcceptMock(...a),
  deskQuote: (...a: unknown[]) => deskQuoteMock(...a),
}));

// `startDeskSwap` reads live/mock state through router-modes rather than
// import.meta.env, so this is the seam that flips the hard-stop.
let isLive = true;
vi.mock("./router-modes", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    effectiveModeForSource: (source: string) =>
      source === "pwnda-desk"
        ? { isLive, mockDetected: !isLive, banner: "", bannerColor: "amber" }
        : (actual.effectiveModeForSource as (s: string) => unknown)(source),
  };
});

import { DeskMockAttemptedError, startDeskSwap } from "./desk-execute";
import { SafetyInvariantError } from "./safety-invariants";
import type { NormalizedQuote } from "./useSwapQuote";

const NOW = 1_000_000;

function deskQuoteObj(over: Record<string, unknown> = {}) {
  return {
    quoteId: "q_1",
    pair: "XMR/ADA",
    direction: "SELL_FOLLOWER",
    deskRole: "LEADER",
    coinIn: "XMR",
    coinOut: "ADA",
    amountIn: "0.1",
    amountOut: "27",
    rate: "270",
    mid: "300",
    markup: 0.1,
    sTotal: 0.1,
    expiresAt: NOW + 60,
    minConfsIn: 10,
    minConfsOut: 3,
    t0Seconds: 1200,
    t1Seconds: 2400,
    t2Seconds: 3600,
    ...over,
  };
}

function quote(over: Record<string, unknown> = {}): NormalizedQuote {
  return {
    source: "pwnda-desk",
    routerLabel: "Pwnda Desk",
    providerName: "desk-leader",
    mockDetected: false,
    deskQuote: deskQuoteObj(over) as never,
    expiresAt: (deskQuoteObj(over) as { expiresAt: number }).expiresAt,
    expectedReceive: "27",
    minReceived: "27",
    totalFeesSource: "0",
    affiliateFeeSource: "0",
    etaSeconds: 1200,
    etaPretty: "~20m",
    warnings: [],
  } as NormalizedQuote;
}

function baseArgs(over: Record<string, unknown> = {}) {
  return {
    quote: quote(),
    fromAsset: "XMR",
    toAsset: "ADA",
    fromDecimals: 12,
    typedAmount: "0.1",
    payoutAddress: "addr_payout",
    refundAddress: "addr_refund",
    nowSeconds: () => NOW,
    ...over,
  } as Parameters<typeof startDeskSwap>[0];
}

beforeEach(() => {
  deskAcceptMock.mockReset();
  deskQuoteMock.mockReset();
  deskAcceptMock.mockResolvedValue({ swapId: "s_1", state: "ACCEPTED" });
  deskQuoteMock.mockResolvedValue(deskQuoteObj({ quoteId: "q_fresh", expiresAt: NOW + 120 }));
  isLive = true;
});

describe("startDeskSwap — happy path", () => {
  it("accepts and returns the persisted summary", async () => {
    const s = await startDeskSwap(baseArgs());
    expect(s.swapId).toBe("s_1");
    expect(deskAcceptMock).toHaveBeenCalledTimes(1);
    expect(deskAcceptMock).toHaveBeenCalledWith({
      quoteId: "q_1",
      pair: "XMR/ADA",
      direction: "SELL_FOLLOWER",
      payoutAddress: "addr_payout",
      refundAddress: "addr_refund",
    });
  });

  it("forwards the quote's own pair/direction, since they pick the key role", async () => {
    // The core derives Leader-vs-Follower from `direction`, and the role
    // decides whether this swap contributes an adaptor point at all. Passing a
    // value re-derived from the assets instead of read off the accepted quote
    // is how that goes silently wrong.
    await startDeskSwap(
      baseArgs({
        quote: quote({ pair: "ZEPH/ADA", direction: "BUY_FOLLOWER" }),
      })
    );
    expect(deskAcceptMock).toHaveBeenCalledWith(
      expect.objectContaining({ pair: "ZEPH/ADA", direction: "BUY_FOLLOWER" })
    );
  });

  it("does not re-quote a fresh quote", async () => {
    await startDeskSwap(baseArgs());
    expect(deskQuoteMock).not.toHaveBeenCalled();
  });

  it("reports phases in order", async () => {
    const phases: string[] = [];
    await startDeskSwap(baseArgs({ onPhase: (p: string) => phases.push(p) }));
    expect(phases).toEqual(["checking-quote", "accepting", "accepted"]);
  });

  it("never fabricates a source tx hash — a desk swap signs nothing in TS", async () => {
    const s = (await startDeskSwap(baseArgs())) as unknown as Record<
      string,
      unknown
    >;
    expect(s.sourceTxHash).toBeUndefined();
  });
});

describe("startDeskSwap — expired quote", () => {
  it("re-quotes EXACTLY once, then accepts against the fresh quote", async () => {
    const args = baseArgs({ quote: quote({ expiresAt: NOW - 1 }) });
    await startDeskSwap(args);
    expect(deskQuoteMock).toHaveBeenCalledTimes(1);
    // The accept must use the FRESH quoteId, not the stale one on screen.
    expect(deskAcceptMock).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "q_fresh" })
    );
  });

  it("re-quotes when inside the freshness margin, not only after the deadline", async () => {
    // Deadline is 3s away; the 5s margin means this is already too stale.
    await startDeskSwap(baseArgs({ quote: quote({ expiresAt: NOW + 3 }) }));
    expect(deskQuoteMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT loop when the re-quote comes back already stale", async () => {
    deskQuoteMock.mockResolvedValue(deskQuoteObj({ expiresAt: NOW - 100 }));
    await expect(
      startDeskSwap(baseArgs({ quote: quote({ expiresAt: NOW - 1 }) }))
    ).rejects.toBeInstanceOf(SafetyInvariantError);
    expect(deskQuoteMock).toHaveBeenCalledTimes(1);
    expect(deskAcceptMock).not.toHaveBeenCalled();
  });

  it("emits the requoting phase", async () => {
    const phases: string[] = [];
    await startDeskSwap(
      baseArgs({
        quote: quote({ expiresAt: NOW - 1 }),
        onPhase: (p: string) => phases.push(p),
      })
    );
    expect(phases).toEqual(["checking-quote", "requoting", "accepting", "accepted"]);
  });
});

describe("startDeskSwap — the amount invariant", () => {
  it("refuses when the quote's amountIn does not match what the user typed", async () => {
    await expect(
      startDeskSwap(baseArgs({ typedAmount: "5" })) // quote is for 0.1
    ).rejects.toBeInstanceOf(SafetyInvariantError);
    // The governing assertion: the irreversible call was never attempted.
    expect(deskAcceptMock).not.toHaveBeenCalled();
  });

  it("does NOT truncate a sub-1 decimal to zero (the atomic-parser trap)", async () => {
    // "0.1" through an atomic parser becomes 0n and would trip the
    // zero-intent branch with a misleading "form-state bug" message.
    await expect(startDeskSwap(baseArgs())).resolves.toBeTruthy();
  });

  it("tolerates sub-1% drift", async () => {
    await startDeskSwap(baseArgs({ typedAmount: "0.1004" }));
    expect(deskAcceptMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an unparseable typed amount", async () => {
    await expect(
      startDeskSwap(baseArgs({ typedAmount: "abc" }))
    ).rejects.toBeInstanceOf(SafetyInvariantError);
    expect(deskAcceptMock).not.toHaveBeenCalled();
  });
});

describe("startDeskSwap — addresses", () => {
  it("refuses a missing payout or refund address", async () => {
    await expect(startDeskSwap(baseArgs({ payoutAddress: "" }))).rejects.toThrow();
    await expect(startDeskSwap(baseArgs({ refundAddress: "" }))).rejects.toThrow();
    expect(deskAcceptMock).not.toHaveBeenCalled();
  });

  it("refuses identical payout and refund addresses", async () => {
    await expect(
      startDeskSwap(baseArgs({ payoutAddress: "same", refundAddress: "same" }))
    ).rejects.toThrow(/identical/i);
    expect(deskAcceptMock).not.toHaveBeenCalled();
  });
});

describe("startDeskSwap — mock hard-stop", () => {
  it("throws DeskMockAttemptedError and NEVER accepts when the desk is not live", async () => {
    isLive = false;
    await expect(startDeskSwap(baseArgs())).rejects.toBeInstanceOf(
      DeskMockAttemptedError
    );
    expect(deskAcceptMock).not.toHaveBeenCalled();
  });

  it("carries desk-shaped fields, not signed-tx fields", async () => {
    isLive = false;
    const err = await startDeskSwap(baseArgs()).catch((e) => e);
    expect(err).toBeInstanceOf(DeskMockAttemptedError);
    expect(err.quoteId).toBe("q_1");
    expect(err.pair).toBe("XMR/ADA");
    expect(err.direction).toBe("SELL_FOLLOWER");
    expect(err.amountIn).toBe("0.1");
    expect(err.reason).toBe("ENV_FLAG_MOCK");
    // Would make a shared mock-stop footer render a signed-tx textarea for a
    // flow that never signed anything.
    expect(err.signedTxHex).toBeUndefined();
  });

  it("still runs the invariants first, so testing mode exercises live validation", async () => {
    isLive = false;
    // A bad amount must fail as a SafetyInvariantError, NOT as the mock stop —
    // otherwise testing mode would silently skip the checks live mode relies on.
    await expect(
      startDeskSwap(baseArgs({ typedAmount: "5" }))
    ).rejects.toBeInstanceOf(SafetyInvariantError);
  });
});
