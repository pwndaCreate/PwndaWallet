/**
 * The NEP-141 legs — USDT and USDC on NEAR (2026-10-06; operator request
 * 2026-10-01): balance, the Send modal's fee check and registration notice,
 * history from NearBlocks' per-token event list, and a transaction's parties.
 *
 * The NEAR RPC and NearBlocks are faked with the field layouts read live on
 * 2026-10-06 (the public test seed's account 5510e2b4…ee412, `intents.near`'s
 * USDT events, tx 8xvZKGz2…). Account ids and hashes below are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "./index";
import { NEAR_RPC_TIMEOUT } from "./near-wallet";
import { NEAR_HISTORY_TIMEOUT, nearblocksFtRow, nep141TxnParties } from "./near-history";
import { clearNep141Caches, nep141NeedsRegistration, nep141SendCostYocto } from "./nep141-wallet";

const USDT = "usdt.tether-token.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ME = "a1".repeat(32);
const THEM = "b2".repeat(32);
const MIN = "1250000000000000000000";

interface Fake {
  tokens: Record<string, string>;
  registered: Set<string>;
  accounts: Record<string, { amount: string; locked: string; storage_usage: number }>;
  rpcDown: boolean;
  nearblocks: (url: string) => Response;
  calls: string[];
}
let fake: Fake;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rpcResult = (result: unknown) => json(200, { jsonrpc: "2.0", id: 1, result });
const viewResult = (v: unknown) =>
  rpcResult({ result: Array.from(new TextEncoder().encode(JSON.stringify(v))), logs: [] });

async function fakeFetch(input: unknown, init?: { body?: unknown }) {
  const url = String(input);
  fake.calls.push(url);
  if (url.startsWith("https://api.nearblocks.io")) return fake.nearblocks(url);
  if (fake.rpcDown) return new Response("bad gateway", { status: 502 });
  const { method, params } = JSON.parse(String(init?.body ?? "{}"));
  if (method === "query" && params.request_type === "call_function") {
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
    if (params.method_name === "ft_balance_of") return viewResult(fake.tokens[`${params.account_id}|${args.account_id}`] ?? "0");
    if (params.method_name === "storage_balance_of") {
      return viewResult(fake.registered.has(args.account_id) ? { total: MIN, available: "0" } : null);
    }
    if (params.method_name === "storage_balance_bounds") return viewResult({ min: MIN, max: MIN });
  }
  if (method === "query" && params.request_type === "view_account") {
    const a = fake.accounts[params.account_id];
    return a
      ? rpcResult(a)
      : json(200, {
          jsonrpc: "2.0",
          id: 1,
          error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, code: -32000, message: "Server error", data: "x" },
        });
  }
  if (method === "gas_price") return rpcResult({ gas_price: "100000000" });
  throw new Error(`unscripted ${method}`);
}

beforeEach(() => {
  fake = {
    tokens: { [`${USDT}|${ME}`]: "120500000" },
    registered: new Set([ME]),
    accounts: { [ME]: { amount: "1000000000000000000000000", locked: "0", storage_usage: 182 } },
    rpcDown: false,
    nearblocks: () => json(200, { txns: [] }),
    calls: [],
  };
  clearNep141Caches();
  NEAR_RPC_TIMEOUT.ms = 2_000;
  NEAR_HISTORY_TIMEOUT.ms = 2_000;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => vi.unstubAllGlobals());

describe("balance", () => {
  it("reads ft_balance_of on the leg's own contract", async () => {
    expect(await getAdapter("usdt-near").getBalance(ME)).toBe("120.5");
    // USDC is a different contract: nothing held there.
    expect(await getAdapter("usdc-near").getBalance(ME)).toBe("0");
  });

  it("throws when no node answers — never a zero", async () => {
    fake.rpcDown = true;
    await expect(getAdapter("usdt-near").getBalance(ME)).rejects.toThrow();
  });
});

describe("the Send modal's NEAR check", () => {
  it("costs only gas to a registered recipient", async () => {
    fake.registered.add(THEM);
    const g = await getAdapter("usdt-near").getGasBudget!(ME, { to: THEM });
    expect(g).toMatchObject({ ticker: "NEAR", chainName: "NEAR", includesAmount: false, sufficient: true });
    expect(g.notice).toBeUndefined();
    // (30 + 5) Tgas at 1e8 yocto/gas, plus 20%, plus the 1-yocto deposit.
    expect(g.required).toBe("0.004200000000000000000001");
  });

  it("names the registration deposit before Send when the recipient is not registered", async () => {
    const g = await getAdapter("usdt-near").getGasBudget!(ME, { to: THEM });
    expect(g.sufficient).toBe(true);
    expect(g.notice).toMatch(/has never held USDT on NEAR/);
    expect(g.notice).toMatch(/0\.00125 NEAR \(NEAR's storage deposit\)/);
    // (60 + 5) Tgas + 20% + 1 yocto + 0.00125 NEAR.
    expect(g.required).toBe("0.009050000000000000000001");
  });

  it("an account with no NEAR on chain cannot send: a definite no", async () => {
    const g = await getAdapter("usdt-near").getGasBudget!(THEM, { to: ME });
    expect(g).toMatchObject({ available: "0", sufficient: false });
  });

  it("an unreadable answer is 'unknown', never a refusal", async () => {
    fake.rpcDown = true;
    const g = await getAdapter("usdt-near").getGasBudget!(ME, { to: THEM });
    expect(g.sufficient).toBeNull();
  });

  it("the cost model: registration adds the minimum and a second call's gas", () => {
    const price = 100_000_000n;
    const plain = nep141SendCostYocto({ gasPrice: price, storageDeposit: 0n });
    const reg = nep141SendCostYocto({ gasPrice: price, storageDeposit: BigInt(MIN) });
    expect(reg - plain).toBe(BigInt(MIN) + (30_000_000_000_000n * price * 6n) / 5n);
    expect(nep141NeedsRegistration(null, BigInt(MIN))).toBe(true);
    expect(nep141NeedsRegistration({ total: "1" }, BigInt(MIN))).toBe(true);
    expect(nep141NeedsRegistration({ total: MIN }, BigInt(MIN))).toBe(false);
  });
});

describe("history from NearBlocks' event list", () => {
  // The `ft-txns` row layout, read live 2026-10-06; values invented.
  const row = (over: Record<string, unknown>) => ({
    event_index: "17539716754665342100000000051000003",
    affected_account_id: ME,
    involved_account_id: THEM,
    delta_amount: "9800000",
    cause: "TRANSFER",
    transaction_hash: "8xvZKGz2UbLzZa6ztqbJqmrzqSy4kCtGmSawPUTg48Lx",
    block_timestamp: "1753971674722903685",
    block: { block_height: 157625613 },
    outcomes: { status: true },
    outcomes_agg: { transaction_fee: 462178870359900000000 },
    ft: { contract: USDT, symbol: "USDt", decimals: 6 },
    ...over,
  });

  it("asks for this token only, and reads a receipt and a send by the delta's sign", async () => {
    fake.nearblocks = () =>
      json(200, {
        txns: [
          row({ delta_amount: "-2500000", transaction_hash: "OUT1" }),
          row({}),
        ],
      });
    const page = await getAdapter("usdt-near").getTransactionHistory(ME);
    const asked = fake.calls.find((u) => u.includes("/ft-txns"))!;
    expect(asked).toContain(`/v1/account/${ME}/ft-txns?contract=usdt.tether-token.near`);
    expect(page.items).toHaveLength(2);
    const [out, inn] = page.items;
    expect(out).toMatchObject({ chain: "usdt-near", hash: "OUT1", direction: "out", amount: "2.5", counterparty: THEM });
    // The fee is the signer's: on a send it is this wallet's, in NEAR.
    expect(out.fee).toBe("0.0004621788703599");
    expect(inn).toMatchObject({ direction: "in", amount: "9.8", counterparty: THEM, timestamp: 1753971674, height: 157625613 });
    expect(inn.fee).toBeUndefined();
  });

  it("drops another token's event and a zero delta", () => {
    expect(nearblocksFtRow(row({ ft: { contract: USDC } }), ME, { chain: "usdt-near", contract: USDT, decimals: 6 })).toBeNull();
    expect(nearblocksFtRow(row({ delta_amount: "0" }), ME, { chain: "usdt-near", contract: USDT, decimals: 6 })).toBeNull();
  });

  it("a NearBlocks failure throws — never 'no transactions'", async () => {
    fake.nearblocks = () => new Response("rate limited", { status: 429 });
    await expect(getAdapter("usdt-near").getTransactionHistory(ME)).rejects.toThrow(/HTTP 429/);
  });
});

describe("a transaction's parties", () => {
  // The `/full` transaction layout, read live for 8xvZKGz2… on 2026-10-06:
  // `fts` events on the receipts, deltas as JSON numbers.
  const txn = (fts: unknown[], actions: unknown[] = []) => ({
    transaction_hash: "H1",
    signer_account_id: THEM,
    receiver_account_id: USDT,
    actions,
    receipts: [
      { predecessor_account_id: THEM, receiver_account_id: USDT, fts },
      { predecessor_account_id: "system", receiver_account_id: THEM, fts: [] },
    ],
  });

  it("names payer and payee from the token's events, never the contract", () => {
    const p = nep141TxnParties(
      txn([
        { affected_account_id: THEM, involved_account_id: ME, delta_amount: -9800000, ft_meta: { contract: USDT } },
        { affected_account_id: ME, involved_account_id: THEM, delta_amount: 9800000, ft_meta: { contract: USDT } },
      ]),
      USDT,
      ME,
      6,
    );
    expect(p).toMatchObject({ from: [THEM], to: [ME] });
    expect(p!.to).not.toContain(USDT);
  });

  it("without events (failed, or not indexed yet), the ft_transfer's own receiver", () => {
    const p = nep141TxnParties(
      txn([], [{ action: "FUNCTION_CALL", method: "ft_transfer", args: JSON.stringify({ receiver_id: ME, amount: "1" }) }]),
      USDT,
      ME,
      6,
    );
    expect(p).toMatchObject({ from: [THEM], to: [ME] });
  });

  it("is null for a transaction that moves no token of this contract", () => {
    expect(nep141TxnParties(txn([]), USDT, ME, 6)).toBeNull();
    expect(
      nep141TxnParties(
        txn([{ affected_account_id: ME, delta_amount: 5, ft_meta: { contract: USDC } }]),
        USDT,
        ME,
        6,
      ),
    ).toBeNull();
  });
});

describe("sending", () => {
  it("the adapter never signs: the session-gated override does", async () => {
    await expect(getAdapter("usdt-near").sendTransaction("k", THEM, "1")).rejects.toThrow(/session override/);
  });
});
