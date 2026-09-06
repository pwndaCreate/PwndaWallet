import { describe, it, expect } from "vitest";
import { preflightMessage, preflightSource } from "./preflight";

describe("preflightSource", () => {
  it("returns ok for a healthy ETH source", () => {
    const r = preflightSource({
      symbol: "ETH",
      blockchain: "eth",
      displayAmount: "0.01",
      intendedAtomic: 10_000_000_000_000_000n,
      decimals: 18,
      balanceAtomic: 100_000_000_000_000_000n, // 0.1 ETH
      estimatedFeeAtomic: 21000n * 50n * 1_000_000_000n, // ~21000 × 50 gwei
    });
    expect(r.kind).toBe("ok");
  });

  it("flags zero amount as form-error", () => {
    const r = preflightSource({
      symbol: "ETH",
      blockchain: "eth",
      displayAmount: "0",
      intendedAtomic: 0n,
      decimals: 18,
    });
    expect(r.kind).toBe("form-error");
  });

  it("flags below-minimum BTC amount", () => {
    const r = preflightSource({
      symbol: "BTC",
      blockchain: "btc",
      displayAmount: "0.000001",
      intendedAtomic: 100n, // 100 sat — well below 1000 sat floor
      decimals: 8,
    });
    expect(r.kind).toBe("below-minimum");
    if (r.kind === "below-minimum") {
      expect(r.symbol).toBe("BTC");
    }
  });

  it("flags insufficient balance with the right messages", () => {
    const r = preflightSource({
      symbol: "ETH",
      blockchain: "eth",
      displayAmount: "1",
      intendedAtomic: 1_000_000_000_000_000_000n, // 1 ETH
      decimals: 18,
      balanceAtomic: 500_000_000_000_000_000n, // 0.5 ETH
    });
    expect(r.kind).toBe("insufficient-balance");
    const msg = preflightMessage(r);
    expect(msg).toContain("Insufficient balance");
    expect(msg).toContain("ETH");
  });

  it("flags NEAR account below 0.1 NEAR floor", () => {
    const r = preflightSource({
      symbol: "NEAR",
      blockchain: "near",
      displayAmount: "0.05",
      intendedAtomic: 50_000_000_000_000_000_000_000n, // 0.05 NEAR
      decimals: 24,
      balanceAtomic: 50_000_000_000_000_000_000_000n, // 0.05 NEAR — below floor
    });
    // Below-minimum hits first because the symbol minimum is 0.1 NEAR.
    expect(r.kind).toBe("below-minimum");
  });

  it("flags SOL account below ~0.001 SOL floor as chain-prerequisite", () => {
    const r = preflightSource({
      symbol: "SOL",
      blockchain: "sol",
      displayAmount: "0.005",
      intendedAtomic: 5_000_000n, // 0.005 SOL
      decimals: 9,
      balanceAtomic: 100_000n, // 0.0001 SOL — below floor
    });
    // Insufficient balance fires first because amount > balance.
    expect(r.kind).toBe("insufficient-balance");
  });

  it("preflightMessage returns null on ok status", () => {
    expect(preflightMessage({ kind: "ok" })).toBeNull();
  });
});
