/**
 * The swap layer's Sui RPC list names no host that serves no Sui JSON-RPC
 * (operator request, 2026-10-01: stale references to the old JSON-RPC path).
 *
 * `getRpcUrlsForBlockchain("sui")` listed `fullnode.mainnet.sui.io:443` and
 * `sui-mainnet-rpc.nodereal.io`. Checked live on 2026-10-01: the first answers
 * every JSON-RPC method with -32601 "JSON-RPC on public fullnodes has been
 * deprecated", the second no longer resolves. Nothing sends or reads Sui
 * through this list (a SUI deposit is `session-send.ts::executeSuiTransfer`,
 * over Sui's GraphQL), so it is empty, and a meta synthesized for a Sui asset
 * carries no RPC that cannot work.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => null) }));

import { getRpcUrlsForBlockchain, getSwapCoinMeta } from "./swap-data";

describe("Sui in the swap layer's RPC lists", () => {
  it("lists nothing: no dead JSON-RPC host for a Sui asset", () => {
    // Was ["https://fullnode.mainnet.sui.io:443", "https://sui-mainnet-rpc.nodereal.io"].
    expect(getRpcUrlsForBlockchain("sui")).toEqual([]);
    const usdcOnSui = getSwapCoinMeta("USDC", "sui");
    expect(usdcOnSui?.chainKind).toBe("SUI");
    expect(usdcOnSui?.defaultRpcUrl).toBeUndefined();
    expect(usdcOnSui?.rpcFallbacks).toBeUndefined();
  });

  it("native SUI keeps its registry entry, whose RPC is publicnode's, not the retired official host", () => {
    const sui = getSwapCoinMeta("SUI", "sui");
    expect(sui?.defaultRpcUrl).toBe("https://sui-rpc.publicnode.com");
  });
});
