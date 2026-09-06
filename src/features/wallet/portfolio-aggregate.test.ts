import { describe, it, expect } from "vitest";
import { aggregatePortfolio, type Holding } from "./portfolio-aggregate";
import type { ChainType } from "../../wallets";

/**
 * Phase 4 lock for the unified-portfolio aggregation. The grand total must
 * dedupe by (chain, address) and per-wallet subtotals must add up, so the
 * "All Wallets" view can never double-count or misattribute value.
 */

// Simple injected USD: $2000/ETH, $30000/BTC, price by chain, balance parsed as float.
const PRICE: Partial<Record<ChainType, number>> = {
  ethereum: 2000,
  bitcoin: 30000,
  solana: 150,
};
const usdFor = (chain: ChainType, balance: string | undefined): number | null => {
  const p = PRICE[chain];
  if (p == null || balance == null) return null;
  const n = parseFloat(balance);
  if (Number.isNaN(n)) return null;
  return n * p;
};

const h = (
  walletId: string,
  walletName: string,
  chain: ChainType,
  address: string,
  balance: string | undefined
): Holding => ({ walletId, walletName, chain, address, balance });

describe("aggregatePortfolio", () => {
  it("sums USD across wallets and chains", () => {
    const agg = aggregatePortfolio(
      [
        h("w1", "Main", "ethereum", "0xAAA", "1"), // $2000
        h("w1", "Main", "bitcoin", "bc1a", "0.1"), // $3000
        h("w2", "Trading", "ethereum", "0xBBB", "2"), // $4000
      ],
      usdFor
    );
    expect(agg.grandTotalUsd).toBe(9000);
    expect(agg.rows).toHaveLength(3);
  });

  it("dedupes by (chain,address) so a shared address counts once", () => {
    const agg = aggregatePortfolio(
      [
        h("w1", "Main", "ethereum", "0xSAME", "1"), // $2000
        h("w2", "Trading", "ethereum", "0xSAME", "1"), // duplicate → skipped
      ],
      usdFor
    );
    expect(agg.grandTotalUsd).toBe(2000);
    expect(agg.rows).toHaveLength(1);
  });

  it("computes per-wallet subtotals that add to the grand total", () => {
    const agg = aggregatePortfolio(
      [
        h("w1", "Main", "ethereum", "0xA", "1"), // $2000
        h("w1", "Main", "solana", "solA", "10"), // $1500
        h("w2", "Trading", "bitcoin", "bcB", "0.5"), // $15000
      ],
      usdFor
    );
    const main = agg.perWallet.find((w) => w.walletId === "w1")!;
    const trading = agg.perWallet.find((w) => w.walletId === "w2")!;
    expect(main.usd).toBe(3500);
    expect(trading.usd).toBe(15000);
    expect(main.usd + trading.usd).toBe(agg.grandTotalUsd);
  });

  it("marks a chain as multi-wallet when >1 wallet holds it (different addresses)", () => {
    const agg = aggregatePortfolio(
      [
        h("w1", "Main", "ethereum", "0xA", "1"),
        h("w2", "Trading", "ethereum", "0xB", "1"), // same chain, different address
        h("w1", "Main", "bitcoin", "bcA", "1"), // only w1
      ],
      usdFor
    );
    expect(agg.multiWalletChains.has("ethereum")).toBe(true);
    expect(agg.multiWalletChains.has("bitcoin")).toBe(false);
  });

  it("rows with unknown price/balance get usd=null and don't affect the total", () => {
    const agg = aggregatePortfolio(
      [
        h("w1", "Main", "ethereum", "0xA", "1"), // $2000
        h("w1", "Main", "cardano" as ChainType, "addr1", "100"), // no price → null
        h("w2", "Trading", "ethereum", "0xB", undefined), // no balance → null
      ],
      usdFor
    );
    expect(agg.grandTotalUsd).toBe(2000);
    expect(agg.rows.find((r) => r.chain === "cardano")!.usd).toBeNull();
    expect(agg.rows.find((r) => r.walletId === "w2")!.usd).toBeNull();
  });

  it("includes every wallet in perWallet even with a $0/unknown total", () => {
    const agg = aggregatePortfolio(
      [h("w1", "Main", "ethereum", "0xA", "1"), h("w2", "Empty", "cardano" as ChainType, "addr1", "0")],
      usdFor
    );
    expect(agg.perWallet.map((w) => w.walletId).sort()).toEqual(["w1", "w2"]);
    expect(agg.perWallet.find((w) => w.walletId === "w2")!.usd).toBe(0);
  });
});
