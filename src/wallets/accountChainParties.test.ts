/**
 * `getTransactionParties` for Stellar, Sui, Algorand, Hedera, Cardano (all
 * through the Rust `http_proxy_call`, faked here), and Aptos, NEAR, Conflux,
 * Ergo (direct `fetch`, stubbed) — plus the history-row fixes made on the way
 * (2026-09-30).
 *
 * Every fixture keeps the field layout a live, read-only request returned on
 * 2026-09-30 (the public test seed's own transactions where it had any,
 * else a recent public one); addresses and hashes are invented. Where a live
 * answer showed something the code relies on, the test says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProxyReq = { method: string; url: string; body?: string };
const proxy = vi.hoisted(() => ({
  handler: null as null | ((req: ProxyReq) => { status: number; body: string }),
  calls: [] as ProxyReq[],
}));

vi.mock("../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args: ProxyReq) => {
    if (cmd !== "http_proxy_call" || !proxy.handler) throw new Error(`unexpected invoke ${cmd}`);
    proxy.calls.push(args);
    return { ...proxy.handler(args), headers: [] };
  }),
}));

import { stellarAdapter } from "./stellar-wallet";
import { suiAdapter } from "./sui-wallet";
import { algoAdapter } from "./algo-wallet";
import { hbarAdapter, hederaValueTransfers } from "./hbar-wallet";
import { adaAdapter, cardanoFlow } from "./ada-wallet";
import { aptAdapter, aptosTransferOf, normalizeAptosAddress } from "./apt-wallet";
import { nearAdapter, NEAR_RPC_TIMEOUT } from "./near-wallet";
import { cfxAdapter } from "./cfx-wallet";
import { ergoAdapter } from "./erg-wallet";

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

beforeEach(() => {
  proxy.handler = null;
  proxy.calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Stub `fetch`: `route(url, init)` returns [status, body]. */
function stubFetch(route: (url: string, init?: RequestInit) => [number, unknown]) {
  const calls: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      const [status, body] = route(url, init);
      if (status === 0) throw new TypeError("Failed to fetch");
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

// =========================================================================
// Stellar — Horizon /transactions/{hash}/operations
// =========================================================================

describe("Stellar parties", () => {
  const ME = "GAMEINVENTEDSTELLARADDRESS000000000000000000000000000000";
  const THEM = "GTHEMINVENTEDSTELLARADDRESS00000000000000000000000000000";
  const OTHER = "GOTHERINVENTEDSTELLARADDRESS0000000000000000000000000000";
  const HASH = "39".repeat(32);
  const op = (over: Record<string, unknown>) => ({
    id: "275636956514693122",
    paging_token: "275636956514693122",
    transaction_successful: true,
    source_account: THEM,
    type_i: 1,
    created_at: "2026-08-29T09:31:07Z",
    transaction_hash: HASH,
    ...over,
  });
  const answer = (records: unknown[]) => () => json(200, { _embedded: { records } });

  it("a payment received: from → to, asked of Horizon's operations for the hash", async () => {
    proxy.handler = answer([op({ type: "payment", from: THEM, to: ME, amount: "1.5000000", asset_type: "native" })]);
    expect(await stellarAdapter.getTransactionParties!(HASH, ME)).toEqual({
      from: [THEM],
      to: [ME],
      source: "horizon.stellar.org",
    });
    expect(proxy.calls[0]).toMatchObject({
      method: "GET",
      url: `https://horizon.stellar.org/transactions/${HASH}/operations?limit=200`,
    });
  });

  it("the live sponsored account creation (three operations): funder → account", async () => {
    // Read 2026-09-30 for the test seed's own creation: begin_sponsoring,
    // create_account (funder / account / starting_balance 0), end_sponsoring.
    proxy.handler = answer([
      op({ type: "begin_sponsoring_future_reserves", type_i: 16, sponsored_id: ME }),
      op({ type: "create_account", type_i: 0, sponsor: THEM, starting_balance: "0.0000000", funder: THEM, account: ME }),
      op({ type: "end_sponsoring_future_reserves", type_i: 17, source_account: ME, begin_sponsor: THEM }),
    ]);
    expect(await stellarAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: [THEM], to: [ME] });
  });

  it("a send among several operations: XLM first, and the ones involving this wallet", async () => {
    proxy.handler = answer([
      op({ type: "payment", from: OTHER, to: THEM, amount: "5", asset_type: "credit_alphanum4", asset_code: "USDC" }),
      op({ type: "payment", from: ME, to: THEM, amount: "2", asset_type: "native", source_account: ME }),
      op({ type: "payment", from: OTHER, to: OTHER, amount: "1", asset_type: "native" }),
    ]);
    expect(await stellarAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [THEM] });
  });

  it("an account merge (live shape): account → into", async () => {
    proxy.handler = answer([op({ type: "account_merge", type_i: 8, source_account: ME, account: ME, into: THEM })]);
    expect(await stellarAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [THEM] });
  });

  it("a transaction that pays nobody names its source account and no recipient", async () => {
    proxy.handler = answer([op({ type: "change_trust", type_i: 6, source_account: ME, asset_type: "credit_alphanum4" })]);
    expect(await stellarAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [] });
  });

  it("an unknown hash is Horizon's 404: null; any other failure throws with the host", async () => {
    proxy.handler = () => json(404, { title: "Resource Missing", status: 404 });
    await expect(stellarAdapter.getTransactionParties!(HASH, ME)).resolves.toBeNull();
    proxy.handler = () => ({ status: 503, body: "upstream unavailable" });
    await expect(stellarAdapter.getTransactionParties!(HASH, ME)).rejects.toThrow(
      /^horizon\.stellar\.org could not read transaction .*: HTTP 503/,
    );
  });
});

// =========================================================================
// Sui — publicnode JSON-RPC, then GraphQL
// =========================================================================

describe("Sui parties", () => {
  const SENDER = "0x" + "d2".repeat(32);
  const SPONSOR = "0x" + "7b".repeat(32);
  const RECIPIENT = "0x" + "5e".repeat(32);
  const DIGEST = "5iVDN5KzN3zAbj1CexYCvdBdJUEvkFRdkYk4KrfyVnLz";
  const SUI = "0x2::sui::SUI";
  const SUI_EXPANDED = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  const rpcResult = (result: unknown) => json(200, { jsonrpc: "2.0", id: 1, result });
  const rpcError = (code: number, message: string) => json(200, { jsonrpc: "2.0", id: 1, error: { code, message } });
  /** The layout publicnode returned for a sponsored transaction on 2026-09-30. */
  const block = (balanceChanges: unknown[]) => ({
    digest: DIGEST,
    transaction: {
      data: {
        messageVersion: "v1",
        transaction: { kind: "ProgrammableTransaction", inputs: [], transactions: [] },
        sender: SENDER,
        gasData: { payment: [], owner: SPONSOR, price: "721", budget: "950000000" },
      },
      txSignatures: [],
    },
    balanceChanges,
    timestampMs: "1790788601973",
    checkpoint: "328740563",
  });
  const route = (rpc: () => { status: number; body: string }, gql: () => { status: number; body: string }) => {
    proxy.handler = (req) => (req.url.includes("graphql") ? gql() : rpc());
  };

  it("the sender, not the gas sponsor, and the owner whose SUI rose", async () => {
    route(
      () =>
        rpcResult(
          block([
            { owner: { AddressOwner: SPONSOR }, coinType: SUI, amount: "-1291380" },
            { owner: { AddressOwner: SENDER }, coinType: SUI, amount: "-500000000" },
            { owner: { AddressOwner: RECIPIENT }, coinType: SUI, amount: "500000000" },
          ]),
        ),
      () => {
        throw new Error("GraphQL must not be asked");
      },
    );
    expect(await suiAdapter.getTransactionParties!(DIGEST, RECIPIENT)).toEqual({
      from: [SENDER],
      to: [RECIPIENT],
      source: "sui-rpc.publicnode.com",
    });
    const req = JSON.parse(proxy.calls[0].body ?? "{}");
    expect(req).toMatchObject({
      method: "sui_getTransactionBlock",
      params: [DIGEST, { showInput: true, showBalanceChanges: true }],
    });
  });

  it("a transfer of another coin: whoever's balance of it rose", async () => {
    route(
      () =>
        rpcResult(
          block([
            { owner: { AddressOwner: SENDER }, coinType: SUI, amount: "-1500000" },
            { owner: { AddressOwner: SENDER }, coinType: USDC, amount: "-2000000" },
            { owner: { AddressOwner: RECIPIENT }, coinType: USDC, amount: "2000000" },
          ]),
        ),
      () => json(500, {}),
    );
    expect(await suiAdapter.getTransactionParties!(DIGEST, SENDER)).toMatchObject({ from: [SENDER], to: [RECIPIENT] });
  });

  it("pruned on publicnode (-32602, live): asks GraphQL, which has it", async () => {
    route(
      () => rpcError(-32602, `Could not find the referenced transaction [TransactionDigest(${DIGEST})].`),
      () =>
        json(200, {
          data: {
            transaction: {
              sender: { address: SENDER },
              effects: {
                balanceChanges: {
                  nodes: [
                    { owner: { address: RECIPIENT }, amount: "500000000", coinType: { repr: SUI_EXPANDED } },
                    { owner: { address: SENDER }, amount: "-501097880", coinType: { repr: SUI_EXPANDED } },
                  ],
                },
              },
            },
          },
        }),
    );
    expect(await suiAdapter.getTransactionParties!(DIGEST, RECIPIENT)).toEqual({
      from: [SENDER],
      to: [RECIPIENT],
      source: "graphql.mainnet.sui.io",
    });
    expect(JSON.parse(proxy.calls[1].body ?? "{}").variables).toEqual({ digest: DIGEST });
  });

  it("unknown to both: null (GraphQL answers `transaction: null`)", async () => {
    route(
      () => rpcError(-32602, `Could not find the referenced transaction [TransactionDigest(${DIGEST})].`),
      () => json(200, { data: { transaction: null } }),
    );
    await expect(suiAdapter.getTransactionParties!(DIGEST, SENDER)).resolves.toBeNull();
  });

  it("publicnode down, GraphQL says unknown: null — GraphQL's answer is the chain's", async () => {
    route(() => ({ status: 502, body: "bad gateway" }), () => json(200, { data: { transaction: null } }));
    await expect(suiAdapter.getTransactionParties!(DIGEST, SENDER)).resolves.toBeNull();
  });

  it("both down: throws, naming both", async () => {
    route(() => ({ status: 502, body: "bad gateway" }), () => ({ status: 503, body: "unavailable" }));
    await expect(suiAdapter.getTransactionParties!(DIGEST, SENDER)).rejects.toThrow(
      /Sui transaction .* could not be read: sui-rpc\.publicnode\.com: .*502.* \| Sui GraphQL failed .*503/,
    );
  });

  it("history rows now name the other side, as counterparty and meta.from / meta.to", async () => {
    // GraphQL since 2026-10-01 (`sui-wallet.test.ts` has why); the live
    // `Address.transactions` node layout.
    const ME = RECIPIENT;
    const node = (digest: string, sender: string, changes: Array<[string, string]>) => ({
      digest,
      sender: { address: sender },
      effects: {
        status: "SUCCESS",
        timestamp: "2026-09-21T12:26:40.000Z",
        checkpoint: { sequenceNumber: 1 },
        executionError: null,
        balanceChangesJson: changes.map(([address, amount]) => ({ address, coinType: SUI_EXPANDED, amount })),
      },
    });
    proxy.handler = ({ url }) => {
      expect(url).toContain("graphql");
      return json(200, {
        data: {
          address: {
            transactions: {
              pageInfo: { hasPreviousPage: false, startCursor: "c" },
              nodes: [
                node("DigestSent", ME, [[ME, "-1001000000"], [SENDER, "1000000000"]]),
                node("DigestReceived", SENDER, [[SPONSOR, "-1000000"], [SENDER, "-250000000"], [ME, "250000000"]]),
              ],
            },
          },
        },
      });
    };
    const items = (await suiAdapter.getTransactionHistory(ME)).items;
    const sent = items.find((t) => t.hash === "DigestSent")!;
    const received = items.find((t) => t.hash === "DigestReceived")!;
    expect(sent).toMatchObject({ direction: "out", counterparty: SENDER, meta: { from: ME, to: SENDER } });
    // The transaction's sender, not its gas sponsor.
    expect(received).toMatchObject({ direction: "in", counterparty: SENDER, meta: { from: SENDER, to: ME } });
  });
});

// =========================================================================
// Algorand — indexer /v2/transactions/{txid}
// =========================================================================

describe("Algorand parties", () => {
  const ME = "HODT2N2CV4CZ4B45Y4ZEJDGAPAY5Z3EM7DYHLHX3SUEWIZQCDOEPZATQIE";
  const THEM = "I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU";
  const CLOSE = "ALGORANDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIN5DNAU";
  const TXID = "7MK6WLKFBPC323ATSEKNEKUTQZ23TCCM75SJNSFAHEM65GYJ5ANQ";
  const tx = (over: Record<string, unknown>) => ({
    "close-rewards": 0,
    "closing-amount": 0,
    "confirmed-round": 62440,
    fee: 1000,
    id: TXID,
    "round-time": 1560614017,
    sender: THEM,
    "tx-type": "pay",
    "payment-transaction": { amount: 100000, "close-amount": 0, receiver: ME },
    ...over,
  });

  it("a payment received (live layout: `{ current-round, transaction }`)", async () => {
    proxy.handler = () => json(200, { "current-round": 60000000, transaction: tx({}) });
    expect(await algoAdapter.getTransactionParties!(TXID, ME)).toEqual({
      from: [THEM],
      to: [ME],
      source: "mainnet-idx.algonode.cloud",
    });
    expect(proxy.calls[0].url).toBe(`https://mainnet-idx.algonode.cloud/v2/transactions/${TXID}`);
  });

  it("a send that closed the account names where the remainder went", async () => {
    proxy.handler = () =>
      json(200, {
        transaction: tx({ sender: ME, "payment-transaction": { amount: 5, receiver: THEM, "close-remainder-to": CLOSE } }),
      });
    expect(await algoAdapter.getTransactionParties!(TXID, ME)).toMatchObject({ from: [ME], to: [THEM, CLOSE] });
  });

  it("an asset clawback: the asset's sender, not the clawback account", async () => {
    proxy.handler = () =>
      json(200, {
        transaction: tx({
          "tx-type": "axfer",
          sender: CLOSE,
          "asset-transfer-transaction": { amount: 1, "asset-id": 31566704, receiver: ME, sender: THEM },
        }),
      });
    expect(await algoAdapter.getTransactionParties!(TXID, ME)).toMatchObject({ from: [THEM], to: [ME] });
  });

  it("unknown id is a 404 (`no transaction found for transaction id`): null; a 5xx throws", async () => {
    proxy.handler = () => json(404, { message: `no transaction found for transaction id: ${TXID}` });
    await expect(algoAdapter.getTransactionParties!(TXID, ME)).resolves.toBeNull();
    proxy.handler = () => ({ status: 500, body: "internal" });
    await expect(algoAdapter.getTransactionParties!(TXID, ME)).rejects.toThrow(
      /^mainnet-idx\.algonode\.cloud could not read transaction .*: HTTP 500/,
    );
  });
});

// =========================================================================
// Hedera — mirror node /transactions/{id}
// =========================================================================

describe("Hedera parties and rows", () => {
  const ID = "0.0.50570-1790788932-436079025";
  /** The live transfer of 2026-09-30, trimmed: the fee went to 0.0.802. */
  const live = {
    charged_tx_fee: 88996,
    consensus_timestamp: "1790788933.257962104",
    name: "CRYPTOTRANSFER",
    node: "0.0.3",
    nonce: 0,
    result: "SUCCESS",
    scheduled: false,
    transaction_id: ID,
    transfers: [
      { account: "0.0.802", amount: 88996, is_approval: false },
      { account: "0.0.50570", amount: -24212447646, is_approval: false },
      { account: "0.0.10859816", amount: 24212358650, is_approval: false },
    ],
  };

  it("payer → recipient; the fee collector is not a recipient", async () => {
    proxy.handler = () => json(200, { transactions: [live] });
    expect(await hbarAdapter.getTransactionParties!(ID, "0xpubkey")).toEqual({
      from: ["0.0.50570"],
      to: ["0.0.10859816"],
      source: "mainnet-public.mirrornode.hedera.com",
    });
    expect(proxy.calls[0].url).toBe(`https://mainnet-public.mirrornode.hedera.com/api/v1/transactions/${ID}`);
  });

  it("the fee comes out of its collectors, and anything above it is a payment (live cases)", () => {
    // 1 tinybar sent; a fee of 88996 to 0.0.802.
    expect(
      hederaValueTransfers({
        charged_tx_fee: 88996,
        node: "0.0.21",
        transaction_id: "0.0.3229-1790788922-900000370",
        transfers: [
          { account: "0.0.802", amount: 88996 },
          { account: "0.0.3229", amount: -88997 },
          { account: "0.0.3230", amount: 1 },
        ],
      }),
    ).toEqual([
      { account: "0.0.3229", tinybars: -1n },
      { account: "0.0.3230", tinybars: 1n },
    ]);
    // 9 tinybars to the submitting node itself, on top of the fee.
    expect(
      hederaValueTransfers({
        charged_tx_fee: 88996,
        node: "0.0.28",
        transaction_id: "0.0.10890314-1790788929-352414468",
        transfers: [
          { account: "0.0.28", amount: 9 },
          { account: "0.0.802", amount: 88996 },
          { account: "0.0.10890314", amount: -89005 },
        ],
      }),
    ).toEqual([
      { account: "0.0.28", tinybars: 9n },
      { account: "0.0.10890314", tinybars: -9n },
    ]);
    // Older transactions paid the node and 0.0.98.
    expect(
      hederaValueTransfers({
        charged_tx_fee: 100,
        node: "0.0.4",
        transaction_id: "0.0.7-1690000000-1",
        transfers: [
          { account: "0.0.4", amount: 30 },
          { account: "0.0.98", amount: 70 },
          { account: "0.0.7", amount: -1100 },
          { account: "0.0.8", amount: 1000 },
        ],
      }),
    ).toEqual([
      { account: "0.0.7", tinybars: -1000n },
      { account: "0.0.8", tinybars: 1000n },
    ]);
  });

  it("takes the `@` form of an id, and picks the user's transaction (nonce 0) of several", async () => {
    proxy.handler = () =>
      json(200, {
        transactions: [
          { ...live, nonce: 1, transfers: [{ account: "0.0.1", amount: -5 }, { account: "0.0.2", amount: 5 }] },
          live,
        ],
      });
    expect(await hbarAdapter.getTransactionParties!("0.0.50570@1790788932.436079025", "0xpubkey")).toMatchObject({
      from: ["0.0.50570"],
      to: ["0.0.10859816"],
    });
    expect(proxy.calls[0].url).toMatch(/\/transactions\/0\.0\.50570-1790788932-436079025$/);
  });

  it("unknown id is a 404: null; a 5xx throws with the host", async () => {
    proxy.handler = () => json(404, { _status: { messages: [{ message: "Not found" }] } });
    await expect(hbarAdapter.getTransactionParties!(ID, "0xpubkey")).resolves.toBeNull();
    proxy.handler = () => ({ status: 502, body: "bad gateway" });
    await expect(hbarAdapter.getTransactionParties!(ID, "0xpubkey")).rejects.toThrow(
      /^mainnet-public\.mirrornode\.hedera\.com could not read transaction .*: HTTP 502/,
    );
  });

  it("history rows: a small send names its recipient, not the fee collector, and its fee separately", async () => {
    proxy.handler = ({ url }) =>
      url.includes("account.publickey")
        ? json(200, { accounts: [{ account: "0.0.3229" }] })
        : json(200, {
            transactions: [
              {
                ...live,
                transaction_id: "0.0.3229-1790788922-900000370",
                node: "0.0.21",
                transfers: [
                  { account: "0.0.802", amount: 88996 },
                  { account: "0.0.3229", amount: -88997 },
                  { account: "0.0.3230", amount: 1 },
                ],
              },
              {
                ...live,
                transaction_id: "0.0.3230-1790788000-1",
                transfers: [
                  { account: "0.0.802", amount: 88996 },
                  { account: "0.0.3230", amount: -100088996 },
                  { account: "0.0.3229", amount: 100000000 },
                ],
              },
            ],
          });
    const [sent, received] = (await hbarAdapter.getTransactionHistory("0x" + "2e".repeat(32))).items;
    // Was: counterparty 0.0.802 and amount 0.00088997 (the fee counted in).
    expect(sent).toMatchObject({ direction: "out", amount: "0.00000001", fee: "0.00088996", counterparty: "0.0.3230" });
    expect(received).toMatchObject({ direction: "in", amount: "1.00000000", counterparty: "0.0.3230" });
    expect(received.fee).toBeUndefined();
  });
});

// =========================================================================
// Cardano — Koios tx_info with inputs
// =========================================================================

describe("Cardano parties and rows", () => {
  const ME = "addr1qy8inventedmeaddress0000000000000000000000000000000000000000000000000000000000000000";
  const THEM = "addr1q87inventedthemaddress00000000000000000000000000000000000000000000000000000000000000";
  const BYRON = "DdzFFzCqrhseybLurG4sxq9PcJMEsKAXTcPZY2cYpAj5CHaZWTJraDszhw7vYZiGSiFF2sabr66bfqppEdaYACp7JPaypttZZwpLEeEM";
  const HASH = "f5".repeat(32);
  /** An input names the output it spends (`tx_hash`, `tx_index`); an output, itself. */
  const utxo = (address: string, value: string, tx_index = 0, tx_hash = "4c".repeat(32)) => ({
    value,
    tx_hash,
    tx_index,
    asset_list: [],
    datum_hash: null,
    stake_addr: null,
    inline_datum: null,
    payment_addr: { cred: null, bech32: address },
    reference_script: null,
  });
  const info = (inputs: unknown[], outputs: unknown[]) => ({
    tx_hash: HASH,
    block_height: 12991792,
    epoch_no: 610,
    absolute_slot: 150000000,
    fee: "165748",
    inputs,
    outputs,
  });

  it("every input address, then every output address (change included)", async () => {
    // The live 53e560b4… layout: a Byron input, a payment out and Byron change.
    proxy.handler = () =>
      json(200, [info([utxo(BYRON, "7930467478", 1)], [utxo(ME, "5000000", 0, HASH), utxo(BYRON, "7925294673", 1, HASH)])]);
    expect(await adaAdapter.getTransactionParties!(HASH, ME)).toEqual({
      from: [BYRON],
      to: [ME, BYRON],
      source: "api.koios.rest",
    });
    expect(proxy.calls[0]).toMatchObject({ method: "POST", url: "https://api.koios.rest/api/v1/tx_info" });
    expect(JSON.parse(proxy.calls[0].body ?? "{}")).toMatchObject({ _tx_hashes: [HASH], _inputs: true });
  });

  it("in the ledger's order, whatever order Koios lists them in", async () => {
    // Two reads of 53e560b4… on 2026-09-30 listed its outputs in both orders.
    proxy.handler = () =>
      json(200, [
        info(
          [utxo(THEM, "1", 3, "bb".repeat(32)), utxo(BYRON, "2", 0, "aa".repeat(32))],
          [utxo(BYRON, "7925294673", 1, HASH), utxo(ME, "5000000", 0, HASH)],
        ),
      ]);
    expect(await adaAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: [BYRON, THEM], to: [ME, BYRON] });
  });

  it("Koios answers `[]` for an unknown hash: null; a failure throws with the host", async () => {
    proxy.handler = () => json(200, []);
    await expect(adaAdapter.getTransactionParties!(HASH, ME)).resolves.toBeNull();
    proxy.handler = () => ({ status: 503, body: "unavailable" });
    await expect(adaAdapter.getTransactionParties!(HASH, ME)).rejects.toThrow(
      /^api\.koios\.rest could not read transaction .*: HTTP 503/,
    );
  });

  it("history: a send is a send — its change back here no longer makes it a receipt, nor its amount 0", () => {
    // Was: "in" 1.834252 (the change), since only outputs were asked for.
    expect(cardanoFlow(info([utxo(ME, "5000000")], [utxo(THEM, "3000000"), utxo(ME, "1834252")]), ME)).toEqual({
      direction: "out",
      lovelace: 3000000n,
      counterparty: THEM,
    });
    // The live f54b0cde… shape, no change: was "out" 0.000000.
    expect(cardanoFlow(info([utxo(ME, "5000000")], [utxo(THEM, "4834252")]), ME)).toEqual({
      direction: "out",
      lovelace: 4834252n,
      counterparty: THEM,
    });
    // A receipt names its payer (an input), not the payer's change output.
    expect(cardanoFlow(info([utxo(BYRON, "7930467478")], [utxo(ME, "5000000"), utxo(BYRON, "7925294673")]), ME)).toEqual({
      direction: "in",
      lovelace: 5000000n,
      counterparty: BYRON,
    });
  });

  it("history: with another party's script input in the same transaction, this wallet's share only", () => {
    const POOL = "addr1wxinventedscriptpool000000000000000000000000000000000000";
    const dex = (mine: string, back: string) =>
      info(
        [utxo(ME, mine, 0, "aa".repeat(32)), utxo(POOL, "1000000000", 1, "bb".repeat(32))],
        [utxo(POOL, "1004834252", 0, HASH), utxo(ME, back, 1, HASH)],
      );
    // Paid 5 ADA into the pool (plus the fee): not the pool's whole output.
    expect(cardanoFlow(dex("10000000", "5000000"), ME)).toEqual({
      direction: "out",
      lovelace: 4834252n,
      counterparty: POOL,
    });
    // Sold into the pool for ADA: a receipt of the gain.
    expect(cardanoFlow(dex("2000000", "11800000"), ME)).toMatchObject({ direction: "in", lovelace: 9800000n });
    // Only the fee left: a consolidation.
    expect(cardanoFlow(info([utxo(ME, "5000000")], [utxo(ME, "4834252")]), ME)).toEqual({
      direction: "self",
      lovelace: 4834252n,
    });
  });

  it("history rows carry exact amounts, and a next page goes further back instead of repeating", async () => {
    const list = Array.from({ length: 3 }, (_, i) => ({
      tx_hash: String(i).repeat(64),
      epoch_no: 610,
      block_height: 300 - i,
      block_time: 1770106397 - i,
    }));
    proxy.handler = ({ url, body }) => {
      if (url.endsWith("/address_txs")) {
        // Koios reads `_after_block_height` as "at or above"; it must not be sent.
        expect(JSON.parse(body ?? "{}")).toEqual({ _addresses: [ME] });
        return json(200, list);
      }
      const hashes: string[] = JSON.parse(body ?? "{}")._tx_hashes;
      return json(
        200,
        hashes.map((h) => ({ ...info([utxo(THEM, "9000000")], [utxo(ME, "1234567")]), tx_hash: h })),
      );
    };
    const first = await adaAdapter.getTransactionHistory(ME, { limit: 2 });
    expect(first.items.map((t) => t.hash)).toEqual([list[0].tx_hash, list[1].tx_hash]);
    expect(first.items[0]).toMatchObject({ direction: "in", amount: "1.234567", counterparty: THEM });
    const second = await adaAdapter.getTransactionHistory(ME, { limit: 2, cursor: first.cursor });
    expect(second.items.map((t) => t.hash)).toEqual([list[2].tx_hash]);
    expect(second.cursor).toBeUndefined();
  });
});

// =========================================================================
// Aptos — /transactions/by_hash (direct fetch)
// =========================================================================

describe("Aptos parties and rows", () => {
  const API = "https://api.mainnet.aptoslabs.com/v1";
  const ME = normalizeAptosAddress("0x" + "eb".repeat(32));
  const THEM = normalizeAptosAddress("0x" + "22".repeat(32));
  const HASH = "0x" + "01".repeat(32);
  /** The live `by_hash` layout of the test seed's own send (2026-09-30), trimmed. */
  const tx = (payload: Record<string, unknown>) => ({
    version: "7318426323",
    hash: HASH,
    gas_used: "63",
    success: true,
    vm_status: "Executed successfully",
    sender: ME,
    sequence_number: "14",
    gas_unit_price: "100",
    payload: { type: "entry_function_payload", type_arguments: [], ...payload },
    timestamp: "1790105077124682",
    type: "user_transaction",
  });

  it("aptos_account::transfer: sender → recipient", async () => {
    const calls = stubFetch(() => [200, tx({ function: "0x1::aptos_account::transfer", arguments: [THEM, "7988200"] })]);
    expect(await aptAdapter.getTransactionParties!(HASH, ME)).toEqual({
      from: [ME],
      to: [THEM],
      source: "api.mainnet.aptoslabs.com",
    });
    expect(calls[0].url).toBe(`${API}/transactions/by_hash/${HASH}`);
  });

  it("primary_fungible_store::transfer is (metadata, recipient, amount)", async () => {
    stubFetch(() => [
      200,
      tx({
        function: "0x1::primary_fungible_store::transfer",
        type_arguments: ["0x1::fungible_asset::Metadata"],
        arguments: [{ inner: "0xa" }, THEM, "250000000"],
      }),
    ]);
    expect(await aptAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [THEM] });
  });

  it("a call that is not a transfer names its sender and no recipient", async () => {
    stubFetch(() => [200, tx({ function: "0x50ead22a::dex_accounts_entry::place_order_to_subaccount", arguments: ["1"] })]);
    expect(await aptAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: [ME], to: [] });
  });

  it("404 transaction_not_found (live body): null; a 5xx or no connection throws", async () => {
    stubFetch(() => [404, { message: `Transaction not found by Transaction hash(${HASH})`, error_code: "transaction_not_found" }]);
    await expect(aptAdapter.getTransactionParties!(HASH, ME)).resolves.toBeNull();
    stubFetch(() => [503, { message: "unavailable" }]);
    await expect(aptAdapter.getTransactionParties!(HASH, ME)).rejects.toThrow(/api\.mainnet\.aptoslabs\.com answered HTTP 503/);
    stubFetch(() => [0, null]);
    await expect(aptAdapter.getTransactionParties!(HASH, ME)).rejects.toThrow(/api\.mainnet\.aptoslabs\.com could not be reached/);
  });

  it("the payload reader: each function's own argument order, and whether the asset is APT", () => {
    expect(aptosTransferOf({ function: "0x1::aptos_account::transfer", arguments: [THEM, "5"] })).toEqual({
      legs: [{ to: THEM, units: 5n }],
      apt: true,
    });
    expect(
      aptosTransferOf({
        function: "0x1::coin::transfer",
        type_arguments: ["0x0000000000000000000000000000000000000000000000000000000000000001::aptos_coin::AptosCoin"],
        arguments: [THEM, "5"],
      })?.apt,
    ).toBe(true);
    expect(
      aptosTransferOf({ function: "0x1::coin::transfer", type_arguments: ["0xf22bede::asset::USDC"], arguments: [THEM, "5"] })?.apt,
    ).toBe(false);
    expect(
      aptosTransferOf({
        function: "0x1::primary_fungible_store::transfer",
        arguments: [{ inner: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b" }, THEM, "5"],
      }),
    ).toEqual({ legs: [{ to: THEM, units: 5n }], apt: false });
    expect(
      aptosTransferOf({ function: "0x1::aptos_account::batch_transfer", arguments: [[THEM, ME], ["1", "2"]] }),
    ).toEqual({ legs: [{ to: THEM, units: 1n }, { to: ME, units: 2n }], apt: true });
    // A look-alike module outside the framework is not a transfer.
    expect(aptosTransferOf({ function: "0xabc::coin::transfer", arguments: [THEM, "5"] })).toBeNull();
  });

  it("history: an APT fungible-asset send reads its real amount and recipient; another asset is skipped", async () => {
    // The sent list; the indexer (read since 2026-10-01) knows nothing more.
    stubFetch((url) => (url.endsWith("/graphql") ? [200, { data: { account_transactions: [] } }] : [
      200,
      [
        tx({
          function: "0x1::primary_fungible_store::transfer",
          type_arguments: ["0x1::fungible_asset::Metadata"],
          arguments: [{ inner: "0xa" }, THEM, "250000000"],
        }),
        {
          ...tx({
            function: "0x1::primary_fungible_store::transfer",
            arguments: [{ inner: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b" }, THEM, "1000000"],
          }),
          hash: "0x" + "02".repeat(32),
          // Each transaction has its own version (the history merges by it
          // since 2026-10-01).
          version: "7318426324",
        },
      ],
    ]));
    const items = (await aptAdapter.getTransactionHistory(ME)).items;
    // Was: counterparty "[object Object]" and the recipient address read as
    // a hex amount; and the USDC transfer listed as APT.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ direction: "out", amount: "2.5", counterparty: THEM });
  });
});

// =========================================================================
// NEAR — NearBlocks /v1/txns/{hash}/full, then the RPC for a fresh own send
// =========================================================================

describe("NEAR parties", () => {
  const ME = "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412";
  const THEM = "9c484fa5d2d069569ba063fc555c34e621ccd88fdbb0295fc79bad232621c5c1";
  const HASH = "BiuXnScWdSgKAHZdv8bzzy9UPYAiWd4tu3gMt5ELMNBP";
  const NB = `https://api.nearblocks.io/v1/txns/${HASH}/full`;
  /** NearBlocks' `/full` answer as read live 2026-09-30, trimmed. */
  const txn = (over: Record<string, unknown> = {}) => ({
    transaction_hash: HASH,
    block_timestamp: "1790273822978124943",
    signer_account_id: THEM,
    receiver_account_id: ME,
    block: { block_height: 217084526 },
    actions: [{ action: "TRANSFER", method: null, args: null, args_full: { deposit: "847680490000000000000000" } }],
    actions_agg: { deposit: 8.4768049e23, gas_attached: 0 },
    outcomes: { status: true },
    outcomes_agg: { transaction_fee: 834989537500000000000, gas_used: 15874843062500 },
    receipts: [
      { receipt_id: "RCX9", predecessor_account_id: THEM, receiver_account_id: ME, receipt_kind: "ACTION", outcome: { status: true }, fts: [], nfts: [] },
      { receipt_id: "7uaP", predecessor_account_id: "system", receiver_account_id: THEM, receipt_kind: "ACTION", outcome: { status: true }, fts: [], nfts: [] },
    ],
    ...over,
  });

  beforeEach(() => {
    NEAR_RPC_TIMEOUT.ms = 1_000;
  });

  it("a payment received: signer → receiver, from NearBlocks' /full", async () => {
    const calls = stubFetch((url) => (url === NB ? [200, { txns: [txn()] }] : [500, "unexpected"]));
    expect(await nearAdapter.getTransactionParties!(HASH, ME)).toEqual({
      from: [THEM],
      to: [ME],
      source: "api.nearblocks.io",
    });
    expect(calls.map((c) => c.url)).toEqual([NB]);
  });

  it("a NEAR Intents withdrawal: the receipt intents.near → this wallet, not the relayer's call", async () => {
    stubFetch(() => [
      200,
      {
        txns: [
          txn({
            signer_account_id: "relayer.near",
            receiver_account_id: "intents.near",
            receipts: [
              { predecessor_account_id: "relayer.near", receiver_account_id: "intents.near" },
              { predecessor_account_id: "intents.near", receiver_account_id: ME },
              { predecessor_account_id: "system", receiver_account_id: "relayer.near" },
            ],
          }),
        ],
      },
    ]);
    expect(await nearAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ from: ["intents.near"], to: [ME] });
  });

  it("not indexed yet (`{\"txns\":[]}`, live) and no node knows it as ours: null", async () => {
    const calls = stubFetch((url) =>
      url === NB
        ? [200, { txns: [] }]
        : [
            200,
            {
              jsonrpc: "2.0",
              id: 1,
              error: {
                name: "HANDLER_ERROR",
                cause: { info: { requested_transaction_hash: HASH }, name: "UNKNOWN_TRANSACTION" },
                code: -32000,
                message: "Server error",
                data: `Transaction ${HASH} doesn't exist`,
              },
            },
          ],
    );
    await expect(nearAdapter.getTransactionParties!(HASH, ME)).resolves.toBeNull();
    // One node's UNKNOWN_TRANSACTION is the answer; the rest are not asked.
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].body ?? "{}")).toMatchObject({
      method: "tx",
      params: { tx_hash: HASH, sender_account_id: ME, wait_until: "NONE" },
    });
  });

  it("not indexed yet, but a node has this wallet's fresh send", async () => {
    stubFetch((url) =>
      url === NB
        ? [200, { txns: [] }]
        : [
            200,
            {
              jsonrpc: "2.0",
              id: 1,
              result: {
                final_execution_status: "FINAL",
                status: { SuccessValue: "" },
                transaction: { signer_id: ME, receiver_id: THEM, actions: [{ Transfer: { deposit: "1" } }], hash: HASH },
                receipts_outcome: [],
              },
            },
          ],
    );
    expect(await nearAdapter.getTransactionParties!(HASH, ME)).toEqual({
      from: [ME],
      to: [THEM],
      source: "near.drpc.org",
    });
  });

  it("NearBlocks failing and no node finding it as ours: throws (it may be someone else's)", async () => {
    stubFetch((url) =>
      url === NB
        ? [429, "Too Many Requests"]
        : [200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION" } } }],
    );
    await expect(nearAdapter.getTransactionParties!(HASH, ME)).rejects.toThrow(
      /NEAR transaction .* could not be read: api\.nearblocks\.io: HTTP 429/,
    );
  });

  it("NearBlocks and every node down: throws, naming both", async () => {
    stubFetch(() => [503, "unavailable"]);
    await expect(nearAdapter.getTransactionParties!(HASH, ME)).rejects.toThrow(
      /api\.nearblocks\.io: HTTP 503.*RPC nodes: NEAR RPC tx at .*: HTTP 503/,
    );
  });
});

// =========================================================================
// Conflux — cfx_getTransactionByHash (direct fetch)
// =========================================================================

describe("Conflux parties and rows", () => {
  const ME = "cfx:aapec3p391t1pexs98yr0wea2sve92uzfp2gkw4aw4";
  const THEM = "cfx:aaj99m65zwpeauts3n9tgx4mkj70ff1a8ecdrcrp7s";
  const HASH = "0x" + "01".repeat(32);
  /** The live `cfx_getTransactionByHash` result (2026-09-30), trimmed. */
  const result = {
    type: "0x0",
    hash: HASH,
    nonce: "0xd",
    from: ME,
    to: THEM,
    value: "0xa23154372f800",
    gasPrice: "0x3b9aca00",
    gas: "0x5208",
    contractCreated: null,
    data: "0x",
    epochHeight: "0x7946425",
    chainId: "0x405",
    status: "0x0",
  };

  it("from → to, from the first RPC that answers", async () => {
    const calls = stubFetch((url) => (url.includes(".com") ? [502, "bad gateway"] : [200, { jsonrpc: "2.0", id: 1, result }]));
    expect(await cfxAdapter.getTransactionParties!(HASH, ME)).toEqual({
      from: [ME],
      to: [THEM],
      source: "main.confluxrpc.org",
    });
    expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({ method: "cfx_getTransactionByHash", params: [HASH] });
  });

  it("a deployment's recipient is the contract it created", async () => {
    stubFetch(() => [200, { jsonrpc: "2.0", id: 1, result: { ...result, to: null, contractCreated: THEM } }]);
    expect(await cfxAdapter.getTransactionParties!(HASH, ME)).toMatchObject({ to: [THEM] });
  });

  it("`result: null` (live, unknown hash): null; both RPCs down: throws with both hosts", async () => {
    stubFetch(() => [200, { jsonrpc: "2.0", id: 1, result: null }]);
    await expect(cfxAdapter.getTransactionParties!(HASH, ME)).resolves.toBeNull();
    stubFetch(() => [503, "unavailable"]);
    await expect(cfxAdapter.getTransactionParties!(HASH, ME)).rejects.toThrow(
      /No Conflux RPC could read transaction .* \(main\.confluxrpc\.com, main\.confluxrpc\.org\): HTTP 503/,
    );
  });

  it("history: a failed transaction (status 1) is `failed`, no longer a completed send", async () => {
    proxy.handler = () =>
      json(200, {
        code: 0,
        message: "",
        data: {
          total: 2,
          list: [
            { hash: "0xaa", from: ME, to: THEM, value: "2853324000000000", gasFee: "21000000000000", timestamp: 1753187707, status: 1, epochNumber: 127165480 },
            { hash: "0xbb", from: ME, to: THEM, value: "1", gasFee: "21000000000000", timestamp: 1753187700, status: 0, epochNumber: 127165470 },
          ],
        },
      });
    const [failed, ok] = (await cfxAdapter.getTransactionHistory(ME)).items;
    expect(failed.direction).toBe("failed");
    expect(ok.direction).toBe("out");
  });
});

// =========================================================================
// Ergo — explorer /transactions/{id}, both mirrors
// =========================================================================

describe("Ergo parties", () => {
  const ME = "9fCMmB72WcFLseNx6QANheTCrDjKeb9FzdFNTdBREt2FzHTmusY";
  const THEM = "9hMRoSfXZJs83S2hLqxZZ8ivw1L8FFgSk7RJB7eq2qXyxU2paED";
  const FEE =
    "2iHkR7CWvD1R4j1yZg5bkeDRQavjAaVPeTDFGGLZduHyfWMuYpmhHocX8GJoaieTx78FntzJbCBVL6rf96ocJoZdmWBL2fci7NqWgAirppPQmZ7fN9V6z13Ay6brPriBKYqLp1bT2Fk4FkFLCfdPpe";
  const ID = "e6".repeat(32);
  /** The live e65b80d7… layout (2026-09-30): one input, a payment, the fee box. */
  const tx = {
    id: ID,
    blockId: "fe".repeat(32),
    inclusionHeight: 1884568,
    timestamp: 1790788831813,
    index: 4,
    globalIndex: 12345678,
    numConfirmations: 1,
    inputs: [{ boxId: "50".repeat(32), value: 3104034, index: 0, outputTransactionId: "36".repeat(32), address: ME }],
    dataInputs: [],
    outputs: [
      { boxId: "86".repeat(32), value: 2004034, index: 0, address: THEM, spentTransactionId: null },
      { boxId: "d9".repeat(32), value: 1100000, index: 1, address: FEE, spentTransactionId: "d0".repeat(32) },
    ],
    size: 251,
  };

  it("every input address → every output address except the miner-fee box", async () => {
    const calls = stubFetch(() => [200, tx]);
    expect(await ergoAdapter.getTransactionParties!(ID, ME)).toEqual({ from: [ME], to: [THEM] });
    expect(calls[0].url).toBe(`https://api.ergoplatform.com/api/v1/transactions/${ID}`);
  });

  it("the second mirror answers when the first fails", async () => {
    stubFetch((url) => (url.includes("ergoplatform") ? [502, "bad gateway"] : [200, tx]));
    expect(await ergoAdapter.getTransactionParties!(ID, ME)).toMatchObject({ from: [ME], to: [THEM] });
  });

  it("history: the fee box is never the counterparty, and a consolidation is `self`", async () => {
    const consolidation = {
      ...tx,
      id: "c0".repeat(32),
      inputs: [
        { ...tx.inputs[0], value: 3000000 },
        { ...tx.inputs[0], boxId: "51".repeat(32), value: 2000000 },
      ],
      outputs: [
        { ...tx.outputs[0], address: ME, value: 3900000 },
        { ...tx.outputs[1], value: 1100000 },
      ],
    };
    stubFetch(() => [200, { items: [tx, consolidation], total: 2 }]);
    const [sent, merged] = (await ergoAdapter.getTransactionHistory(ME)).items;
    expect(sent).toMatchObject({ direction: "out", counterparty: THEM });
    // Was: "out" of 0.0011 ERG, counterparty the fee contract.
    expect(merged).toMatchObject({ direction: "self", amount: "0.0039" });
    expect(merged.counterparty).toBeUndefined();
  });

  it("history: a send's amount leaves its fee out, and the fee stands beside it (2026-10-01)", async () => {
    const OTHER = "9iInventedCoFunderAddressxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const withChange = {
      ...tx,
      id: "c1".repeat(32),
      inputs: [{ ...tx.inputs[0], value: 5000000 }],
      outputs: [
        { ...tx.outputs[0], value: 2000000 },
        { ...tx.outputs[0], boxId: "87".repeat(32), address: ME, value: 1900000 },
        { ...tx.outputs[1], value: 1100000 },
      ],
    };
    // Another address's input too (a DEX order): whose share of the fee was
    // whose is not on the chain, so the whole loss stays the amount.
    const coFunded = {
      ...tx,
      id: "c2".repeat(32),
      inputs: [
        { ...tx.inputs[0], value: 3000000 },
        { ...tx.inputs[0], boxId: "52".repeat(32), address: OTHER, value: 1000000 },
      ],
      outputs: [
        { ...tx.outputs[0], value: 2900000 },
        { ...tx.outputs[1], value: 1100000 },
      ],
    };
    const received = {
      ...tx,
      id: "c3".repeat(32),
      inputs: [{ ...tx.inputs[0], address: THEM }],
      outputs: [
        { ...tx.outputs[0], address: ME },
        { ...tx.outputs[1] },
      ],
    };
    stubFetch(() => [200, { items: [tx, withChange, coFunded, received], total: 4 }]);
    const [live, change, dex, receipt] = (await ergoAdapter.getTransactionHistory(ME)).items;
    // Was "0.003104034": the 0.0011 ERG fee box counted as sent.
    expect(live).toMatchObject({ direction: "out", amount: "0.002004034", fee: "0.0011", counterparty: THEM });
    expect(change).toMatchObject({ direction: "out", amount: "0.002", fee: "0.0011" });
    expect(dex).toMatchObject({ direction: "out", amount: "0.003" });
    expect(dex.fee).toBeUndefined();
    expect(receipt).toMatchObject({ direction: "in", amount: "0.002004034", counterparty: THEM });
    expect(receipt.fee).toBeUndefined();
  });

  it("history: a consolidation carries the fee it paid", async () => {
    const consolidation = {
      ...tx,
      id: "c4".repeat(32),
      inputs: [
        { ...tx.inputs[0], value: 3000000 },
        { ...tx.inputs[0], boxId: "51".repeat(32), value: 2000000 },
      ],
      outputs: [
        { ...tx.outputs[0], address: ME, value: 3900000 },
        { ...tx.outputs[1], value: 1100000 },
      ],
    };
    stubFetch(() => [200, { items: [consolidation], total: 1 }]);
    const [row] = (await ergoAdapter.getTransactionHistory(ME)).items;
    expect(row).toMatchObject({ direction: "self", amount: "0.0039", fee: "0.0011" });
  });

  it("404 `Not found Transaction with id` (live) from the mirrors: null; both failing: throws", async () => {
    stubFetch(() => [404, { status: 404, reason: `Not found Transaction with id: ${ID}` }]);
    await expect(ergoAdapter.getTransactionParties!(ID, ME)).resolves.toBeNull();
    stubFetch(() => [503, "unavailable"]);
    await expect(ergoAdapter.getTransactionParties!(ID, ME)).rejects.toThrow(
      /No Ergo explorer could read transaction .*api\.ergoplatform\.com.*\(503\).*api\.sigmaspace\.io.*\(503\)/,
    );
  });
});
