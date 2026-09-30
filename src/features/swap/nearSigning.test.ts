/**
 * NEAR sends (2026-09-29 send-safety audit).
 *
 * Every NEAR transfer this wallet ever broadcast was invalid and reported as
 * sent: the Rust signer (`swap_sign_near_tx`) signs whatever bytes it is given,
 * the caller gave it the raw borsh `Transaction`, and NEAR verifies signatures
 * over sha256(borsh(Transaction)). The broadcast is `broadcast_tx_async`, which
 * answers with a hash before anything is validated, so the UI said "sent".
 *
 * The fakes here are the NEAR RPC (fetch) and the Rust commands (invoke). The
 * fake signer signs exactly what it is handed with the abandon-seed NEAR key,
 * like Rust does — so the old code's signature over raw bytes is what these
 * tests see from it, and that is how they were shown to fail there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "../../lib/tauri";
import {
  NEAR_CONFIRM,
  encodeNearTransferTransaction,
  executeNearNativeTransfer,
} from "./swap-sources";
import { executeNearSend } from "./session-send";
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
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// ── The wallet: the abandon seed's NEAR key (same derivation as Rust's) ──
const me = nearAdapter.deriveFromMnemonic(ABANDON);
const SECRET = Uint8Array.from(Buffer.from(me.privateKey, "hex"));
const PUB = ed25519.getPublicKey(SECRET);
const ME_PK = "ed25519:" + b58encode(PUB);
const OTHER = "a".repeat(64); // an implicit account
const BLOCK_HASH = "GmJtbfLwEB5JJGfpnwFhF99f8HUZ3v2Xi1k4p1fCEXH1";
const ONE_NEAR = "1000000000000000000000000";

// ── The fake NEAR network ──
interface FakeNear {
  nonce: number | null;
  accounts: Record<string, { amount: string; locked: string; storage_usage: number }>;
  /** What `tx` answers for the broadcast hash. */
  outcome: "success" | "failure" | "unknown";
  /** URL → an HTTP status (5xx) or "no-query" (the -32601 1rpc.io answers). */
  broken: Record<string, number | "no-query">;
  requests: Array<{ url: string; method: string; params: any }>;
}
let net: FakeNear;

function rpcResult(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    headers: { "content-type": "application/json" },
  });
}
function rpcError(name: string, data: string) {
  // The exact shape rpc.fastnear.com / near.drpc.org answered, 2026-09-29.
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { name: "HANDLER_ERROR", cause: { name, info: {} }, code: -32000, message: "Server error", data },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function fakeFetch(input: unknown, init?: { body?: unknown }) {
  const url = String(input);
  const { method, params } = JSON.parse(String(init?.body ?? "{}"));
  net.requests.push({ url, method, params });
  const broken = net.broken[url];
  if (typeof broken === "number") return new Response("upstream down", { status: broken });
  if (broken === "no-query" && method === "query") {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "the method query does not exist/is not available" } }),
      { headers: { "content-type": "application/json" } },
    );
  }
  if (method === "query" && params.request_type === "view_access_key") {
    return net.nonce === null
      ? rpcError("UNKNOWN_ACCESS_KEY", "access key does not exist while viewing")
      : rpcResult({ nonce: net.nonce, permission: "FullAccess" });
  }
  if (method === "query" && params.request_type === "view_account") {
    const a = net.accounts[params.account_id];
    return a
      ? rpcResult(a)
      : rpcError("UNKNOWN_ACCOUNT", `account ${params.account_id} does not exist while viewing`);
  }
  if (method === "status") return rpcResult({ sync_info: { latest_block_hash: BLOCK_HASH } });
  if (method === "tx") {
    if (net.outcome === "unknown") {
      return rpcError("UNKNOWN_TRANSACTION", `Transaction ${params.tx_hash} doesn't exist`);
    }
    return rpcResult({
      final_execution_status: "EXECUTED_OPTIMISTIC",
      status:
        net.outcome === "success"
          ? { SuccessValue: "" }
          : { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "x" } } } } },
    });
  }
  throw new Error(`unscripted NEAR RPC ${method}`);
}

// ── The fake Rust core ──
let signingKey: Uint8Array;
let broadcasts: string[];
let broadcastFails: boolean;
let sessionAccount: { accountId: string; publicKey: string };

async function fakeInvoke(cmd: string, args: any): Promise<unknown> {
  switch (cmd) {
    case "swap_sign_near_tx": {
      // Rust signs whatever bytes it is given (commands.rs swap_sign_near_tx).
      const msg = Uint8Array.from(Buffer.from(args.messageB64, "base64"));
      return Buffer.from(ed25519.sign(msg, signingKey)).toString("base64");
    }
    case "swap_broadcast": {
      broadcasts.push(args.input.rawTx);
      if (broadcastFails) throw "network error: connection reset by peer";
      // A node answers with the transaction's hash; broadcast_tx_async does
      // not validate the signature first.
      const signed = Uint8Array.from(Buffer.from(args.input.rawTx, "base64"));
      return b58encode(sha256(signed.subarray(0, signed.length - 65)));
    }
    case "swap_get_near_address":
      return sessionAccount;
    default:
      throw new Error(`unscripted invoke ${cmd}`);
  }
}

const signCalls = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "swap_sign_near_tx");

/** The broadcast SignedTransaction, split into its Transaction and signature. */
function lastBroadcast() {
  const signed = Uint8Array.from(Buffer.from(broadcasts[broadcasts.length - 1], "base64"));
  return {
    txBytes: signed.subarray(0, signed.length - 65),
    sigType: signed[signed.length - 65],
    sig: signed.subarray(signed.length - 64),
  };
}

/** receiver_id out of our Transaction layout (signer, key, nonce, receiver…). */
function receiverOf(txBytes: Uint8Array): string {
  const view = new DataView(txBytes.buffer, txBytes.byteOffset, txBytes.byteLength);
  let off = 4 + view.getUint32(0, true) + 1 + 32 + 8;
  const n = view.getUint32(off, true);
  off += 4;
  return new TextDecoder().decode(txBytes.subarray(off, off + n));
}

const transfer = (over: Partial<Parameters<typeof executeNearNativeTransfer>[0]> = {}) =>
  executeNearNativeTransfer({
    sessionId: "session-1",
    fromAccountId: me.address,
    fromPublicKey: ME_PK,
    depositAddress: OTHER,
    amountAtomic: ONE_NEAR,
    rpcUrl: "https://near.drpc.org",
    ...over,
  });

// Guarded so this file can also be pointed at the pre-2026-09-29 modules,
// which is how its assertions were shown to fail there.
const savedConfirm = NEAR_CONFIRM ? { ...NEAR_CONFIRM } : null;
beforeEach(() => {
  net = { nonce: 41, accounts: {}, outcome: "success", broken: {}, requests: [] };
  signingKey = SECRET;
  broadcasts = [];
  broadcastFails = false;
  sessionAccount = { accountId: me.address, publicKey: ME_PK };
  if (NEAR_CONFIRM) Object.assign(NEAR_CONFIRM, { pollMs: 2, budgetMs: 40 });
  if (NEAR_RPC_TIMEOUT) NEAR_RPC_TIMEOUT.ms = 2_000;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(fakeInvoke as any);
});
afterEach(() => {
  if (NEAR_CONFIRM && savedConfirm) Object.assign(NEAR_CONFIRM, savedConfirm);
  vi.unstubAllGlobals();
});

describe("NEAR signs the transaction hash (2026-09-29 send-safety audit)", () => {
  // A real mainnet transfer, read-only from rpc.fastnear.com on 2026-09-29:
  // tx 8GpuLMv5… in block 217868484, signed against block 217868479. Its
  // block hash is not in any RPC view of a transaction; it was recovered by
  // re-encoding the transaction against each preceding block until the hash
  // matched. Public chain data — anyone can look the hash up.
  const REAL = {
    hash: "8GpuLMv5fH38hSkCiBRwEmeJxw1VeeiWm1pBXWbTfyLo",
    signerId: "55066.near",
    publicKey: "A6voSSdtJtZxqZ6n2er1sGRTJW9kxcjwNjD5s1oUsGBS",
    nonce: 104526738000010n,
    receiverId: "nayakasuresh300.near",
    blockHash: "GmJtbfLwEB5JJGfpnwFhF99f8HUZ3v2Xi1k4p1fCEXH1",
    deposit: 41143808012500000000000n,
    signature:
      "5Z7s3nYDr7QHpsh8gsDZDz7iefX7JhgSBekXJ4cUhZ5HJt447UEd36WSKP5W6jTrCyHH7ESrFExSYwa6oyqPi9Pg",
    bytes:
      "0a00000035353036362e6e65617200873deb42eebbc22ec8b4011fc00c76130a3e99396505b28e4b7ebcf0f239" +
      "1fb98a881607115f0000140000006e6179616b617375726573683330302e6e656172ea39165c462b768f4eb2c1" +
      "2ccdd2766da5cfdbc0dea6b1511a880c51fd667dd0010000000300480f9d21860969b608000000000000",
  };

  it("a real mainnet transfer: our encoder reproduces its hash, and its signature is over sha256(borsh), not the bytes", () => {
    const bytes = encodeNearTransferTransaction({
      signerId: REAL.signerId,
      publicKeyEd25519Base58: REAL.publicKey,
      nonce: REAL.nonce,
      receiverId: REAL.receiverId,
      blockHashB58: REAL.blockHash,
      yoctoAmount: REAL.deposit,
    });
    expect(hex(bytes)).toBe(REAL.bytes);
    expect(b58encode(sha256(bytes))).toBe(REAL.hash);

    const sig = b58decode(REAL.signature);
    const pk = b58decode(REAL.publicKey);
    expect(ed25519.verify(sig, sha256(bytes), pk)).toBe(true);
    // The convention the wallet used until 2026-09-29: NEAR would reject it.
    expect(ed25519.verify(sig, bytes, pk)).toBe(false);
  });

  it("what is broadcast verifies over the hash, and the id returned is that hash", async () => {
    const r = await transfer();
    const { txBytes, sigType, sig } = lastBroadcast();
    expect(sigType).toBe(0); // ed25519
    expect(ed25519.verify(sig, sha256(txBytes), PUB)).toBe(true);
    expect(r).toEqual({ txHash: b58encode(sha256(txBytes)), confirmed: true });
    // Rust was handed the 32-byte hash, not the transaction.
    const [, signArgs] = signCalls()[0] as [string, { messageB64: string }];
    expect(Buffer.from(signArgs.messageB64, "base64").length).toBe(32);
  });

  it("a hash from the broadcast is not success: a transfer NEAR ran and failed is an error naming the hash", async () => {
    net.outcome = "failure";
    const err = await transfer().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/NEAR ran the transfer and it failed/);
    const { txBytes } = lastBroadcast();
    expect(err.message).toContain(b58encode(sha256(txBytes)));
  });

  it("not seen within the wait: unconfirmed (a swap keeps tracking the hash), and the dashboard says 'unknown' with it", async () => {
    net.outcome = "unknown";
    const r = await transfer();
    const { txBytes } = lastBroadcast();
    expect(r).toEqual({ txHash: b58encode(sha256(txBytes)), confirmed: false });

    const err = await executeNearSend({
      sessionId: "session-1",
      fromAddress: me.address,
      to: OTHER,
      amount: "1",
      rpcUrl: "https://near.drpc.org",
    }).catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.hash).toBe(b58encode(sha256(lastBroadcast().txBytes)));
  });

  it("a broadcast that throws is still looked up by hash — the connection can drop after delivery", async () => {
    broadcastFails = true;
    const r = await transfer();
    expect(r.confirmed).toBe(true);
    // Only the identical signed bytes were re-sent to the next node.
    expect(broadcasts.length).toBe(NEAR_CONFIRM.broadcastTries);
    expect(new Set(broadcasts).size).toBe(1);
  });

  it("a signature that does not verify for the account's key is never broadcast", async () => {
    signingKey = ed25519.utils.randomSecretKey();
    await expect(transfer()).rejects.toThrow(/does not match this account's key/);
    expect(broadcasts).toEqual([]);
  });
});

describe("NEAR recipients are validated before anything is signed (#5)", () => {
  it.each([
    ["0x" + "ab".repeat(20), /Ethereum-style address/],
    ["Alice.near", /not a valid NEAR account ID/],
    ["bob..near", /not a valid NEAR account ID/],
    ["-bob.near", /not a valid NEAR account ID/],
    ["bob.near.", /not a valid NEAR account ID/],
    ["a", /2 to 64 characters/],
    ["b".repeat(65), /2 to 64 characters/],
    ["A".repeat(64), /lowercase hex/],
  ])("refuses %s", async (to, why) => {
    await expect(transfer({ depositAddress: to })).rejects.toThrow(why);
    expect(signCalls()).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(net.requests).toEqual([]);
  });

  it("refuses a named account that does not exist (a transfer to it fails on chain)", async () => {
    await expect(transfer({ depositAddress: "nobody-here.near" })).rejects.toThrow(
      /"nobody-here\.near" does not exist/,
    );
    expect(signCalls()).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it("trims whitespace, and pays an existing named account exactly by name", async () => {
    net.accounts["bob.near"] = { amount: "1", locked: "0", storage_usage: 100 };
    const r = await transfer({ depositAddress: "  bob.near \n" });
    expect(r.confirmed).toBe(true);
    expect(receiverOf(lastBroadcast().txBytes)).toBe("bob.near");
  });
});

describe("an amount of 0 is refused (#14)", () => {
  it("in the shared transfer", async () => {
    await expect(transfer({ amountAtomic: "0" })).rejects.toThrow(/greater than zero/);
    expect(signCalls()).toEqual([]);
  });

  it("in the dashboard send", async () => {
    await expect(
      executeNearSend({ sessionId: "s", fromAddress: me.address, to: OTHER, amount: "0", rpcUrl: "https://near.drpc.org" }),
    ).rejects.toThrow(/greater than zero/);
    expect(signCalls()).toEqual([]);
  });
});

describe("the dashboard sends only from the account the signer holds (#8)", () => {
  it("refuses a wallet whose account is not the session's, before signing", async () => {
    const shown = "b".repeat(64); // e.g. imported from a private key
    await expect(
      executeNearSend({ sessionId: "s", fromAddress: shown, to: OTHER, amount: "1", rpcUrl: "https://near.drpc.org" }),
    ).rejects.toThrow(/isn't supported yet[\s\S]*Nothing was signed/);
    expect(signCalls()).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it("sends from the session's account when it is the one shown", async () => {
    const r = await executeNearSend({
      sessionId: "s",
      fromAddress: `  ${me.address} `,
      to: OTHER,
      amount: "0.5",
      rpcUrl: "https://near.drpc.org",
    });
    expect(r.hash).toBe(b58encode(sha256(lastBroadcast().txBytes)));
    expect(r.pending).toBeUndefined();
  });
});

describe("NEAR balance and history say what is true (#4)", () => {
  const view = { amount: "5000000000000000000000000", locked: "0", storage_usage: 182 };

  it("reads view_account across the RPC list, and reports what can be sent", async () => {
    net.accounts[me.address] = view;
    net.broken["https://near.drpc.org"] = 503;
    net.broken["https://1rpc.io/near"] = "no-query";
    // 5 NEAR minus 182 bytes × 10^19 yocto of storage stake.
    expect(await nearAdapter.getBalance(me.address)).toBe("4.99818");
    expect(net.requests.map((r) => r.url)).toEqual([
      "https://near.drpc.org",
      "https://1rpc.io/near",
      "https://rpc.fastnear.com",
    ]);
  });

  it("an account NEAR does not know yet is a real 0 — and not rotated past", async () => {
    expect(await nearAdapter.getBalance(OTHER)).toBe("0");
    expect(net.requests.length).toBe(1);
  });

  it("throws, never '0', when no node answers", async () => {
    for (const u of [
      "https://near.drpc.org",
      "https://1rpc.io/near",
      "https://rpc.fastnear.com",
      "https://near.lava.build",
      "https://rpc.mainnet.near.org",
    ]) {
      net.broken[u] = 502;
    }
    await expect(nearAdapter.getBalance(me.address)).rejects.toThrow(/HTTP 502/);
  });

  // Was "history says it is unavailable": since 2026-09-30 history is read
  // from NearBlocks (`near-history.ts`, covered in `nearHistory.test.ts`).
  // The point this test made still holds: a read that fails throws, never an
  // empty list read as "no transactions".
  it("history that cannot be read throws instead of 'no transactions'", async () => {
    await expect(nearAdapter.getTransactionHistory(me.address)).rejects.toThrow();
    expect(net.requests.map((r) => r.url)).toEqual([
      `https://api.nearblocks.io/v1/account/${me.address}/txns?per_page=25&order=desc`,
    ]);
  });
});
