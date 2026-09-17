/**
 * Zephyr send path, against a mocked wallet-rpc (incident 2026-09-15).
 *
 * Reported: Zephyr and its assets could not be sent, and the Send modal showed
 * no fee. What these pin:
 *   - pricing is a dry-run `transfer` (`do_not_relay` + `get_tx_metadata`) with
 *     the asset as both source and destination, and the fee is labelled with
 *     the SENT asset (fees are paid in the source asset at zephyr v2.3.0);
 *   - wallet-rpc errors arrive as plain strings (Tauri `Err(String)`) and are
 *     classified, not dereferenced: the validate_address catch used to call
 *     `e.message.startsWith` and throw a TypeError instead;
 *   - an unknown asset selector throws instead of silently sending ZPH;
 *   - a quote is relayed with `relay_tx {hex}` only by the session that built it;
 *   - `get_fee_estimate` (a daemon method the wallet-rpc lacks) is never called;
 *   - balances are selected by `asset_type`, not by array position;
 *   - an incoming mempool transfer is a pending receipt, not a send.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ invoke: vi.fn() }));
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
import { SendQuoteError, isDefinitiveQuoteError } from "./send-quote";
import type { ZphTransfer } from "./zph-rpc";
import {
  classifyZphTransferError,
  describeZphRelayError,
  initZphSession,
  lockZphWallet,
  onZphSent,
  zphAdapter,
  zphRecipientProblem,
  zphSyncRefusal,
  zphTransferToChainTx,
} from "./zph-wallet";

const invokeMock = vi.mocked(invoke);
const SEED = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");
const SEED_2 = Array.from({ length: 25 }, (_, i) => `other${i}`).join(" ");
const TO = "ZEPHYR2qjmpfgEjnpvUnmcW84J5q3uvP5Z5oc8h6F9zsTrhpFkPgRecipient";
const TX_HASH = "ab".repeat(32);
const METADATA = "cafe".repeat(40);

type RpcHandler = (params: any) => unknown;
let rpc: Record<string, RpcHandler>;
let walletHeight = 1_900_000;
let probeHeight = 1_900_000;

function defaultRpc(): Record<string, RpcHandler> {
  return {
    open_wallet: () => ({}),
    close_wallet: () => ({}),
    // Throwing skips the address self-heal, which is not under test here.
    get_address: () => {
      throw "RPC error -13: No wallet file";
    },
    auto_refresh: () => ({}),
    create_address: () => ({ address: "ZEPHs6m7test", address_index: 1 }),
    get_height: () => ({ height: walletHeight }),
    validate_address: () => ({
      valid: true,
      integrated: false,
      subaddress: false,
      nettype: "mainnet",
      openalias_address: "",
    }),
    get_balance: () => ({ balances: [] }),
    transfer: (p) => ({
      tx_hash: TX_HASH,
      tx_key: "k",
      amount: p.destinations[0].amount,
      fee: 25_400_000,
      ...(p.do_not_relay ? { tx_metadata: METADATA } : {}),
    }),
    relay_tx: () => ({ tx_hash: TX_HASH }),
  };
}

/** The wallet-rpc calls made since the last clear, in order. */
const rpcCalls = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === "zph_rpc_call")
    .map(([, a]) => a as { method: string; params: any });

beforeAll(async () => {
  rpc = defaultRpc();
  invokeMock.mockImplementation(async (cmd: string, args?: any) => {
    switch (cmd) {
      case "zph_check_wallet_rpc":
        return true;
      case "zph_start_rpc":
      case "zph_stop_rpc":
        return null;
      case "zph_probe_node":
        return probeHeight > 0
          ? { url: args.url, ok: true, latency_ms: 5, height: probeHeight, error: null }
          : { url: args.url, ok: false, latency_ms: null, height: null, error: "timeout" };
      case "zph_rpc_call": {
        const h = rpc[args.method];
        // Real rejections are STRINGS (Tauri `Err(String)`), so the mock's are too.
        if (!h) throw "RPC error -32601: Method not found";
        return h(args.params);
      }
      default:
        throw `unexpected command ${cmd}`;
    }
  });
  await initZphSession(SEED, "master-password");
});

beforeEach(() => {
  invokeMock.mockClear();
  rpc = defaultRpc();
  walletHeight = 1_900_000;
  probeHeight = 1_900_000;
});

describe("zphTransferToChainTx", () => {
  const t = (o: Partial<ZphTransfer>): ZphTransfer => ({
    txid: "aa",
    amount: 1_500_000_000_000,
    fee: 25_400_000,
    height: 100,
    timestamp: 1_800_000_000,
    confirmations: 12,
    type: "in",
    address: "ZEPHYR",
    locked: false,
    payment_id: "0",
    subaddr_index: { major: 0, minor: 0 },
    asset_type: "ZSD",
    ...o,
  });

  it("maps an incoming mempool transfer (`pool`) to a pending RECEIPT, not a send", () => {
    const row = zphTransferToChainTx(t({ type: "pool", confirmations: 7, height: 0 }));
    expect(row.direction).toBe("in");
    expect(row.confirmations).toBe(0);
    expect(row.counterparty).toBeUndefined();
    expect(row.meta?.raw_type).toBe("pool");
  });

  it("keeps an outgoing unconfirmed transfer (`pending`) outgoing, with its recipient", () => {
    const row = zphTransferToChainTx(
      t({ type: "pending", confirmations: 0, destinations: [{ address: TO, amount: 1 }] }),
    );
    expect(row.direction).toBe("pending");
    expect(row.counterparty).toBe(TO);
  });

  it("carries the asset and 12-decimal amounts for the renderers", () => {
    const row = zphTransferToChainTx(t({ type: "out" }));
    expect(row).toMatchObject({ direction: "out", amount: "1.5", fee: "0.0000254" });
    expect(row.meta?.asset_type).toBe("ZSD");
  });
});

describe("classifyZphTransferError (string rejections, zephyr v2.3.0 codes)", () => {
  it.each([
    ["RPC error -37: not enough unlocked money", "insufficient-funds", /unlocked ZEPHUSD/],
    ["RPC error -17: not enough money", "insufficient-funds", /Not enough ZEPHUSD/],
    [
      "RPC error -16: Transaction not possible. Available only 1.000000000000, transaction amount 2.000025400000 = 2.000000000000 + 0.000025400000 (fee)",
      "insufficient-funds",
      /Not enough ZEPHUSD/,
    ],
    ["RPC error -2: WALLET_RPC_ERROR_CODE_WRONG_ADDRESS: ZEPHbad", "invalid-address", /not a valid Zephyr address/],
    ["TCP connect failed: Connection refused (os error 10061)", "not-ready", /cannot reach its node/],
    ["RPC error -38: no connection to daemon", "not-ready", /cannot reach its node/],
    ["RPC error -16: No transaction created", "other", /No transaction created/],
    ["RPC error -4: Mint/redeem TX amounts permit at most 4 decimal places", "other", /4 decimal places/],
  ])("%s → %s", (raw, kind, message) => {
    const err = classifyZphTransferError(raw, "ZSD");
    expect(err).toBeInstanceOf(SendQuoteError);
    expect(err.kind).toBe(kind);
    expect(err.message).toMatch(message);
    // The exact wallet string stays in the message, so it can be searched for.
    expect(err.message).toContain(raw);
  });

  it("never renders 'undefined' for an empty rejection", () => {
    expect(classifyZphTransferError(undefined, "ZPH").message).not.toContain("undefined");
  });

  it("passes an already-classified error through", () => {
    const e = new SendQuoteError("invalid-address", "Invalid Zephyr address.");
    expect(classifyZphTransferError(e, "ZPH")).toBe(e);
  });
});

describe("zphSyncRefusal", () => {
  const status = (o: Partial<Parameters<typeof zphSyncRefusal>[0] & object> = {}) => ({
    walletHeight: 1_900,
    daemonHeight: 1_900,
    synced: true,
    percent: 100,
    daemonOk: true,
    ...o,
  });

  it("lets a synced wallet send", () => {
    expect(zphSyncRefusal(status())).toBeNull();
  });

  it("blames an unreachable node, not the wallet (was 'not fully synced (0.0% — N / 0)')", () => {
    const msg = zphSyncRefusal(status({ synced: false, daemonOk: false, daemonHeight: 0, percent: 0 }))!;
    expect(msg).toMatch(/Could not reach a Zephyr node/);
    expect(msg).not.toMatch(/0\.0%/);
  });

  it("reports real sync progress when the node answered", () => {
    expect(zphSyncRefusal(status({ synced: false, walletHeight: 950, percent: 50 }))).toMatch(
      /not fully synced \(50\.0% — 950 \/ 1900\)/,
    );
  });

  it("says the wallet is not ready when there is no status at all", () => {
    expect(zphSyncRefusal(null)).toMatch(/not ready/);
  });
});

describe("zphRecipientProblem / describeZphRelayError", () => {
  it("refuses invalid and non-mainnet addresses definitively", () => {
    const base = { valid: true, integrated: false, subaddress: false, nettype: "mainnet", openalias_address: "" };
    expect(zphRecipientProblem(base)).toBeNull();
    expect(zphRecipientProblem({ ...base, valid: false })?.kind).toBe("invalid-address");
    expect(zphRecipientProblem({ ...base, nettype: "testnet" })?.message).toBe(
      "Address is for testnet, not mainnet.",
    );
  });

  it("does not claim nothing was sent when relay_tx fails to commit", () => {
    expect(describeZphRelayError("RPC error -4: Failed to commit tx.").message).toMatch(
      /check Activity before sending again/,
    );
    expect(describeZphRelayError("RPC error -26: Failed to parse hex.").message).toBe(
      "RPC error -26: Failed to parse hex.",
    );
  });
});

describe("quoteSend", () => {
  it("prices with a dry-run transfer of the asset to itself, full 12-decimal precision", async () => {
    const q = await zphAdapter.quoteSend!({ to: ` ${TO} `, amount: "1.123456789012", assetType: "ZSD" });
    const transfer = rpcCalls().find((c) => c.method === "transfer")!;
    expect(transfer.params).toMatchObject({
      destinations: [{ address: TO, amount: 1_123_456_789_012 }],
      source_asset: "ZSD",
      destination_asset: "ZSD",
      do_not_relay: true,
      get_tx_metadata: true,
    });
    // The fee is charged in the sent asset, so it is labelled with it.
    expect(q).toMatchObject({
      to: TO,
      amount: "1.123456789012",
      assetType: "ZSD",
      fee: "0.0000254",
      feeTicker: "ZEPHUSD",
    });
  });

  it("prices a plain ZEPH send as ZPH→ZPH and labels the fee ZEPH", async () => {
    const q = await zphAdapter.quoteSend!({ to: TO, amount: "2" });
    expect(rpcCalls().find((c) => c.method === "transfer")!.params).toMatchObject({
      source_asset: "ZPH",
      destination_asset: "ZPH",
    });
    expect(q.feeTicker).toBe("ZEPH");
    expect("assetType" in q).toBe(false);
  });

  it("classifies a string 'not enough unlocked money' as definitive", async () => {
    rpc.transfer = () => {
      throw "RPC error -37: not enough unlocked money";
    };
    const err = await zphAdapter.quoteSend!({ to: TO, amount: "99", assetType: "ZRS" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "insufficient-funds" });
    expect(isDefinitiveQuoteError(err)).toBe(true);
  });

  it("waits for sync instead of calling a shortfall on an unscanned wallet", async () => {
    walletHeight = 1_000;
    const err = await zphAdapter.quoteSend!({ to: TO, amount: "1" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "not-ready" });
    expect(isDefinitiveQuoteError(err)).toBe(false);
    expect(rpcCalls().some((c) => c.method === "transfer")).toBe(false);
  });

  it("still prices when validate_address rejects with a STRING (was a TypeError)", async () => {
    rpc.validate_address = () => {
      throw "RPC error -32601: Method not found";
    };
    await expect(zphAdapter.quoteSend!({ to: TO, amount: "1" })).resolves.toMatchObject({
      fee: "0.0000254",
    });
  });

  it("refuses an invalid recipient without building anything", async () => {
    rpc.validate_address = () => ({ valid: false, integrated: false, subaddress: false, nettype: "mainnet", openalias_address: "" });
    const err = await zphAdapter.quoteSend!({ to: TO, amount: "1" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "invalid-address" });
    expect(rpcCalls().some((c) => c.method === "transfer")).toBe(false);
  });
});

describe("sendTransaction", () => {
  it("sends ZSD as a relayed ZSD→ZSD transfer and announces it", async () => {
    const heard = vi.fn();
    const off = onZphSent(heard);
    const r = await zphAdapter.sendTransaction("", TO, "3", "ZSD");
    off();
    expect(r).toEqual({ hash: TX_HASH });
    expect(rpcCalls().find((c) => c.method === "transfer")!.params).toMatchObject({
      source_asset: "ZSD",
      destination_asset: "ZSD",
      do_not_relay: false,
    });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("throws on an unknown asset before anything reaches the wallet (was: sent as ZPH)", async () => {
    for (const bad of ["ZEPHUSD", "BOGUS", "ZEPH"]) {
      await expect(zphAdapter.sendTransaction("", TO, "1", bad)).rejects.toThrow(/Unknown Zephyr asset/);
    }
    expect(rpcCalls()).toEqual([]);
  });

  it("still sends when validate_address rejects with a STRING (was a TypeError)", async () => {
    rpc.validate_address = () => {
      throw "RPC error -32601: Method not found";
    };
    await expect(zphAdapter.sendTransaction("", TO, "1")).resolves.toEqual({ hash: TX_HASH });
  });

  it("turns a string wallet error into a readable one", async () => {
    rpc.transfer = () => {
      throw "RPC error -17: not enough money";
    };
    await expect(zphAdapter.sendTransaction("", TO, "1")).rejects.toThrow(
      /Not enough ZEPH for this amount plus the network fee/,
    );
  });
});

describe("getFeeEstimate / balances", () => {
  it("never calls get_fee_estimate, which zephyr-wallet-rpc does not have", async () => {
    await expect(zphAdapter.getFeeEstimate()).rejects.toThrow(/priced per send/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reads balances by asset_type, not by array position", async () => {
    rpc.get_balance = () => ({
      balances: [
        { asset_type: "ZSD", balance: 42e12, unlocked_balance: 42e12 },
        { asset_type: "ZRS", balance: 5e12, unlocked_balance: 4.2e12 },
        { asset_type: "ZPH", balance: 14e12, unlocked_balance: 14e12 },
      ],
    });
    expect(await zphAdapter.getBalance("")).toBe("14");
    expect(await zphAdapter.getSendableBalance!("ZRS")).toEqual({ unlocked: "4.2", total: "5" });
  });

  it("treats a missing entry as zero (wallet-rpc omits zero balances)", async () => {
    rpc.get_balance = () => ({ balances: [] });
    expect(await zphAdapter.getSendableBalance!("ZYS")).toEqual({ unlocked: "0", total: "0" });
  });
});

describe("sendQuoted", () => {
  it("relays the quoted transaction as built and announces it", async () => {
    const q = await zphAdapter.quoteSend!({ to: TO, amount: "2", assetType: "ZRS" });
    invokeMock.mockClear();
    const heard = vi.fn();
    const off = onZphSent(heard);
    const r = await zphAdapter.sendQuoted!(q);
    off();
    expect(rpcCalls()).toEqual([{ method: "relay_tx", params: { hex: METADATA } }]);
    expect(r).toEqual({ hash: TX_HASH });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("does not claim nothing was sent when relay_tx fails to commit", async () => {
    const q = await zphAdapter.quoteSend!({ to: TO, amount: "2" });
    rpc.relay_tx = () => {
      throw "RPC error -4: Failed to commit tx.";
    };
    await expect(zphAdapter.sendQuoted!(q)).rejects.toThrow(/check Activity/);
  });

  it("builds fresh instead of relaying a quote that aged out", async () => {
    const q = await zphAdapter.quoteSend!({ to: TO, amount: "2" });
    invokeMock.mockClear();
    await zphAdapter.sendQuoted!({ ...q, quotedAt: Date.now() - 91_000 });
    const methods = rpcCalls().map((c) => c.method);
    expect(methods).not.toContain("relay_tx");
    expect(rpcCalls().find((c) => c.method === "transfer")!.params.do_not_relay).toBe(false);
  });

  it("never relays a transaction built by an earlier wallet session", async () => {
    const q = await zphAdapter.quoteSend!({ to: TO, amount: "2" });
    await initZphSession(SEED_2, "master-password"); // a new session (new epoch)
    invokeMock.mockClear();
    await zphAdapter.sendQuoted!(q);
    const methods = rpcCalls().map((c) => c.method);
    expect(methods).not.toContain("relay_tx");
    expect(methods).toContain("transfer");
  });
});

describe("lockZphWallet (incident 2026-09-15)", () => {
  // Lock used closeZphWallet, which sends close_wallet into the process the
  // swap node keeps under its SwapEngine lease, so a swap in flight lost its
  // wallet. A lock releases only the app's lease; Rust closes the wallet itself
  // when nothing else holds one.
  it("releases the app's lease and never sends close_wallet", async () => {
    await initZphSession(SEED, "master-password");
    invokeMock.mockClear();
    await lockZphWallet();
    expect(invokeMock.mock.calls.map(([cmd]) => cmd)).toContain("zph_stop_rpc");
    expect(rpcCalls().map((c) => c.method)).not.toContain("close_wallet");
  });

  it("control: the hard close still sends close_wallet first", async () => {
    const { closeZphWallet } = await import("./zph-wallet");
    await initZphSession(SEED, "master-password");
    invokeMock.mockClear();
    await closeZphWallet();
    expect(rpcCalls().map((c) => c.method)).toContain("close_wallet");
  });
});
