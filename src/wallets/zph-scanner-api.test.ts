import { describe, it, expect } from "vitest";
import { zphAssetPrice, type ZphLiveStats } from "./zph-scanner-api";

/**
 * Funds-relevant lock for the Zephyr per-asset USD pricing shared by the
 * portrait `ZephyrAssetsCard` and the landscape wallet view. A wrong
 * asset→price mapping would misvalue a user's holdings; a non-null result
 * for missing data would show a bogus $0. Both are pinned here.
 *
 * Values mirror the live oracle snapshot (zephyrprotocol.com/api/v1/livestats,
 * 2026-06-29): ZSD $1 peg, ZRS $0.4183 reserve-share NAV, ZYS $1.931 yield slip.
 */
const STATS: ZphLiveStats = {
  reserve_ratio: 3.745686,
  reserve_ratio_ma: 3.863722,
  zeph_in_reserve: 4_269_925.67,
  zeph_in_reserve_value: 1_455_617.66,
  zeph_in_reserve_percent: 0.2321,
  zeph_circ: 11_773_131.72,
  zsd_circ: 388_598.18,
  zrs_circ: 2_550_908.7,
  zys_circ: 156_962.32,
  zeph_price: 0.3409,
  zsd_price: 1,
  zrs_price: 0.4183,
  zys_price: 1.931,
  zsd_in_yield_reserve: 303_097.75,
  zsd_in_yield_reserve_percent: 0.78,
  zys_current_variable_apy: 8.2618,
};

describe("zphAssetPrice — Zephyr per-asset USD from the live oracle stats", () => {
  it("maps each asset to its own oracle price field", () => {
    expect(zphAssetPrice(STATS, "ZPH")).toBe(0.3409);
    expect(zphAssetPrice(STATS, "ZSD")).toBe(1);
    expect(zphAssetPrice(STATS, "ZRS")).toBe(0.4183);
    expect(zphAssetPrice(STATS, "ZYS")).toBe(1.931);
  });

  it("returns null when stats are absent (loading / not on the zephyr dashboard)", () => {
    expect(zphAssetPrice(null, "ZSD")).toBeNull();
    expect(zphAssetPrice(undefined, "ZYS")).toBeNull();
  });

  it("returns null for a non-finite or missing price field — never a bogus $0", () => {
    expect(zphAssetPrice({ ...STATS, zrs_price: NaN as unknown as number }, "ZRS")).toBeNull();
    const missing = { ...STATS } as Partial<ZphLiveStats>;
    delete missing.zys_price;
    expect(zphAssetPrice(missing as ZphLiveStats, "ZYS")).toBeNull();
  });

  it("drives the card row math: atomic (1e12) balance × price → USD", () => {
    // 42 ZSD held (42e12 atomic) × $1 = $42.00; 3 ZYS × $1.931 = $5.793.
    const zsdUsd = (42_000_000_000_000 / 1e12) * (zphAssetPrice(STATS, "ZSD") ?? 0);
    const zrsUsd = (5_000_000_000_000 / 1e12) * (zphAssetPrice(STATS, "ZRS") ?? 0);
    const zysUsd = (3_000_000_000_000 / 1e12) * (zphAssetPrice(STATS, "ZYS") ?? 0);
    expect(zsdUsd).toBeCloseTo(42, 6);
    expect(zrsUsd).toBeCloseTo(2.0915, 6);
    expect(zysUsd).toBeCloseTo(5.793, 6);
    // Ecosystem subtotal the card foots.
    expect(zsdUsd + zrsUsd + zysUsd).toBeCloseTo(49.8845, 6);
  });
});
