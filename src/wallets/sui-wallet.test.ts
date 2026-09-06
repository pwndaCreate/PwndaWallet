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
 * JSON-RPC-shaped error riding a 200 response, and `getTransactionHistory`
 * queries `FromAddress` + `ToAddress` separately and merges/dedupes by
 * digest rather than using the now-broken compound filter.
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

describe("getTransactionHistory", () => {
  const txA = {
    digest: "digestA",
    timestampMs: "1787428416000",
    checkpoint: "100",
    balanceChanges: [
      { owner: { AddressOwner: ADDR }, coinType: "0x2::sui::SUI", amount: "-2043888" },
    ],
  };
  const txB = {
    digest: "digestB",
    timestampMs: "1787428500000", // newer than txA
    checkpoint: "101",
    balanceChanges: [
      { owner: { AddressOwner: ADDR }, coinType: "0x2::sui::SUI", amount: "5000000" },
    ],
  };
  // Appears in BOTH the FromAddress and ToAddress results — a self-transfer.
  const txSelf = {
    digest: "digestSelf",
    timestampMs: "1787428450000",
    checkpoint: "99",
    balanceChanges: [
      { owner: { AddressOwner: ADDR }, coinType: "0x2::sui::SUI", amount: "-1000" },
    ],
  };

  it("queries FromAddress and ToAddress SEPARATELY — never the removed FromOrToAddress filter", async () => {
    mockProxy.mockResolvedValue(rpcOk({ data: [] }));
    await suiAdapter.getTransactionHistory!(ADDR, { limit: 10 });

    expect(mockProxy).toHaveBeenCalledTimes(2);
    const bodies = mockProxy.mock.calls.map((c) => JSON.parse(c[0].body));
    const filters = bodies.map((b) => b.params[0].filter);
    expect(filters).toContainEqual({ FromAddress: ADDR });
    expect(filters).toContainEqual({ ToAddress: ADDR });
    expect(filters.some((f: object) => "FromOrToAddress" in f)).toBe(false);
  });

  it("merges results from both queries, newest first", async () => {
    mockProxy
      .mockResolvedValueOnce(rpcOk({ data: [txB, txA] })) // FromAddress
      .mockResolvedValueOnce(rpcOk({ data: [] })); // ToAddress
    const { items } = await suiAdapter.getTransactionHistory!(ADDR, { limit: 10 });
    expect(items.map((i) => i.hash)).toEqual(["digestB", "digestA"]);
  });

  it("dedupes a transaction that appears in BOTH results (self-transfer)", async () => {
    mockProxy
      .mockResolvedValueOnce(rpcOk({ data: [txSelf, txA] })) // FromAddress
      .mockResolvedValueOnce(rpcOk({ data: [txSelf, txB] })); // ToAddress
    const { items } = await suiAdapter.getTransactionHistory!(ADDR, { limit: 10 });
    const digests = items.map((i) => i.hash);
    expect(digests.filter((d) => d === "digestSelf")).toHaveLength(1);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("keeps results from the SURVIVING query when the other rejects — partial data beats none", async () => {
    mockProxy
      .mockResolvedValueOnce(rpcOk({ data: [txA] })) // FromAddress succeeds
      .mockResolvedValueOnce({ status: 500, body: "fail", headers: [] }); // ToAddress fails
    const { items } = await suiAdapter.getTransactionHistory!(ADDR, { limit: 10 });
    expect(items.map((i) => i.hash)).toEqual(["digestA"]);
  });

  it("returns an EMPTY (not thrown) result only when BOTH queries fail", async () => {
    mockProxy.mockResolvedValue({ status: 500, body: "fail", headers: [] });
    const { items } = await suiAdapter.getTransactionHistory!(ADDR, { limit: 10 });
    expect(items).toEqual([]);
  });

  it("respects the limit after merging", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      digest: `d${i}`,
      timestampMs: String(1787428000000 + i * 1000),
      checkpoint: String(i),
      balanceChanges: [
        { owner: { AddressOwner: ADDR }, coinType: "0x2::sui::SUI", amount: "100" },
      ],
    }));
    mockProxy
      .mockResolvedValueOnce(rpcOk({ data: many }))
      .mockResolvedValueOnce(rpcOk({ data: [] }));
    const { items } = await suiAdapter.getTransactionHistory!(ADDR, { limit: 3 });
    expect(items).toHaveLength(3);
    // Highest timestamp (d7) first.
    expect(items[0].hash).toBe("d7");
  });
});
