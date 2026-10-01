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
 * These tests pin: `getBalance` throws (never coerces to "0") on a
 * JSON-RPC-shaped error riding a 200 response.
 *
 * History moved to GraphQL on 2026-10-01 (operator request): publicnode's
 * `suix_queryTransactionBlocks` (the `FromAddress` + `ToAddress` pair that
 * replaced the removed compound filter) failed WHOLE for any address with a
 * transaction publicnode has pruned — "unable to derive balance/object
 * changes because effect is empty", live for the public test seed. The
 * history tests below pin the GraphQL read; node layouts are the live
 * answer's, digests and addresses invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_proxy", () => ({
  httpProxyCall: vi.fn(),
}));

import { httpProxyCall } from "./_proxy";
import { suiAdapter } from "./sui-wallet";

const mockProxy = httpProxyCall as unknown as ReturnType<typeof vi.fn>;

const ADDR = "0x" + "ab".repeat(32);

function rpcOk(result: unknown) {
  return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }), headers: [] };
}
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

describe("getBalance", () => {
  it("returns the decimal SUI amount on a real result", async () => {
    mockProxy.mockResolvedValueOnce(rpcOk({ totalBalance: "2400562135516" }));
    const bal = await suiAdapter.getBalance(ADDR);
    expect(bal).toBe("2400.562135516");
  });

  it("throws — never returns '0' — on the deprecated-endpoint error shape (HTTP 200, JSON-RPC error)", async () => {
    // The exact body the real fullnode.mainnet.sui.io returned 2026-08-22.
    mockProxy.mockResolvedValueOnce(
      rpcErr(
        -32601,
        "Method not found. JSON-RPC on public fullnodes has been deprecated. Please migrate to gRPC or GraphQL endpoints."
      )
    );
    await expect(suiAdapter.getBalance(ADDR)).rejects.toThrow(/deprecated/i);
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
  /** One `Address.transactions` node, in the layout the live query returned. */
  const node = (
    digest: string,
    iso: string,
    checkpoint: number,
    changes: Array<[string, string]>,
    over: { status?: string; sender?: string; error?: string; coinType?: string } = {},
  ) => ({
    digest,
    sender: { address: over.sender ?? ADDR },
    effects: {
      status: over.status ?? "SUCCESS",
      timestamp: iso,
      checkpoint: { sequenceNumber: checkpoint },
      executionError: over.error ? { message: over.error } : null,
      balanceChangesJson: changes.map(([address, amount]) => ({ address, coinType: over.coinType ?? SUI, amount })),
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
        // Sent 0.5 SUI: the recipient's rise is the counterparty.
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
