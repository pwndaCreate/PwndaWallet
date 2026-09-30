/**
 * Xelis sends against a mocked `xelis_wallet` (2026-09-29 send-safety audit,
 * finding 14).
 *
 * `build_transaction {broadcast: true}` builds and submits in one call. The
 * send had no sync check, and it parsed the response's `fee` strictly AFTER
 * the broadcast, against a shape nobody had observed (the spike only built
 * with `broadcast: false`): an unexpected `fee` threw "expected a u64", the UI
 * said "Transaction failed" with the form filled, and a retry paid twice.
 * What these pin:
 *   - a wallet that is not synced (or not online) refuses before building;
 *   - nothing after a successful answer throws: the hash comes back;
 *   - a success with no hash, a transport failure, or a failed SUBMISSION is an
 *     unknown outcome, never a failure the form invites again;
 *   - errors the wallet raises while BUILDING stay ordinary errors.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("./xelis-nodes", () => ({
  pickXelisDaemon: vi.fn(async () => "https://node.sandbox.test"),
}));
vi.mock("./xelis-keys", async () => {
  const actual = await vi.importActual<typeof import("./xelis-keys")>("./xelis-keys");
  return {
    ...actual,
    verifyXelisSeedIntegrity: vi.fn(() => ({ ok: true })),
    xelisAddressFromSeed: vi.fn(() => OWN),
    xelisNetworkFromEnv: vi.fn(() => "mainnet"),
  };
});

import { invoke } from "../lib/tauri";
import { isSendOutcomeUnknown } from "./send-outcome";
import { initXelisSession, xelisAdapter } from "./xelis-wallet";

const invokeMock = vi.mocked(invoke);
/** Real mainnet addresses from `xelis-vectors.ts`. */
const OWN = "xel:qc3hdkmsc0nqks7jqz8cpnzv5c3ur7my6yy7ct6ulf5kuexv53pqqjlaht0";
const TO = "xel:ym3qntl80esaae92u6ac4dk0nq2lle8scy03f8xknud9at29w3csqnyl7dc";
const HASH = "f8bd7c15e3a94085f8130cc67e1fefd89192cdd208b68b10e1cc6e1a83afe5d6";

type RpcHandler = (params: any) => unknown;
let rpc: Record<string, RpcHandler>;

function defaultRpc(): Record<string, RpcHandler> {
  return {
    get_address: () => OWN,
    is_online: () => true,
    get_topoheight: () => 1_000,
    network_info: () => ({ topoheight: 1_010, stable_topoheight: 1_000 }),
    get_balance: () => 500_000_000,
    build_transaction: () => ({ hash: HASH, fee: 25_000 }),
  };
}

const rpcCalls = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === "xelis_rpc_call")
    .map(([, a]) => a as { method: string; params: any });
const builds = () => rpcCalls().filter((c) => c.method === "build_transaction");

beforeAll(async () => {
  rpc = defaultRpc();
  invokeMock.mockImplementation(async (cmd: string, args?: any) => {
    switch (cmd) {
      case "xelis_binary_status":
      case "xelis_rpc_is_running":
        return true;
      case "xelis_ensure_wallet":
        return false;
      case "xelis_start_rpc":
      case "xelis_stop_rpc":
        return null;
      case "xelis_rpc_call": {
        const h = rpc[args.method];
        if (!h) throw "RPC error -32601: Method not found";
        return h(args.params);
      }
      default:
        throw `unexpected command ${cmd}`;
    }
  });
  await initXelisSession("seed words are mocked", "master-password");
});

beforeEach(() => {
  invokeMock.mockClear();
  rpc = defaultRpc();
});

describe("Xelis send (2026-09-29 send-safety audit, finding 14)", () => {
  it("sends with broadcast: true and returns the hash", async () => {
    await expect(xelisAdapter.sendTransaction("", TO, "1.5")).resolves.toEqual({ hash: HASH });
    expect(builds()).toHaveLength(1);
    expect(builds()[0].params).toMatchObject({
      broadcast: true,
      transfers: [{ amount: 150_000_000, destination: TO }],
    });
  });

  it("refuses before building while the wallet is still scanning", async () => {
    rpc.get_topoheight = () => 900; // stable is 1_000
    await expect(xelisAdapter.sendTransaction("", TO, "1")).rejects.toThrow(/still scanning/);
    expect(builds()).toEqual([]);
  });

  it("refuses before building while the wallet is offline", async () => {
    rpc.is_online = () => false;
    await expect(xelisAdapter.sendTransaction("", TO, "1")).rejects.toThrow(/not connected/);
    expect(builds()).toEqual([]);
  });

  it("never throws after a successful broadcast: an unreadable fee still returns the hash", async () => {
    rpc.build_transaction = () => ({ hash: HASH, fee: "25000.5" });
    await expect(xelisAdapter.sendTransaction("", TO, "1")).resolves.toEqual({ hash: HASH });
  });

  it("a success with no hash is an unknown outcome, not a failure", async () => {
    rpc.build_transaction = () => ({ fee: 25_000 });
    const err = await xelisAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
  });

  it("a transport failure of the one-call send is an unknown outcome", async () => {
    rpc.build_transaction = () => {
      throw "Xelis RPC request failed: error sending request for url (http://127.0.0.1:1/json_rpc)";
    };
    const err = await xelisAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
  });

  it("a failed SUBMISSION is an unknown outcome", async () => {
    rpc.build_transaction = () => {
      throw "RPC error -32004: UNSPECIFIED Couldn't submit transaction: timeout";
    };
    const err = await xelisAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
  });

  it("a BUILD refusal stays an ordinary error", async () => {
    rpc.build_transaction = () => {
      throw "RPC error -32004: BALANCE_NOT_FOUND Balance for asset 0000 was not found";
    };
    const err = await xelisAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(String(err.message ?? err)).toMatch(/BALANCE_NOT_FOUND/);
  });
});
