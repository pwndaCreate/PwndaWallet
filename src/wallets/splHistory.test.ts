/**
 * SPL token history (USDC / USDT on Solana) — found while tracing the
 * operator's 2026-09-30 report of Activity errors: the reader ended in
 * `.catch(() => [])`, so when every Solana RPC failed the Activity tab said
 * "no transactions" for the leg instead of showing a failure — the same
 * silent-empty shape as BSC's "chain not supported". It also labelled every
 * confirmed transfer "unconfirmed" (`finalized ? 1 : 0`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ run: undefined as undefined | (() => Promise<unknown>) }));
vi.mock("./sol-wallet", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./sol-wallet")>();
  return { ...orig, runOnAnySolanaRpc: () => h.run!() };
});

import { usdcSolAdapter } from "./spl-token-wallet";

const OWNER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

beforeEach(() => {
  h.run = undefined;
});

describe("USDC on Solana history", () => {
  it("throws when no RPC answers — the old reader returned an empty list", async () => {
    h.run = async () => {
      throw new Error("All Solana RPCs failed: 429, 403, 503");
    };
    await expect(usdcSolAdapter.getTransactionHistory(OWNER)).rejects.toThrow(/All Solana RPCs failed/);
  });

  it("a confirmed signature has its slot as the block and no invented count; a failed one is `failed`", async () => {
    h.run = async () => [
      { signature: "5sig", slot: 380000000, blockTime: 1790000000, confirmationStatus: "finalized", err: null },
      { signature: "6sig", slot: 380000001, blockTime: 1790000100, confirmationStatus: "processed", err: null },
      { signature: "7sig", slot: 380000002, blockTime: 1790000200, confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } },
    ];
    const { items } = await usdcSolAdapter.getTransactionHistory(OWNER);
    expect(items.map((t) => [t.hash, t.direction, t.height, t.confirmations])).toEqual([
      ["5sig", "pending", 380000000, undefined],
      ["6sig", "pending", 380000001, 0],
      ["7sig", "failed", 380000002, undefined],
    ]);
  });
});
