import { describe, expect, it } from "vitest";
import { CANONICAL_ASSET_ORDER, assetRank } from "./coin-metadata";

/**
 * Regression lock for the 2026-06-21 "Smart" asset ordering. `assetRank`
 * is the shared prominence rank used by both the swap pickers and the
 * portfolio tiebreak, so the two surfaces feel consistent.
 */
describe("assetRank — canonical asset ordering", () => {
  it("leads with BTC, ETH, then USDT by market cap", () => {
    expect(assetRank("BTC")).toBe(0);
    expect(assetRank("ETH")).toBe(1);
    // Since 2026-09-29 (see the next test): USDT is third, not last.
    expect(assetRank("USDT")).toBe(2);
    expect(assetRank("SOL")).toBe(3);
  });

  it("is case-insensitive", () => {
    expect(assetRank("btc")).toBe(0);
    expect(assetRank("Eth")).toBe(assetRank("ETH"));
  });

  it("ranks USDT and USDC among the majors, where a user looks for them", () => {
    // Until 2026-09-29 this asserted the opposite: every native before any
    // stablecoin. That put USDC and USDT at the foot of an 18-row swap picker
    // and at the foot of the asset list, and the operator reported them
    // missing from both. They now rank by market cap, like everything else.
    expect(assetRank("USDT")).toBeLessThan(assetRank("SOL"));
    expect(assetRank("USDC")).toBeLessThan(assetRank("ADA"));
    for (const later of ["ADA", "XMR", "ZEPH"]) {
      expect(assetRank(later)).toBeGreaterThan(assetRank("USDC"));
    }
    // Legs rank as their symbol: USD₮0 on Arbitrum sorts with USDT.
    expect(assetRank("USDT0-ARB")).toBe(assetRank("USDT"));
  });

  it("sends unknown tickers to the end", () => {
    expect(assetRank("NOPE")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("has no duplicate entries", () => {
    expect(new Set(CANONICAL_ASSET_ORDER).size).toBe(CANONICAL_ASSET_ORDER.length);
  });
});
