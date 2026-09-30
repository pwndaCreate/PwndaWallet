/**
 * Monero sends against a mocked monero-wallet-rpc (2026-09-29 send-safety
 * audit).
 *
 * The send was ONE `transfer` that built and broadcast together, under a 30 s
 * client timeout, on a single-threaded wallet-rpc. A timeout could leave it
 * broadcast while the UI said "Transaction failed" with the form filled; the
 * retry, queued behind the first, picked other outputs and paid twice. What
 * these pin:
 *   - the build is a dry run (`do_not_relay` + `get_tx_metadata`) and only
 *     `relay_tx` broadcasts, so the txid is known first (finding 1);
 *   - a relay that does not report success is settled by that txid: found →
 *     success; provably not relayed → plain Error; else
 *     `SendOutcomeUnknownError(txid)`; a failed build relays nothing;
 *   - a string rejection from `validate_address` no longer crashes the send
 *     with a TypeError, and the recipient is trimmed (finding 6);
 *   - a failed node probe is not reported as "not fully synced (0.0% — N / 0)"
 *     (finding 7);
 *   - priority 0, exact amounts above 2^53, failed rows in history, and an
 *     incoming mempool transfer shown as a receipt (findings 10, 11, 12).
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

import { invoke } from "../lib/tauri";
import { isSendOutcomeUnknown } from "./send-outcome";
import { initXmrSession, xmrAdapter } from "./xmr-wallet";

const invokeMock = vi.mocked(invoke);
const SEED = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");
const TO =
  "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const TX_HASH = "cd".repeat(32);
const METADATA = "beef".repeat(40);

type RpcHandler = (params: any) => unknown;
let rpc: Record<string, RpcHandler>;
let probeHeight = 3_000_000;
let walletHeight = 3_000_000;

function defaultRpc(): Record<string, RpcHandler> {
  return {
    open_wallet: () => ({}),
    close_wallet: () => ({}),
    // Throwing skips the address self-heal, which is not under test here.
    get_address: () => {
      throw "RPC error -13: No wallet file";
    },
    auto_refresh: () => ({}),
    create_address: () => ({ address: "8sandboxSubaddress", address_index: 1 }),
    get_height: () => ({ height: walletHeight }),
    validate_address: () => ({
      valid: true,
      integrated: false,
      subaddress: false,
      nettype: "mainnet",
      openalias_address: "",
    }),
    get_balance: () => ({ balance: 5_000_000_000_000, unlocked_balance: 3_250_000_000_000 }),
    transfer: (p) => ({
      tx_hash: TX_HASH,
      tx_key: "k",
      amount: p.destinations[0].amount,
      fee: 30_720_000,
      ...(p.do_not_relay && p.get_tx_metadata ? { tx_metadata: METADATA } : {}),
    }),
    relay_tx: () => ({ tx_hash: TX_HASH }),
    get_transfer_by_txid: () => {
      throw "RPC error -8: Transaction not found.";
    },
  };
}

/** The wallet-rpc calls made since the last clear, in order. */
const rpcCalls = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === "xmr_rpc_call")
    .map(([, a]) => a as { method: string; params: any });
const methods = () => rpcCalls().map((c) => c.method);

beforeAll(async () => {
  rpc = defaultRpc();
  invokeMock.mockImplementation(async (cmd: string, args?: any) => {
    switch (cmd) {
      case "xmr_check_wallet_rpc":
        return true;
      case "xmr_start_rpc":
      case "xmr_stop_rpc":
        return null;
      case "xmr_probe_node":
        return probeHeight > 0
          ? { url: args.url, ok: true, latency_ms: 5, height: probeHeight, error: null }
          : { url: args.url, ok: false, latency_ms: null, height: null, error: "timeout" };
      case "xmr_rpc_call": {
        const h = rpc[args.method];
        // Real rejections are STRINGS (Tauri `Err(String)`), so the mock's are too.
        if (!h) throw "RPC error -32601: Method not found";
        return h(args.params);
      }
      default:
        throw `unexpected command ${cmd}`;
    }
  });
  await initXmrSession(SEED, "master-password");
});

beforeEach(() => {
  invokeMock.mockClear();
  rpc = defaultRpc();
  probeHeight = 3_000_000;
  walletHeight = 3_000_000;
});

describe("Monero send: build, then relay (2026-09-29 send-safety audit)", () => {
  it("builds without relaying, then relays exactly that transaction", async () => {
    const r = await xmrAdapter.sendTransaction("", TO, "1.5");
    expect(r).toEqual({ hash: TX_HASH });
    const calls = rpcCalls();
    const transfer = calls.find((c) => c.method === "transfer")!;
    expect(transfer.params).toMatchObject({
      destinations: [{ address: TO, amount: 1_500_000_000_000 }],
      do_not_relay: true,
      get_tx_metadata: true,
    });
    expect(calls.filter((c) => c.method === "relay_tx")).toEqual([
      { method: "relay_tx", params: { hex: METADATA } },
    ]);
    expect(methods().indexOf("transfer")).toBeLessThan(methods().indexOf("relay_tx"));
  });

  it("a build that times out relays nothing and is a plain, retryable Error", async () => {
    rpc.transfer = () => {
      throw "RPC timed out after 30s";
    };
    const err = await xmrAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/Nothing was sent/);
    expect(methods()).not.toContain("relay_tx");
  });

  it("relay timeout, txid then found pending → success, submitted not confirmed", async () => {
    rpc.relay_tx = () => {
      throw "RPC timed out after 30s";
    };
    rpc.get_transfer_by_txid = ({ txid }) => ({
      transfer: { txid, type: "pending" },
      transfers: [{ txid, type: "pending" }],
    });
    await expect(xmrAdapter.sendTransaction("", TO, "1")).resolves.toEqual({
      hash: TX_HASH,
      pending: true,
    });
    expect(methods().filter((m) => m === "relay_tx")).toHaveLength(1);
  });

  it("relay timeout, txid then found mined → success", async () => {
    rpc.relay_tx = () => {
      throw "TCP read failed: connection reset";
    };
    rpc.get_transfer_by_txid = ({ txid }) => ({ transfer: { txid, type: "out" } });
    await expect(xmrAdapter.sendTransaction("", TO, "1")).resolves.toEqual({ hash: TX_HASH });
  });

  it("relay -4 and the wallet does not know the txid → outcome unknown, with the txid", async () => {
    rpc.relay_tx = () => {
      throw "RPC error -4: Failed to commit tx.";
    };
    const err = await xmrAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.hash).toBe(TX_HASH);
    // Relayed once, never rebuilt: SIGN ONCE.
    expect(methods().filter((m) => m === "relay_tx")).toHaveLength(1);
    expect(methods().filter((m) => m === "transfer")).toHaveLength(1);
  });

  it("a lookup that itself times out is asked once more, then the outcome is unknown", async () => {
    rpc.relay_tx = () => {
      throw "RPC timed out after 30s";
    };
    rpc.get_transfer_by_txid = () => {
      throw "RPC timed out after 30s";
    };
    const err = await xmrAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.hash).toBe(TX_HASH);
    expect(methods().filter((m) => m === "get_transfer_by_txid")).toHaveLength(2);
  });

  it("a relay that provably sent nothing (-26) is a plain Error, and nothing is looked up", async () => {
    rpc.relay_tx = () => {
      throw "RPC error -26: Failed to parse hex.";
    };
    const err = await xmrAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/Nothing was sent/);
    expect(methods()).not.toContain("get_transfer_by_txid");
  });

  it("uses priority 0 (the wallet's default), not 1 (the lowest)", async () => {
    await xmrAdapter.sendTransaction("", TO, "1");
    expect(rpcCalls().find((c) => c.method === "transfer")!.params.priority).toBe(0);
  });

  it("sends an amount above 2^53 piconero exactly, as a decimal string", async () => {
    // 9007.199254740993 XMR = 2^53 + 1 piconero: Number() rounds it to 2^53.
    await xmrAdapter.sendTransaction("", TO, "9007.199254740993");
    const amount = rpcCalls().find((c) => c.method === "transfer")!.params.destinations[0].amount;
    expect(amount).toBe("9007199254740993");
  });
});

describe("Monero recipient and sync checks (2026-09-29 send-safety audit)", () => {
  it("still sends when validate_address rejects with a STRING (was a TypeError)", async () => {
    rpc.validate_address = () => {
      throw "RPC error -32601: Method not found";
    };
    await expect(xmrAdapter.sendTransaction("", TO, "1")).resolves.toEqual({ hash: TX_HASH });
  });

  it("trims the recipient before validating and building", async () => {
    await xmrAdapter.sendTransaction("", `  ${TO}\n`, "1");
    expect(rpcCalls().find((c) => c.method === "validate_address")!.params.address).toBe(TO);
    expect(rpcCalls().find((c) => c.method === "transfer")!.params.destinations[0].address).toBe(TO);
  });

  it("refuses an invalid address before building anything", async () => {
    rpc.validate_address = () => ({ valid: false, integrated: false, subaddress: false, nettype: "mainnet" });
    await expect(xmrAdapter.sendTransaction("", TO, "1")).rejects.toThrow(/Invalid Monero address/);
    expect(methods()).not.toContain("transfer");
  });

  it("never hands the wallet a name to resolve (OpenAlias), even when validate_address is down", async () => {
    rpc.validate_address = () => {
      throw "RPC timed out after 30s";
    };
    await expect(xmrAdapter.sendTransaction("", "donate.example.org", "1")).rejects.toThrow(
      /OpenAlias/
    );
    expect(methods()).not.toContain("transfer");
  });

  it("blames an unreachable node, not the wallet (was 'not fully synced (0.0% — N / 0)')", async () => {
    probeHeight = 0;
    const err = await xmrAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(err.message).toMatch(/Could not reach a Monero node/);
    expect(err.message).not.toMatch(/0\.0%/);
    expect(methods()).not.toContain("transfer");
  });

  it("says the wallet did not answer when get_height is busy (was '?% — 0 / 0')", async () => {
    rpc.get_height = () => {
      throw "RPC timed out after 30s";
    };
    const err = await xmrAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(err.message).toMatch(/did not report whether it is synced/);
    expect(err.message).not.toMatch(/\/ 0\)/);
  });
});

describe("Monero history, balance and fee (2026-09-29 send-safety audit)", () => {
  it("asks for failed transfers too, so a dropped send stays visible", async () => {
    rpc.get_transfers = () => ({ failed: [{ txid: "ff", type: "failed", amount: 1, fee: 1, timestamp: 1, confirmations: 0, height: 0, destinations: [{ address: TO, amount: 1 }] }] });
    const page = await xmrAdapter.getTransactionHistory("");
    expect(rpcCalls().find((c) => c.method === "get_transfers")!.params.failed).toBe(true);
    expect(page.items[0]).toMatchObject({ direction: "failed", counterparty: TO });
  });

  it("shows an incoming mempool transfer as a pending RECEIPT, not a send", async () => {
    rpc.get_transfers = () => ({
      pool: [{ txid: "aa", amount: 2_000_000_000_000, fee: 0, timestamp: 5, confirmations: 3, height: 0 }],
    });
    const page = await xmrAdapter.getTransactionHistory("");
    expect(page.items[0]).toMatchObject({ direction: "in", confirmations: 0 });
    expect(page.items[0].counterparty).toBeUndefined();
  });

  it("reports unlocked and total separately", async () => {
    await expect(xmrAdapter.getSendableBalance!()).resolves.toEqual({ unlocked: "3.25", total: "5" });
  });

  it("never calls get_fee_estimate, which monero-wallet-rpc does not have", async () => {
    await expect(xmrAdapter.getFeeEstimate()).rejects.toThrow(/Not estimated in advance/);
    expect(methods()).toEqual([]);
  });
});
