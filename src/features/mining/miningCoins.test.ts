import { describe, it, expect } from "vitest";
import {
  MINING_COINS,
  algorithmFor,
  coinLanes,
  coinMinesOn,
  isDualLaneCoin,
  lanesLabel,
} from "./miningCoins";

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

  // XEL is fourth. Since 2026-09-18 SIMPLE shows four targets collapsed, so
  // there is no fold left to sit behind; the order still pins it last.
  it("XEL is fourth", () => {
    expect(MINING_COINS[3].sym).toBe("XEL");
  });

  it("every coin present before this change is still present after it", () => {
    // Reordering must never silently drop a coin — the whole point of a
    // single shared array (per this file's own header) is that a coin can't
    // go missing from one surface while staying in another.
    // RVN, CFX and ERG were removed ON PURPOSE on 2026-09-18 (retired from
    // mining, lolMiner no longer shipped). This pins the new set so the next
    // drop is deliberate too.
    expect(MINING_COINS.map((c) => c.sym).sort()).toEqual(
      ["XEL", "XMR", "ZANO", "ZEPH"].sort()
    );
  });

  it("each coin's lanes are exactly the declared ones", () => {
    const byChain = Object.fromEntries(
      MINING_COINS.map((c) => [c.chain, coinLanes(c.chain)])
    );
    expect(byChain).toEqual({
      monero: ["cpu"],
      zephyr: ["cpu"],
      xelis: ["cpu", "gpu"],
      zano: ["gpu"],
    });
  });
});

describe("per-lane algorithms", () => {
  it("XEL mines XelisHash v3 on both lanes", () => {
    expect(algorithmFor("xelis", "cpu")).toBe("xelishashv3");
    expect(algorithmFor("xelis", "gpu")).toBe("xelishashv3");
    expect(isDualLaneCoin("xelis")).toBe(true);
    expect(lanesLabel("xelis")).toBe("CPU/GPU");
  });

  it("a single-lane coin has no algorithm on the lane it cannot mine", () => {
    expect(algorithmFor("monero", "cpu")).toBe("randomx");
    expect(algorithmFor("monero", "gpu")).toBeNull();
    expect(algorithmFor("zano", "gpu")).toBe("progpowz");
    expect(algorithmFor("zano", "cpu")).toBeNull();
    expect(isDualLaneCoin("zano")).toBe(false);
    expect(lanesLabel("zano")).toBe("GPU");
  });

  it("every rostered coin names an algorithm for each lane it claims", () => {
    for (const c of MINING_COINS) {
      const lanes = coinLanes(c.chain);
      expect(lanes.length).toBeGreaterThan(0);
      for (const lane of lanes) {
        expect(algorithmFor(c.chain, lane)).not.toBeNull();
        expect(coinMinesOn(c.chain, lane)).toBe(true);
      }
    }
  });

  it("an unrostered coin is CPU-only for gating but has no algorithm to mine", () => {
    // Conservative: a CPU lane always exists, so the gating rule has
    // something to consult — but nothing can START it, because there is no
    // algorithm to launch.
    expect(coinLanes("bitcoin")).toEqual(["cpu"]);
    expect(algorithmFor("bitcoin", "cpu")).toBeNull();
  });
});
