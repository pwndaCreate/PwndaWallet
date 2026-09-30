/**
 * Zano sends against a mocked simplewallet (2026-09-29 send-safety audit).
 *
 * The send handed `to` to simplewallet untouched and omitted `fee`. From the
 * vendored v2.2.1.506 source (`.swap-sidecar-work/zano-build`, the version the
 * app runs): an omitted fee is 0 and `on_transfer` refuses it ("Given fee is
 * too low"), `@name` is resolved by the (public) daemon, and a 42-character
 * `0x…` becomes a bridge wrap to the custody wallet. What these pin:
 *   - only real Zano addresses reach simplewallet: prefix, keccak checksum and
 *     body size checked here; aliases, `0x…` and gateway addresses refused
 *     (finding 4);
 *   - every send pays the explicit 0.01 ZANO fee, amounts go as JSON numbers
 *     while exact and as exact strings above 2^53 (finding 5);
 *   - a failure that may have come after the broadcast is an unknown outcome,
 *     not "failed" (the send is one call, so there is no txid before it);
 *   - the fee estimate is that fee, and the Send modal gets unlocked vs total.
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
    zanoAddressFromSeed: vi.fn(() => OWN),
  };
});

import { keccak_256 } from "@noble/hashes/sha3.js";
import { invoke } from "../lib/tauri";
import { _internal } from "./xmr-keys";
import { isSendOutcomeUnknown } from "./send-outcome";
import { initZanoSession, zanoAdapter, zanoRecipientProblem } from "./zano-wallet";

const invokeMock = vi.mocked(invoke);

/** Derived from a real seed and matched against simplewallet (zano-keys.test.ts). */
const ZX =
  "ZxDuP6pbXjqTevNr6PFRZYLL8vCoX5RuhHJwSc5DcdA5Gs4gZTwoiRXgkmryoJnsTeaYNmFy6c2wvMwaPTWvWWJK32SLJWruw";
/** An auditable wallet's address (zano-keys.test.ts). */
const AZX =
  "aZxarvWBzhT1Jjyx8Lh4vTJA8CdYkzGV99FwftpWP2SLF7JJrB1LJKsDzCCgVmXbcvN58dmL6Zr2d26nAC5b3x114ZajA6UM2T6";
const OWN = ZX;
const TO = ZX;

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

/** base58(varint(prefix) ‖ body ‖ keccak4), the layout simplewallet parses. */
function encode(prefix: number, body: Uint8Array): string {
  const payload = Uint8Array.from([...varint(prefix), ...body]);
  const raw = Uint8Array.from([...payload, ...keccak_256(payload).slice(0, 4)]);
  return _internal.moneroBase58Encode(raw);
}
const keys = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
const withFlags = Uint8Array.from([...keys, 0]);
const paymentId = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

type RpcHandler = (params: any) => unknown;
let rpc: Record<string, RpcHandler>;

function defaultRpc(): Record<string, RpcHandler> {
  return {
    getaddress: () => ({ address: OWN }),
    getbalance: () => ({
      balances: [
        {
          asset_info: {
            asset_id: "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a",
            ticker: "ZANO",
            full_name: "Zano",
            decimal_point: 12,
            current_supply: 0,
            hidden_supply: false,
          },
          total: 7_500_000_000_000,
          unlocked: 5_000_000_000_000,
          awaiting_in: 0,
          awaiting_out: 0,
        },
      ],
    }),
    transfer: () => ({ tx_hash: "ee".repeat(32), tx_size: 1800, used_out_ids: [3] }),
  };
}

const rpcCalls = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === "zano_rpc_call")
    .map(([, a]) => a as { method: string; params: any });
const transferCalls = () => rpcCalls().filter((c) => c.method === "transfer");

beforeAll(async () => {
  rpc = defaultRpc();
  invokeMock.mockImplementation(async (cmd: string, args?: any) => {
    switch (cmd) {
      case "zano_binary_status":
        return true;
      case "zano_rpc_is_running":
        return true;
      case "zano_ensure_wallet":
        return false;
      case "zano_start_rpc":
      case "zano_stop_rpc":
        return null;
      case "zano_rpc_call": {
        const h = rpc[args.method];
        if (!h) throw `Zano RPC error: {"code":-32601,"message":"Method not found"}`;
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
});

beforeEach(() => {
  invokeMock.mockClear();
  rpc = defaultRpc();
});

describe("zanoRecipientProblem (2026-09-29 send-safety audit, finding 4)", () => {
  it("accepts standard, integrated and auditable Zano addresses", () => {
    expect(zanoRecipientProblem(ZX)).toBeNull();
    expect(zanoRecipientProblem(AZX)).toBeNull();
    // Independent vectors: the DOC_EXMP addresses in simplewallet's own source
    // (basic_kv_structs.h:36, wallet_public_structs_defs.h:1084, v2.2.1.506).
    expect(
      zanoRecipientProblem(
        "ZxBvJDuQjMG9R2j4WnYUhBYNrwZPwuyXrC7FHdVmWqaESgowDvgfWtiXeNGu8Px9B24pkmjsA39fzSSiEQG1ekB225ZnrMTBp",
      ),
    ).toBeNull();
    expect(
      zanoRecipientProblem(
        "iZ2EMyPD7g28hgBfboZeCENaYrHBYZ1bLFi5cgWvn4WJLaxfgs4kqG6cJi9ai2zrXWSCpsvRXit14gKjeijx6YPCLJEv6Fx4rVm1hdAGQFis",
      ),
    ).toBeNull();
    expect(zanoRecipientProblem(encode(0xc5, keys))).toBeNull(); // old 64-byte layout
    expect(zanoRecipientProblem(encode(0x36f8, Uint8Array.from([...withFlags, ...paymentId])))).toBeNull();
    expect(zanoRecipientProblem(encode(0x3678, Uint8Array.from([...keys, ...paymentId])))).toBeNull();
  });

  it("refuses an alias: the public node would decide who gets paid", () => {
    expect(zanoRecipientProblem("@exchange")).toMatch(/aliases/);
  });

  it("refuses a 0x address: simplewallet would turn it into a bridge wrap", () => {
    expect(zanoRecipientProblem("0x" + "ab".repeat(20))).toMatch(/Ethereum-style/);
  });

  it("refuses a gateway address (gwZ…)", () => {
    expect(zanoRecipientProblem(encode(0x656e, withFlags))).toMatch(/gateway/);
  });

  it("refuses a checksum mismatch, a foreign prefix and a wrong body size", () => {
    const flipped = ZX.slice(0, -1) + (ZX.endsWith("w") ? "x" : "w");
    expect(zanoRecipientProblem(flipped)).toMatch(/not a valid Zano address/);
    expect(zanoRecipientProblem(encode(0x12, withFlags))).toMatch(/not a valid Zano address/);
    expect(zanoRecipientProblem(encode(0xc5, Uint8Array.from([...withFlags, 9])))).toMatch(
      /not a valid Zano address/,
    );
    expect(zanoRecipientProblem("Zx0OIl")).toMatch(/not a valid Zano address/);
    expect(zanoRecipientProblem("")).toMatch(/Enter a Zano address/);
  });
});

describe("Zano send (2026-09-29 send-safety audit)", () => {
  it("pays the explicit 0.01 ZANO fee, numeric amounts, trimmed recipient (was: no fee → refused)", async () => {
    const r = await zanoAdapter.sendTransaction("", `  ${TO}\n`, "1.5");
    expect(r).toEqual({ hash: "ee".repeat(32) });
    expect(transferCalls()).toHaveLength(1);
    expect(transferCalls()[0].params).toEqual({
      destinations: [{ address: TO, amount: 1_500_000_000_000 }],
      fee: 10_000_000_000,
      mixin: 0,
    });
  });

  it("sends an amount above 2^53 atomic exactly, as a decimal string", async () => {
    await zanoAdapter.sendTransaction("", TO, "9007.199254740993");
    expect(transferCalls()[0].params.destinations[0].amount).toBe("9007199254740993");
  });

  it("never sends to an alias or a 0x address", async () => {
    await expect(zanoAdapter.sendTransaction("", "@exchange", "1")).rejects.toThrow(/aliases/);
    await expect(zanoAdapter.sendTransaction("", "0x" + "ab".repeat(20), "1")).rejects.toThrow(
      /Ethereum-style/,
    );
    expect(transferCalls()).toEqual([]);
  });

  it("a refusal from simplewallet itself is a plain Error (nothing was sent)", async () => {
    rpc.transfer = () => {
      throw `Zano RPC error: {"code":-4,"message":"WALLET_RPC_ERROR_CODE_NOT_ENOUGH_MONEY: not enough money"}`;
    };
    const err = await zanoAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/NOT_ENOUGH_MONEY/);
  });

  it("a timeout of the one-call send is an unknown outcome, not a failure", async () => {
    rpc.transfer = () => {
      throw "Zano RPC request failed: error sending request for url (http://127.0.0.1:18084/json_rpc): operation timed out";
    };
    const err = await zanoAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
  });

  it("no_connection_to_daemon (thrown when the daemon send call fails) is an unknown outcome", async () => {
    rpc.transfer = () => {
      throw `Zano RPC error: {"code":-4,"message":"WALLET_RPC_ERROR_CODE_GENERIC_TRANSFER_ERROR: [tools::error::no_connection_to_daemon] wallet2.cpp:7519 no connection to daemon"}`;
    };
    const err = await zanoAdapter.sendTransaction("", TO, "1").catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
  });

  it("reports the exact fee it pays, and unlocked vs total", async () => {
    const fee = await zanoAdapter.getFeeEstimate();
    expect(fee.normal.value).toBe("0.01");
    expect(fee.unit).toBe("ZANO");
    await expect(zanoAdapter.getSendableBalance!()).resolves.toEqual({ unlocked: "5", total: "7.5" });
  });
});
