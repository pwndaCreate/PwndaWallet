/**
 * SOL and SPL (USDC/USDT on Solana) sends against a scripted Solana network —
 * the 2026-09-29 send-safety audit.
 *
 * `lib/tauri`'s `invoke` is the only fake: every RPC the adapters make goes
 * through `sol_rpc_call`, and a small in-memory chain answers it — accounts,
 * blockhashes, block heights that advance with (fake) time, signature
 * statuses. Key derivation, transaction building, signing and web3.js's
 * `Connection` are the real code. DNS is blocked for the whole file and the
 * block is asserted untouched after every test, so nothing here can reach a
 * real node.
 *
 * What the audit found, one block each below:
 *  - one press could sign and broadcast up to eleven DIFFERENT transactions
 *    (each endpoint attempt fetched its own blockhash and re-signed);
 *  - an SPL transfer that failed on chain was reported as sent;
 *  - a token account's address was paid through a "nested" ATA derived from it;
 *  - input mistakes and deterministic refusals were reported as an outage
 *    ("All Solana RPC endpoints failed. Try again in a moment.");
 *  - the SOL amount went through parseFloat ("1,5" → 1, "0x10" → 0, "1e3" → 1000);
 *  - SPL had no `gasToken`/`getGasBudget`, and SOL's fee read could disable Send.
 */
import dns from "node:dns";
import { Buffer } from "node:buffer";
import { Keypair, PublicKey, SystemInstruction, Transaction } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: undefined as undefined | ((cmd: string, args: unknown) => Promise<unknown>),
}));
vi.mock("../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => h.invoke!(cmd, args),
}));

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** Mainnet's rent-exempt minimums (0-byte wallet, 165-byte token account). */
const RENT0 = 890_880;
const RENT_TOKEN = 2_039_280;
const SLOT_MS = 400;

/** An on-curve wallet nobody in these tests holds a key for but the fake. */
const FRIEND = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();

const ataOf = (owner: string, mint: string) =>
  PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(TOKEN).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0].toBase58();

function tokenAccountData(mint: string, owner: string, amount: bigint, state = 1): Uint8Array {
  const d = new Uint8Array(165);
  d.set(new PublicKey(mint).toBytes(), 0);
  d.set(new PublicKey(owner).toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  return d;
}

const txOf = (wire: string) => Transaction.from(Buffer.from(wire, "base64"));
const sigOf = (wire: string) => base58.encode(txOf(wire).signature!);

type Acct = { lamports: number; owner: string; data?: Uint8Array };
type SendReply =
  /** Answer with the signature; the transaction lands per `landing`. */
  | "accept"
  /** No answer, and nothing was forwarded. */
  | "hang"
  /** No answer — but the node DID forward it, and it lands per `landing`. */
  | "hang-forwarded"
  | { http: number; body?: string }
  | { rpcError: { code: number; message: string; data?: unknown } };

/** A Solana network, as far as `sol_rpc_call` can tell. */
class FakeSolana {
  readonly t0 = Date.now();
  accounts = new Map<string, Acct>();
  calls: { url: string; method: string; params: any[] }[] = [];
  sends: { url: string; wire: string }[] = [];
  /** How the n-th `sendTransaction` (0-based, any endpoint) is answered. */
  onSend: (url: string, n: number) => SendReply = () => "accept";
  /** What a forwarded transaction does. `null`: it is dropped and never lands. */
  landing: { afterMs: number; err: unknown } | null = { afterMs: 1_000, err: null };
  /** Reads that never answer. */
  hangRead: (method: string, url: string) => boolean = () => false;
  /** Do nodes serve `searchTransactionHistory`? */
  history = true;
  /** Slots the node answering `getSignatureStatuses` lags behind the chain. */
  statusLag = 0;
  private blockhashes = new Map<string, number>();
  private landed = new Map<string, { at: number; slot: number; err: unknown }>();

  slot(at = Date.now()) {
    return 330_000_000 + Math.floor((at - this.t0) / SLOT_MS);
  }
  height(at = Date.now()) {
    return 310_000_000 + Math.floor((at - this.t0) / SLOT_MS);
  }

  private account(key: string) {
    const a = this.accounts.get(key);
    if (!a) return null;
    const data = a.data ?? new Uint8Array(0);
    return {
      data: [Buffer.from(data).toString("base64"), "base64"],
      executable: false,
      lamports: a.lamports,
      owner: a.owner,
      rentEpoch: 0,
      space: data.length,
    };
  }

  private status(sig: string) {
    const l = this.landed.get(sig);
    if (!l || Date.now() < l.at) return null;
    return { slot: l.slot, confirmations: 10, err: l.err, confirmationStatus: "confirmed" };
  }

  /** The node forwards it: it lands `landing.afterMs` later if its blockhash is still valid then. */
  private forward(wire: string) {
    if (!this.landing) return;
    const sig = sigOf(wire);
    if (this.landed.has(sig)) return;
    const lastValid = this.blockhashes.get(txOf(wire).recentBlockhash!) ?? -1;
    const at = Date.now() + this.landing.afterMs;
    if (this.height(at) > lastValid) return;
    this.landed.set(sig, { at, slot: this.slot(at), err: this.landing.err });
  }

  invoke = (cmd: string, args: unknown): Promise<unknown> => {
    if (cmd !== "sol_rpc_call") return Promise.reject(new Error(`unexpected invoke ${cmd}`));
    const { url, body } = args as { url: string; body: string };
    const req = JSON.parse(body);
    const method: string = req.method;
    const params: any[] = req.params ?? [];
    this.calls.push({ url, method, params });
    const reply = (x: object) =>
      Promise.resolve({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: req.id, ...x }) });
    const result = (r: unknown) => reply({ result: r });
    const never = () => new Promise<unknown>(() => {});

    if (method === "sendTransaction") {
      const wire: string = params[0];
      const n = this.sends.length;
      this.sends.push({ url, wire });
      // A node that already processed it refuses at preflight, as mainnet does.
      if (this.status(sigOf(wire))) {
        return reply({
          error: {
            code: -32002,
            message: "Transaction simulation failed: This transaction has already been processed",
            data: { err: "AlreadyProcessed", logs: [] },
          },
        });
      }
      const r = this.onSend(url, n);
      if (r === "hang") return never();
      if (r === "hang-forwarded") {
        this.forward(wire);
        return never();
      }
      if (r === "accept") {
        this.forward(wire);
        return result(sigOf(wire));
      }
      if ("http" in r) return Promise.resolve({ status: r.http, body: r.body ?? "" });
      return reply({ error: r.rpcError });
    }

    if (this.hangRead(method, url)) return never();
    const context = { slot: this.slot() };
    switch (method) {
      case "getLatestBlockhash": {
        const b = new Uint8Array(32);
        b[0] = 9;
        new DataView(b.buffer).setUint32(1, this.blockhashes.size + 1);
        const blockhash = base58.encode(b);
        const lastValidBlockHeight = this.height() + 150;
        this.blockhashes.set(blockhash, lastValidBlockHeight);
        return result({ context, value: { blockhash, lastValidBlockHeight } });
      }
      case "getMultipleAccounts":
        return result({ context, value: (params[0] as string[]).map((k) => this.account(k)) });
      case "getAccountInfo":
        return result({ context, value: this.account(params[0]) });
      case "getBalance":
        return result({ context, value: this.accounts.get(params[0])?.lamports ?? 0 });
      case "getMinimumBalanceForRentExemption":
        return result((128 + Number(params[0])) * 6_960);
      case "getSignatureStatuses":
        if (params[1]?.searchTransactionHistory && !this.history) {
          return reply({ error: { code: -32011, message: "Transaction history is not available from this node" } });
        }
        return result({
          context: { slot: this.slot() - this.statusLag },
          value: (params[0] as string[]).map((s) => this.status(s)),
        });
      case "getEpochInfo":
        // Asked for at "finalized": ~32 slots behind the tip.
        return result({
          epoch: 760,
          slotIndex: 1_000,
          slotsInEpoch: 432_000,
          absoluteSlot: this.slot() - 32,
          blockHeight: this.height() - 32,
        });
      case "getBlockHeight":
        return result(this.height());
      default:
        return reply({ error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };
}

let wallets: { address: string; privateKey: string };

/** Fresh adapter modules (their routing and rent caches are module state). */
async function load() {
  vi.resetModules();
  const sol = await import("./sol-wallet");
  const spl = await import("./spl-token-wallet");
  const outcome = await import("./send-outcome");
  wallets = sol.solAdapter.deriveFromMnemonic(ABANDON);
  return { sol, spl, isUnknown: outcome.isSendOutcomeUnknown };
}

/** The sender holds `lamports` SOL and 100 USDC in its ATA; FRIEND holds 0.5 SOL and no USDC account. */
function network(me: string, lamports = 1_000_000_000): FakeSolana {
  const f = new FakeSolana();
  f.accounts.set(me, { lamports, owner: SYSTEM });
  f.accounts.set(FRIEND, { lamports: 500_000_000, owner: SYSTEM });
  f.accounts.set(ataOf(me, USDC), {
    lamports: RENT_TOKEN,
    owner: TOKEN,
    data: tokenAccountData(USDC, me, 100_000_000n),
  });
  h.invoke = f.invoke;
  return f;
}

/** Drive a send to its end on fake time. */
async function settle<T>(p: Promise<T>, maxMs = 300_000) {
  let out: { ok: true; value: T } | { ok: false; error: any } | undefined;
  p.then(
    (value) => (out = { ok: true, value }),
    (error) => (out = { ok: false, error }),
  );
  const start = Date.now();
  while (!out && Date.now() - start < maxMs) await vi.advanceTimersByTimeAsync(200);
  if (!out) throw new Error(`still running after ${maxMs} ms of fake time`);
  return { ...out, elapsedMs: Date.now() - start };
}

// ── No test in this file may reach the network ──────────────────────────
const realLookup = dns.lookup;
const lookups: string[] = [];
beforeAll(() => {
  (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    lookups.push(host);
    const cb = rest[rest.length - 1] as (e: Error) => void;
    process.nextTick(() => cb(Object.assign(new Error(`network blocked: ${host}`), { code: "ENOTFOUND" })));
  };
});
afterAll(() => {
  (dns as { lookup: unknown }).lookup = realLookup;
});

/** Counts every signature any Solana `Transaction` makes, whichever code path signs. */
const spyOnSigning = () => vi.spyOn(Transaction.prototype, "sign");
let sign: ReturnType<typeof spyOnSigning>;
beforeEach(() => {
  vi.useFakeTimers();
  sign = spyOnSigning();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(lookups, "a test tried to reach the network").toEqual([]);
  lookups.length = 0;
});

const REFUSED_AT_PREFLIGHT: SendReply = {
  rpcError: {
    code: -32002,
    message: "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
    data: { err: { InstructionError: [0, { Custom: 1 }] }, logs: [] },
  },
};

describe("one press signs ONE transaction (2026-09-29 send-safety audit)", () => {
  it("SOL: every endpoint times out on broadcast — one signature, the same bytes to each, then a verdict", async () => {
    const { sol, isUnknown } = await load();
    const f = network(wallets.address);
    f.onSend = () => "hang";
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));

    expect(sign).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((c) => c.method === "getLatestBlockhash")).toHaveLength(1);
    expect(f.sends.length).toBeGreaterThan(1); // delivery was retried...
    expect(new Set(f.sends.map((s) => s.wire)).size).toBe(1); // ...with the identical bytes
    // Nothing answered and nothing landed. Once the chain is past the
    // blockhash's last valid height that is a certainty: safe to send again.
    expect(r.ok).toBe(false);
    const e = (r as { error: Error }).error;
    expect(isUnknown(e)).toBe(false);
    expect(e.message).toMatch(/can no longer land/);
    expect(e.message).toContain(sigOf(f.sends[0].wire));
    expect(e.message).not.toMatch(/All Solana RPC endpoints failed/);
  });

  it("USDC: every endpoint times out on broadcast — one signature, the same bytes to each", async () => {
    const { spl, isUnknown } = await load();
    const f = network(wallets.address);
    f.onSend = () => "hang";
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, FRIEND, "1"));

    expect(sign).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((c) => c.method === "getLatestBlockhash")).toHaveLength(1);
    expect(f.sends.length).toBeGreaterThan(1);
    expect(new Set(f.sends.map((s) => s.wire)).size).toBe(1);
    expect(r.ok).toBe(false);
    expect(isUnknown((r as { error: Error }).error)).toBe(false);
    expect((r as { error: Error }).error.message).toMatch(/can no longer land/);
  });

  it("a broadcast that timed out but WAS forwarded is found by its signature — reported sent, never signed again", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    // The first endpoint forwards it and the reply goes missing; every later
    // endpoint would hang too.
    f.onSend = (_url, n) => (n === 0 ? "hang-forwarded" : "hang");
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));

    expect(sign).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, value: { hash: sigOf(f.sends[0].wire) } });
    expect((r as { value: { pending?: boolean } }).value.pending).toBeUndefined();
    expect(new Set(f.sends.map((s) => s.wire)).size).toBe(1);
  });

  it("a rate-limited endpoint is passed over with the same bytes", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    f.onSend = (_url, n) => (n === 0 ? { http: 429, body: "Too Many Requests" } : "accept");
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));

    expect(sign).toHaveBeenCalledTimes(1);
    expect(f.sends).toHaveLength(2);
    expect(f.sends[1].wire).toBe(f.sends[0].wire);
    expect(r).toMatchObject({ ok: true, value: { hash: sigOf(f.sends[0].wire) } });
  });
});

describe("the outcome is read by signature, over HTTP (2026-09-29 send-safety audit)", () => {
  it("SOL: confirmed → sent, with the transfer the user asked for", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));

    expect(r).toMatchObject({ ok: true, value: { hash: sigOf(f.sends[0].wire) } });
    expect((r as { value: { pending?: boolean } }).value.pending).toBeUndefined();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(f.sends).toHaveLength(1);
    const t = SystemInstruction.decodeTransfer(txOf(f.sends[0].wire).instructions[0]);
    expect(t.fromPubkey.toBase58()).toBe(wallets.address);
    expect(t.toPubkey.toBase58()).toBe(FRIEND);
    expect(BigInt(t.lamports)).toBe(250_000_000n);
  });

  it("USDC: a transfer that fails ON CHAIN is a failure naming the signature, not 'sent'", async () => {
    const { spl, isUnknown } = await load();
    const f = network(wallets.address);
    f.landing = { afterMs: 1_000, err: { InstructionError: [1, { Custom: 1 }] } };
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, FRIEND, "1"));

    expect(r.ok).toBe(false);
    const e = (r as { error: Error }).error;
    expect(isUnknown(e)).toBe(false);
    expect(e.message).toMatch(/recorded on Solana but failed/);
    expect(e.message).toMatch(/fee was charged/);
    expect(e.message).toContain(sigOf(f.sends[0].wire));
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("SOL: a transfer that fails on chain is a failure too", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    f.landing = { afterMs: 1_000, err: { InstructionError: [0, { Custom: 1 }] } };
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));
    expect(r.ok).toBe(false);
    expect((r as { error: Error }).error.message).toMatch(/recorded on Solana but failed \(instruction 0 failed/);
  });

  it("accepted, then dropped: once its blockhash is provably past, a plain failure that is safe to retry", async () => {
    const { sol, isUnknown } = await load();
    const f = network(wallets.address);
    f.landing = null; // the network accepts it and never includes it
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));

    expect(r.ok).toBe(false);
    const e = (r as { error: Error }).error;
    expect(isUnknown(e)).toBe(false);
    expect(e.message).toMatch(/can no longer land/);
    expect(e.message).toMatch(/safe to send again/);
    expect(e.message).toContain(sigOf(f.sends[0].wire));
    // Not before the chain passed lastValidBlockHeight (150 blocks at 400 ms,
    // measured on the finalized chain).
    expect(r.elapsedMs).toBeGreaterThanOrEqual(60_000);
    // It kept re-sending — always the same bytes.
    expect(sign).toHaveBeenCalledTimes(1);
    expect(f.sends.length).toBeGreaterThan(1);
    expect(new Set(f.sends.map((s) => s.wire)).size).toBe(1);
  });

  it("a node without transaction history still proves absence from its status cache", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    f.landing = null;
    f.history = false;
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));
    expect(r.ok).toBe(false);
    expect((r as { error: Error }).error.message).toMatch(/can no longer land/);
  });

  it("never declares 'expired, safe to retry' from a node whose view lags the finalized chain", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    f.landing = null;
    // The node answering status queries is far behind: its "not found" could
    // predate the block holding the transaction.
    f.statusLag = 1_000;
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));
    // Accepted, never proven gone: "submitted", not "safe to send again".
    expect(r).toMatchObject({ ok: true, value: { hash: sigOf(f.sends[0].wire), pending: true } });
  });

  it("no endpoint ever answered and nothing can be read: SendOutcomeUnknownError carrying the signature", async () => {
    const { sol, isUnknown } = await load();
    const f = network(wallets.address);
    f.onSend = () => "hang";
    f.hangRead = (m) => m === "getSignatureStatuses" || m === "getEpochInfo";
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));

    expect(r.ok).toBe(false);
    const e = (r as { error: Error & { hash?: string } }).error;
    expect(isUnknown(e)).toBe(true);
    expect(e.hash).toBe(sigOf(f.sends[0].wire));
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("accepted, but its status cannot be read in time: submitted (pending), not failed", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    f.landing = null;
    f.hangRead = (m) => m === "getSignatureStatuses" || m === "getEpochInfo";
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));
    expect(r).toMatchObject({ ok: true, value: { hash: sigOf(f.sends[0].wire), pending: true } });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("a preflight refusal on the first attempt is an ordinary failure, after one broadcast", async () => {
    const { sol, isUnknown } = await load();
    const f = network(wallets.address);
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));

    expect(r.ok).toBe(false);
    const e = (r as { error: Error }).error;
    expect(isUnknown(e)).toBe(false);
    expect(e.message).toMatch(/refused this transaction before sending it: Error processing Instruction 0/);
    expect(e.message).toMatch(/Nothing was sent/);
    expect(f.sends).toHaveLength(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("every endpoint refusing before forwarding (rate limits) says nothing was sent", async () => {
    const { sol, isUnknown } = await load();
    const f = network(wallets.address);
    f.onSend = () => ({ http: 429, body: "Too Many Requests" });
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.25"));
    expect(r.ok).toBe(false);
    const e = (r as { error: Error }).error;
    expect(isUnknown(e)).toBe(false);
    expect(e.message).toMatch(/Nothing was sent/);
    expect(new Set(f.sends.map((s) => s.wire)).size).toBe(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe("SOL: input and balances are checked before anything is signed (2026-09-29 send-safety audit)", () => {
  it.each(["1,5", "0x10", "1e3", "-1", "", "0", "0.0000000001", "1.2.3"])(
    "amount %j is refused without touching the network",
    async (amount) => {
      const { sol } = await load();
      const f = network(wallets.address);
      f.onSend = () => REFUSED_AT_PREFLIGHT;
      const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, amount));
      // parseFloat made "1,5" a 1 SOL transfer, "0x10" a 0 SOL one, "1e3" 1000 SOL.
      expect(sign).not.toHaveBeenCalled();
      expect(f.calls).toEqual([]);
      expect(r.ok).toBe(false);
      expect((r as { error: Error }).error.message).not.toMatch(/All Solana RPC endpoints failed/);
    },
  );

  it("a recipient pasted with whitespace around it is paid at the trimmed address", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, `  ${FRIEND}\n`, "0.25"));
    expect(r).toMatchObject({ ok: true });
    const t = SystemInstruction.decodeTransfer(txOf(f.sends[0].wire).instructions[0]);
    expect(t.toPubkey.toBase58()).toBe(FRIEND);
  });

  it("something that is not an address is called that, not an outage", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, "not-an-address", "0.25"));
    expect((r as { error: Error }).error.message).toMatch(/is not a Solana address/);
    expect(f.calls).toEqual([]);
  });

  it("a new account below the rent-exempt minimum is refused, with the minimum named", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    const fresh = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, fresh, "0.0005"));
    expect((r as { error: Error }).error.message).toMatch(/will not open an account with less than 0\.00089088 SOL/);
    expect(sign).not.toHaveBeenCalled();
    expect(f.sends).toEqual([]);
  });

  it("more than the balance is refused, with the balance named", async () => {
    const { sol } = await load();
    const f = network(wallets.address, 100_000_000);
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.2"));
    expect((r as { error: Error }).error.message).toMatch(/holds 0\.1 SOL\. Sending 0\.2 SOL needs 0\.200005 SOL/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("leaving dust below the rent-exempt minimum is refused, with the amounts that would work", async () => {
    const { sol } = await load();
    const f = network(wallets.address, 10_000_000); // 0.01 SOL
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, FRIEND, "0.0095"));
    const m = (r as { error: Error }).error.message;
    expect(m).toMatch(/would leave 0\.000495 SOL here/);
    expect(m).toMatch(/at most 0\.00910412 SOL, or exactly 0\.009995 SOL to empty the address/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("SOL sent to a token account is refused", async () => {
    const { sol } = await load();
    const f = network(wallets.address);
    const friendsUsdc = ataOf(FRIEND, USDC);
    f.accounts.set(friendsUsdc, { lamports: RENT_TOKEN, owner: TOKEN, data: tokenAccountData(USDC, FRIEND, 5n) });
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(sol.solAdapter.sendTransaction(wallets.privateKey, friendsUsdc, "0.25"));
    expect((r as { error: Error }).error.message).toMatch(/is a token account or token mint, not a wallet/);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("SPL recipients are resolved on chain (2026-09-29 send-safety audit)", () => {
  it("a token account of this mint is paid directly — never through an ATA derived from it", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    const friendsUsdc = ataOf(FRIEND, USDC);
    f.accounts.set(friendsUsdc, { lamports: RENT_TOKEN, owner: TOKEN, data: tokenAccountData(USDC, FRIEND, 5n) });
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, friendsUsdc, "1.5"));

    const ixs = txOf(f.sends[0].wire).instructions;
    // The old code treated the token account as an owner and paid a NESTED
    // ATA it created: ATA(owner = the token account).
    const nested = ataOf(friendsUsdc, USDC);
    expect(ixs.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()))).not.toContain(nested);
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.toBase58()).toBe(TOKEN);
    expect(ixs[0].data[0]).toBe(3);
    expect(ixs[0].keys[0].pubkey.toBase58()).toBe(ataOf(wallets.address, USDC));
    expect(ixs[0].keys[1].pubkey.toBase58()).toBe(friendsUsdc);
    expect(Buffer.from(ixs[0].data).readBigUInt64LE(1)).toBe(1_500_000n);
    expect(r).toMatchObject({ ok: true });
  });

  it("a token account of ANOTHER mint is refused before signing", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    const friendsUsdt = ataOf(FRIEND, USDT);
    f.accounts.set(friendsUsdt, { lamports: RENT_TOKEN, owner: TOKEN, data: tokenAccountData(USDT, FRIEND, 5n) });
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, friendsUsdt, "1"));
    expect((r as { error: Error }).error.message).toMatch(/token account for a different token/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("a Token-2022 account is refused before signing", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    const t22 = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
    f.accounts.set(t22, { lamports: RENT_TOKEN, owner: TOKEN_2022, data: tokenAccountData(USDC, FRIEND, 0n) });
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, t22, "1"));
    expect((r as { error: Error }).error.message).toMatch(/Token-2022 account/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("an off-curve address with no account (a closed token account, a PDA) is refused before signing", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    const pda = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    )[0].toBase58();
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, pda, "1"));
    expect((r as { error: Error }).error.message).toMatch(/program-derived address/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("a wallet without a USDC account: idempotent create, then the transfer to its ATA", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, FRIEND, "2"));

    const ixs = txOf(f.sends[0].wire).instructions;
    expect(ixs).toHaveLength(2);
    expect(ixs[0].programId.toBase58()).toBe(ATA_PROGRAM);
    // CreateIdempotent (1). The plain Create it replaced FAILS — fee spent —
    // when the account appears between the check and the landing.
    expect([...ixs[0].data]).toEqual([1]);
    expect(ixs[0].keys.map((k) => k.pubkey.toBase58())).toEqual([
      wallets.address,
      ataOf(FRIEND, USDC),
      FRIEND,
      USDC,
      SYSTEM,
      TOKEN,
    ]);
    expect(ixs[1].programId.toBase58()).toBe(TOKEN);
    expect(ixs[1].keys[1].pubkey.toBase58()).toBe(ataOf(FRIEND, USDC));
    expect(r).toMatchObject({ ok: true });
  });

  it("a wallet with a USDC account: the transfer alone", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    f.accounts.set(ataOf(FRIEND, USDC), {
      lamports: RENT_TOKEN,
      owner: TOKEN,
      data: tokenAccountData(USDC, FRIEND, 0n),
    });
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, FRIEND, "2"));
    const ixs = txOf(f.sends[0].wire).instructions;
    expect(ixs).toHaveLength(1);
    expect(ixs[0].keys[1].pubkey.toBase58()).toBe(ataOf(FRIEND, USDC));
    expect(r).toMatchObject({ ok: true });
  });

  it("a recipient pasted with whitespace around it is trimmed", async () => {
    const { spl } = await load();
    network(wallets.address);
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, ` ${FRIEND} `, "2"));
    expect(r).toMatchObject({ ok: true });
  });

  it("no SOL for the fee and the recipient's account rent: refused before signing, in SOL terms", async () => {
    const { spl } = await load();
    const f = network(wallets.address, 1_000_000); // 0.001 SOL
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, FRIEND, "2"));
    const m = (r as { error: Error }).error.message;
    expect(m).toMatch(/costs the 0\.000005 SOL network fee plus 0\.00203928 SOL to open the recipient's USDC account/);
    expect(m).toMatch(/holds 0\.001 SOL/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("more USDC than its token account holds: refused before signing", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    f.onSend = () => REFUSED_AT_PREFLIGHT;
    const r = await settle(spl.usdcSolAdapter.sendTransaction(wallets.privateKey, FRIEND, "150"));
    expect((r as { error: Error }).error.message).toMatch(/holds 100 USDC; this send needs 150/);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("SPL fees are paid in SOL: gasToken and getGasBudget (2026-09-29 send-safety audit)", () => {
  it("names SOL on Solana as the fee coin", async () => {
    const { spl } = await load();
    expect(spl.usdcSolAdapter.gasToken).toEqual({ ticker: "SOL", chainName: "Solana" });
    expect(spl.usdtSolAdapter.gasToken).toEqual({ ticker: "SOL", chainName: "Solana" });
  });

  it("a recipient with no USDC account costs the fee plus that account's rent", async () => {
    const { spl } = await load();
    network(wallets.address);
    const b = await spl.usdcSolAdapter.getGasBudget!(wallets.address, { to: FRIEND, amount: "2" });
    expect(b).toMatchObject({
      ticker: "SOL",
      chainName: "Solana",
      includesAmount: false,
      available: "1",
      required: "0.00204428",
      sufficient: true,
    });
  });

  it("a recipient that has one costs the fee alone", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    f.accounts.set(ataOf(FRIEND, USDC), { lamports: RENT_TOKEN, owner: TOKEN, data: tokenAccountData(USDC, FRIEND, 0n) });
    const b = await spl.usdcSolAdapter.getGasBudget!(wallets.address, { to: FRIEND });
    expect(b).toMatchObject({ required: "0.000005", sufficient: true });
  });

  it("no SOL at all is a definite no, even before a recipient is typed", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    f.accounts.delete(wallets.address);
    const b = await spl.usdcSolAdapter.getGasBudget!(wallets.address, {});
    // It has to hold the fee plus the rent-exempt minimum Solana makes it keep.
    expect(b).toMatchObject({ available: "0", required: "0.00089588", sufficient: false });
  });

  it("enough for the fee and rent but not to stay rent-exempt afterwards is a no", async () => {
    const { spl } = await load();
    network(wallets.address, 2_500_000);
    const b = await spl.usdcSolAdapter.getGasBudget!(wallets.address, { to: FRIEND });
    expect(b).toMatchObject({ available: "0.0025", required: "0.00293516", sufficient: false });
  });

  it("an unreachable network is 'unknown', never 'you have no SOL'", async () => {
    const { spl } = await load();
    const f = network(wallets.address);
    f.hangRead = () => true;
    const p = spl.usdcSolAdapter.getGasBudget!(wallets.address, { to: FRIEND });
    const r = await settle(p);
    expect(r).toMatchObject({ ok: true, value: { required: null, sufficient: null } });
  });
});

describe("SOL fee estimate (2026-09-29 send-safety audit)", () => {
  it("is the fee the send pays, and cannot fail on the network (so it can never disable Send)", async () => {
    const { sol } = await load();
    const unreachable = vi.fn(() => Promise.reject(new Error("no network")));
    h.invoke = unreachable;
    const fee = await sol.solAdapter.getFeeEstimate();
    expect(fee.normal.value).toBe("0.000005");
    expect(fee.unit).toBe("SOL");
    expect(unreachable).not.toHaveBeenCalled();
  });
});

describe("classifyBroadcastResponse", () => {
  const rpc = (x: object) => JSON.stringify({ jsonrpc: "2.0", id: 1, ...x });
  // "unavailable" = refused before forwarding: nothing can land from it.
  // "ambiguous" = no trustworthy answer: it may have been forwarded.
  it.each([
    ["a signature", "accepted", 200, rpc({ result: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW" })],
    ["HTTP 429", "unavailable", 429, "Too Many Requests"],
    ["HTTP 403", "unavailable", 403, ""],
    ["HTTP 502", "ambiguous", 502, "Bad Gateway"],
    ["a body that is not JSON", "ambiguous", 200, "<html>"],
    ["an unknown blockhash", "unavailable", 200, rpc({ error: { code: -32002, message: "Transaction simulation failed: Blockhash not found", data: { err: "BlockhashNotFound" } } })],
    ["already processed", "already-processed", 200, rpc({ error: { code: -32002, message: "Transaction simulation failed: This transaction has already been processed", data: { err: "AlreadyProcessed" } } })],
    ["a simulation failure", "rejected", 200, rpc({ error: { code: -32002, message: "Transaction simulation failed: Insufficient funds for fee", data: { err: "InsufficientFundsForFee" } } })],
    ["a node that is behind", "unavailable", 200, rpc({ error: { code: -32005, message: "Node is behind by 42 slots" } })],
    ["a gateway rate limit in JSON-RPC", "unavailable", 200, rpc({ error: { code: -32000, message: "rate limit exceeded" } })],
    ["an unexplained server error", "ambiguous", 200, rpc({ error: { code: -32000, message: "upstream timeout" } })],
  ])("%s → %s", async (_what, kind, status, body) => {
    const { sol } = await load();
    expect(sol.classifyBroadcastResponse(status as number, body as string).kind).toBe(kind);
  });
});

describe("solSpendProblem — the runtime's rent rule for the paying account", () => {
  it("allows emptying, refuses dust, lets a pre-rent-rule account shrink", async () => {
    const { sol } = await load();
    const rent = BigInt(RENT0);
    expect(sol.solSpendProblem(1_000_000_000n, 5_000n, 100_000_000n, rent)).toBeNull();
    expect(sol.solSpendProblem(1_000_000n, 5_000n, 995_000n, rent)).toBeNull(); // exactly empty
    expect(sol.solSpendProblem(1_000_000n, 5_000n, 500_000n, rent)).toBe("rent"); // 495,000 left
    expect(sol.solSpendProblem(1_000_000n, 5_000n, 996_000n, rent)).toBe("insufficient");
    // Within a fee of the minimum: the fee alone would leave it rent-paying.
    expect(sol.solSpendProblem(rent + 1_000n, 5_000n, 0n, rent)).toBe("rent");
    // Already below the minimum (an old account): it may only shrink, and does.
    expect(sol.solSpendProblem(500_000n, 5_000n, 100_000n, rent)).toBeNull();
  });
});
