import { describe, expect, it } from "vitest";
import { CANONICAL_ASSET_ORDER, assetRank } from "./coin-metadata";

/**
 * Regression lock for the 2026-06-21 "Smart" asset ordering. `assetRank`
 * is the shared prominence rank used by both the swap pickers and the
 * portfolio tiebreak, so the two surfaces feel consistent.
 */
describe("assetRank — canonical asset ordering", () => {
  it("leads with BTC, ETH, SOL", () => {
    expect(assetRank("BTC")).toBe(0);
    expect(assetRank("ETH")).toBe(1);
    expect(assetRank("SOL")).toBe(2);
  });

  it("is case-insensitive", () => {
    expect(assetRank("btc")).toBe(0);
    expect(assetRank("Eth")).toBe(assetRank("ETH"));
  });

  it("ranks every native before the stablecoins", () => {
    const stableMin = Math.min(
      assetRank("USDC"),
      assetRank("USDT"),
      assetRank("DAI")
    );
    for (const native of ["BTC", "ETH", "SOL", "ADA", "XMR", "ZEPH"]) {
      expect(assetRank(native)).toBeLessThan(stableMin);
    }
  });

  it("sends unknown tickers to the end", () => {
    expect(assetRank("NOPE")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("has no duplicate entries", () => {
    expect(new Set(CANONICAL_ASSET_ORDER).size).toBe(CANONICAL_ASSET_ORDER.length);
  });
});
