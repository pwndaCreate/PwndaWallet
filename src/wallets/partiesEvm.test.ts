/**
 * `getTransactionParties` on the EVM adapters and their ERC-20 legs —
 * operator request 2026-09-30: "in the info I can see which address each
 * transaction was sent and received from".
 *
 * Read live on 2026-09-30 (eth.drpc.org, one request each, the world-public
 * test address 0x9858…):
 *  - `eth_getTransactionByHash` 0x6f3d8961… — a plain ETH receive: `from`
 *    0x7cec…, `to` 0x9858…, `input` "0x";
 *  - `eth_getTransactionReceipt` 0x2c9af6a8… — a USDC transfer OUT of 0x9858…
 *    that 0x9858… did not send: a sweeper (tx `from` 0x44a3…) called a helper
 *    contract (tx `to` 0x2c64…) that ran `transferFrom(0x9858…, 0x44a3…)`.
 *    Only the token contract's `Transfer` log names the parties;
 *  - an unknown hash: `{"id":1,"jsonrpc":"2.0","result":null}` for both calls.
 *
 * The fixtures keep that layout; the hashes and third-party addresses are
 * invented. `fetch` is the only fake, answering per host; nothing reaches
 * the network.
 */
import { getAddress } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvmAdapter } from "./evm-factory";
import { ERC20_TRANSFER_TOPIC, erc20CalldataTransfer, erc20TransferLogs } from "./parties-a-evm";
import { usdcArbAdapter } from "./eth-wallet";
import { ARB_RPCS } from "./chain-rpcs";

// Checksummed by ethers, as the reader prints them.
const ME = getAddress("0x9858effd232b4033e47d90003d41ec34ecaeda94"); // the test seed's EVM address
const SWEEPER = getAddress("0x44a3831b70e4cfba7d73262dc78443664cabe644");
const HELPER = getAddress("0x2c64c4722b4ff5d8dca035b71b5eb8dc9b7e0787");
const OTHER = getAddress("0x7cecd9e9e0ba9f29f553402e4dd6d3c1ea2c2759");
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // USDC on Arbitrum
const USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const HASH = "0x" + "5a".repeat(32);

const lc = (s: string) => s.toLowerCase();
const word = (addr: string) => "0x" + "0".repeat(24) + lc(addr).slice(2);
const amountWord = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

type Host = "rpc1" | "rpc2" | "rpc3";
const URLS: Record<Host, string> = {
  rpc1: "https://rpc1.parties.test.invalid",
  rpc2: "https://rpc2.parties.test.invalid",
  rpc3: "https://rpc3.parties.test.invalid/v2/SECRET-KEY",
};

/** What one host answers per method: a result, a JSON-RPC error, an HTTP status, or a dropped connection. */
type Reply = { result: unknown } | { error: { code: number; message: string }; status?: number } | { http: number } | { network: true };

let replies: Partial<Record<Host, Partial<Record<string, Reply>>>> = {};
let calls: Array<{ host: string; method: string }> = [];

function hostKey(url: string): Host | string {
  const hit = (Object.entries(URLS) as [Host, string][]).find(([, u]) => url === u);
  return hit ? hit[0] : new URL(url).host;
}

beforeEach(() => {
  replies = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const req = JSON.parse(String(init?.body));
      const host = hostKey(url);
      calls.push({ host, method: req.method });
      const r = (replies as Record<string, Partial<Record<string, Reply>>>)[host]?.[req.method];
      if (!r) throw new Error(`TEST TRIPWIRE: ${host} ${req.method} not scripted`);
      if ("network" in r) throw new TypeError("Failed to fetch");
      if ("http" in r) return new Response("<html>upstream error</html>", { status: r.http });
      const body = JSON.stringify({ jsonrpc: "2.0", id: req.id, ...r });
      return new Response(body, { status: "status" in r && r.status ? r.status : 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function adapter(opts: { token?: string; hosts?: Host[] } = {}) {
  const urls = (opts.hosts ?? ["rpc1", "rpc2"]).map((h) => URLS[h]);
  return createEvmAdapter({
    chain: opts.token ? "usdc-arb" : "arbitrum",
    displayName: opts.token ? "USDC (Arbitrum)" : "Arbitrum",
    ticker: opts.token ? "USDC" : "ETH",
    color: "#000",
    chainId: 42161,
    rpcUrl: urls[0],
    rpcFallbacks: urls.slice(1),
    ...(opts.token ? { tokenContract: opts.token, tokenDecimals: 6 } : {}),
  });
}

/** An `eth_getTransactionByHash` result, as eth.drpc.org printed one (addresses lower-case). */
function txJson(over: Record<string, unknown> = {}) {
  return {
    blockHash: "0x" + "7a".repeat(32),
    blockNumber: "0x18dd999",
    from: lc(OTHER),
    gas: "0xc055",
    gasPrice: "0x4a29eecf",
    hash: HASH,
    input: "0x",
    nonce: "0x0",
    to: lc(ME),
    transactionIndex: "0x78",
    value: "0x8d22523da50",
    type: "0x2",
    chainId: "0xa4b1",
    ...over,
  };
}

/** An `eth_getTransactionReceipt` result carrying `logs`. */
function receiptJson(logs: unknown[], over: Record<string, unknown> = {}) {
  return {
    type: "0x2",
    status: "0x1",
    logs,
    transactionHash: HASH,
    blockNumber: "0x163641b",
    gasUsed: "0xe4ee",
    from: lc(SWEEPER),
    to: lc(HELPER),
    contractAddress: null,
    ...over,
  };
}

function transferLog(token: string, from: string, to: string, amount = 10_000_000n, extraTopics: string[] = []) {
  return {
    address: lc(token),
    topics: [ERC20_TRANSFER_TOPIC, word(from), word(to), ...extraTopics],
    data: amountWord(amount),
    logIndex: "0xc",
    transactionHash: HASH,
    removed: false,
  };
}

describe("native coin — eth_getTransactionByHash's from / to", () => {
  it("receive: the sender and this wallet, checksummed, with the host that answered", async () => {
    replies.rpc1 = { eth_getTransactionByHash: { result: txJson() } };
    expect(await adapter().getTransactionParties!(HASH, ME)).toEqual({ from: [OTHER], to: [ME], source: "rpc1.parties.test.invalid" });
    expect(calls).toEqual([{ host: "rpc1", method: "eth_getTransactionByHash" }]);
  });

  it("send, still in the mempool (no block yet): the transaction already names both", async () => {
    replies.rpc1 = {
      eth_getTransactionByHash: { result: txJson({ from: lc(ME), to: lc(OTHER), blockNumber: null, blockHash: null, transactionIndex: null }) },
    };
    expect(await adapter().getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [OTHER] });
  });

  it("a contract creation has no `to`: the receipt's new contract stands in", async () => {
    const created = "0x1111111111111111111111111111111111111111";
    replies.rpc1 = {
      eth_getTransactionByHash: { result: txJson({ from: lc(ME), to: null }) },
      eth_getTransactionReceipt: { result: receiptJson([], { contractAddress: created }) },
    };
    expect(await adapter().getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [created] });
  });

  it("the first RPC does not know it, the next does: a mempool is not the chain's last word", async () => {
    replies.rpc1 = { eth_getTransactionByHash: { result: null } };
    replies.rpc2 = { eth_getTransactionByHash: { result: txJson() } };
    expect(await adapter().getTransactionParties!(HASH, ME)).toMatchObject({ from: [OTHER], source: "rpc2.parties.test.invalid" });
  });

  it("not found: every RPC that answered said null (one was down) → null", async () => {
    replies.rpc1 = { eth_getTransactionByHash: { result: null } };
    replies.rpc2 = { eth_getTransactionByHash: { network: true } };
    expect(await adapter().getTransactionParties!(HASH, ME)).toBeNull();
  });

  it("every RPC failed: throws, naming each HOST (never an env URL's key) and its status", async () => {
    replies.rpc1 = { eth_getTransactionByHash: { http: 503 } };
    replies.rpc2 = { eth_getTransactionByHash: { error: { code: -32005, message: "rate limit exceeded" }, status: 429 } };
    replies.rpc3 = { eth_getTransactionByHash: { network: true } };
    const err = await adapter({ hosts: ["rpc1", "rpc2", "rpc3"] })
      .getTransactionParties!(HASH, ME)
      .then(
        () => {
          throw new Error("expected a rejection");
        },
        (e: unknown) => e as Error,
      );
    expect(err.message).toBe(
      "every Arbitrum RPC failed — rpc1.parties.test.invalid: HTTP 503; " +
        "rpc2.parties.test.invalid: HTTP 429, JSON-RPC error -32005: rate limit exceeded; " +
        "rpc3.parties.test.invalid: request failed (Failed to fetch)",
    );
    expect(err.message).not.toMatch(/SECRET-KEY/);
  });

  it("a string that is not a transaction hash is null, with no request", async () => {
    expect(await adapter().getTransactionParties!("a1".repeat(32), ME)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("ERC-20 leg — the token's Transfer logs, not the transaction's from / to", () => {
  it("the live sweep: the log's parties (0x9858… → 0x44a3…), not the tx's (0x44a3… → 0x2c64…)", async () => {
    replies.rpc1 = { eth_getTransactionReceipt: { result: receiptJson([transferLog(USDC, ME, SWEEPER)]) } };
    expect(await adapter({ token: USDC }).getTransactionParties!(HASH, ME)).toEqual({
      from: [ME],
      to: [SWEEPER],
      source: "rpc1.parties.test.invalid",
    });
    // One request: the receipt holds the answer.
    expect(calls).toEqual([{ host: "rpc1", method: "eth_getTransactionReceipt" }]);
  });

  it("receive, among other tokens' transfers and an ERC-721 Transfer (four topics): only this token's", async () => {
    const logs = [
      transferLog(USDT, OTHER, ME),
      transferLog(USDC, OTHER, ME),
      transferLog(USDC, HELPER, SWEEPER, 1n, ["0x" + "0".repeat(63) + "7"]),
    ];
    replies.rpc1 = { eth_getTransactionReceipt: { result: receiptJson(logs) } };
    expect(await adapter({ token: USDC }).getTransactionParties!(HASH, ME)).toMatchObject({ from: [OTHER], to: [ME] });
  });

  it("several transfers of the token: those involving the wallet; when none does, all of them", async () => {
    const logs = [transferLog(USDC, HELPER, OTHER), transferLog(USDC, OTHER, ME), transferLog(USDC, HELPER, SWEEPER)];
    replies.rpc1 = { eth_getTransactionReceipt: { result: receiptJson(logs) } };
    expect(await adapter({ token: USDC }).getTransactionParties!(HASH, ME)).toMatchObject({ from: [OTHER], to: [ME] });
    expect(await adapter({ token: USDC }).getTransactionParties!(HASH, "0x000000000000000000000000000000000000dEaD")).toMatchObject({
      from: [HELPER, OTHER],
      to: [OTHER, ME, SWEEPER],
    });
  });

  it("a reverted transfer keeps no log: its calldata names whom it was for", async () => {
    const calldata = "0xa9059cbb" + word(OTHER).slice(2) + amountWord(5_000_000n).slice(2);
    replies.rpc1 = {
      eth_getTransactionReceipt: { result: receiptJson([], { status: "0x0", from: lc(ME), to: lc(USDC) }) },
      eth_getTransactionByHash: { result: txJson({ from: lc(ME), to: lc(USDC), input: calldata, value: "0x0" }) },
    };
    expect(await adapter({ token: USDC }).getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [OTHER] });
  });

  it("a transaction that moved none of this token names nobody for it", async () => {
    replies.rpc1 = {
      eth_getTransactionReceipt: { result: receiptJson([transferLog(USDT, OTHER, ME)]) },
      eth_getTransactionByHash: { result: txJson({ to: lc(HELPER), input: "0x12345678" }) },
    };
    expect(await adapter({ token: USDC }).getTransactionParties!(HASH, ME)).toEqual({
      from: [],
      to: [],
      source: "rpc1.parties.test.invalid",
    });
  });

  it("no receipt yet (pending) on any RPC: null — there is no transfer to read until it is mined", async () => {
    replies.rpc1 = { eth_getTransactionReceipt: { result: null } };
    replies.rpc2 = { eth_getTransactionReceipt: { result: null } };
    expect(await adapter({ token: USDC }).getTransactionParties!(HASH, ME)).toBeNull();
  });

  it("every RPC failed: throws with the leg's name", async () => {
    replies.rpc1 = { eth_getTransactionReceipt: { http: 502 } };
    replies.rpc2 = { eth_getTransactionReceipt: { error: { code: -32603, message: "internal error" } } };
    await expect(adapter({ token: USDC }).getTransactionParties!(HASH, ME)).rejects.toThrow(
      "every USDC (Arbitrum) RPC failed — rpc1.parties.test.invalid: HTTP 502; rpc2.parties.test.invalid: JSON-RPC error -32603: internal error",
    );
  });

  it("the shipped USDC (Arbitrum) leg asks its own chain's RPC list, first entry first", async () => {
    const first = new URL(ARB_RPCS()[0]).host;
    (replies as Record<string, Partial<Record<string, Reply>>>)[first] = {
      eth_getTransactionReceipt: { result: receiptJson([transferLog(USDC, OTHER, ME)]) },
    };
    expect(await usdcArbAdapter.getTransactionParties!(HASH, ME)).toEqual({ from: [OTHER], to: [ME], source: first });
  });
});

describe("the pure readers", () => {
  it("erc20TransferLogs: matches the contract case-insensitively, ignores other topics", () => {
    const logs = [transferLog(USDC.toUpperCase().replace("0X", "0x"), ME, OTHER), { address: lc(USDC), topics: ["0x" + "11".repeat(32)] }];
    expect(erc20TransferLogs({ logs }, USDC)).toEqual([{ from: ME, to: OTHER }]);
    expect(erc20TransferLogs(null, USDC)).toEqual([]);
  });

  it("erc20CalldataTransfer: transfer and transferFrom on the token itself; nothing else", () => {
    const transferFrom = "0x23b872dd" + word(ME).slice(2) + word(SWEEPER).slice(2) + amountWord(1n).slice(2);
    expect(erc20CalldataTransfer({ to: lc(USDC), from: lc(HELPER), input: transferFrom }, USDC)).toEqual({ from: ME, to: SWEEPER });
    // The same call through a helper contract is not a call ON the token.
    expect(erc20CalldataTransfer({ to: lc(HELPER), from: lc(SWEEPER), input: transferFrom }, USDC)).toBeNull();
    expect(erc20CalldataTransfer({ to: lc(USDC), from: lc(ME), input: "0xa9059cbb" }, USDC)).toBeNull();
  });
});
