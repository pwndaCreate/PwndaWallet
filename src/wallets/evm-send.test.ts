/**
 * EVM sends from the Send button, against a scripted chain (2026-09-29
 * send-safety audit).
 *
 * The audit drove the real `createEvmAdapter().sendTransaction` against an
 * in-memory chain and got two transfers out of one press: a transient error
 * AFTER a node had taken the transfer re-ran the whole send on the next RPC,
 * which read a fresh pending nonce and signed a new transaction. Each test
 * below is one way a send went wrong, reproduced at the network boundary.
 *
 * How the fake works:
 *  - `fetch` is stubbed and answers only the three `*.invalid` hosts below;
 *    any other URL throws. ethers' own transport (`FetchRequest`) is routed
 *    into the same fake, so a provider-based send path is just as offline
 *    and this file can be pointed at the pre-fix adapter to show it fail.
 *  - Signing is real, with a key generated at run time that has never held
 *    anything. The signed bytes go nowhere but the fake.
 *  - The chain keeps nonces, a mempool and mined transactions, answers
 *    "already known" / "nonce too low" the way geth does, and can be told to
 *    fail a call before or AFTER applying it (a node that took the
 *    transaction and then lost the reply).
 */
import { ethers } from "ethers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvmAdapter } from "./evm-factory";
import { EVM_SEND_TIMING, parseEvmAmount, parseEvmRecipient } from "./evm-send";
import { withGasMargin } from "./evm-gas";
import { isSendOutcomeUnknown } from "./send-outcome";
import { STABLECOIN_NETWORKS } from "./stablecoins";

// ── the fake chain ─────────────────────────────────────────────────────────

type Host = "rpc1" | "rpc2" | "rpc3";
const URL_OF: Record<Host, string> = {
  rpc1: "https://rpc1.evm-send.test.invalid",
  rpc2: "https://rpc2.evm-send.test.invalid",
  rpc3: "https://rpc3.evm-send.test.invalid",
};
const HOST_OF = new Map(Object.entries(URL_OF).map(([h, u]) => [u, h as Host]));

type Fault =
  | { kind: "rpc-error"; code?: number; message: string; data?: unknown; status?: number }
  | { kind: "http"; status: number }
  | { kind: "network" }
  | { kind: "hang" }
  | { kind: "result"; value: unknown };

interface Rule {
  host?: Host;
  method?: string;
  /** 1-based call numbers of this (host, method) the rule applies to; all when omitted. */
  calls?: number[];
  /** Apply the call first (its side effects happen), then answer with the fault. */
  afterEffect?: boolean;
  fault: Fault;
}

const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const lc = (s: string) => s.toLowerCase();

interface ChainTx {
  hash: string;
  raw: string;
  tx: ethers.Transaction;
  from: string;
}

class FakeChain {
  chainId = 42161;
  height = 1000;
  baseFee: bigint | null = 20_000_000n; // 0.02 gwei, Arbitrum-like
  gasPrice = 30_000_000n;
  tip: bigint | null = 0n; // null: eth_maxPriorityFeePerGas is not supported
  balance = 10n ** 20n; // native, for any sender
  tokenBalance = 10n ** 12n; // token units, for any sender
  startNonce = 7;
  /** L2-style inclusion at broadcast. Off: the transaction waits in the mempool. */
  mineOnBroadcast = true;
  /** Mine the mempool on this many-th receipt poll (0: never). */
  mineOnReceiptPoll = 0;
  /** Receipts come back with status 0. */
  revertAll = false;
  /** Hosts whose "pending" nonce counts the mempool. */
  seesMempool = new Set<Host>(["rpc1", "rpc2", "rpc3"]);
  rules: Rule[] = [];

  nonces = new Map<string, number>();
  mempool = new Map<string, ChainTx>();
  mined = new Map<string, ChainTx & { block: number; status: 0 | 1 }>();
  /** Every transaction a node took into its pool, in order. */
  taken: Array<ChainTx & { host: Host }> = [];
  /** Every eth_sendRawTransaction that reached a node. */
  sendCalls: Array<{ host: Host; hash: string }> = [];
  calls: Array<{ host: Host; method: string }> = [];
  private counts = new Map<string, number>();
  private receiptPolls = 0;

  nonceOf(addr: string): number {
    return this.nonces.get(lc(addr)) ?? this.startNonce;
  }

  private mine(t: ChainTx) {
    this.height += 1;
    this.mempool.delete(t.hash);
    this.mined.set(t.hash, { ...t, block: this.height, status: this.revertAll ? 0 : 1 });
    this.nonces.set(lc(t.from), Math.max(this.nonceOf(t.from), t.tx.nonce + 1));
  }

  mineAll() {
    for (const t of [...this.mempool.values()]) this.mine(t);
  }

  /** The fault for this call, if a rule matches. Counts the call either way. */
  faultFor(host: Host, method: string): Rule | undefined {
    const key = `${host} ${method}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    this.calls.push({ host, method });
    return this.rules.find(
      (r) =>
        (r.host == null || r.host === host) &&
        (r.method == null || r.method === method) &&
        (r.calls == null || r.calls.includes(n)),
    );
  }

  handle(host: Host, method: string, params: any[]): { result?: unknown; error?: any } {
    const err = (message: string, code = -32000, data?: unknown) => ({ error: { code, message, data } });
    switch (method) {
      case "eth_chainId":
        return { result: hex(this.chainId) };
      case "eth_blockNumber":
        return { result: hex(this.height) };
      case "eth_gasPrice":
        return { result: hex(this.gasPrice) };
      case "eth_getBalance":
        return { result: hex(this.balance) };
      case "eth_maxPriorityFeePerGas":
        return this.tip == null ? err("the method eth_maxPriorityFeePerGas does not exist", -32601) : { result: hex(this.tip) };
      case "eth_getBlockByNumber":
        return { result: blockJson(this.height, this.baseFee) };
      case "eth_getTransactionCount": {
        const [addr, tag] = params;
        let n = this.nonceOf(addr);
        if (tag === "pending" && this.seesMempool.has(host)) {
          n += [...this.mempool.values()].filter((m) => lc(m.from) === lc(addr)).length;
        }
        return { result: hex(n) };
      }
      case "eth_estimateGas": {
        const call = params[0] ?? {};
        const value = call.value ? BigInt(call.value) : 0n;
        if (value > this.balance) return err("insufficient funds for transfer");
        if (call.data && call.data !== "0x") {
          const [, amount] = ERC20.decodeFunctionData("transfer", call.data);
          if (amount > this.tokenBalance) {
            const data = ERC20_ERROR.encodeErrorResult("Error", ["ERC20: transfer amount exceeds balance"]);
            return err("execution reverted: ERC20: transfer amount exceeds balance", 3, data);
          }
          return { result: hex(60_000) };
        }
        return { result: hex(21_000) };
      }
      case "eth_sendRawTransaction": {
        const raw: string = params[0];
        const tx = ethers.Transaction.from(raw);
        const hash = ethers.keccak256(raw);
        const from = tx.from!;
        this.sendCalls.push({ host, hash });
        if (Number(tx.chainId) !== this.chainId) return err("invalid chain id for signer");
        if (this.mempool.has(hash)) return err("already known");
        if (this.mined.has(hash) || tx.nonce < this.nonceOf(from)) return err("nonce too low");
        if ([...this.mempool.values()].some((m) => lc(m.from) === lc(from) && m.tx.nonce === tx.nonce)) {
          return err("replacement transaction underpriced");
        }
        const price = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
        if (tx.value + tx.gasLimit * price > this.balance) {
          return err("insufficient funds for gas * price + value");
        }
        const t: ChainTx = { hash, raw, tx, from };
        this.taken.push({ ...t, host });
        if (this.mineOnBroadcast) this.mine(t);
        else this.mempool.set(hash, t);
        return { result: hash };
      }
      case "eth_getTransactionByHash": {
        const h = lc(params[0]);
        const m = this.mined.get(h) ?? [...this.mined.values()].find((x) => lc(x.hash) === h);
        if (m) return { result: txJson(m.tx, m.block) };
        const p = [...this.mempool.values()].find((x) => lc(x.hash) === h);
        return { result: p ? txJson(p.tx, null) : null };
      }
      case "eth_getTransactionReceipt": {
        this.receiptPolls += 1;
        if (this.mineOnReceiptPoll > 0 && this.receiptPolls >= this.mineOnReceiptPoll) this.mineAll();
        const h = lc(params[0]);
        const m = [...this.mined.values()].find((x) => lc(x.hash) === h);
        return { result: m ? receiptJson(m.tx, m.block, m.status) : null };
      }
      default:
        return err(`method not mocked: ${method}`, -32601);
    }
  }
}

const ERC20 = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
const ERC20_ERROR = new ethers.Interface(["error Error(string)"]);

function blockJson(n: number, baseFee: bigint | null) {
  return {
    hash: ethers.toBeHex(n, 32),
    parentHash: ethers.toBeHex(n - 1, 32),
    number: hex(n),
    timestamp: hex(1_700_000_000 + n),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    gasLimit: hex(30_000_000),
    gasUsed: "0x0",
    miner: ethers.ZeroAddress,
    extraData: "0x",
    transactions: [],
    ...(baseFee != null ? { baseFeePerGas: hex(baseFee) } : {}),
  };
}

function txJson(t: ethers.Transaction, block: number | null) {
  const sig = t.signature!;
  return {
    hash: t.hash,
    nonce: hex(t.nonce),
    from: t.from,
    to: t.to,
    value: hex(t.value),
    gas: hex(t.gasLimit),
    gasPrice: hex(t.gasPrice ?? t.maxFeePerGas ?? 0n),
    ...(t.type === 2
      ? { maxFeePerGas: hex(t.maxFeePerGas!), maxPriorityFeePerGas: hex(t.maxPriorityFeePerGas!) }
      : {}),
    input: t.data,
    type: hex(t.type ?? 0),
    chainId: hex(t.chainId),
    v: hex(t.type === 2 ? sig.yParity : (sig.networkV ?? BigInt(sig.v))),
    yParity: hex(sig.yParity),
    r: sig.r,
    s: sig.s,
    accessList: [],
    blockNumber: block == null ? null : hex(block),
    blockHash: block == null ? null : ethers.toBeHex(block, 32),
    transactionIndex: block == null ? null : "0x0",
  };
}

function receiptJson(t: ethers.Transaction, block: number, status: 0 | 1) {
  return {
    transactionHash: t.hash,
    transactionIndex: "0x0",
    blockHash: ethers.toBeHex(block, 32),
    blockNumber: hex(block),
    from: t.from,
    to: t.to,
    contractAddress: null,
    cumulativeGasUsed: hex(21_000),
    gasUsed: hex(21_000),
    effectiveGasPrice: hex(20_000_000n),
    logs: [],
    logsBloom: "0x" + "00".repeat(256),
    status: hex(status),
    type: hex(t.type ?? 0),
  };
}

let chain: FakeChain;

/** One JSON-RPC payload (or batch) through the fake, honouring the rules. */
async function serve(
  host: Host,
  body: any,
  signal?: AbortSignal | null,
): Promise<{ status: number; text: string }> {
  const items: any[] = Array.isArray(body) ? body : [body];
  const answers: any[] = [];
  let transport: Fault | undefined;
  for (const p of items) {
    const rule = chain.faultFor(host, p.method);
    let out: { result?: unknown; error?: any };
    if (rule && !rule.afterEffect) out = {};
    else out = chain.handle(host, p.method, p.params ?? []);
    if (rule) {
      const f = rule.fault;
      if (f.kind === "rpc-error") out = { error: { code: f.code ?? -32000, message: f.message, data: f.data } };
      else if (f.kind === "result") out = { result: f.value };
      else transport ??= f;
      if (f.kind === "rpc-error" && f.status) transport ??= { kind: "http", status: f.status };
    }
    answers.push({ jsonrpc: "2.0", id: p.id, ...out });
  }
  if (transport?.kind === "network") throw new TypeError("Failed to fetch");
  if (transport?.kind === "hang") {
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }
  const json = JSON.stringify(Array.isArray(body) ? answers : answers[0]);
  if (transport?.kind === "http") {
    const errBody = answers.some((a) => a.error) ? json : "<html>upstream error</html>";
    return { status: transport.status, text: errBody };
  }
  return { status: 200, text: json };
}

function hostFor(url: string): Host {
  const host = HOST_OF.get(new URL(url).origin);
  if (!host) throw new Error(`TEST TRIPWIRE: request to a URL outside the fake: ${url}`);
  return host;
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = hostFor(url);
  const text = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array);
  const out = await serve(host, JSON.parse(text), init?.signal);
  return new Response(out.text, { status: out.status, headers: { "content-type": "application/json" } });
});

// ── the adapter under test ─────────────────────────────────────────────────

const USDC_ARB = STABLECOIN_NETWORKS.find((n) => n.chain === "usdc-arb")!.contract;
const USDT_ETH = STABLECOIN_NETWORKS.find((n) => n.chain === "usdt-eth")!.contract;
const KEY = ethers.Wallet.createRandom().privateKey; // never funded, never broadcast
const FROM = new ethers.Wallet(KEY).address;
const RECIPIENT = ethers.Wallet.createRandom().address;

function adapter(opts: { token?: boolean; hosts?: Host[] } = {}) {
  const urls = (opts.hosts ?? ["rpc1", "rpc2"]).map((h) => URL_OF[h]);
  return createEvmAdapter({
    chain: opts.token ? "usdc-arb" : "arbitrum",
    displayName: opts.token ? "USDC (Arbitrum)" : "Arbitrum",
    ticker: opts.token ? "USDC" : "ETH",
    color: "#000",
    chainId: 42161,
    rpcUrl: urls[0],
    rpcFallbacks: urls.slice(1),
    ...(opts.token ? { tokenContract: USDC_ARB, tokenDecimals: 6 } : {}),
  });
}

let signSpy: ReturnType<typeof vi.spyOn>;
const savedTiming = { ...EVM_SEND_TIMING };

beforeAll(() => {
  // A provider-based send path would reach the network through ethers'
  // FetchRequest, not `fetch`: send it to the same fake.
  ethers.FetchRequest.registerGetUrl(async (req) => {
    const host = hostFor(req.url);
    const out = await serve(host, JSON.parse(new TextDecoder().decode(req.body!)));
    return {
      statusCode: out.status,
      statusMessage: out.status === 200 ? "OK" : "ERROR",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(out.text),
    };
  });
});

afterAll(() => {
  ethers.FetchRequest.registerGetUrl(ethers.FetchRequest.createGetUrlFunc());
});

beforeEach(() => {
  chain = new FakeChain();
  fakeFetch.mockClear();
  vi.stubGlobal("fetch", fakeFetch);
  signSpy = vi.spyOn(ethers.BaseWallet.prototype, "signTransaction");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.assign(EVM_SEND_TIMING, { requestTimeoutMs: 250, receiptBudgetMs: 400, pollIntervalMs: 5 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.assign(EVM_SEND_TIMING, savedTiming);
});

/** Distinct transactions any node took. One press must never make two. */
function distinctTaken(): number {
  return new Set(chain.taken.map((t) => lc(t.hash))).size;
}

async function outcome(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (e) {
    return e;
  }
}

// ── C1: signed once, whatever fails after the broadcast ─────────────────────

describe("C1 (2026-09-29 send-safety audit): one press signs one transaction", () => {
  it("a transient receipt error after the broadcast does not sign again (native ETH)", async () => {
    chain.rules.push({
      host: "rpc1",
      method: "eth_getTransactionReceipt",
      calls: [1],
      fault: { kind: "rpc-error", code: -32603, message: "internal error" },
    });
    const r = (await adapter().sendTransaction(KEY, RECIPIENT, "0.5")) as { hash: string; pending?: boolean };
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(distinctTaken()).toBe(1);
    expect(lc(r.hash)).toBe(lc(chain.taken[0].hash));
    expect(r.pending).toBeUndefined();
  });

  it("the same, for a USDC transfer", async () => {
    chain.rules.push({
      host: "rpc1",
      method: "eth_getTransactionReceipt",
      calls: [1],
      fault: { kind: "rpc-error", code: -32603, message: "internal error" },
    });
    const r = (await adapter({ token: true }).sendTransaction(KEY, RECIPIENT, "100")) as { hash: string };
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(distinctTaken()).toBe(1);
    expect(lc(r.hash)).toBe(lc(chain.taken[0].hash));
  });

  it("a failed eth_blockNumber (ethers batched it with the broadcast) does not sign again", async () => {
    chain.rules.push({
      host: "rpc1",
      method: "eth_blockNumber",
      fault: { kind: "rpc-error", code: -32603, message: "internal error" },
    });
    await outcome(adapter().sendTransaction(KEY, RECIPIENT, "0.5"));
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(distinctTaken()).toBe(1);
  });

  it("a 502 on the broadcast reply after the node took it: same bytes elsewhere, one transfer", async () => {
    chain.rules.push({
      host: "rpc1",
      method: "eth_sendRawTransaction",
      afterEffect: true,
      fault: { kind: "http", status: 502 },
    });
    const r = (await adapter().sendTransaction(KEY, RECIPIENT, "0.5")) as { hash: string; pending?: boolean };
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(distinctTaken()).toBe(1);
    // rpc2 got the SAME bytes and said "nonce too low"; the hash lookup
    // turned that into success rather than a second transaction.
    expect(new Set(chain.sendCalls.map((c) => lc(c.hash))).size).toBe(1);
    expect(lc(r.hash)).toBe(lc(chain.taken[0].hash));
    expect(r.pending).toBeUndefined();
  });
});

// ── H1 / H2: what is reported is what is known ──────────────────────────────

describe("H1/H2 (2026-09-29 send-safety audit): the outcome is reported as known", () => {
  it("taken, then every endpoint fails: SendOutcomeUnknownError with the hash", async () => {
    chain.rules.push(
      // rpc1 takes the transaction and the reply is lost...
      { host: "rpc1", method: "eth_sendRawTransaction", afterEffect: true, fault: { kind: "network" } },
      // ...and afterwards nothing can be learned from it...
      { host: "rpc1", method: "eth_getTransactionByHash", fault: { kind: "http", status: 503 } },
      { host: "rpc1", method: "eth_getTransactionReceipt", fault: { kind: "http", status: 503 } },
      // ...while rpc2 is unreachable throughout.
      { host: "rpc2", fault: { kind: "network" } },
    );
    const e = await outcome(adapter().sendTransaction(KEY, RECIPIENT, "0.5"));
    expect(isSendOutcomeUnknown(e)).toBe(true);
    expect(lc((e as { hash?: string }).hash ?? "")).toBe(lc(chain.taken[0].hash));
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(distinctTaken()).toBe(1);
  });

  it("'already known' from the next node is success, not 'Transaction failed'", async () => {
    chain.mineOnBroadcast = false;
    chain.mineOnReceiptPoll = 2;
    // rpc2 does not count the mempool in its pending nonce: the pre-fix code
    // re-signed the identical bytes there and reported "already known" as a
    // failure with the form still filled.
    chain.seesMempool = new Set<Host>(["rpc1"]);
    chain.rules.push({
      host: "rpc1",
      method: "eth_sendRawTransaction",
      afterEffect: true,
      fault: { kind: "http", status: 504 },
    });
    const r = (await adapter().sendTransaction(KEY, RECIPIENT, "0.5")) as { hash: string; pending?: boolean };
    expect(lc(r.hash)).toBe(lc(chain.taken[0].hash));
    expect(r.pending).toBeUndefined();
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(distinctTaken()).toBe(1);
  });

  it("a mined but reverted transfer is a failure that names the hash", async () => {
    chain.revertAll = true;
    const e = await outcome(adapter({ token: true }).sendTransaction(KEY, RECIPIENT, "100"));
    expect(e).toBeInstanceOf(Error);
    expect(isSendOutcomeUnknown(e)).toBe(false);
    const msg = (e as Error).message;
    expect(msg).toContain(chain.taken[0].hash);
    expect(msg).toMatch(/reverted/);
    expect(msg).toMatch(/fee was spent/);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(distinctTaken()).toBe(1);
  });

  it("no receipt within the budget: submitted and pending, never re-sent", { timeout: 4_000 }, async () => {
    chain.mineOnBroadcast = false; // stays in the mempool
    const started = Date.now();
    const r = (await adapter().sendTransaction(KEY, RECIPIENT, "0.5")) as { hash: string; pending?: boolean };
    expect(r.pending).toBe(true);
    expect(lc(r.hash)).toBe(lc(chain.taken[0].hash));
    expect(Date.now() - started).toBeGreaterThanOrEqual(EVM_SEND_TIMING.receiptBudgetMs - 20);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(chain.sendCalls).toHaveLength(1);
  });

  it("receipt polls that all fail end as pending, not as a resend", { timeout: 4_000 }, async () => {
    chain.rules.push({ method: "eth_getTransactionReceipt", fault: { kind: "network" } });
    const r = (await adapter().sendTransaction(KEY, RECIPIENT, "0.5")) as { hash: string; pending?: boolean };
    expect(r.pending).toBe(true);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(chain.sendCalls).toHaveLength(1);
  });

  it("a node that hangs on the broadcast is abandoned and the same bytes go to the next", async () => {
    chain.rules.push({ host: "rpc1", method: "eth_sendRawTransaction", fault: { kind: "hang" } });
    const r = (await adapter().sendTransaction(KEY, RECIPIENT, "0.5")) as { hash: string };
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(chain.taken.map((t) => t.host)).toEqual(["rpc2"]);
    expect(lc(r.hash)).toBe(lc(chain.taken[0].hash));
  });

  it("a success that names another hash is not taken as success (the sandbox mock's shape)", async () => {
    chain.rules.push({
      host: "rpc1",
      method: "eth_sendRawTransaction",
      fault: { kind: "result", value: "0x" + "fe".repeat(32) },
    });
    const r = (await adapter().sendTransaction(KEY, RECIPIENT, "0.5")) as { hash: string };
    expect(chain.taken.map((t) => t.host)).toEqual(["rpc2"]);
    expect(lc(r.hash)).toBe(lc(chain.taken[0].hash));
    expect(signSpy).toHaveBeenCalledTimes(1);
  });
});

// ── M2: the first meaningful error ──────────────────────────────────────────

describe("M2 (2026-09-29 send-safety audit): the first meaningful error is the one shown", () => {
  it("a token contract's refusal survives the next node being down", async () => {
    chain.tokenBalance = 5_000_000n; // 5 USDC
    chain.rules.push({ host: "rpc2", fault: { kind: "network" } });
    const e = await outcome(adapter({ token: true }).sendTransaction(KEY, RECIPIENT, "100"));
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect((e as Error).message).toMatch(/USDC contract refused this transfer/);
    expect((e as Error).message).toMatch(/transfer amount exceeds balance/);
    expect((e as Error).message).toMatch(/Nothing was sent/);
    expect(signSpy).not.toHaveBeenCalled();
    expect(chain.sendCalls).toHaveLength(0);
  });

  it("'insufficient funds' at the broadcast is reported plainly, with a flaky node after it", async () => {
    chain.balance = 500_000_000_000_000_000n + 1n; // the amount, and 1 wei for the fee
    chain.rules.push({ host: "rpc2", fault: { kind: "network" } });
    const e = await outcome(adapter().sendTransaction(KEY, RECIPIENT, "0.5"));
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect((e as Error).message).toBe(
      "Not enough ETH on Arbitrum to cover this amount plus the network fee. Nothing was sent.",
    );
    expect(chain.taken).toHaveLength(0);
    expect(signSpy).toHaveBeenCalledTimes(1);
  });

  it("'InsufficientFunds' (no space, as Nethermind-style clients write it) is the same plain refusal", async () => {
    chain.rules.push(
      {
        host: "rpc1",
        method: "eth_sendRawTransaction",
        fault: { kind: "rpc-error", message: "InsufficientFunds, Account balance: 1, cumulative cost: 2" },
      },
      { host: "rpc2", fault: { kind: "network" } },
    );
    const e = await outcome(adapter().sendTransaction(KEY, RECIPIENT, "0.5"));
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect((e as Error).message).toBe(
      "Not enough ETH on Arbitrum to cover this amount plus the network fee. Nothing was sent.",
    );
  });

  it("a node that refuses the request (API key) is passed over", async () => {
    chain.rules.push({
      host: "rpc1",
      method: "eth_sendRawTransaction",
      fault: { kind: "rpc-error", code: -32000, message: "Unauthorized: API key required" },
    });
    const r = (await adapter().sendTransaction(KEY, RECIPIENT, "0.5")) as { hash: string };
    expect(chain.taken.map((t) => t.host)).toEqual(["rpc2"]);
    expect(lc(r.hash)).toBe(lc(chain.taken[0].hash));
  });

  it("every node declines outright: an ordinary failure, nothing sent", async () => {
    chain.rules.push(
      {
        host: "rpc1",
        method: "eth_sendRawTransaction",
        fault: { kind: "rpc-error", code: -32000, message: "Unauthorized: API key required" },
      },
      { host: "rpc2", method: "eth_sendRawTransaction", fault: { kind: "http", status: 429 } },
    );
    const e = await outcome(adapter().sendTransaction(KEY, RECIPIENT, "0.5"));
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect((e as Error).message).toMatch(/^No Arbitrum node would take this transaction/);
    expect((e as Error).message).toMatch(/API key required/);
    expect((e as Error).message).toMatch(/Nothing was sent/);
    expect(chain.taken).toHaveLength(0);
  });

  it("a lost reply before a refusal stays unknown: the first node may have it", async () => {
    chain.rules.push(
      { host: "rpc1", method: "eth_sendRawTransaction", fault: { kind: "network" } },
      {
        host: "rpc2",
        method: "eth_sendRawTransaction",
        fault: { kind: "rpc-error", message: "insufficient funds for gas * price + value" },
      },
    );
    const e = await outcome(adapter().sendTransaction(KEY, RECIPIENT, "0.5"));
    expect(isSendOutcomeUnknown(e)).toBe(true);
    expect((e as { hash?: string }).hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("nothing reachable while preparing: a plain failure naming the first node", async () => {
    chain.rules.push({ fault: { kind: "network" } });
    const e = await outcome(adapter().sendTransaction(KEY, RECIPIENT, "0.5"));
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect((e as Error).message).toMatch(/^Could not reach any Arbitrum node to prepare this transaction \(rpc1\./);
    expect(signSpy).not.toHaveBeenCalled();
  });
});

// ── M1 / H3 / L3: input refused in plain words, before any network call ─────

describe("M1/H3/L3 (2026-09-29 send-safety audit): input is refused before any network call", () => {
  const RAW_ETHERS = /ENS|FixedNumber|too many decimals for format|invalid address|bad address checksum|could not coalesce/;
  const checksummed = ethers.getAddress(RECIPIENT);
  // EIP-55's own example (0x5aAeb605…) with its first letter's case flipped:
  // still mixed case, so the checksum applies, and it no longer matches.
  const badChecksum = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

  const cases: Array<[string, { token?: boolean; to: string; amount: string; expect: RegExp }]> = [
    ["the zero address", { to: ethers.ZeroAddress, amount: "0.5", expect: /zero address.*burned/ }],
    ["the zero address, for a token", { token: true, to: ethers.ZeroAddress, amount: "1", expect: /zero address/ }],
    ["the token's own contract", { token: true, to: USDC_ARB, amount: "1", expect: /USDC token contract itself/ }],
    ["the token's own contract, lowercase", { token: true, to: lc(USDC_ARB), amount: "1", expect: /USDC token contract itself/ }],
    ["another chain's stablecoin contract", { to: lc(USDT_ETH), amount: "0.5", expect: /USDT token contract on Ethereum/ }],
    ["a recipient missing 0x", { to: checksummed.slice(2), amount: "0.5", expect: /missing its 0x prefix/ }],
    ["an ENS name", { to: "vitalik.eth", amount: "0.5", expect: /Names like example\.eth are not supported/ }],
    ["a non-EVM address", { to: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", amount: "0.5", expect: /not a valid address on Arbitrum/ }],
    ["a bad checksum", { to: badChecksum, amount: "0.5", expect: /fails its checksum/ }],
    ["a comma decimal", { to: RECIPIENT, amount: "1,5", expect: /Use a dot for decimals/ }],
    ["zero", { to: RECIPIENT, amount: "0", expect: /greater than zero/ }],
    ["zero with decimals", { to: RECIPIENT, amount: "0.000", expect: /greater than zero/ }],
    ["a negative amount", { to: RECIPIENT, amount: "-1", expect: /greater than zero/ }],
    ["an exponent", { to: RECIPIENT, amount: "1e-6", expect: /plain number/ }],
    ["an empty amount", { to: RECIPIENT, amount: "  ", expect: /Enter an amount/ }],
    ["too many decimals for USDC", { token: true, to: RECIPIENT, amount: "1.0000001", expect: /USDC has at most 6 decimal places/ }],
  ];

  for (const [name, c] of cases) {
    it(`refuses ${name}`, async () => {
      const e = await outcome(adapter({ token: c.token }).sendTransaction(KEY, c.to, c.amount));
      expect(e).toBeInstanceOf(Error);
      expect(isSendOutcomeUnknown(e)).toBe(false);
      expect((e as Error).message).toMatch(c.expect);
      expect((e as Error).message).not.toMatch(RAW_ETHERS);
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(chain.calls).toHaveLength(0);
      expect(signSpy).not.toHaveBeenCalled();
    });
  }

  it("USDT on Ethereum: the zero address and its own contract are refused", () => {
    const ctx = { chainName: "Ethereum", ticker: "USDT", tokenContract: USDT_ETH };
    expect(() => parseEvmRecipient(ethers.ZeroAddress, ctx)).toThrow(/zero address/);
    expect(() => parseEvmRecipient(USDT_ETH, ctx)).toThrow(/USDT token contract itself/);
  });

  it("every registry contract is refused on every chain, in any case", () => {
    const ctx = { chainName: "Arbitrum", ticker: "ETH" };
    for (const n of STABLECOIN_NETWORKS) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(n.contract)) continue; // SPL / TRON rows
      expect(() => parseEvmRecipient(n.contract.toUpperCase().replace(/^0X/, "0x"), ctx), n.chain).toThrow(
        /token contract/,
      );
    }
  });

  it("a trailing space or newline is trimmed, and the exact address is paid", async () => {
    await adapter().sendTransaction(KEY, `  ${lc(RECIPIENT)} \n`, " 0.25 ");
    expect(chain.taken).toHaveLength(1);
    const tx = chain.taken[0].tx;
    expect(tx.to).toBe(checksummed);
    expect(tx.value).toBe(ethers.parseEther("0.25"));
  });

  it("parses amounts exactly", () => {
    expect(parseEvmAmount("1.5", 6, "USDC")).toBe(1_500_000n);
    expect(parseEvmAmount(".5", 18, "ETH")).toBe(500_000_000_000_000_000n);
    expect(parseEvmAmount("5.", 6, "USDC")).toBe(5_000_000n);
    // Zeros past the precision are harmless, as ethers treats them.
    expect(parseEvmAmount("1.50000000", 6, "USDC")).toBe(1_500_000n);
    expect(parseEvmAmount("0.000000000000000001", 18, "ETH")).toBe(1n);
  });
});

// ── the transaction that gets signed ────────────────────────────────────────

describe("the signed transaction", () => {
  it("native: recipient, exact value, chain id, pending nonce, EIP-1559 fees as before", async () => {
    chain.tip = 1_500_000n;
    await adapter().sendTransaction(KEY, RECIPIENT, "0.123456789");
    const tx = chain.taken[0].tx;
    expect(tx.from).toBe(FROM);
    expect(tx.to).toBe(ethers.getAddress(RECIPIENT));
    expect(tx.value).toBe(ethers.parseEther("0.123456789"));
    expect(tx.chainId).toBe(42161n);
    expect(tx.nonce).toBe(7);
    expect(tx.type).toBe(2);
    // ethers' getFeeData rule, which the old path used: 2 x base + tip.
    expect(tx.maxPriorityFeePerGas).toBe(1_500_000n);
    expect(tx.maxFeePerGas).toBe(2n * 20_000_000n + 1_500_000n);
    // A plain transfer's 21,000 gets no margin.
    expect(tx.gasLimit).toBe(21_000n);
  });

  it("token: calls transfer(recipient, units) on the contract, with a gas margin", async () => {
    await adapter({ token: true }).sendTransaction(KEY, RECIPIENT, "1.5");
    const tx = chain.taken[0].tx;
    expect(tx.to).toBe(ethers.getAddress(USDC_ARB));
    expect(tx.value).toBe(0n);
    const [to, amount] = ERC20.decodeFunctionData("transfer", tx.data);
    expect(to).toBe(ethers.getAddress(RECIPIENT));
    expect(amount).toBe(1_500_000n);
    expect(tx.gasLimit).toBe(72_000n); // 60,000 + 20%
  });

  it("a zero base fee (BNB Chain) signs a legacy transaction at eth_gasPrice, as before", async () => {
    chain.baseFee = 0n;
    await adapter().sendTransaction(KEY, RECIPIENT, "0.5");
    const tx = chain.taken[0].tx;
    expect(tx.type).toBe(0);
    expect(tx.gasPrice).toBe(30_000_000n);
  });

  it("a node without eth_maxPriorityFeePerGas gets ethers' 1 gwei tip, as before", async () => {
    chain.tip = null;
    await adapter().sendTransaction(KEY, RECIPIENT, "0.5");
    expect(chain.taken[0].tx.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it("a node answering for another chain is not used to build the transaction", async () => {
    chain.rules.push({ host: "rpc1", method: "eth_chainId", fault: { kind: "result", value: "0x1" } });
    chain.rules.push({ host: "rpc1", method: "eth_getTransactionCount", fault: { kind: "result", value: "0x99" } });
    await adapter().sendTransaction(KEY, RECIPIENT, "0.5");
    expect(chain.taken[0].tx.nonce).toBe(7); // rpc2's answer, not rpc1's 0x99
  });

  it("uses the pending nonce, so a second press after a pending one is a new nonce", async () => {
    chain.mineOnBroadcast = false;
    Object.assign(EVM_SEND_TIMING, { receiptBudgetMs: 30 });
    await adapter().sendTransaction(KEY, RECIPIENT, "0.5");
    await adapter().sendTransaction(KEY, RECIPIENT, "0.5");
    expect(chain.taken.map((t) => t.tx.nonce)).toEqual([7, 8]);
  });
});

describe("withGasMargin", () => {
  it("leaves a plain transfer alone and adds 20%, rounded up, to anything else", () => {
    expect(withGasMargin(21_000n)).toBe(21_000n);
    expect(withGasMargin(60_000n)).toBe(72_000n);
    expect(withGasMargin(100_001n)).toBe(120_002n); // 100,001 + ceil(20,000.2)
  });
});

// The Send modal's "enough gas?" check reads getGasBudget. It must price the
// transaction the send will actually sign, or it says "enough" and the node
// then refuses with "insufficient funds".
describe("getGasBudget prices what the send signs (2026-09-29 send-safety audit)", () => {
  const maxFee = 2n * 20_000_000n; // 2 x base fee + a 0 tip, as the send computes it

  it("a token transfer: the recipient trimmed, the margined gas limit", async () => {
    const b = await adapter({ token: true }).getGasBudget!(FROM, { to: ` ${RECIPIENT} `, amount: " 1.5 " });
    expect(b.required).toBe(ethers.formatEther(72_000n * maxFee));
    expect(b.sufficient).toBe(true);
  });

  it("a native transfer: exactly 21,000 gas, plus the amount", async () => {
    const b = await adapter().getGasBudget!(FROM, { to: `${RECIPIENT}\n`, amount: "0.5" });
    expect(b.required).toBe(ethers.formatEther(21_000n * maxFee + ethers.parseEther("0.5")));
  });
});
