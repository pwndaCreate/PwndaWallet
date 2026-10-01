/**
 * A Zano receipt: the row and the details agree about the sender (operator
 * request, 2026-10-01).
 *
 * Zano hides who sent a transaction. A sender can attach its own address
 * (`tx_payer`, `show_sender`), and simplewallet then lists it in the incoming
 * entry's `remote_addresses`; nothing checks it. The history row leaves it out
 * for that reason (`zanoTransfersToChainTx`), but `zanoTransferParties` named
 * it as the sender, so the details window, which asks the wallet when the row
 * cannot say enough (an amount the wallet could not read), showed it as the
 * sender. It is now listed with a note saying the sender attached it itself.
 *
 * Layouts: `wallet_transfer_info` as the vendored simplewallet v2.2.1.506
 * serializes it (no funded Zano wallet was available to capture a live answer);
 * addresses from `zanoXelisParties.test.ts`, the txid invented.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => null) }));

import { zanoTransferParties, zanoTransfersToChainTx } from "../../wallets/zano-wallet";
import type { TxPartiesState } from "../../lib/txParties";
import { txDetailsModel } from "./TxDetails";

const ZANO_OWN =
  "ZxDuP6pbXjqTevNr6PFRZYLL8vCoX5RuhHJwSc5DcdA5Gs4gZTwoiRXgkmryoJnsTeaYNmFy6c2wvMwaPTWvWWJK32SLJWruw";
const ZANO_THEM =
  "ZxBvJDuQjMG9R2j4WnYUhBYNrwZPwuyXrC7FHdVmWqaESgowDvgfWtiXeNGu8Px9B24pkmjsA39fzSSiEQG1ekB225ZnrMTBp";
const ZANO_ASSET = "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";
const ZTX = "97".repeat(32);

/** One incoming `wallet_transfer_info` from `search_for_transactions2`. */
function incoming(over: Record<string, unknown> = {}) {
  return {
    tx_hash: ZTX,
    height: 3_100_000,
    timestamp: 1790000000,
    employed_entries: { receive: [{ index: 0, amount: 1_000_000_000_000, asset_id: ZANO_ASSET, payment_id: "" }], spent: [] },
    fee: 10_000_000_000,
    show_sender: false,
    remote_addresses: [] as string[],
    subtransfers_by_pid: [{ payment_id: "", subtransfers: [{ amount: 1_000_000_000_000, is_income: true, asset_id: ZANO_ASSET }] }],
    ...over,
  };
}

/** The row Activity shows for a receipt whose amount the wallet could not read. */
const [row] = zanoTransfersToChainTx([
  {
    isIncome: true,
    amount: 0,
    amountUnknown: true,
    assetId: ZANO_ASSET,
    height: 3_100_000,
    txHash: ZTX,
    timestamp: 1790000000,
    remoteAddresses: [ZANO_THEM],
  },
]);

const asked = (answer: unknown): TxPartiesState => ({
  status: "done",
  parties: zanoTransferParties(answer, ZTX, ZANO_OWN, "zano simplewallet (local)"),
});

describe("a Zano receipt's sender: the row and the details agree", () => {
  it("the row names no sender, so the details ask the wallet", () => {
    expect(row.counterparty).toBeUndefined();
    expect(row.meta?.from).toBeUndefined();
    expect(txDetailsModel(row, { ownAddress: ZANO_OWN }).needsParties).toBe(true);
  });

  it("an address the sender attached itself is listed as its own claim, not as the sender", () => {
    const m = txDetailsModel(row, {
      ownAddress: ZANO_OWN,
      parties: asked({ in: [incoming({ show_sender: true, remote_addresses: [ZANO_THEM] })] }),
    });
    expect(m.from).toEqual([{ address: ZANO_THEM, you: false }]);
    // Was null: the claim read as the sender, with nothing saying otherwise.
    expect(m.fromNote).toBe("The sender attached this address itself. Zano does not check it.");
    expect(m.to).toEqual([{ address: ZANO_OWN, you: true }]);
  });

  it("with no claim attached, the sender is hidden, as before", () => {
    const m = txDetailsModel(row, { ownAddress: ZANO_OWN, parties: asked({ in: [incoming()] }) });
    expect(m.from).toEqual([]);
    expect(m.fromNote).toBe("Hidden: Zano does not reveal who sent a transaction.");
  });

  it("a sender another chain reads is not called a claim", () => {
    const dash = txDetailsModel(
      { chain: "dash", hash: "d1".repeat(32), direction: "in", amount: "0.5", height: 2_300_000 },
      { ownAddress: "XownDashAddressInvented00000000000", parties: { status: "done", parties: { from: ["XsenderDashAddressInvented000000000"], to: [] } } },
    );
    expect(dash.from).toEqual([{ address: "XsenderDashAddressInvented000000000", you: false }]);
    expect(dash.fromNote).toBeNull();
  });
});
