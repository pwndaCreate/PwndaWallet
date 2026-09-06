import { describe, it, expect } from "vitest";
import { MINING_COINS, isGpuCoin } from "./miningCoins";

/**
 * The array order is load-bearing, not cosmetic: `MineSimpleView` shows
 * exactly the first `TARGETS_COLLAPSED` (3) entries before "N more ▾", so the
 * first three ARE the coins a fresh user sees. Reported 2026-08-29: the
 * default top three showed XMR/ZEPH/RVN, with ZANO — one of the two coins
 * that has a house-default pwnda pool (see `HOUSE_DEFAULT_POOL` in
 * `pools.ts`) — hidden behind the expander.
 */
describe("MINING_COINS — the collapsed-view order", () => {
  it("leads with XMR, ZANO, ZEPH", () => {
    expect(MINING_COINS.slice(0, 3).map((c) => c.sym)).toEqual([
      "XMR",
      "ZANO",
      "ZEPH",
    ]);
  });

  it("every coin present before this change is still present after it", () => {
    // Reordering must never silently drop a coin — the whole point of a
    // single shared array (per this file's own header) is that a coin can't
    // go missing from one surface while staying in another.
    expect(MINING_COINS.map((c) => c.sym).sort()).toEqual(
      ["CFX", "ERG", "RVN", "XMR", "ZANO", "ZEPH"].sort()
    );
  });

  it("hardware lane is unchanged by the reorder", () => {
    const byChain = Object.fromEntries(
      MINING_COINS.map((c) => [c.chain, c.hardware])
    );
    expect(byChain).toEqual({
      monero: "cpu",
      zephyr: "cpu",
      ravencoin: "gpu",
      conflux: "gpu",
      ergo: "gpu",
      zano: "gpu",
    });
    expect(isGpuCoin("zano")).toBe(true);
    expect(isGpuCoin("monero")).toBe(false);
  });
});
