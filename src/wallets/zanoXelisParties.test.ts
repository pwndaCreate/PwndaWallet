/**
 * Zano and Xelis `getTransactionParties` (2026-09-30), against mocked
 * sidecars.
 *
 * Zano: simplewallet's `search_for_transactions2` by `tx_id`, answer
 * `{ in, out, pool }` lists of `wallet_transfer_info`, fields as serialized
 * by the vendored v2.2.1.506 source (`wallet_public_structs_defs.h`) — the
 * version the app runs. No funded Zano wallet was available to capture a
 * live answer, so the layout is the source's.
 *
 * Xelis: the entries of `list_transactions` (the call the history makes),
 * variant keys flattened in snake_case as `xelis-rpc.ts::parseTransferEntry`
 * documents from the wallet's `api/wallet.rs`. Addresses from
 * `xelis-vectors.ts`; txids invented.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("./zano-nodes", () => ({
  pickZanoDaemon: vi.fn(async () => "http://node.sandbox.test:10500"),
}));
vi.mock("./zano-keys", async () => {
  const actual = await vi.importActual<typeof import("./zano-keys")>("./zano-keys");
  return {
    ...actual,
    validateZanoSeed: vi.fn(() => true),
    readZanoSeedMeta: vi.fn(() => ({ auditable: false, passwordProtected: false })),
    zanoAddressFromSeed: vi.fn(() => ZANO_OWN),
  };
});
vi.mock("./xelis-nodes", () => ({
  pickXelisDaemon: vi.fn(async () => "https://node.sandbox.test"),
}));
vi.mock("./xelis-keys", async () => {
  const actual = await vi.importActual<typeof import("./xelis-keys")>("./xelis-keys");
  return {
    ...actual,
    verifyXelisSeedIntegrity: vi.fn(() => ({ ok: true })),
    xelisAddressFromSeed: vi.fn(() => XEL_OWN),
    xelisNetworkFromEnv: vi.fn(() => "mainnet"),
  };
});

import { invoke } from "../lib/tauri";
import { initZanoSession, zanoAdapter, zanoTransferParties } from "./zano-wallet";
import { initXelisSession, xelisAdapter, xelisEntryParties } from "./xelis-wallet";

const invokeMock = vi.mocked(invoke);

/** Simplewallet's own DOC_EXMP address, and one derived in zano-keys.test.ts. */
const ZANO_OWN =
  "ZxDuP6pbXjqTevNr6PFRZYLL8vCoX5RuhHJwSc5DcdA5Gs4gZTwoiRXgkmryoJnsTeaYNmFy6c2wvMwaPTWvWWJK32SLJWruw";
const ZANO_THEM =
  "ZxBvJDuQjMG9R2j4WnYUhBYNrwZPwuyXrC7FHdVmWqaESgowDvgfWtiXeNGu8Px9B24pkmjsA39fzSSiEQG1ekB225ZnrMTBp";
const ZANO_ASSET = "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";
const ZTX = "97".repeat(32);

/** One `wallet_transfer_info` as simplewallet v2.2.1.506 serializes it. */
function wti(income: boolean, over: Record<string, unknown> = {}) {
  return {
    tx_hash: ZTX,
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

describe("Zano: a search_for_transactions2 answer as parties", () => {
  it("a send names its recipients from remote_addresses", () => {
    const r = { out: [wti(false, { remote_addresses: [ZANO_THEM] })] };
    expect(zanoTransferParties(r, ZTX, ZANO_OWN)).toEqual({ from: [ZANO_OWN], to: [ZANO_THEM] });
  });

  it("a receipt hides its sender; one the sender attached itself (show_sender) stays a hidden sender's claim", () => {
    expect(zanoTransferParties({ in: [wti(true)] }, ZTX, ZANO_OWN)).toEqual({
      from: [],
      to: [ZANO_OWN],
      senderHidden: true,
    });
    // Was `{ from: [ZANO_THEM], to: [ZANO_OWN] }`: the claim read as the
    // sender, while the history row leaves it out (2026-10-01).
    const shown = { in: [wti(true, { show_sender: true, remote_addresses: [ZANO_THEM] })] };
    expect(zanoTransferParties(shown, ZTX, ZANO_OWN)).toEqual({
      from: [ZANO_THEM],
      to: [ZANO_OWN],
      senderHidden: true,
    });
  });

  it("the pool list is not filtered by tx_id on simplewallet's side: other hashes are ignored here", () => {
    const r = {
      pool: [
        wti(true, { tx_hash: "aa".repeat(32), height: 0, remote_addresses: [ZANO_THEM] }),
        wti(false, { height: 0, remote_addresses: [ZANO_THEM] }),
      ],
    };
    expect(zanoTransferParties(r, ZTX, ZANO_OWN)).toEqual({ from: [ZANO_OWN], to: [ZANO_THEM] });
    expect(zanoTransferParties({ pool: [wti(true, { tx_hash: "aa".repeat(32) })] }, ZTX, ZANO_OWN)).toBeNull();
  });

  it("no entry for the hash (empty lists are left out of the answer): null", () => {
    expect(zanoTransferParties({}, ZTX, ZANO_OWN)).toBeNull();
  });
});

const XEL_OWN = "xel:qc3hdkmsc0nqks7jqz8cpnzv5c3ur7my6yy7ct6ulf5kuexv53pqqjlaht0";
const XEL_THEM = "xel:ym3qntl80esaae92u6ac4dk0nq2lle8scy03f8xknud9at29w3csqnyl7dc";
const XEL_NATIVE = "0".repeat(64);
const XTX = "f8bd7c15e3a94085f8130cc67e1fefd89192cdd208b68b10e1cc6e1a83afe5d6";

describe("Xelis: a list_transactions entry as parties", () => {
  const base = { hash: XTX, topoheight: 11982, timestamp: 1711479939489 };

  it("incoming: its `from` → this wallet; outgoing: this wallet → its destinations", () => {
    const incoming = {
      ...base,
      incoming: { from: XEL_THEM, transfers: [{ amount: 100, asset: XEL_NATIVE, extra_data: null }] },
    };
    expect(xelisEntryParties(incoming, XEL_OWN)).toEqual({ from: [XEL_THEM], to: [XEL_OWN] });
    const outgoing = {
      ...base,
      outgoing: {
        fee: 25000,
        nonce: 1458,
        transfers: [
          { amount: 1, asset: "ab".repeat(32), destination: XEL_OWN, extra_data: null },
          { amount: 1, asset: XEL_NATIVE, destination: XEL_THEM, extra_data: null },
        ],
      },
    };
    // XEL transfers first; the other asset's destination is not this adapter's.
    expect(xelisEntryParties(outgoing, XEL_OWN)).toEqual({ from: [XEL_OWN], to: [XEL_THEM] });
  });

  it("a mining reward has no sender; a burn has no recipient", () => {
    expect(xelisEntryParties({ ...base, coinbase: { reward: 146229430 } }, XEL_OWN)).toEqual({ from: [], to: [XEL_OWN] });
    expect(
      xelisEntryParties({ ...base, burn: { asset: XEL_NATIVE, amount: 5, fee: 25000, nonce: 3 } }, XEL_OWN),
    ).toEqual({ from: [XEL_OWN], to: [] });
  });
});

type RpcHandler = (params: any) => unknown;
let zanoRpc: Record<string, RpcHandler>;
let xelisRpc: Record<string, RpcHandler>;

function defaultZano(): Record<string, RpcHandler> {
  return { getaddress: () => ({ address: ZANO_OWN }), getbalance: () => ({ balances: [] }) };
}
function defaultXelis(): Record<string, RpcHandler> {
  return {
    get_address: () => XEL_OWN,
    is_online: () => true,
    get_topoheight: () => 1_000,
    network_info: () => ({ topoheight: 1_010, stable_topoheight: 1_000 }),
    get_balance: () => 500_000_000,
    list_transactions: () => [],
  };
}
const rpcCalls = (cmd: string, method: string) =>
  invokeMock.mock.calls
    .filter(([c, a]) => c === cmd && (a as { method: string }).method === method)
    .map(([, a]) => (a as { params: unknown }).params);

describe("before the wallets are open", () => {
  it("there is nothing to ask: throws", async () => {
    await expect(zanoAdapter.getTransactionParties!(ZTX, ZANO_OWN)).rejects.toThrow(/Zano wallet is not open/);
    await expect(xelisAdapter.getTransactionParties!(XTX, XEL_OWN)).rejects.toThrow(/Xelis wallet is not open/);
  });
});

describe("through the sidecar passthroughs", () => {
  beforeAll(async () => {
    zanoRpc = defaultZano();
    xelisRpc = defaultXelis();
    invokeMock.mockImplementation(async (cmd: string, args?: any) => {
      switch (cmd) {
        case "zano_binary_status":
        case "zano_rpc_is_running":
        case "xelis_binary_status":
        case "xelis_rpc_is_running":
          return true;
        case "zano_ensure_wallet":
        case "xelis_ensure_wallet":
          return false;
        case "zano_start_rpc":
        case "zano_stop_rpc":
        case "xelis_start_rpc":
        case "xelis_stop_rpc":
          return null;
        case "zano_rpc_call":
        case "xelis_rpc_call": {
          const h = (cmd === "zano_rpc_call" ? zanoRpc : xelisRpc)[args.method];
          if (!h) throw "RPC error -32601: Method not found";
          return h(args.params);
        }
        default:
          throw `unexpected command ${cmd}`;
      }
    });
    await initZanoSession(
      "able ability about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt",
      "master-password",
    );
    await initXelisSession("seed words are mocked", "master-password");
  });

  beforeEach(() => {
    invokeMock.mockClear();
    zanoRpc = defaultZano();
    xelisRpc = defaultXelis();
  });

  it("Zano: asks search_for_transactions2 for the tx_id, in every list", async () => {
    zanoRpc.search_for_transactions2 = () => ({ out: [wti(false, { remote_addresses: [ZANO_THEM] })] });
    expect(await zanoAdapter.getTransactionParties!(ZTX, ZANO_OWN)).toEqual({
      from: [ZANO_OWN],
      to: [ZANO_THEM],
      source: "zano simplewallet (local)",
    });
    expect(rpcCalls("zano_rpc_call", "search_for_transactions2")).toEqual([
      { tx_id: ZTX, in: true, out: true, pool: true, filter_by_height: false, min_height: 0, max_height: 0 },
    ]);
  });

  it("Zano: nothing for the hash is null; an RPC failure throws", async () => {
    zanoRpc.search_for_transactions2 = () => ({});
    await expect(zanoAdapter.getTransactionParties!(ZTX, ZANO_OWN)).resolves.toBeNull();
    zanoRpc.search_for_transactions2 = () => {
      throw "Zano RPC is not running (no JWT secret)";
    };
    await expect(zanoAdapter.getTransactionParties!(ZTX, ZANO_OWN)).rejects.toThrow(
      /^Zano simplewallet \(local\) could not read transaction .*: Zano RPC is not running/,
    );
  });

  it("Xelis: finds the hash in the native-asset list the history reads, without a limit", async () => {
    xelisRpc.list_transactions = () => [
      { hash: "11".repeat(32), topoheight: 12000, timestamp: 1711479999000, coinbase: { reward: 1 } },
      {
        hash: XTX,
        topoheight: 11982,
        timestamp: 1711479939489,
        incoming: { from: XEL_THEM, transfers: [{ amount: 100, asset: XEL_NATIVE, extra_data: null }] },
      },
    ];
    expect(await xelisAdapter.getTransactionParties!(XTX.toUpperCase(), XEL_OWN)).toEqual({
      from: [XEL_THEM],
      to: [XEL_OWN],
      source: "xelis_wallet (local)",
    });
    expect(rpcCalls("xelis_rpc_call", "list_transactions")).toEqual([{ asset: XEL_NATIVE }]);
  });

  it("Xelis: not in the wallet's list is null; a failed read throws", async () => {
    await expect(xelisAdapter.getTransactionParties!(XTX, XEL_OWN)).resolves.toBeNull();
    xelisRpc.list_transactions = () => {
      throw "Xelis RPC is not running";
    };
    await expect(xelisAdapter.getTransactionParties!(XTX, XEL_OWN)).rejects.toThrow(
      /^xelis_wallet \(local\) could not list its transactions: Xelis RPC is not running/,
    );
  });
});
