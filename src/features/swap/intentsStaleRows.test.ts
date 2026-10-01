/**
 * Pending NEAR Intents rows that nothing could settle (operator report,
 * 2026-10-01: "Why are two swaps from weeks ago still labeled pending?").
 *
 * The operator's two ETH → BTC rows of 2026-05-06 had no deposit address, so
 * 1Click could never be asked about them, and their source hashes are unknown
 * to three Ethereum nodes; the third attempt at the same swap is the address's
 * first mined transaction (nonce 0). Hashes and addresses below are invented.
 */
import { describe, expect, it, vi } from "vitest";
import type { SwapHistoryEntry } from "./swap-history-store";
import { normalizeLegacyAmounts } from "./swap-history-store";
import {
  NOT_SENT_AFTER_MS,
  needsSettling,
  patchForVerdict,
  settleStaleIntentsRows,
  staleVerdict,
} from "./intents-stale-rows";
import { swapStatusLabel, swapStatusView } from "./swap-details";
import { rowsToResume, resumePendingIntentsSwaps } from "./intents-status-resume";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const DEPOSIT = "0x1111111111111111111111111111111111111111";
const OWN = "0x2222222222222222222222222222222222222222";

const row = (extra: Partial<SwapHistoryEntry> = {}): SwapHistoryEntry => ({
  id: "r1",
  fromAsset: "ETH",
  toAsset: "BTC",
  fromAmount: "0.005",
  toAmount: "0.00012521",
  status: "pending",
  sourceTxHash: "0x" + "ab".repeat(32),
  sourceExplorerUrl: "",
  provider: "NEAR Intents · solver-relay",
  createdAt: "2026-05-06T22:58:05.687Z",
  ...extra,
});

describe("which rows only their source transaction can settle", () => {
  it("a pending NEAR Intents row with a source hash and no deposit address", () => {
    expect(needsSettling(row())).toBe(true);
    expect(needsSettling(row({ depositAddress: DEPOSIT }))).toBe(false);
    expect(needsSettling(row({ sourceTxHash: "" }))).toBe(false);
    expect(needsSettling(row({ status: "success" }))).toBe(false);
    expect(needsSettling(row({ provider: "Pwnda Desk · desk" }))).toBe(false);
  });
});

describe("staleVerdict", () => {
  it("a deposit not on an EVM chain days later was never mined: not sent", () => {
    expect(staleVerdict(row(), { status: "done", parties: null }, NOW, [])).toEqual({ kind: "not-sent" });
  });

  it("a young row is left alone (the deposit may still be mined)", () => {
    const young = row({ createdAt: new Date(NOW - NOT_SENT_AFTER_MS + 60_000).toISOString() });
    expect(staleVerdict(young, { status: "done", parties: null }, NOW, [])).toBeNull();
  });

  it("an unknown hash proves nothing on a chain whose public nodes prune history", () => {
    expect(staleVerdict(row({ fromAsset: "SUI" }), { status: "done", parties: null }, NOW, [])).toBeNull();
  });

  it("a read that failed or is still running settles nothing", () => {
    expect(staleVerdict(row(), { status: "error", message: "HTTP 503" }, NOW, [])).toBeNull();
    expect(staleVerdict(row(), { status: "loading" }, NOW, [])).toBeNull();
  });

  it("a deposit on its chain names the deposit address", () => {
    const v = staleVerdict(row(), { status: "done", parties: { from: [OWN], to: [DEPOSIT] } }, NOW, [OWN]);
    expect(v).toEqual({ kind: "deposit-address", depositAddress: DEPOSIT });
  });

  it("a UTXO deposit's change is told apart only when the wallet knows it as its own", () => {
    const btc = row({ fromAsset: "BTC", toAsset: "ETH" });
    const parties = { status: "done" as const, parties: { from: ["bc1qme"], to: ["bc1qdeposit", "bc1qchange"] } };
    expect(staleVerdict(btc, parties, NOW, ["bc1qme", "bc1qchange"])).toEqual({
      kind: "deposit-address",
      depositAddress: "bc1qdeposit",
    });
    // Two outputs neither known as the wallet's: not guessed.
    expect(staleVerdict(btc, parties, NOW, ["bc1qme"])).toBeNull();
  });
});

describe("settling and showing a row", () => {
  it("not sent: failed with its reason, shown as \"Not sent\" and listed as \"not sent\"", () => {
    const patch = patchForVerdict({ kind: "not-sent" }, NOW);
    expect(patch).toMatchObject({ status: "failed", failureReason: "deposit-not-on-chain", outcomeUnknown: false });
    const settled = row(patch);
    expect(swapStatusLabel(settled)).toBe("not sent");
    const view = swapStatusView(settled);
    expect(view.key).toBe("not-sent");
    expect(view.detail).toContain("nothing left your wallet");
    // An ordinary failure still reads as one.
    expect(swapStatusLabel(row({ status: "failed" }))).toBe("failed");
  });

  it("settleStaleIntentsRows patches each row and returns the recovered ones", async () => {
    const update = vi.fn(async () => {});
    const recovered = await settleStaleIntentsRows(
      [row({ id: "never" }), row({ id: "found", sourceTxHash: "0x" + "cd".repeat(32) }), row({ id: "done", status: "success" })],
      {
        readParties: async (_c, hash) =>
          hash.startsWith("0xcd") ? { status: "done", parties: { from: [OWN], to: [DEPOSIT] } } : { status: "done", parties: null },
        update,
        now: () => NOW,
        ownAddresses: () => [OWN],
      },
    );
    expect(update).toHaveBeenCalledWith("never", expect.objectContaining({ failureReason: "deposit-not-on-chain" }));
    expect(update).toHaveBeenCalledWith("found", { depositAddress: DEPOSIT });
    expect(update).toHaveBeenCalledTimes(2);
    expect(recovered.map((r) => r.id)).toEqual(["found"]);
  });

  it("the resume pass asks 1Click about a recovered row however old it is", async () => {
    const old = row({ id: "found" });
    expect(rowsToResume([{ ...old, depositAddress: DEPOSIT }], NOW, () => false)).toHaveLength(0);
    const poll = vi.fn(async () => ({ status: "SUCCESS" }));
    const update = vi.fn(async () => {});
    const n = await resumePendingIntentsSwaps({
      load: async () => [old],
      update,
      poll: poll as never,
      isActive: () => false,
      now: () => NOW,
      settle: async () => [{ ...old, depositAddress: DEPOSIT }],
    });
    expect(n).toBe(1);
    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ depositAddress: DEPOSIT }));
    expect(update).toHaveBeenCalledWith("found", expect.objectContaining({ status: "success" }));
  });
});

describe("amounts of rows older than the repository's history", () => {
  it("a 2026-05-06 row's base-unit toAmount reads in BTC", () => {
    const legacy = row({ toAmount: "12521" });
    expect(normalizeLegacyAmounts(legacy).toAmount).toBe("0.00012521");
  });

  it("a later integer amount, or a decimal one, is left as written", () => {
    expect(normalizeLegacyAmounts(row({ toAmount: "12521", createdAt: "2026-05-28T00:00:00Z" })).toAmount).toBe("12521");
    expect(normalizeLegacyAmounts(row({ toAmount: "0.00012521" })).toAmount).toBe("0.00012521");
  });
});
