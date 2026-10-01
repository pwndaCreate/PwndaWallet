/**
 * Regression lock for the 2026-08-22 "Sui not loaded" bug.
 *
 * Root cause, two layers:
 *  1. The adapter's sole RPC host, `fullnode.mainnet.sui.io`, had its
 *     JSON-RPC surface deprecated upstream — every `suix_*` method now
 *     returns `-32601 Method not found` inside an HTTP 200 body. No
 *     fallback existed, so every dashboard read failed on every session.
 *  2. `getTransactionHistory`'s `FromOrToAddress` filter was independently
 *     removed from the supported filter set (`-32602 Feature is not
 *     supported`), even on providers that still serve the method — so
 *     simply swapping the host would not have been enough on its own.
 *
 * These tests pin: `getBalance` throws (never coerces to "0") on an error
 * riding a 200 response.
 *
 * History moved to GraphQL on 2026-10-01 (operator request): publicnode's
 * `suix_queryTransactionBlocks` (the `FromAddress` + `ToAddress` pair that
 * replaced the removed compound filter) failed WHOLE for any address with a
 * transaction publicnode has pruned — "unable to derive balance/object
 * changes because effect is empty", live for the public test seed. The
 * history tests below pin the GraphQL read; node layouts are the live
 * answer's, digests and addresses invented.
 *
 * Later on 2026-10-01 (operator request: Sui ends JSON-RPC on full nodes in
 * mid-October) the balance moved to GraphQL as well, and the send's chain
 * calls became functions here (`readSuiSendState` and the rest, last block
 * below). Their answers keep the live layouts of that day, read for the
 * public test seed; `features/swap/suiSend.test.ts` drives them through a
 * whole send.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_proxy", () => ({
  httpProxyCall: vi.fn(),
}));

import { httpProxyCall } from "./_proxy";
import {
  SUI_GAS_PAYMENT_MAX,
  executeSuiTransaction,
  readSuiSendState,
  simulateSuiGas,
  suiAdapter,
  suiGasBudget,
  suiGasPayment,
  suiTransactionStatus,
  type SuiCoinRef,
} from "./sui-wallet";

const mockProxy = httpProxyCall as unknown as ReturnType<typeof vi.fn>;

const ADDR = "0x" + "ab".repeat(32);

function rpcErr(code: number, message: string) {
  return {
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }),
    headers: [],
  };
}

beforeEach(() => {
  mockProxy.mockReset();
});

/** A GraphQL answer, as the proxy returns it. */
function gql(data: unknown) {
  return { status: 200, body: JSON.stringify({ data }), headers: [] };
}
/** The request a proxied call carried. */
const sent = (i = 0) => {
  const call = mockProxy.mock.calls[i][0];
  return { url: call.url as string, ...(JSON.parse(call.body) as { query: string; variables: any }) };
};

describe("getBalance (GraphQL since 2026-10-01)", () => {
  it("returns the decimal SUI amount, the total of coins and address balance", async () => {
    mockProxy.mockResolvedValueOnce(gql({ address: { balance: { totalBalance: "2400562135516" } } }));
    const bal = await suiAdapter.getBalance(` ${ADDR} `);
    expect(bal).toBe("2400.562135516");
    const req = sent();
    // Not publicnode's suix_getBalance, which Sui is decommissioning.
    expect(req.url).toBe("https://graphql.mainnet.sui.io/graphql");
    expect(req.query).toContain('balance(coinType: "0x2::sui::SUI") { totalBalance }');
    expect(req.variables).toEqual({ address: ADDR });
  });

  it("an unused address is a real zero (the public test seed, live 2026-10-01)", async () => {
    mockProxy.mockResolvedValueOnce(
      gql({ address: { balance: { totalBalance: "0" } } }),
    );
    await expect(suiAdapter.getBalance(ADDR)).resolves.toBe("0.000000000");
  });

  it("throws — never returns '0' — on an error riding HTTP 200", async () => {
    mockProxy.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ data: null, errors: [{ message: 'Failed to parse "SuiAddress"' }] }),
      headers: [],
    });
    await expect(suiAdapter.getBalance(ADDR)).rejects.toThrow(/Failed to parse "SuiAddress"/);
    // The body the retired fullnode.mainnet.sui.io JSON-RPC returned
    // (2026-08-22): JSON with no `data` is no balance.
    mockProxy.mockResolvedValueOnce(
      rpcErr(
        -32601,
        "Method not found. JSON-RPC on public fullnodes has been deprecated. Please migrate to gRPC or GraphQL endpoints."
      )
    );
    await expect(suiAdapter.getBalance(ADDR)).rejects.toThrow(/200 but no data/);
    // An answer without the field.
    mockProxy.mockResolvedValueOnce(gql({ address: { balance: null } }));
    await expect(suiAdapter.getBalance(ADDR)).rejects.toThrow(/no balance for this address/);
  });

  it("throws on an HTTP-level failure too", async () => {
    mockProxy.mockResolvedValueOnce({ status: 503, body: "upstream down", headers: [] });
    await expect(suiAdapter.getBalance(ADDR)).rejects.toThrow(/503/);
  });
});

describe("getTransactionHistory (GraphQL, 2026-10-01)", () => {
  const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  const OTHER = "0x" + "cd".repeat(32);
  const SPONSOR = "0x" + "ef".repeat(32);
  /**
   * One `Address.transactions` node, in the layout the live query returned.
   * `gasOwner` and `gas` (computation, storage, rebate) add the gas fields
   * the query asks since 2026-10-01, in their live layout: `gasInput.
   * gasSponsor.address`, and `gasEffects.gasSummary` with numbers.
   */
  const node = (
    digest: string,
    iso: string,
    checkpoint: number,
    changes: Array<[string, string]>,
    over: {
      status?: string;
      sender?: string;
      error?: string;
      coinType?: string;
      gasOwner?: string;
      gas?: [number, number, number];
    } = {},
  ) => ({
    digest,
    sender: { address: over.sender ?? ADDR },
    ...(over.gasOwner ? { gasInput: { gasSponsor: { address: over.gasOwner } } } : {}),
    effects: {
      status: over.status ?? "SUCCESS",
      timestamp: iso,
      checkpoint: { sequenceNumber: checkpoint },
      executionError: over.error ? { message: over.error } : null,
      balanceChangesJson: changes.map(([address, amount]) => ({ address, coinType: over.coinType ?? SUI, amount })),
      ...(over.gas
        ? {
            gasEffects: {
              gasSummary: { computationCost: over.gas[0], storageCost: over.gas[1], storageRebate: over.gas[2] },
            },
          }
        : {}),
    },
  });
  const gqlPage = (nodes: unknown[], pageInfo: Record<string, unknown> = { hasPreviousPage: false, startCursor: "c0" }) => ({
    status: 200,
    body: JSON.stringify({ data: { address: { transactions: { pageInfo, nodes } } } }),
    headers: [],
  });

  it("asks GraphQL ONCE, for what the address sent AND received — `relation: AFFECTED`", async () => {
    mockProxy.mockResolvedValue(gqlPage([]));
    await suiAdapter.getTransactionHistory!(ADDR, { limit: 10 });
    expect(mockProxy).toHaveBeenCalledTimes(1);
    const call = mockProxy.mock.calls[0][0];
    expect(call.url).toBe("https://graphql.mainnet.sui.io/graphql");
    const body = JSON.parse(call.body);
    // The field defaults to SENT, which would drop every receipt.
    expect(body.query).toMatch(/transactions\(last: \$last, before: \$before, relation: AFFECTED\)/);
    expect(body.variables).toEqual({ address: ADDR, last: 10, before: null });
    expect(call.body).not.toContain("suix_queryTransactionBlocks");
  });

  it("the page comes oldest first; the history is newest first, with a cursor for older pages", async () => {
    mockProxy.mockResolvedValue(
      gqlPage(
        [
          node("DigestOld", "2026-05-10T14:04:09.471Z", 274168221, [[ADDR, "100000000"], [OTHER, "-101097880"]]),
          node("DigestNew", "2026-05-11T03:45:28.118Z", 274364064, [[OTHER, "499880120"], [ADDR, "-500000000"]]),
        ],
        { hasPreviousPage: true, startCursor: "KAE6CwiNguh1ELeGqYUS" },
      ),
    );
    const page = await suiAdapter.getTransactionHistory!(ADDR, { limit: 2 });
    expect(page.items.map((i) => i.hash)).toEqual(["DigestNew", "DigestOld"]);
    expect(page.cursor).toBe("KAE6CwiNguh1ELeGqYUS");
    await suiAdapter.getTransactionHistory!(ADDR, { limit: 2, cursor: page.cursor });
    expect(JSON.parse(mockProxy.mock.calls[1][0].body).variables.before).toBe("KAE6CwiNguh1ELeGqYUS");
  });

  it("asks for at most 50 per page — the service refuses 51 (live: `Page size is too large: 51 > 50`)", async () => {
    mockProxy.mockResolvedValue(gqlPage([]));
    await suiAdapter.getTransactionHistory!(ADDR, { limit: 200 });
    expect(JSON.parse(mockProxy.mock.calls[0][0].body).variables.last).toBe(50);
  });

  it("THROWS when GraphQL fails — a failed read is not an empty history", async () => {
    mockProxy.mockResolvedValue({ status: 500, body: "fail", headers: [] });
    await expect(suiAdapter.getTransactionHistory!(ADDR, { limit: 10 })).rejects.toThrow(
      /Sui history could not be read: Sui GraphQL failed .*HTTP 500/,
    );
    // GraphQL errors ride a 200 body.
    mockProxy.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ data: null, errors: [{ message: 'Failed to parse "SuiAddress"' }] }),
      headers: [],
    });
    await expect(suiAdapter.getTransactionHistory!(ADDR)).rejects.toThrow(/Failed to parse "SuiAddress"/);
  });

  it("a send, a receipt and another coin's transfer read as the JSON-RPC rows did", async () => {
    mockProxy.mockResolvedValue(
      gqlPage([
        // Received 0.1 SUI; the sender paid its own gas.
        node("DigestIn", "2026-05-10T14:04:09.471Z", 274168221, [[OTHER, "-101097880"], [ADDR, "100000000"]], { sender: OTHER }),
        // Sent 0.5 SUI: the recipient's rise is the counterparty. No gas
        // fields in this node, so the whole change stays the amount (the gas
        // is left out only when the answer says who paid it, below).
        node("DigestOut", "2026-05-11T03:45:28.118Z", 274364064, [[OTHER, "499880120"], [ADDR, "-500000000"]]),
        // Only another coin reached this address: a 0-SUI receipt, as before.
        node("DigestCoin", "2026-05-12T00:00:00.000Z", 274400000, [[ADDR, "2000000000"]], {
          sender: OTHER,
          coinType: "0x" + "77".repeat(32) + "::ocean::OCEAN",
        }),
      ]),
    );
    const { items } = await suiAdapter.getTransactionHistory!(ADDR);
    const byHash = Object.fromEntries(items.map((i) => [i.hash, i]));
    expect(byHash.DigestOut).toMatchObject({
      direction: "out",
      amount: "0.500000000",
      counterparty: OTHER,
      meta: { from: ADDR, to: OTHER },
      height: 274364064,
      timestamp: Math.floor(Date.parse("2026-05-11T03:45:28.118Z") / 1000),
    });
    expect(byHash.DigestOut.confirmations).toBeUndefined();
    expect(byHash.DigestIn).toMatchObject({ direction: "in", amount: "0.100000000", counterparty: OTHER, meta: { from: OTHER, to: ADDR } });
    expect(byHash.DigestCoin).toMatchObject({ direction: "in", amount: "0.000000000" });
  });

  it("a FAILURE is `failed`: nothing moved, the gas it paid is its fee, the reason kept", async () => {
    mockProxy.mockResolvedValue(
      gqlPage([
        node("DigestFailed", "2026-02-20T22:24:42.352Z", 247072812, [[ADDR, "-572208"]], {
          status: "FAILURE",
          error: "Error in 1st command, Move Bytecode Verification Error. Please run the Bytecode Verifier for more information.",
        }),
      ]),
    );
    const [row] = (await suiAdapter.getTransactionHistory!(ADDR)).items;
    expect(row).toMatchObject({
      direction: "failed",
      amount: "0.000000000",
      fee: "0.000572208",
      meta: { intended: "out", failure: expect.stringMatching(/^Error in 1st command, Move Bytecode Verification Error/) },
    });
  });

  it("a sponsored receipt names its sender, even when the sponsor's gas exceeds the amount", async () => {
    // The live 2026-02-21 layout (DUEbvzBu…, from the other side): 863,032
    // MIST moved, the sponsor paid 1,032,832 MIST of gas. Read as "the
    // largest SUI faller", as the JSON-RPC rows did, the sender was the sponsor.
    mockProxy.mockResolvedValue(
      gqlPage([
        node(
          "DigestSponsored",
          "2026-02-21T03:56:28.363Z",
          247150984,
          [[ADDR, "863032"], [OTHER, "-863032"], [SPONSOR, "-1032832"]],
          { sender: OTHER },
        ),
      ]),
    );
    const [row] = (await suiAdapter.getTransactionHistory!(ADDR)).items;
    expect(row).toMatchObject({ direction: "in", amount: "0.000863032", counterparty: OTHER, meta: { from: OTHER, to: ADDR } });
  });

  it("asks for the gas owner and the gas, so a send's amount can leave its gas out", async () => {
    mockProxy.mockResolvedValue(gqlPage([]));
    await suiAdapter.getTransactionHistory!(ADDR);
    const { query } = JSON.parse(mockProxy.mock.calls[0][0].body);
    expect(query).toContain("gasInput { gasSponsor { address } }");
    expect(query).toContain("gasEffects { gasSummary { computationCost storageCost storageRebate } }");
  });

  it("a send this address paid the gas for: the amount leaves the gas out and `fee` holds it", async () => {
    // The test seed's send of 2026-05-11 (6pAfmULA…), the live layout: 0.5 SUI
    // left the address, the recipient got 0.49988012, the gas was 110,000
    // computation + 988,000 storage − 978,120 rebate = 119,880 MIST.
    mockProxy.mockResolvedValue(
      gqlPage([
        node("DigestOut", "2026-05-11T03:45:28.118Z", 274364064, [[OTHER, "499880120"], [ADDR, "-500000000"]], {
          gasOwner: ADDR,
          gas: [110000, 988000, 978120],
        }),
      ]),
    );
    const [row] = (await suiAdapter.getTransactionHistory!(ADDR)).items;
    // Was "0.500000000", no fee.
    expect(row).toMatchObject({
      direction: "out",
      amount: "0.499880120",
      fee: "0.000119880",
      counterparty: OTHER,
      meta: { from: ADDR, to: OTHER },
    });
  });

  it("a sponsored send keeps its whole change and no fee: the gas was the sponsor's", async () => {
    // The test seed's 4RUbkLxb… (2025-07-04), the live layout: the sponsor's
    // SUI paid the gas, the address's change is exactly what it sent.
    mockProxy.mockResolvedValue(
      gqlPage([
        node(
          "DigestSponsoredOut",
          "2025-07-04T13:49:03.071Z",
          163910339,
          [[SPONSOR, "-1041640"], [OTHER, "10000000"], [ADDR, "-10000000"]],
          { gasOwner: SPONSOR, gas: [2000000, 1976000, 2934360] },
        ),
      ]),
    );
    const [row] = (await suiAdapter.getTransactionHistory!(ADDR)).items;
    expect(row).toMatchObject({ direction: "out", amount: "0.010000000", counterparty: OTHER });
    expect(row.fee).toBeUndefined();
  });

  it("a send that moved only gas reads 0 with its fee; a loss smaller than the gas, or a rebate, stays whole", async () => {
    mockProxy.mockResolvedValue(
      gqlPage([
        // Paid only the gas (a call that moved no SUI of its own).
        node("DigestGasOnly", "2026-05-12T00:00:00.000Z", 274400001, [[ADDR, "-119880"]], {
          gasOwner: ADDR,
          gas: [110000, 988000, 978120],
        }),
        // Paid 119,880 of gas and got 69,880 back from the call: a net loss
        // smaller than the gas. Whose share was whose is not in the answer.
        node("DigestOffset", "2026-05-12T00:00:01.000Z", 274400002, [[ADDR, "-50000"], [OTHER, "50000"]], {
          gasOwner: ADDR,
          gas: [110000, 988000, 978120],
        }),
        // The test seed's G2ukojQB… (2025-01-22): freed storage, a net rebate.
        node("DigestRebate", "2025-01-22T21:23:51.967Z", 104434360, [[ADDR, "3078120"]], {
          gasOwner: ADDR,
          gas: [750000, 14455200, 18283320],
        }),
      ]),
    );
    const byHash = Object.fromEntries((await suiAdapter.getTransactionHistory!(ADDR)).items.map((r) => [r.hash, r]));
    expect(byHash.DigestGasOnly).toMatchObject({ direction: "out", amount: "0.000000000", fee: "0.000119880" });
    expect(byHash.DigestOffset).toMatchObject({ direction: "out", amount: "0.000050000" });
    expect(byHash.DigestOffset.fee).toBeUndefined();
    expect(byHash.DigestRebate).toMatchObject({ direction: "in", amount: "0.003078120" });
    expect(byHash.DigestRebate.fee).toBeUndefined();
  });

  it("a transaction that changed no balance is left out; one whose changes are missing reads amount unknown", async () => {
    const quiet = node("DigestQuiet", "2026-01-01T00:00:00.000Z", 1, []);
    const missing = { ...node("DigestMissing", "2026-01-02T00:00:00.000Z", 2, []), effects: { status: "SUCCESS", timestamp: "2026-01-02T00:00:00.000Z", checkpoint: { sequenceNumber: 2 } } };
    mockProxy.mockResolvedValue(gqlPage([quiet, missing]));
    const { items } = await suiAdapter.getTransactionHistory!(ADDR);
    expect(items.map((i) => i.hash)).toEqual(["DigestMissing"]);
    expect(items[0]).toMatchObject({ direction: "out", amount: "" });
  });

  it("an address publicnode cannot list (its live `effect is empty` answer) now reads", async () => {
    // Was: both JSON-RPC queries got this answer and the history threw
    // "Sui history could not be read: Sui RPC suix_queryTransactionBlocks:
    // ErrorObject { … effect is empty … }" — the public test seed, live on
    // 2026-09-30 and 2026-10-01.
    mockProxy.mockImplementation(async ({ url }: { url: string }) =>
      url.includes("graphql")
        ? gqlPage([node("DigestOk", "2026-05-11T03:45:28.118Z", 274364064, [[OTHER, "499880120"], [ADDR, "-500000000"]])])
        : rpcErr(
            -32000,
            'ErrorObject { code: InvalidParams, message: "unable to derive balance/object changes because effect is empty", data: None }',
          ),
    );
    const { items } = await suiAdapter.getTransactionHistory!(ADDR);
    expect(items.map((i) => i.hash)).toEqual(["DigestOk"]);
  });
});

describe("the send's chain calls over GraphQL (operator request, 2026-10-01)", () => {
  /**
   * The public test seed's coin 0xb3103ee5… as it stood before its send of
   * 2026-05-11, in the live `MoveObject` layout (read through that send's
   * `objectChanges.inputState` on 2026-10-01: `version` a number, `digest`
   * base58, `contents.json` `{ id, balance }` with the balance a string).
   */
  const SEED_COIN_NODE = {
    address: "0xb3103ee56b3e0aea3c3db9403e3f062f513026bc8bf3fac53c783ea571a3ef15",
    version: 872783653,
    digest: "4ZAVLMEE62Aa8gm41JKUfzSQW4wdp5T62vDkdYgN1g4U",
    contents: {
      json: { id: "0xb3103ee56b3e0aea3c3db9403e3f062f513026bc8bf3fac53c783ea571a3ef15", balance: "500000000" },
    },
  };
  const state = (over: Record<string, unknown> = {}) =>
    gql({
      epoch: { referenceGasPrice: "100" },
      address: {
        balance: { coinBalance: "500000000", addressBalance: "0" },
        objects: { nodes: [SEED_COIN_NODE] },
      },
      ...over,
    });

  it("readSuiSendState: the gas price, both halves of the balance and a page of coins, in one request", async () => {
    mockProxy.mockResolvedValueOnce(state());
    const s = await readSuiSendState(ADDR);
    expect(s).toEqual({
      referenceGasPrice: 100n,
      coinBalance: 500000000n,
      addressBalance: 0n,
      coins: [
        {
          objectId: SEED_COIN_NODE.address,
          version: "872783653",
          digest: SEED_COIN_NODE.digest,
          balance: 500000000n,
        },
      ],
    });
    expect(mockProxy).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.url).toBe("https://graphql.mainnet.sui.io/graphql");
    expect(req.query).toContain(
      `objects(first: ${SUI_GAS_PAYMENT_MAX}, filter: { type: "0x2::coin::Coin<0x2::sui::SUI>" })`,
    );
    expect(req.query).toContain('balance(coinType: "0x2::sui::SUI") { coinBalance addressBalance }');
    expect(req.variables).toEqual({ address: ADDR });
  });

  it("readSuiSendState: an address with no coins answers an empty list (the test seed, live)", async () => {
    mockProxy.mockResolvedValueOnce(
      state({ address: { balance: { coinBalance: "0", addressBalance: "0" }, objects: { nodes: [] } } }),
    );
    await expect(readSuiSendState(ADDR)).resolves.toMatchObject({ coins: [], coinBalance: 0n });
  });

  it("readSuiSendState throws on a coin it cannot read, and on a missing part — never a partial answer", async () => {
    const bad = { ...SEED_COIN_NODE, digest: null };
    mockProxy.mockResolvedValueOnce(
      state({ address: { balance: { coinBalance: "1", addressBalance: "0" }, objects: { nodes: [bad] } } }),
    );
    await expect(readSuiSendState(ADDR)).rejects.toThrow(/a coin this wallet cannot read/);
    mockProxy.mockResolvedValueOnce(state({ epoch: null }));
    await expect(readSuiSendState(ADDR)).rejects.toThrow(/no reference gas price/);
    mockProxy.mockResolvedValueOnce(state({ address: null }));
    await expect(readSuiSendState(ADDR)).rejects.toThrow(/no balance or coin list/);
    const noBalance = { ...SEED_COIN_NODE, contents: { json: { id: SEED_COIN_NODE.address } } };
    mockProxy.mockResolvedValueOnce(
      state({ address: { balance: { coinBalance: "1", addressBalance: "0" }, objects: { nodes: [noBalance] } } }),
    );
    await expect(readSuiSendState(ADDR)).rejects.toThrow(/no coin balance/);
  });

  it("suiGasPayment: largest first, ties by object id, at most one page of 50", () => {
    const coin = (i: number, balance: bigint): SuiCoinRef => ({
      objectId: "0x" + i.toString(16).padStart(64, "0"),
      version: "1",
      digest: "4ZAVLMEE62Aa8gm41JKUfzSQW4wdp5T62vDkdYgN1g4U",
      balance,
    });
    const coins = Array.from({ length: 60 }, (_, i) => coin(i, BigInt(i % 7)));
    const out = suiGasPayment(coins);
    expect(out).toHaveLength(50);
    for (let i = 1; i < out.length; i++) {
      const [a, b] = [out[i - 1], out[i]];
      expect(a.balance > b.balance || (a.balance === b.balance && a.objectId < b.objectId)).toBe(true);
    }
    // The ten left out are the smallest.
    expect(out.at(-1)!.balance).toBe(1n);
    expect(coins).toHaveLength(60); // not sorted in place
  });

  it("suiGasBudget: the JSON-RPC resolver's formula, both branches", () => {
    // computation + 1,000 x price + storage - rebate ...
    expect(
      suiGasBudget(100n, { computationCost: 100000n, storageCost: 1976000n, storageRebate: 0n }),
    ).toBe(2176000n);
    // ... never less than computation + 1,000 x price (a rebate larger than the storage).
    expect(
      suiGasBudget(110n, { computationCost: 110000n, storageCost: 988000n, storageRebate: 978120n }),
    ).toBe(229880n);
    expect(
      suiGasBudget(100n, { computationCost: 750000n, storageCost: 988000n, storageRebate: 1978120n }),
    ).toBe(850000n);
  });

  it("simulateSuiGas: the bytes go as BCS; the live answer's gas comes back", async () => {
    // The live answer for an unsigned transfer from the test seed, 2026-10-01.
    mockProxy.mockResolvedValueOnce(
      gql({
        simulateTransaction: {
          effects: {
            status: "SUCCESS",
            executionError: null,
            gasEffects: {
              gasObject: {
                address: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                version: 2,
                digest: "DUV9vWYeJp8hVGGiswV8patPLWow95bVpj5GmEvYZwNv",
              },
              gasSummary: { computationCost: 100000, storageCost: 1976000, storageRebate: 0, nonRefundableStorageFee: 0 },
            },
          },
        },
      }),
    );
    await expect(simulateSuiGas(new Uint8Array([1, 2, 3]))).resolves.toEqual({
      computationCost: 100000n,
      storageCost: 1976000n,
      storageRebate: 0n,
    });
    expect(sent().query).toContain("simulateTransaction(transaction: $tx)");
    expect(sent().variables).toEqual({ tx: { bcs: { value: "AQID" } } });
  });

  it("simulateSuiGas: a failed dry run throws the resolver's words", async () => {
    mockProxy.mockResolvedValueOnce(
      gql({
        simulateTransaction: {
          effects: { status: "FAILURE", executionError: { message: "InsufficientCoinBalance in command 0" }, gasEffects: null },
        },
      }),
    );
    await expect(simulateSuiGas(new Uint8Array([1]))).rejects.toThrow(
      "Dry run failed, could not automatically determine a budget: InsufficientCoinBalance in command 0",
    );
    mockProxy.mockResolvedValueOnce(gql({ simulateTransaction: { effects: null } }));
    await expect(simulateSuiGas(new Uint8Array([1]))).rejects.toThrow(/returned no result/);
  });

  it("executeSuiTransaction: the signed bytes and the one signature; the outcome read back", async () => {
    mockProxy.mockResolvedValueOnce(
      gql({ executeTransaction: { effects: { digest: "Dig1", status: "SUCCESS", executionError: null } } }),
    );
    await expect(executeSuiTransaction("AQID", "SIG")).resolves.toEqual({ digest: "Dig1", status: "SUCCESS" });
    expect(sent().query).toContain("executeTransaction(transactionDataBcs: $tx, signatures: $signatures)");
    expect(sent().variables).toEqual({ tx: "AQID", signatures: ["SIG"] });
    mockProxy.mockResolvedValueOnce(
      gql({ executeTransaction: { effects: { digest: "Dig2", status: "FAILURE", executionError: { message: "MoveAbort" } } } }),
    );
    await expect(executeSuiTransaction("AQID", "SIG")).resolves.toEqual({
      digest: "Dig2",
      status: "FAILURE",
      error: "MoveAbort",
    });
    // A transport failure throws: the caller settles it by digest.
    mockProxy.mockRejectedValueOnce(new Error("http request failed: timed out"));
    await expect(executeSuiTransaction("AQID", "SIG")).rejects.toThrow(/timed out/);
  });

  it("suiTransactionStatus: null while GraphQL does not have it, else its outcome", async () => {
    mockProxy.mockResolvedValueOnce(gql({ transactionEffects: null }));
    await expect(suiTransactionStatus("Dig")).resolves.toBeNull();
    expect(sent().variables).toEqual({ digest: "Dig" });
    mockProxy.mockResolvedValueOnce(gql({ transactionEffects: { status: "SUCCESS", executionError: null } }));
    await expect(suiTransactionStatus("Dig")).resolves.toEqual({ status: "SUCCESS" });
    mockProxy.mockResolvedValueOnce(
      gql({ transactionEffects: { status: "FAILURE", executionError: { message: "InsufficientGas" } } }),
    );
    await expect(suiTransactionStatus("Dig")).resolves.toEqual({ status: "FAILURE", error: "InsufficientGas" });
  });
});
