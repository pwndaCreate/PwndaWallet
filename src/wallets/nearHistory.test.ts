/**
 * NEAR history from NearBlocks (operator report 2026-09-30: NEAR was listed
 * among the Activity header's "errors" because the adapter threw "NEAR
 * transaction history is not available in this wallet yet…").
 *
 * Read 2026-09-30 for the test seed's implicit account (5510e2b4…ee412):
 * `https://api.nearblocks.io/v1/account/<id>/txns?per_page=25&order=desc` →
 * HTTP 200, `access-control-allow-origin: *`, 25 receipts, including two
 * `intents.near → <account>` withdrawals that the transaction list
 * (`/txns-only`) does not contain. Deposits arrive as JSON numbers
 * (`8.4768049e+23`). Fixtures keep that shape, trimmed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNearHistory, nearblocksReceiptRow, yoctoFromJson } from "./near-history";
import { nearAdapter } from "./near-wallet";

const ME = "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412";
const SENDER = "9c484fa5d2d069569ba063fc555c34e621ccd88fdbb0295fc79bad232621c5c1";

function receipt(over: Record<string, unknown> = {}) {
  return {
    receipt_id: "RCX9qeQc8QKMUHxTYUSLbsQJfYVjL8gLXApst7HkeKa",
    predecessor_account_id: SENDER,
    receiver_account_id: ME,
    receipt_outcome: { gas_burnt: 7524947687500, tokens_burnt: 752494768750000000000, executor_account_id: ME, status: true },
    transaction_hash: "BiuXnScWdSgKAHZdv8bzzy9UPYAiWd4tu3gMt5ELMNBP",
    block_timestamp: "1790273822978124943",
    block: { block_height: 217084526 },
    actions: [{ action: "TRANSFER", method: null, deposit: 8.4768049e23, fee: 752494768750000000000, args: null }],
    outcomes: { status: true },
    outcomes_agg: { transaction_fee: 834989537500000000000 },
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("yoctoFromJson reads NearBlocks' JSON numbers exactly as printed", () => {
  it("scientific notation, without float arithmetic", () => {
    expect(yoctoFromJson(8.4768049e23)).toEqual({ yocto: 847680490000000000000000n, approx: true });
    expect(yoctoFromJson(2e24)?.yocto).toBe(2_000000000000000000000000n);
    expect(yoctoFromJson(6.945239791124138e22)?.yocto).toBe(69452397911241380000000n);
  });
  it("a digit string is exact; a safe integer is not approximate", () => {
    expect(yoctoFromJson("834989537500000000000")).toEqual({ yocto: 834989537500000000000n, approx: false });
    expect(yoctoFromJson(1000000000000000)).toEqual({ yocto: 1000000000000000n, approx: false });
    expect(yoctoFromJson(-1)).toBeNull();
    expect(yoctoFromJson("1e3")).toBeNull();
  });
});

describe("NearBlocks receipts as rows", () => {
  it("a payment received: amount, sender, block, time — no fee (the sender's)", () => {
    expect(nearblocksReceiptRow(receipt(), ME)).toMatchObject({
      chain: "near",
      hash: "BiuXnScWdSgKAHZdv8bzzy9UPYAiWd4tu3gMt5ELMNBP",
      direction: "in",
      amount: "0.84768049",
      fee: undefined,
      height: 217084526,
      timestamp: 1790273822,
      counterparty: SENDER,
      meta: { from: SENDER, to: ME, receiptId: "RCX9qeQc8QKMUHxTYUSLbsQJfYVjL8gLXApst7HkeKa", amountApprox: true },
    });
  });

  it("a NEAR Intents withdrawal (intents.near → account) is a received payment", () => {
    const row = nearblocksReceiptRow(
      receipt({
        predecessor_account_id: "intents.near",
        actions: [{ action: "TRANSFER", deposit: 1000000000000000000 }],
        outcomes_agg: { transaction_fee: 1.987735372704e21 },
      }),
      ME,
    );
    expect(row).toMatchObject({ direction: "in", amount: "0.000001", counterparty: "intents.near" });
    // The relayer's fee is not this wallet's.
    expect(row?.fee).toBeUndefined();
  });

  it("a gas refund (system → account) is not a payment", () => {
    expect(nearblocksReceiptRow(receipt({ predecessor_account_id: "system" }), ME)).toBeNull();
  });

  it("a payment sent: the transaction fee is this wallet's", () => {
    const row = nearblocksReceiptRow(
      receipt({ predecessor_account_id: ME, receiver_account_id: SENDER, actions: [{ action: "TRANSFER", deposit: "1000000000000000000000000" }] }),
      ME,
    );
    expect(row).toMatchObject({ direction: "out", amount: "1", fee: "0.0008349895375", counterparty: SENDER });
  });

  it("a failed receipt is `failed`", () => {
    const row = nearblocksReceiptRow(receipt({ receipt_outcome: { status: false }, outcomes: { status: false } }), ME);
    expect(row?.direction).toBe("failed");
  });
});

describe("the adapter reads NearBlocks (was: threw 'not available')", () => {
  it("asks the receipt list for the account and maps it", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown) => {
        urls.push(String(u));
        return new Response(JSON.stringify({ cursor: "16578685297", txns: [receipt(), receipt({ predecessor_account_id: "system" })] }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const page = await nearAdapter.getTransactionHistory(ME, { limit: 2 });
    expect(urls).toEqual([`https://api.nearblocks.io/v1/account/${ME}/txns?per_page=2&order=desc`]);
    expect(page.items.map((t) => t.direction)).toEqual(["in"]);
    expect(page.cursor).toBe("16578685297");
  });

  it("a NearBlocks 429 throws — an error, never an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Too Many Requests", { status: 429 })));
    await expect(fetchNearHistory(ME, { limit: 25 })).rejects.toThrow(/^HTTP 429 from https:\/\/api\.nearblocks\.io\//);
  });
});
