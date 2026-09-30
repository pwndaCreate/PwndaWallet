/**
 * `getTransactionParties` on SOL and its SPL legs (USDC / USDT on Solana) —
 * operator request 2026-09-30: "in the info I can see which address each
 * transaction was sent and received from".
 *
 * `lib/tauri`'s `invoke` is the only fake: it answers `sol_rpc_call` with the
 * `getTransaction` (`jsonParsed`) body a node would send, and web3.js's real
 * `Connection` parses and validates it — so every fixture here is held to
 * the schema web3.js enforces on the wire. The layouts are those read live on
 * 2026-09-30 from api.mainnet-beta.solana.com for the world-public test seed's
 * address HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk:
 *
 *  - qVYdBi6P… — an exchange-style batch payout: `advanceNonce`, two
 *    ComputeBudget instructions (partially decoded: `accounts` / `data`), then
 *    three System `transfer`s, one of them to the test address;
 *  - 3eo67ffV… — a USDC `transferChecked` INTO the test address's associated
 *    account, whose token balances name the owner `usdc8UkQ…`, not the test
 *    address: 2RftcbzfNi… had created that account and handed it to a vanity
 *    owner (`setAuthority` accountOwner) using the public seed;
 *  - an unknown signature: `{"jsonrpc":"2.0","result":null,"id":1}`.
 *
 * Other keys and signatures are generated here.
 */
import { Keypair } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { result: unknown } | { error: { code: number; message: string } } | { http: number; body?: string };
const h = vi.hoisted(() => ({
  answer: undefined as undefined | ((url: string, method: string, params: any[], n: number) => Answer),
  calls: [] as Array<{ url: string; method: string }>,
}));
vi.mock("../lib/tauri", () => ({
  invoke: async (cmd: string, args: { url: string; body: string }) => {
    if (cmd !== "sol_rpc_call") throw new Error(`unexpected invoke ${cmd}`);
    const req = JSON.parse(args.body);
    h.calls.push({ url: args.url, method: req.method });
    const a = h.answer!(args.url, req.method, req.params ?? [], h.calls.filter((c) => c.method === req.method).length);
    if ("http" in a) return { status: a.http, body: a.body ?? "" };
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: req.id, ...a }) };
  },
}));

import { solAdapter } from "./sol-wallet";
import { usdcSolAdapter } from "./spl-token-wallet";

const ME = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const sig = (n: number) => base58.encode(new Uint8Array(64).fill(n));
const PAYER = key(1);
const A = key(2);
const B = key(3);
const SENDER = key(4);
const VANITY = key(5);
const ATA_1 = key(11);
const ATA_2 = key(12);
const ATA_3 = key(13);

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SIG = sig(9);

interface TxSpec {
  keys: string[];
  signers?: number;
  instructions: unknown[];
  inner?: Array<{ index: number; instructions: unknown[] }>;
  pre: number[];
  post: number[];
  fee?: number;
  err?: unknown;
  preTok?: unknown[];
  postTok?: unknown[];
}

/** A `getTransaction` (`jsonParsed`) result in the wire layout read live. */
function solTx(s: TxSpec) {
  return {
    blockTime: 1790254163,
    meta: {
      computeUnitsConsumed: 900,
      costUnits: 3141,
      err: s.err ?? null,
      fee: s.fee ?? 5000,
      innerInstructions: s.inner ?? [],
      logMessages: [],
      postBalances: s.post,
      postTokenBalances: s.postTok ?? [],
      preBalances: s.pre,
      preTokenBalances: s.preTok ?? [],
      rewards: [],
      status: s.err ? { Err: s.err } : { Ok: null },
    },
    slot: 450033656,
    transaction: {
      message: {
        accountKeys: s.keys.map((pubkey, i) => ({ pubkey, signer: i < (s.signers ?? 1), source: "transaction", writable: true })),
        instructions: s.instructions,
        recentBlockhash: base58.encode(new Uint8Array(32).fill(8)),
      },
      signatures: [SIG],
    },
    transactionIndex: 12,
    version: "legacy",
  };
}

const systemTransfer = (source: string, destination: string, lamports: number) => ({
  parsed: { info: { destination, lamports, source }, type: "transfer" },
  program: "system",
  programId: SYSTEM,
  stackHeight: 1,
});

const tokenBalance = (accountIndex: number, owner: string, amount: string, mint = USDC) => ({
  accountIndex,
  mint,
  owner,
  programId: TOKEN,
  uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6 || null, uiAmountString: String(Number(amount) / 1e6) },
});

const transferChecked = (source: string, destination: string, authority: string, amount: string, mint = USDC) => ({
  parsed: {
    info: { authority, destination, mint, source, tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) } },
    type: "transferChecked",
  },
  program: "spl-token",
  programId: TOKEN,
  stackHeight: 1,
});

/** Every endpoint answers `getTransaction` with `result`. */
const always = (result: unknown) => () => ({ result });

beforeEach(() => {
  h.calls = [];
  h.answer = undefined;
});

// ── Native SOL ───────────────────────────────────────────────────────────────

/** The live batch payout's layout: nonce, compute budget, three transfers. */
const BATCH = solTx({
  keys: [PAYER, key(6), A, ME, B, "SysvarRecentB1ockHashes11111111111111111111", SYSTEM, COMPUTE],
  instructions: [
    { parsed: { info: { nonceAccount: key(6), nonceAuthority: PAYER, recentBlockhashesSysvar: "SysvarRecentB1ockHashes11111111111111111111" }, type: "advanceNonce" }, program: "system", programId: SYSTEM, stackHeight: 1 },
    { accounts: [], data: "3QAwFKa3MJAs", programId: COMPUTE, stackHeight: 1 },
    { accounts: [], data: "FjrGSs", programId: COMPUTE, stackHeight: 1 },
    systemTransfer(PAYER, A, 1714048000),
    systemTransfer(PAYER, ME, 25354690),
    systemTransfer(PAYER, B, 2198798000),
  ],
  pre: [1201987736459959, 20103635, 477362044, 2129517340, 30294693, 42706560, 1, 1],
  post: [1201983798246269, 20103635, 2191410044, 2154872030, 2229092693, 42706560, 1, 1],
  fee: 13000,
});

describe("SOL — the System program's transfers", () => {
  it("a batch payout: only the transfer to this wallet, with the host that answered", async () => {
    h.answer = always(BATCH);
    const p = await solAdapter.getTransactionParties!(SIG, ME);
    expect(p).toMatchObject({ from: [PAYER], to: [ME] });
    expect(p!.source).toMatch(/^[a-z0-9.-]+$/);
    expect(h.calls).toHaveLength(1);
  });

  it("…and every transfer, for an address that is in none of them", async () => {
    h.answer = always(BATCH);
    expect(await solAdapter.getTransactionParties!(SIG, key(40))).toMatchObject({ from: [PAYER], to: [A, ME, B] });
  });

  it("send: this wallet is the source", async () => {
    h.answer = always(
      solTx({ keys: [ME, A, SYSTEM], instructions: [systemTransfer(ME, A, 1_000_000)], pre: [5_000_000, 0, 1], post: [3_995_000, 1_000_000, 1] }),
    );
    expect(await solAdapter.getTransactionParties!(SIG, ME)).toMatchObject({ from: [ME], to: [A] });
  });

  it("failed on chain: the balances moved only by the fee, the instruction still names whom it was for", async () => {
    h.answer = always(
      solTx({
        keys: [ME, A, SYSTEM],
        instructions: [systemTransfer(ME, A, 1_000_000)],
        pre: [5_000_000, 0, 1],
        post: [4_995_000, 0, 1],
        err: { InstructionError: [0, "ExternalAccountLamportSpend"] },
      }),
    );
    expect(await solAdapter.getTransactionParties!(SIG, ME)).toMatchObject({ from: [ME], to: [A] });
  });

  it("no System transfer (a program moved lamports): the balance changes, fee payer's fee excepted", async () => {
    h.answer = always(
      solTx({
        keys: [PAYER, ATA_1, ME, TOKEN],
        instructions: [{ accounts: [ATA_1, ME, PAYER], data: "A", programId: TOKEN, stackHeight: 1 }],
        pre: [10_000_000, 2_039_280, 1_000_000, 1],
        post: [9_995_000, 0, 3_039_280, 1],
      }),
    );
    expect(await solAdapter.getTransactionParties!(SIG, ME)).toMatchObject({ from: [ATA_1], to: [ME] });
  });

  it("a CPI transfer (inner instruction) counts when the transaction succeeded", async () => {
    h.answer = always(
      solTx({
        keys: [ME, A, key(7), SYSTEM],
        instructions: [{ accounts: [ME, A], data: "3Bxs4Bc3VYuGVB19", programId: key(7), stackHeight: 1 }],
        inner: [{ index: 0, instructions: [{ ...systemTransfer(ME, A, 7_000), stackHeight: 2 }] }],
        pre: [100_000, 0, 1, 1],
        post: [88_000, 7_000, 1, 1],
      }),
    );
    expect(await solAdapter.getTransactionParties!(SIG, ME)).toMatchObject({ from: [ME], to: [A] });
  });

  it("not found: `result: null` from two endpoints is believed — no eleven-endpoint sweep", async () => {
    h.answer = () => ({ result: null });
    expect(await solAdapter.getTransactionParties!(SIG, ME)).toBeNull();
    expect(h.calls.filter((c) => c.method === "getTransaction")).toHaveLength(2);
  });

  it("the first endpoint does not know it (no full history, say), the second does", async () => {
    h.answer = (_url, _m, _p, n) => (n === 1 ? { result: null } : { result: BATCH });
    expect(await solAdapter.getTransactionParties!(SIG, ME)).toMatchObject({ from: [PAYER], to: [ME] });
  });

  it("every endpoint failed: throws, naming each host and what it said", async () => {
    h.answer = () => ({ http: 429, body: '{"error":{"code":429,"message":"Too many requests"}}' });
    const err = await solAdapter.getTransactionParties!(SIG, ME).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^every Solana RPC endpoint failed — /);
    expect(err.message).toContain("api.mainnet-beta.solana.com: ");
    expect(err.message).toMatch(/429/);
    expect(err.message.split("; ")).toHaveLength(h.calls.length);
  });

  it("a string that is not a signature is null, with no request", async () => {
    h.answer = () => {
      throw new Error("no request expected");
    };
    expect(await solAdapter.getTransactionParties!("0x" + "ab".repeat(32), ME)).toBeNull();
    expect(h.calls).toEqual([]);
  });
});

// ── SPL (USDC on Solana) ─────────────────────────────────────────────────────

/** The live 3eo67ffV… layout: fee payer = sender, one `transferChecked`. */
function usdcTransfer(opts: { senderOwner: string; recipientOwner: string; amount: string; feePayer?: string; err?: unknown }) {
  const moved = opts.err ? 0 : Number(opts.amount);
  return solTx({
    keys: [opts.feePayer ?? opts.senderOwner, ATA_1, ATA_2, USDC, TOKEN],
    instructions: [transferChecked(ATA_2, ATA_1, opts.senderOwner, opts.amount)],
    pre: [985000, 2039280, 2039280, 517263752437, 92795783],
    post: [980000, 2039280, 2039280, 517263752437, 92795783],
    err: opts.err,
    preTok: [tokenBalance(1, opts.recipientOwner, "20000"), tokenBalance(2, opts.senderOwner, "9074000")],
    postTok: [tokenBalance(1, opts.recipientOwner, String(20000 + moved)), tokenBalance(2, opts.senderOwner, String(9074000 - moved))],
  });
}

describe("USDC (Solana) — the token's owners, plus the direction and amount SPL rows lack", () => {
  it("receive: owners, not token accounts; direction and amount; no fee (the sender paid it)", async () => {
    h.answer = always(usdcTransfer({ senderOwner: SENDER, recipientOwner: ME, amount: "10000" }));
    const p = await usdcSolAdapter.getTransactionParties!(SIG, ME);
    expect(p).toMatchObject({ from: [SENDER], to: [ME], direction: "in", amount: "0.01" });
    expect(p!.fee).toBeUndefined();
    expect(p!.from).not.toContain(ATA_2);
  });

  it("send, fee paid by this wallet: direction out, the amount, and the fee in SOL", async () => {
    h.answer = always(usdcTransfer({ senderOwner: ME, recipientOwner: A, amount: "2500000" }));
    expect(await usdcSolAdapter.getTransactionParties!(SIG, ME)).toMatchObject({
      from: [ME],
      to: [A],
      direction: "out",
      amount: "2.5",
      fee: "0.000005",
    });
  });

  it("a payment into this wallet's associated account that a vanity owner now holds (the live hijack): the real owner, and no side for the wallet", async () => {
    h.answer = always(usdcTransfer({ senderOwner: SENDER, recipientOwner: VANITY, amount: "10000" }));
    const p = await usdcSolAdapter.getTransactionParties!(SIG, ME);
    expect(p).toMatchObject({ from: [SENDER], to: [VANITY] });
    expect(p!.direction).toBeUndefined();
    expect(p!.amount).toBeUndefined();
  });

  it("several USDC transfers (and a USDT one): only the wallet's; its net is the amount", async () => {
    h.answer = always(
      solTx({
        keys: [SENDER, ATA_1, ATA_2, ATA_3, key(14), key(15), TOKEN],
        instructions: [
          transferChecked(ATA_1, ATA_2, SENDER, "1000000"),
          transferChecked(ATA_1, ATA_3, SENDER, "3000000"),
          transferChecked(key(14), key(15), SENDER, "7", USDT),
        ],
        pre: [9_000_000, 2039280, 2039280, 2039280, 2039280, 2039280, 1],
        post: [8_995_000, 2039280, 2039280, 2039280, 2039280, 2039280, 1],
        preTok: [tokenBalance(1, SENDER, "9000000"), tokenBalance(2, ME, "0"), tokenBalance(3, B, "0"), tokenBalance(4, SENDER, "7", USDT), tokenBalance(5, ME, "0", USDT)],
        postTok: [tokenBalance(1, SENDER, "5000000"), tokenBalance(2, ME, "1000000"), tokenBalance(3, B, "3000000"), tokenBalance(4, SENDER, "0", USDT), tokenBalance(5, ME, "7", USDT)],
      }),
    );
    expect(await usdcSolAdapter.getTransactionParties!(SIG, ME)).toMatchObject({ from: [SENDER], to: [ME], direction: "in", amount: "1" });
    // For an address in none of them: the balance changes, all of them.
    expect(await usdcSolAdapter.getTransactionParties!(SIG, key(40))).toMatchObject({ from: [SENDER], to: [ME, B] });
  });

  it("failed on chain: `failed`, and the amount it was for; parties from its instruction", async () => {
    h.answer = always(usdcTransfer({ senderOwner: ME, recipientOwner: A, amount: "500000", err: { InstructionError: [0, { Custom: 1 }] } }));
    expect(await usdcSolAdapter.getTransactionParties!(SIG, ME)).toMatchObject({
      from: [ME],
      to: [A],
      direction: "failed",
      amount: "0.5",
      fee: "0.000005",
    });
  });

  it("a plain `transfer` names no mint: it is read from the accounts' token balances", async () => {
    const plain = { parsed: { info: { amount: "40000", authority: SENDER, destination: ATA_1, source: ATA_2 }, type: "transfer" }, program: "spl-token", programId: TOKEN, stackHeight: 1 };
    const tx = usdcTransfer({ senderOwner: SENDER, recipientOwner: ME, amount: "40000" });
    tx.transaction.message.instructions = [plain];
    h.answer = always(tx);
    expect(await usdcSolAdapter.getTransactionParties!(SIG, ME)).toMatchObject({ from: [SENDER], to: [ME], direction: "in", amount: "0.04" });
  });

  it("not found: null", async () => {
    h.answer = () => ({ result: null });
    expect(await usdcSolAdapter.getTransactionParties!(SIG, ME)).toBeNull();
  });
});
