/**
 * Monero and Zephyr `getTransactionParties` (2026-09-30), against mocked
 * wallet-rpcs.
 *
 * Both read `get_transfer_by_txid` through their existing passthroughs
 * (`xmr_rpc_call`, `zph_rpc_call`). The entry layout is monero-wallet-rpc's
 * documented example for that method (`fill_transfer_entry`): an outgoing
 * entry's `address` is the account's own address and its `destinations` the
 * recipients; an incoming entry's `address` is the receiving subaddress.
 * Addresses and txids are invented. Real rejections from the passthroughs
 * are STRINGS (Tauri `Err(String)`), so the mocks' are too.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("./xmr-nodes", () => ({
  getSelectedNode: vi.fn(async () => null),
  raceBestNode: vi.fn(async () => "http://node.sandbox.test:18081"),
  getBestNodeUrl: vi.fn(() => null),
  startHealthLoop: vi.fn(),
  stopHealthLoop: vi.fn(),
  onHealthUpdate: vi.fn(() => () => {}),
  getHealthSnapshot: vi.fn(() => []),
  getActivePool: vi.fn(async () => []),
  HOT_SWAP_SPEEDUP_THRESHOLD: 1.75,
}));
vi.mock("./xmr-keys", () => ({
  generateXmrSeed: vi.fn(),
  xmrAddressFromSeed: vi.fn(async () => "4ownSandboxAddress"),
  validateXmrSeed: vi.fn(async () => ({ ok: true })),
  normalizeXmrSeed: (s: string) => s.trim().split(/\s+/).join(" "),
  xmrKeysFromRawSecret: vi.fn(),
  bytesToHex: vi.fn(),
}));
vi.mock("./zph-nodes", () => ({
  getSelectedNode: vi.fn(async () => null),
  raceBestNode: vi.fn(async () => "http://node.sandbox.test:17767"),
  getHealthSnapshot: vi.fn(() => []),
  startHealthLoop: vi.fn(),
  stopHealthLoop: vi.fn(),
  onHealthUpdate: vi.fn(() => () => {}),
  HOT_SWAP_SPEEDUP_THRESHOLD: 1.75,
}));
vi.mock("./zph-keys", () => ({
  generateZephyrSeed: vi.fn(),
  validateZephyrSeed: vi.fn(async () => ({ ok: true })),
  normalizeZephyrSeed: (s: string) => s.trim().split(/\s+/).join(" "),
  zephyrAddressFromSeed: vi.fn(async () => "ZEPHYR2ownSandboxAddress"),
}));

import { invoke } from "../lib/tauri";
import { walletRpcTransferParties } from "./parties-b-walletrpc";
import { initXmrSession, xmrAdapter } from "./xmr-wallet";
import { initZphSession, zphAdapter } from "./zph-wallet";

const invokeMock = vi.mocked(invoke);
const SEED = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");
const TXID = "c3".repeat(32);
const ACCOUNT = "44ownPrimaryAddressInventedForTheTestAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SUBADDR = "86ownSubaddressInventedForTheTestBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const DEST_1 = "7BnERTpvL5MbCLtj5n9No7J5oE5hHiB3tVCK5cjSvCsYWD2WRJLFuWeKTLiXo5QJqt2ZwUaLy2Vh1Ad51K7FNgqcHgjW85o";
const DEST_2 = "77Vx9cs1VPicFndSVgYUvTdLCJEZw9h81hXLMYsjBCXSJfUehLa9TDW3Ffh45SQa7xb6dUs18mpNxfUhQGqfwXPSMrvKhVp";

/** One `get_transfer_by_txid` entry in monero-wallet-rpc's layout. */
function entry(type: string, over: Record<string, unknown> = {}) {
  const outgoing = type === "out" || type === "pending" || type === "failed";
  return {
    address: outgoing ? ACCOUNT : SUBADDR,
    amount: 300000000000,
    amounts: [300000000000],
    confirmations: 1,
    ...(outgoing
      ? {
          destinations: [
            { address: DEST_1, amount: 100000000000 },
            { address: DEST_2, amount: 200000000000 },
          ],
        }
      : {}),
    double_spend_seen: false,
    fee: outgoing ? 21650200000 : 0,
    height: 153624,
    locked: false,
    note: "",
    payment_id: "0000000000000000",
    subaddr_index: { major: 0, minor: outgoing ? 0 : 3 },
    subaddr_indices: [{ major: 0, minor: outgoing ? 0 : 3 }],
    suggested_confirmations_threshold: 1,
    timestamp: 1535918400,
    txid: TXID,
    type,
    unlock_time: 0,
    ...over,
  };
}
const answer = (...entries: unknown[]) => ({ transfer: entries[0], transfers: entries });

describe("the wallet-rpc answer as parties", () => {
  it("a send: the account's address → every destination", () => {
    expect(walletRpcTransferParties(answer(entry("out")))).toEqual({ from: [ACCOUNT], to: [DEST_1, DEST_2] });
  });

  it("a receipt: the sender is hidden, the receiving subaddress named", () => {
    expect(walletRpcTransferParties(answer(entry("in")))).toEqual({ from: [], to: [SUBADDR], senderHidden: true });
    expect(walletRpcTransferParties(answer(entry("pool")))).toMatchObject({ senderHidden: true, to: [SUBADDR] });
  });

  it("a send to this wallet's own subaddress lists the out entry's destination", () => {
    const self = answer(
      entry("out", { destinations: [{ address: SUBADDR, amount: 5 }] }),
      entry("in", { amount: 5 }),
    );
    expect(walletRpcTransferParties(self)).toEqual({ from: [ACCOUNT], to: [SUBADDR] });
  });

  it("a send this wallet did not build (restored from seed) has no destinations: nobody is guessed", () => {
    const { destinations: _d, ...restored } = entry("out");
    expect(walletRpcTransferParties(answer(restored))).toEqual({ from: [ACCOUNT], to: [] });
  });

  it("pending and failed sends are sends; the single `transfer` field is read when `transfers` is absent", () => {
    expect(walletRpcTransferParties(answer(entry("pending")))).toMatchObject({ from: [ACCOUNT], to: [DEST_1, DEST_2] });
    expect(walletRpcTransferParties({ transfer: entry("failed") })).toMatchObject({ from: [ACCOUNT] });
    expect(walletRpcTransferParties({})).toBeNull();
  });
});

type RpcHandler = (params: any) => unknown;
let xmrRpc: Record<string, RpcHandler>;
let zphRpc: Record<string, RpcHandler>;

function baseRpc(receive: string): Record<string, RpcHandler> {
  return {
    open_wallet: () => ({}),
    close_wallet: () => ({}),
    // Throwing skips the address self-heal, which is not under test here.
    get_address: () => {
      throw "RPC error -13: No wallet file";
    },
    auto_refresh: () => ({}),
    create_address: () => ({ address: receive, address_index: 1 }),
    get_height: () => ({ height: 3_000_000 }),
    get_transfer_by_txid: () => {
      throw "RPC error -8: Transaction not found.";
    },
  };
}

const lookups = (cmd: string) =>
  invokeMock.mock.calls
    .filter(([c, a]) => c === cmd && (a as { method: string }).method === "get_transfer_by_txid")
    .map(([, a]) => (a as { params: unknown }).params);

describe("before the wallets are open", () => {
  it("there is nothing to ask: throws, rather than claiming the transaction is unknown", async () => {
    await expect(xmrAdapter.getTransactionParties!(TXID, ACCOUNT)).rejects.toThrow(/Monero wallet is not open/);
    await expect(zphAdapter.getTransactionParties!(TXID, ACCOUNT)).rejects.toThrow(/Zephyr wallet is not open/);
  });
});

describe("through the wallet-rpc passthroughs", () => {
  beforeAll(async () => {
    xmrRpc = baseRpc("8sandboxSubaddress");
    zphRpc = baseRpc("ZEPHs6m7test");
    invokeMock.mockImplementation(async (cmd: string, args?: any) => {
      switch (cmd) {
        case "xmr_check_wallet_rpc":
        case "zph_check_wallet_rpc":
          return true;
        case "xmr_start_rpc":
        case "xmr_stop_rpc":
        case "zph_start_rpc":
        case "zph_stop_rpc":
          return null;
        case "xmr_probe_node":
        case "zph_probe_node":
          return { url: args.url, ok: true, latency_ms: 5, height: 3_000_000, error: null };
        case "xmr_rpc_call":
        case "zph_rpc_call": {
          const h = (cmd === "xmr_rpc_call" ? xmrRpc : zphRpc)[args.method];
          if (!h) throw "RPC error -32601: Method not found";
          return h(args.params);
        }
        default:
          throw `unexpected command ${cmd}`;
      }
    });
    await initXmrSession(SEED, "master-password");
    await initZphSession(SEED, "master-password");
  });

  beforeEach(() => {
    invokeMock.mockClear();
    xmrRpc = baseRpc("8sandboxSubaddress");
    zphRpc = baseRpc("ZEPHs6m7test");
  });

  it("Monero: asks get_transfer_by_txid for account 0, names the sidecar as the source", async () => {
    xmrRpc.get_transfer_by_txid = () => answer(entry("out"));
    expect(await xmrAdapter.getTransactionParties!(` ${TXID} `, ACCOUNT)).toEqual({
      from: [ACCOUNT],
      to: [DEST_1, DEST_2],
      source: "monero-wallet-rpc (local)",
    });
    expect(lookups("xmr_rpc_call")).toEqual([{ txid: TXID, account_index: 0 }]);
  });

  it("Monero: a receipt is senderHidden", async () => {
    xmrRpc.get_transfer_by_txid = () => answer(entry("in"));
    expect(await xmrAdapter.getTransactionParties!(TXID, ACCOUNT)).toMatchObject({
      from: [],
      to: [SUBADDR],
      senderHidden: true,
    });
  });

  it("Monero: `-8 Transaction not found.` is null; any other failure throws", async () => {
    await expect(xmrAdapter.getTransactionParties!(TXID, ACCOUNT)).resolves.toBeNull();
    xmrRpc.get_transfer_by_txid = () => {
      throw "TCP connect failed: connection refused";
    };
    await expect(xmrAdapter.getTransactionParties!(TXID, ACCOUNT)).rejects.toThrow(
      /^monero-wallet-rpc \(local\) could not read transaction .*: TCP connect failed/,
    );
  });

  it("Zephyr: the same method through zph_rpc_call", async () => {
    zphRpc.get_transfer_by_txid = () => answer(entry("in", { asset_type: "ZSD" }));
    expect(await zphAdapter.getTransactionParties!(TXID, ACCOUNT)).toEqual({
      from: [],
      to: [SUBADDR],
      senderHidden: true,
      source: "zephyr-wallet-rpc (local)",
    });
    expect(lookups("zph_rpc_call")).toEqual([{ txid: TXID, account_index: 0 }]);
    expect(lookups("xmr_rpc_call")).toEqual([]);
  });

  it("Zephyr: a send names its recipients; not found is null; a failure throws", async () => {
    zphRpc.get_transfer_by_txid = () => answer(entry("out", { asset_type: "ZPH" }));
    expect(await zphAdapter.getTransactionParties!(TXID, ACCOUNT)).toMatchObject({ from: [ACCOUNT], to: [DEST_1, DEST_2] });
    zphRpc = baseRpc("ZEPHs6m7test");
    await expect(zphAdapter.getTransactionParties!(TXID, ACCOUNT)).resolves.toBeNull();
    zphRpc.get_transfer_by_txid = () => {
      throw "RPC timed out after 30s";
    };
    await expect(zphAdapter.getTransactionParties!(TXID, ACCOUNT)).rejects.toThrow(/^zephyr-wallet-rpc \(local\)/);
  });
});
