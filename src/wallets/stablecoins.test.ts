import { describe, it, expect } from "vitest";
import {
  STABLECOINS,
  STABLECOIN_NETWORKS,
  groupStablecoins,
  isStablecoinChain,
  stablecoinNetworkFor,
} from "./stablecoins";
import { getAdapter, ALL_CHAINS } from "./index";
import type { ChainType } from "./types";
import { SOURCE_CAPABLE_BLOCKCHAINS } from "../features/swap/intents-source-capability";

/**
 * The registry is the contract between a verified on-chain fact and the
 * balance the user reads. `scripts/verify-stablecoins.mjs` checks the
 * addresses against the chains; these tests check everything that does not
 * need a network.
 */
describe("stablecoin registry", () => {
  it("every leg is a real, registered chain with an adapter", () => {
    for (const n of STABLECOIN_NETWORKS) {
      expect(ALL_CHAINS).toContain(n.chain);
      const a = getAdapter(n.chain);
      expect(a).toBeDefined();
      expect(a.chain).toBe(n.chain);
    }
  });

  it("no contract address is reused across two different symbols", () => {
    // A duplicate here would mean two rows reading the SAME token and the
    // stacked total counting one balance twice.
    const byAddr = new Map<string, string[]>();
    for (const n of STABLECOIN_NETWORKS) {
      const k = `${n.parent}:${n.contract.toLowerCase()}`;
      byAddr.set(k, [...(byAddr.get(k) ?? []), n.symbol]);
    }
    for (const [k, syms] of byAddr) {
      expect(new Set(syms).size, `${k} claimed by ${syms.join(" + ")}`).toBe(1);
    }
  });

  it("decimals are declared per contract, not assumed", () => {
    // BSC's USDC and USDT are 18; everything else verified at 6. A blanket 6
    // would understate a BSC balance by a factor of 10^12.
    const bsc = STABLECOIN_NETWORKS.filter((n) => n.parent === "bsc");
    expect(bsc.length).toBeGreaterThan(0);
    for (const n of bsc) expect(n.decimals).toBe(18);
    for (const n of STABLECOIN_NETWORKS.filter((x) => x.parent !== "bsc")) {
      expect(n.decimals).toBe(6);
    }
  });

  it("classifies leg chains and leaves ordinary chains alone", () => {
    expect(isStablecoinChain("usdc-base")).toBe(true);
    expect(isStablecoinChain("usdt-avax")).toBe(true);
    expect(isStablecoinChain("ethereum")).toBe(false);
    expect(isStablecoinChain("zano")).toBe(false);
    expect(stablecoinNetworkFor("usdc-bsc")?.symbol).toBe("USDC");
    expect(stablecoinNetworkFor("ethereum")).toBeUndefined();
  });

  it("Polygon's old USDT address is filed under USDT0, not USDT", () => {
    // Verified live 2026-09-02: 0xc2132D05… answers symbol() = "USDT0".
    // Filing it under USDT would mislabel the token the user actually holds.
    const row = STABLECOIN_NETWORKS.find(
      (n) => n.contract.toLowerCase() === "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    );
    expect(row?.symbol).toBe("USDT0");
    expect(row?.parent).toBe("polygon");
  });

  it("ships no bridged USDC.e address under the USDC symbol", () => {
    // Both of these answer symbol() = "USDC" while being a DIFFERENT token
    // with its own liquidity — only name() tells them apart. Shipping either
    // would show a balance the user cannot spend as native USDC.
    const bridged = [
      "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // Arbitrum USDC.e
      "0x7f5c764cbc14f9669b88837ca1490cca17c31607", // Optimism USDC.e
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // Polygon USDC.e (PoS)
      "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664", // Avalanche USDC.e
    ];
    const shipped = STABLECOIN_NETWORKS.map((n) => n.contract.toLowerCase());
    for (const b of bridged) expect(shipped).not.toContain(b);
  });
});

describe("groupStablecoins — stacking, and what a missing balance means", () => {
  const bal = (o: Partial<Record<ChainType, string>>) => o;

  it("sums the networks that answered into one family total", () => {
    const g = groupStablecoins(
      bal({ "usdc-eth": "10.5", "usdc-base": "4.5", "usdc-bsc": "0" }),
    ).find((x) => x.symbol === "USDC")!;
    expect(g.total).toBe(15);
    expect(g.rows.find((r) => r.chain === "usdc-eth")!.amount).toBe(10.5);
  });

  it("treats a FAILED network as unknown, not as zero", () => {
    // The distinction is the whole point: summing a failed chain as 0 quietly
    // understates what the user owns, and they have no way to tell.
    const g = groupStablecoins(
      bal({ "usdc-eth": "10", "usdc-base": "—", "usdc-op": "Syncing…" }),
    ).find((x) => x.symbol === "USDC")!;
    expect(g.total).toBe(10);
    expect(g.rows.find((r) => r.chain === "usdc-base")!.amount).toBeNull();
    expect(g.rows.find((r) => r.chain === "usdc-op")!.amount).toBeNull();
  });

  it("total is null — not 0 — when EVERY network failed", () => {
    const g = groupStablecoins(bal({ "usdt-eth": "—" })).find(
      (x) => x.symbol === "USDT",
    )!;
    expect(g.total).toBeNull();
  });

  it("returns a group per family, each with all of its networks", () => {
    const groups = groupStablecoins({});
    expect(groups.map((g) => g.symbol)).toEqual(["USDC", "USDT", "USDT0"]);
    for (const g of groups) {
      const family = STABLECOINS.find((f) => f.symbol === g.symbol)!;
      expect(g.rows).toHaveLength(family.networks.length);
    }
  });

  it("marks only legs the wallet can actually swap via NEAR", () => {
    // A route the wallet cannot sign must not be advertised. Derived from
    // `SOURCE_CAPABLE_BLOCKCHAINS` rather than a hand-copied list — an earlier
    // version of this test hardcoded the chains and went red the moment Solana
    // legs were added, even though Solana has had a source signer all along.
    // A test that has to be edited whenever the truth changes is not testing
    // the truth.
    const toIntents: Partial<Record<ChainType, string>> = {
      ethereum: "eth", arbitrum: "arb", base: "base", optimism: "op",
      polygon: "pol", avalanche: "avax", bsc: "bnb", monad: "monad",
      solana: "sol", tron: "tron", near: "near", stellar: "stellar",
    };
    for (const n of STABLECOIN_NETWORKS) {
      if (!n.nearIntents) continue;
      const id = toIntents[n.parent];
      expect(id, `no Intents id mapped for ${n.parent}`).toBeDefined();
      expect(
        SOURCE_CAPABLE_BLOCKCHAINS.has(id as never),
        `${n.chain} advertises a NEAR route but ${n.parent} has no source signer`,
      ).toBe(true);
    }
  });
});
