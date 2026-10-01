/**
 * Zano history rows name the recipients of a send (operator request,
 * 2026-10-01).
 *
 * `zano-rpc.ts::parseTransferEntry` dropped `remote_addresses`, so no Zano row
 * named any address: the details had to ask simplewallet again for a send's
 * recipient. Now a send's row carries them (`meta.to`, the first as
 * `counterparty`); a receipt's row is unchanged — the protocol hides the
 * sender, and the address an incoming entry may list is the sender's own
 * unchecked claim (`tx_payer`).
 *
 * The entries keep the field layout of `wallet_transfer_info` as the vendored
 * simplewallet v2.2.1.506 serializes it (the same fixture shape as
 * `zanoXelisParties.test.ts`); no funded Zano wallet was available to capture
 * a live answer. Addresses are simplewallet's documentation example and one
 * derived in `zano-keys.test.ts`; txids invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "../lib/tauri";
import { getRecentTransfers } from "./zano-rpc";
import { zanoAdapter, zanoTransfersToChainTx } from "./zano-wallet";

const invokeMock = vi.mocked(invoke);

const ZANO_THEM =
  "ZxBvJDuQjMG9R2j4WnYUhBYNrwZPwuyXrC7FHdVmWqaESgowDvgfWtiXeNGu8Px9B24pkmjsA39fzSSiEQG1ekB225ZnrMTBp";
const ZANO_OTHER =
  "ZxDuP6pbXjqTevNr6PFRZYLL8vCoX5RuhHJwSc5DcdA5Gs4gZTwoiRXgkmryoJnsTeaYNmFy6c2wvMwaPTWvWWJK32SLJWruw";
const ZANO_ASSET = "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";

/** One `wallet_transfer_info` as simplewallet v2.2.1.506 serializes it. */
function wti(txByte: string, income: boolean, over: Record<string, unknown> = {}) {
  return {
    tx_hash: txByte.repeat(32),
    height: 3_100_000,
    unlock_time: 0,
    tx_blob_size: 1800,
    comment: "",
    timestamp: 1790000000,
    employed_entries: income
      ? { receive: [{ index: 0, amount: 1_000_000_000_000, asset_id: ZANO_ASSET, payment_id: "" }], spent: [] }
      : {
          receive: [{ index: 1, amount: 400_000_000_000, asset_id: ZANO_ASSET, payment_id: "" }],
          spent: [{ index: 7, amount: 1_410_000_000_000, asset_id: ZANO_ASSET, payment_id: "" }],
        },
    fee: 10_000_000_000,
    is_service: false,
    is_mixing: false,
    is_mining: false,
    tx_type: 0,
    show_sender: false,
    contract: [],
    service_entries: [],
    transfer_internal_index: 12,
    remote_addresses: [] as string[],
    remote_aliases: [] as string[],
    subtransfers_by_pid: [
      { payment_id: "", subtransfers: [{ amount: 1_000_000_000_000, is_income: income, asset_id: ZANO_ASSET }] },
    ],
    ...over,
  };
}

/** `get_recent_txs_and_info3` answering `transfers`. */
function stubSidecar(transfers: unknown[]) {
  invokeMock.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === "zano_rpc_call" && args?.method === "get_recent_txs_and_info3") {
      return {
        last_item_index: transfers.length,
        pi: { balance: 0, curent_height: 3_834_338, transfer_entries_count: transfers.length, transfers_count: transfers.length, unlocked_balance: 0 },
        total_transfers: transfers.length,
        transfers,
      };
    }
    throw new Error(`unexpected invoke ${cmd} ${args?.method ?? ""}`);
  });
}

// A block body: `mockReset()` returns the mock, and a function returned from
// `beforeEach` is run as its teardown — with no arguments.
beforeEach(() => {
  invokeMock.mockReset();
});

describe("Zano history rows and the other side's addresses", () => {
  it("the parser keeps remote_addresses (it dropped them)", async () => {
    stubSidecar([wti("a1", false, { remote_addresses: [ZANO_THEM, ZANO_OTHER, ZANO_THEM] }), wti("a2", true)]);
    const [sent, received] = await getRecentTransfers();
    expect(sent.remoteAddresses).toEqual([ZANO_THEM, ZANO_OTHER]);
    expect(received.remoteAddresses).toBeUndefined();
  });

  it("a send names its recipients: meta.to, and the first as the counterparty", async () => {
    stubSidecar([wti("a1", false, { remote_addresses: [ZANO_THEM, ZANO_OTHER] })]);
    const [row] = zanoTransfersToChainTx(await getRecentTransfers());
    expect(row).toMatchObject({ direction: "out", counterparty: ZANO_THEM, meta: { assetId: ZANO_ASSET, to: [ZANO_THEM, ZANO_OTHER] } });
  });

  it("the adapter's own history read maps them the same way", async () => {
    stubSidecar([wti("a3", false, { remote_addresses: [ZANO_THEM] })]);
    const { items } = await zanoAdapter.getTransactionHistory!("ignored");
    expect(items[0]).toMatchObject({ direction: "out", counterparty: ZANO_THEM, meta: { to: [ZANO_THEM] } });
  });

  it("a receipt stays without a sender, even when the entry lists the sender's own claim", async () => {
    stubSidecar([wti("a4", true, { show_sender: true, remote_addresses: [ZANO_THEM] }), wti("a5", true)]);
    for (const row of zanoTransfersToChainTx(await getRecentTransfers())) {
      expect(row.direction).toBe("in");
      expect(row.counterparty).toBeUndefined();
      expect(row.meta).toEqual({ assetId: ZANO_ASSET });
    }
  });

  it("a send whose recipients this wallet does not know (no remote_addresses) is unchanged", async () => {
    stubSidecar([wti("a6", false)]);
    const [row] = zanoTransfersToChainTx(await getRecentTransfers());
    expect(row.counterparty).toBeUndefined();
    expect(row.meta).toEqual({ assetId: ZANO_ASSET });
  });
});
