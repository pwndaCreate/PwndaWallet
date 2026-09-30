/**
 * Aptos history rows (2026-09-30).
 *
 * Found in the sandbox's Activity pass on the public test seed: a week-old
 * Aptos transaction sat at the top of the list and its details read
 * "▲ SENT −0.00005445 APT · STATUS unconfirmed · CONFIRMATIONS 0". The node
 * had answered `success: false` — the transfer aborted, only its gas was
 * paid — and the adapter mapped that to `confirmations: 0`, which the whole
 * UI reads as "waiting for a block" (`ChainTx`). The list's sort puts unmined
 * rows first, so every failed Aptos transaction was pinned there.
 *
 * Addresses and hashes are invented; the row shape is the Aptos REST API's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { aptAdapter, normalizeAptosAddress } from "./apt-wallet";

const ME = normalizeAptosAddress("0x" + "a1".repeat(32));
const THEM = normalizeAptosAddress("0x" + "b2".repeat(32));

const transfer = (over: Record<string, unknown>) => ({
  type: "user_transaction",
  hash: "0x" + "00".repeat(31) + "01",
  sender: ME,
  success: true,
  vm_status: "Executed successfully",
  version: "7330657800",
  timestamp: "1790150810000000",
  gas_used: "11",
  gas_unit_price: "100",
  payload: { function: "0x1::aptos_account::transfer", arguments: [THEM, "5445"] },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

function stubNode(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toContain(`/accounts/${ME}/transactions`);
      return new Response(JSON.stringify(rows), { status: 200 });
    }),
  );
}

describe("Aptos history", () => {
  it("an aborted transaction is `failed`, committed, and never an unconfirmed send", async () => {
    stubNode([
      transfer({
        hash: "0x" + "00".repeat(31) + "02",
        success: false,
        vm_status: "Move abort in 0x1::coin: EINSUFFICIENT_BALANCE(0x10006)",
      }),
    ]);
    const [row] = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(row.direction).toBe("failed");
    // Committed: no count, its version as the block (a count of 1 read
    // "1 / 6 pending" in the details).
    expect(row.confirmations).toBeUndefined();
    expect(row.height).toBe(7330657800);
    expect(row.meta).toMatchObject({
      intended: "out",
      failure: "Move abort in 0x1::coin: EINSUFFICIENT_BALANCE(0x10006)",
    });
    // Its gas was still paid, by this wallet.
    expect(row.fee).toBe("0.000011");
  });

  it("a successful send keeps its direction and fee; a receipt carries no fee of ours", async () => {
    stubNode([
      transfer({}),
      transfer({ hash: "0x" + "00".repeat(31) + "03", sender: THEM, payload: { function: "0x1::coin::transfer", arguments: [ME, "100000000"] } }),
    ]);
    const [sent, received] = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(sent).toMatchObject({ direction: "out", amount: "0.00005445", fee: "0.000011", counterparty: THEM });
    expect(received).toMatchObject({ direction: "in", amount: "1", counterparty: THEM });
    expect(received.fee).toBeUndefined();
    for (const r of [sent, received]) expect(r.confirmations).toBeUndefined();
  });
});
