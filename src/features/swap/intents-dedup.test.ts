import { describe, it, expect } from "vitest";
import {
  chainsForSymbol,
  dedupSymbols,
  defaultBlockchainFor,
  isAnyToAnyRoutable,
  isMultiChainSymbol,
  isSourceCapableAsset,
  lookupByAssetId,
  resolveAsset,
  sourceChainsForSymbol,
} from "./intents-dedup";

describe("intents-dedup", () => {
  it("groups multi-chain assets under one symbol", () => {
    const usdcEntries = chainsForSymbol("USDC");
    expect(usdcEntries.length).toBeGreaterThanOrEqual(4);
    expect(new Set(usdcEntries.map((a) => a.blockchain)).size).toBe(usdcEntries.length);
  });

  it("native ETH appears on multiple chains", () => {
    const eth = chainsForSymbol("ETH");
    const chains = eth.map((a) => a.blockchain);
    expect(chains).toContain("eth");
    expect(chains).toContain("arb");
    expect(chains).toContain("base");
  });

  it("native single-chain assets have exactly one entry", () => {
    expect(chainsForSymbol("BTC")).toHaveLength(1);
    expect(chainsForSymbol("NEAR")).toHaveLength(1);
  });

  it("dedupSymbols deduplicates and orders natives first", () => {
    const all = dedupSymbols();
    expect(all).toContain("ETH");
    expect(all).toContain("BTC");
    expect(all).toContain("USDC");
    // No duplicates.
    expect(new Set(all).size).toBe(all.length);
    // Natives ordered first — BTC and ETH appear before USDC.
    const btcIdx = all.indexOf("BTC");
    const ethIdx = all.indexOf("ETH");
    const usdcIdx = all.indexOf("USDC");
    expect(btcIdx).toBeLessThan(usdcIdx);
    expect(ethIdx).toBeLessThan(usdcIdx);
  });

  it("source-only dedupSymbols excludes destination-only chains", () => {
    const sourceOnly = dedupSymbols({ sourceOnly: true });
    // TON is destination-only — its symbol drops out if no source-capable
    // chain has a token with that symbol.
    expect(sourceOnly).not.toContain("TON");
    // ETH is source-capable on multiple chains, so present.
    expect(sourceOnly).toContain("ETH");
  });

  it("isMultiChainSymbol uses Pwnda-aware filter (single L1 per symbol Pwnda surfaces)", () => {
    // After 2026-05-07 dropdown rewrite: both source and destination
    // sides restrict to Pwnda's surfaced chains. For native gas tokens
    // there's exactly one chain (e.g. ETH on Ethereum, BTC on Bitcoin)
    // — so isMultiChainSymbol returns false for everything in Pwnda's
    // visible set. Only true if Pwnda gains support for the same
    // symbol on multiple L1s, which doesn't apply today.
    expect(isMultiChainSymbol("USDC")).toBe(false); // ERC-20: Pwnda doesn't surface
    expect(isMultiChainSymbol("BTC")).toBe(false); // single L1
    expect(isMultiChainSymbol("ETH")).toBe(false); // L1 only after Arbitrum/Base/Op restriction
  });

  it("defaultBlockchainFor returns Pwnda L1 for natives, null for unsurfaced tokens", () => {
    expect(defaultBlockchainFor("BTC")).toBe("btc");
    expect(defaultBlockchainFor("ETH")).toBe("eth");
    expect(defaultBlockchainFor("LTC")).toBe("ltc");
    // USDC isn't in Pwnda's surfaced set (no ERC-20 / SPL token balance
    // feed yet) — `pwndaDestinationChainsForSymbol` returns empty.
    expect(defaultBlockchainFor("USDC")).toBeNull();
    expect(defaultBlockchainFor("NONEXISTENT")).toBeNull();
  });

  it("resolveAsset returns the right entry for (symbol, blockchain)", () => {
    const a = resolveAsset("USDC", "base");
    expect(a).not.toBeNull();
    expect(a!.symbol).toBe("USDC");
    expect(a!.blockchain).toBe("base");
    expect(a!.assetId).toContain("base-");
  });

  it("isSourceCapableAsset gates correctly", () => {
    // ETH on Ethereum: source-capable.
    expect(isSourceCapableAsset("ETH", "eth")).toBe(true);
    // BTC on Bitcoin: source-capable.
    expect(isSourceCapableAsset("BTC", "btc")).toBe(true);
    // TON: not source-capable in v1.x.
    expect(isSourceCapableAsset("TON", "ton")).toBe(false);
  });

  it("isAnyToAnyRoutable: source must be source-capable, dest just exist", () => {
    expect(isAnyToAnyRoutable("ETH", "eth", "BTC", "btc")).toBe(true);
    expect(isAnyToAnyRoutable("BTC", "btc", "ETH", "arb")).toBe(true);
    expect(isAnyToAnyRoutable("ETH", "eth", "TON", "ton")).toBe(true); // dest TON OK
    expect(isAnyToAnyRoutable("TON", "ton", "ETH", "eth")).toBe(false); // source TON not
  });

  it("lookupByAssetId round-trips", () => {
    const all = chainsForSymbol("USDC");
    for (const a of all) {
      expect(lookupByAssetId(a.assetId)).toEqual(a);
    }
  });

  it("sourceChainsForSymbol filters to source-capable", () => {
    const chains = sourceChainsForSymbol("USDC");
    for (const a of chains) {
      expect(isSourceCapableAsset(a.symbol, a.blockchain)).toBe(true);
    }
  });
});
