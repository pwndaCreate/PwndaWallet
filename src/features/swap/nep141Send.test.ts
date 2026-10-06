/**
 * NEP-141 sends — USDT and USDC on NEAR (2026-10-06; operator request
 * 2026-10-01).
 *
 * A token send is a FunctionCall to the TOKEN CONTRACT: `ft_transfer` with
 * exactly 1 yoctoNEAR, preceded by `storage_deposit` when the receiver is not
 * registered with the contract (a transfer to an unregistered account fails).
 * The Rust signer is unchanged: it signs the 32-byte transaction hash it is
 * handed, so the whole transaction is built — and pinned here — in TypeScript.
 *
 * The fakes are the NEAR RPC (fetch) and the Rust commands (invoke), as in
 * `nearSigning.test.ts`: the fake signer signs exactly what it is handed with
 * the abandon-seed NEAR key, like Rust does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "../../lib/tauri";
import {
  NEAR_CONFIRM,
  decodeNearTransaction,
  encodeNearTransaction,
  executeNearTokenTransfer,
} from "./swap-sources";
import { executeNearTokenSend } from "./session-send";
import { SafetyInvariantError, assertNearTokenTransferShape } from "./safety-invariants";
import { nearAdapter, NEAR_RPC_TIMEOUT } from "../../wallets/near-wallet";
import { isSendOutcomeUnknown } from "../../wallets/send-outcome";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b?: Uint8Array) => new TextDecoder().decode(b ?? new Uint8Array());

// ── The wallet: the abandon seed's NEAR key (same derivation as Rust's) ──
const me = nearAdapter.deriveFromMnemonic(ABANDON);
const SECRET = Uint8Array.from(Buffer.from(me.privateKey, "hex"));
const PUB = ed25519.getPublicKey(SECRET);
const ME_PK = "ed25519:" + b58encode(PUB);
const USDT = "usdt.tether-token.near";
const FRESH = "c".repeat(64); // an implicit account the contract has never seen
const REGISTERED = "d".repeat(64);
const MIN = "1250000000000000000000"; // 0.00125 NEAR, both contracts' minimum
const BLOCK_HASH = "GmJtbfLwEB5JJGfpnwFhF99f8HUZ3v2Xi1k4p1fCEXH1";

interface FakeNear {
  nonce: number;
  /** view_account answers; absent = UNKNOWN_ACCOUNT. */
  accounts: Record<string, { amount: string; locked: string; storage_usage: number }>;
  /** ft_balance_of per account, on USDT. */
  tokens: Record<string, string>;
  /** Accounts with storage on USDT. */
  registered: Set<string>;
  outcome: "success" | "failure" | "unknown";
}
let net: FakeNear;

function rpcResult(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    headers: { "content-type": "application/json" },
  });
}
function rpcError(name: string, data: string) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { name: "HANDLER_ERROR", cause: { name, info: {} }, code: -32000, message: "Server error", data },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
const viewResult = (v: unknown) => rpcResult({ result: Array.from(utf8(JSON.stringify(v))), logs: [] });

async function fakeFetch(_input: unknown, init?: { body?: unknown }) {
  const { method, params } = JSON.parse(String(init?.body ?? "{}"));
  if (method === "query" && params.request_type === "view_access_key") {
    return rpcResult({ nonce: net.nonce, permission: "FullAccess" });
  }
  if (method === "query" && params.request_type === "view_account") {
    const a = net.accounts[params.account_id];
    return a ? rpcResult(a) : rpcError("UNKNOWN_ACCOUNT", `account ${params.account_id} does not exist`);
  }
  if (method === "query" && params.request_type === "call_function") {
    expect(params.account_id).toBe(USDT);
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
    switch (params.method_name) {
      case "ft_balance_of":
        return viewResult(net.tokens[args.account_id] ?? "0");
      case "storage_balance_of":
        return viewResult(net.registered.has(args.account_id) ? { total: MIN, available: "0" } : null);
      case "storage_balance_bounds":
        return viewResult({ min: MIN, max: MIN });
    }
  }
  if (method === "gas_price") return rpcResult({ gas_price: "100000000" });
  if (method === "status") return rpcResult({ sync_info: { latest_block_hash: BLOCK_HASH } });
  if (method === "tx") {
    if (net.outcome === "unknown") return rpcError("UNKNOWN_TRANSACTION", `Transaction ${params.tx_hash} doesn't exist`);
    return rpcResult({
      final_execution_status: "EXECUTED_OPTIMISTIC",
      status:
        net.outcome === "success"
          ? { SuccessValue: "" }
          : { Failure: { ActionError: { index: 1, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } } },
    });
  }
  throw new Error(`unscripted NEAR RPC ${method} ${params?.request_type ?? ""} ${params?.method_name ?? ""}`);
}

let broadcasts: string[];
async function fakeInvoke(cmd: string, args: any): Promise<unknown> {
  switch (cmd) {
    case "swap_sign_near_tx": {
      const msg = Uint8Array.from(Buffer.from(args.messageB64, "base64"));
      return Buffer.from(ed25519.sign(msg, SECRET)).toString("base64");
    }
    case "swap_broadcast":
      broadcasts.push(args.input.rawTx);
      return "";
    case "swap_get_near_address":
      return { accountId: me.address, publicKey: ME_PK };
    default:
      throw new Error(`unscripted invoke ${cmd}`);
  }
}
const signCalls = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "swap_sign_near_tx");

/** The broadcast transaction, decoded. */
function lastTx() {
  const signed = Uint8Array.from(Buffer.from(broadcasts[broadcasts.length - 1], "base64"));
  const txBytes = signed.subarray(0, signed.length - 65);
  return { txBytes, sig: signed.subarray(signed.length - 64), tx: decodeNearTransaction(txBytes) };
}

const send = (over: Partial<Parameters<typeof executeNearTokenTransfer>[0]> = {}) =>
  executeNearTokenTransfer({
    sessionId: "session-1",
    fromAccountId: me.address,
    fromPublicKey: ME_PK,
    tokenContract: USDT,
    receiverId: FRESH,
    amountAtomic: "12500000", // 12.5 USDT
    decimals: 6,
    ticker: "USDT",
    rpcUrl: "https://near.drpc.org",
    ...over,
  });

const savedConfirm = { ...NEAR_CONFIRM };
beforeEach(() => {
  net = {
    nonce: 41,
    accounts: { [me.address]: { amount: "1000000000000000000000000", locked: "0", storage_usage: 182 } }, // 1 NEAR
    tokens: { [me.address]: "100000000" }, // 100 USDT
    registered: new Set([me.address, REGISTERED]),
    outcome: "success",
  };
  broadcasts = [];
  Object.assign(NEAR_CONFIRM, { pollMs: 2, budgetMs: 40 });
  NEAR_RPC_TIMEOUT.ms = 2_000;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(fakeInvoke as any);
});
afterEach(() => {
  Object.assign(NEAR_CONFIRM, savedConfirm);
  vi.unstubAllGlobals();
});

describe("the FunctionCall encoding, pinned against mainnet", () => {
  // A real `storage_deposit` + `ft_transfer` on usdt.tether-token.near, read
  // read-only from archival-rpc.mainnet.fastnear.com on 2026-10-06: tx
  // 7rdPVtGp… in block 218787406, signed against block 218787401. As for the
  // native transfer in `nearSigning.test.ts`, the block hash is in no RPC view
  // of a transaction; it was found by re-encoding against each preceding
  // block until the hash matched. Public chain data.
  const REAL = {
    hash: "7rdPVtGppoQWSGGiMxpXWamoCZUTmSqeSYxE3crpTm9b",
    signerId: "rakhapf.tg",
    publicKey: "Aroe4EQMWjqjD2xwbUuDcLz5xSyvZxoNBdWzcTQkdgef",
    nonce: 114081076013745n,
    receiverId: "usdt.tether-token.near",
    blockHash: "2Jaay6SBwmqbMht2WdzpmsYmfqynegCFg6RhmzQBuK3Q",
    payee: "99cb8370739f5ca82d45663857e97e5fa388df7e5fd88d18cdfd58ccae3ae34e",
    signature:
      "5Ssb6h5pRg6WDidd2HzXHvhweuRMx5QrYMUSbgVCm2fPzjtjjqXS1y3LpC1vLtccVezdqPo1acsNPAGq6isGy16y",
  };

  it("reproduces the real transaction's hash, with the JSON arguments the wallet writes", () => {
    const bytes = encodeNearTransaction({
      signerId: REAL.signerId,
      publicKeyEd25519Base58: REAL.publicKey,
      nonce: REAL.nonce,
      receiverId: REAL.receiverId,
      blockHashB58: REAL.blockHash,
      actions: [
        {
          kind: "functionCall",
          methodName: "storage_deposit",
          // Exactly what `executeNearTokenTransfer` serialises.
          args: utf8(JSON.stringify({ account_id: REAL.payee, registration_only: true })),
          gas: 30_000_000_000_000n,
          deposit: 1_250_000_000_000_000_000_000n,
        },
        {
          kind: "functionCall",
          methodName: "ft_transfer",
          args: utf8(JSON.stringify({ receiver_id: REAL.payee, amount: "155493667" })),
          gas: 50_000_000_000_000n,
          deposit: 1n,
        },
      ],
    });
    expect(b58encode(sha256(bytes))).toBe(REAL.hash);
    const sig = b58decode(REAL.signature);
    const pk = b58decode(REAL.publicKey);
    expect(ed25519.verify(sig, sha256(bytes), pk)).toBe(true);
    expect(ed25519.verify(sig, bytes, pk)).toBe(false);
    // And it reads back as it was written.
    const d = decodeNearTransaction(bytes);
    expect(d.receiverId).toBe(REAL.receiverId);
    expect(d.actions.map((a) => [a.tag, a.methodName, a.deposit])).toEqual([
      [2, "storage_deposit", 1_250_000_000_000_000_000_000n],
      [2, "ft_transfer", 1n],
    ]);
  });

  it("a single Transfer encodes as the native encoder does", async () => {
    const { encodeNearTransferTransaction } = await import("./swap-sources");
    const args = {
      signerId: "55066.near",
      publicKeyEd25519Base58: "A6voSSdtJtZxqZ6n2er1sGRTJW9kxcjwNjD5s1oUsGBS",
      nonce: 104526738000010n,
      receiverId: "nayakasuresh300.near",
      blockHashB58: BLOCK_HASH,
    };
    expect(
      Buffer.from(encodeNearTransaction({ ...args, actions: [{ kind: "transfer", deposit: 41143808012500000000000n }] })),
    ).toEqual(Buffer.from(encodeNearTransferTransaction({ ...args, yoctoAmount: 41143808012500000000000n })));
  });
});

describe("a USDT send on NEAR", () => {
  it("to an unregistered account: registers it and transfers, in ONE transaction to the token contract", async () => {
    const r = await send();
    expect(r.confirmed).toBe(true);
    expect(r.registered).toBe(true);
    const { txBytes, sig, tx } = lastTx();
    expect(tx.signerId).toBe(me.address);
    expect(tx.receiverId).toBe(USDT);
    expect(tx.actions).toHaveLength(2);
    const [reg, xfer] = tx.actions;
    expect(reg.methodName).toBe("storage_deposit");
    expect(JSON.parse(text(reg.args))).toEqual({ account_id: FRESH, registration_only: true });
    expect(reg.deposit).toBe(BigInt(MIN));
    expect(xfer.methodName).toBe("ft_transfer");
    expect(JSON.parse(text(xfer.args))).toEqual({ receiver_id: FRESH, amount: "12500000" });
    expect(xfer.deposit).toBe(1n);
    // Signed once, over the hash, and the id returned is that hash.
    expect(signCalls()).toHaveLength(1);
    expect(ed25519.verify(sig, sha256(txBytes), PUB)).toBe(true);
    expect(r.txHash).toBe(b58encode(sha256(txBytes)));
  });

  it("to a registered account: the transfer alone", async () => {
    const r = await send({ receiverId: REGISTERED });
    expect(r.registered).toBe(false);
    const { tx } = lastTx();
    expect(tx.actions.map((a) => a.methodName)).toEqual(["ft_transfer"]);
  });

  it("refuses, before anything is signed, what it can decide alone", async () => {
    const refusals: Array<[Partial<Parameters<typeof executeNearTokenTransfer>[0]>, RegExp]> = [
      [{ receiverId: me.address }, /cannot be sent to the NEAR account that holds it/],
      [{ receiverId: "0x" + "ab".repeat(20) }, /Ethereum-style address/],
      [{ receiverId: "nobody-here.near" }, /does not exist[\s\S]*anyone could still create/],
      [{ amountAtomic: "0" }, /greater than zero/],
      [{ amountAtomic: "100000001" }, /holds 100 USDT; this send needs 100\.000001/],
    ];
    for (const [over, why] of refusals) {
      await expect(send(over)).rejects.toThrow(why);
    }
    expect(signCalls()).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it("refuses when the account's NEAR cannot pay the gas and the registration, and says what it costs", async () => {
    // 0.005 NEAR spendable: enough gas for a plain transfer, not with a registration.
    net.accounts[me.address] = { amount: "6820000000000000000000", locked: "0", storage_usage: 182 };
    const err = await send().catch((e) => e);
    expect(err.message).toMatch(/paid in NEAR/);
    expect(err.message).toMatch(/0\.00125 NEAR to register the recipient/);
    expect(err.message).toMatch(/Nothing was sent/);
    expect(signCalls()).toHaveLength(0);
    // The same balance can send to a registered account.
    await expect(send({ receiverId: REGISTERED })).resolves.toMatchObject({ confirmed: true });
  });

  it("a transfer NEAR ran and failed is an error naming the token and the hash", async () => {
    net.outcome = "failure";
    const err = await send().catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/NEAR ran the USDT transfer and it failed/);
    expect(err.message).toContain(b58encode(sha256(lastTx().txBytes)));
  });

  it("not seen within the wait: unconfirmed, and the dashboard reports an unknown outcome with the hash", async () => {
    net.outcome = "unknown";
    expect(await send()).toMatchObject({ confirmed: false });
    const err = await executeNearTokenSend({
      sessionId: "session-1",
      fromAddress: me.address,
      to: FRESH,
      amount: "1.5",
      tokenContract: USDT,
      decimals: 6,
      ticker: "USDT",
      rpcUrl: "https://near.drpc.org",
    }).catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.hash).toBe(b58encode(sha256(lastTx().txBytes)));
    // The typed 1.5 reached the contract as 1500000 atomic units.
    expect(JSON.parse(text(lastTx().tx.actions.at(-1)!.args)).amount).toBe("1500000");
  });

  it("the dashboard send refuses a wallet the session's key does not control", async () => {
    const err = await executeNearTokenSend({
      sessionId: "session-1",
      fromAddress: "e".repeat(64),
      to: FRESH,
      amount: "1",
      tokenContract: USDT,
      decimals: 6,
      ticker: "USDT",
      rpcUrl: "https://near.drpc.org",
    }).catch((e) => e);
    expect(err.message).toMatch(/can only sign for/);
    expect(signCalls()).toHaveLength(0);
  });
});

describe("the NEP-141 shape check refuses any other transaction", () => {
  const base = {
    signerId: me.address,
    publicKeyEd25519Base58: ME_PK.slice("ed25519:".length),
    nonce: 42n,
    blockHashB58: BLOCK_HASH,
  };
  const fc = (methodName: string, args: unknown, deposit: bigint) => ({
    kind: "functionCall" as const,
    methodName,
    args: utf8(JSON.stringify(args)),
    gas: 30_000_000_000_000n,
    deposit,
  });
  const check = (receiverId: string, actions: Parameters<typeof encodeNearTransaction>[0]["actions"], storage: bigint | null) =>
    assertNearTokenTransferShape({
      decoded: decodeNearTransaction(encodeNearTransaction({ ...base, receiverId, actions })),
      tokenContract: USDT,
      receiverId: FRESH,
      amountAtomic: 5n,
      storageDeposit: storage,
      ticker: "USDT",
    });
  const good = fc("ft_transfer", { receiver_id: FRESH, amount: "5" }, 1n);
  const reg = fc("storage_deposit", { account_id: FRESH, registration_only: true }, BigInt(MIN));

  it("passes the two shapes it builds", () => {
    expect(() => check(USDT, [good], null)).not.toThrow();
    expect(() => check(USDT, [reg, good], BigInt(MIN))).not.toThrow();
  });

  it.each([
    ["another contract", () => check("evil.near", [good], null), "NEAR_RECIPIENT_DRIFT"],
    ["another payee", () => check(USDT, [fc("ft_transfer", { receiver_id: "x".repeat(64), amount: "5" }, 1n)], null), "NEAR_RECIPIENT_DRIFT"],
    ["another amount", () => check(USDT, [fc("ft_transfer", { receiver_id: FRESH, amount: "6" }, 1n)], null), "TX_VALUE_VS_QUOTE"],
    ["2 yocto attached", () => check(USDT, [fc("ft_transfer", { receiver_id: FRESH, amount: "5" }, 2n)], null), "NEAR_ACTION_NOT_TRANSFER"],
    ["a memo smuggled in", () => check(USDT, [fc("ft_transfer", { receiver_id: FRESH, amount: "5", memo: "x" }, 1n)], null), "NEAR_ACTION_NOT_TRANSFER"],
    ["ft_transfer_call", () => check(USDT, [fc("ft_transfer_call", { receiver_id: FRESH, amount: "5" }, 1n)], null), "NEAR_ACTION_NOT_TRANSFER"],
    ["an extra action", () => check(USDT, [good, good], null), "NEAR_ACTION_NOT_TRANSFER"],
    ["a registration nobody decided", () => check(USDT, [reg, good], null), "NEAR_ACTION_NOT_TRANSFER"],
    ["registering another account", () => check(USDT, [fc("storage_deposit", { account_id: "y".repeat(64), registration_only: true }, BigInt(MIN)), good], BigInt(MIN)), "NEAR_RECIPIENT_DRIFT"],
    ["a larger registration deposit", () => check(USDT, [fc("storage_deposit", { account_id: FRESH, registration_only: true }, BigInt(MIN) * 2n), good], BigInt(MIN)), "NEAR_ACTION_NOT_TRANSFER"],
    ["a native Transfer instead", () => check(USDT, [{ kind: "transfer", deposit: 5n }], null), "NEAR_ACTION_NOT_TRANSFER"],
  ])("refuses %s", (_name, run, invariant) => {
    let err: unknown = null;
    try {
      run();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SafetyInvariantError);
    expect((err as SafetyInvariantError).invariant).toBe(invariant);
  });
});
