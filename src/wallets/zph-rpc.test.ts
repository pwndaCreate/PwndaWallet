import { describe, expect, it } from "vitest";
import {
  clampZphDisplayDecimals,
  zphToAtomic,
  atomicToZph,
  parseZphAssetSelector,
  pickAssetBalance,
  type ZphAssetBalance,
} from "./zph-rpc";

/**
 * 2026-09-15: `sendTransaction` mapped any unrecognised asset selector to ZPH,
 * so a UI ticker or stray value would have sent ZEPH under another label.
 */
describe("parseZphAssetSelector — unknown assets are refused, never sent as ZPH", () => {
  it("maps undefined to ZPH and passes the four RPC assets through", () => {
    expect(parseZphAssetSelector(undefined)).toBe("ZPH");
    for (const a of ["ZPH", "ZSD", "ZRS", "ZYS"] as const) {
      expect(parseZphAssetSelector(a)).toBe(a);
    }
  });

  it("throws on UI tickers, legacy names and anything else", () => {
    // Legacy-tagged outputs (ZEPH/ZEPHUSD/...) cannot be spent after hard fork
    // 11 (zephyr v2.3.0 blockchain.cpp:3337-3346), so they are not selectors.
    for (const bad of ["ZEPHUSD", "ZEPH", "zsd", "", "BOGUS"]) {
      expect(() => parseZphAssetSelector(bad)).toThrow(/Unknown Zephyr asset/);
    }
  });
});

/**
 * 2026-09-15: `getBalanceForAsset` returned `list[0]` without checking which
 * asset it was. Correct only while the server returns at most one entry.
 */
describe("pickAssetBalance — selects by asset_type, not position", () => {
  const e = (asset_type: ZphAssetBalance["asset_type"], balance: number): ZphAssetBalance => ({
    asset_type,
    balance,
    unlocked_balance: balance,
  });

  it("finds the requested asset among decoys", () => {
    const list = [e("ZSD", 42), e("ZRS", 5), e("ZPH", 14)];
    expect(pickAssetBalance(list, "ZPH")?.balance).toBe(14);
    expect(pickAssetBalance(list, "ZRS")?.balance).toBe(5);
  });

  it("returns null when the asset is absent (wallet-rpc omits zero balances)", () => {
    expect(pickAssetBalance([e("ZSD", 1)], "ZYS")).toBeNull();
    expect(pickAssetBalance([], "ZPH")).toBeNull();
    expect(pickAssetBalance(undefined, "ZPH")).toBeNull();
  });
});

/**
 * Regression lock for the 2026-06-21 Zephyr mint/redeem fix.
 *
 * Cross-asset `transfer` (mint/redeem) amounts must have ≤4 decimal places
 * — the daemon rejects more with `RPC error -4: Mint/redeem TX amounts
 * permit at most 4 decimal places`. `clampZphDisplayDecimals` truncates
 * (rounds DOWN) so we never try to spend more than the user has.
 */
describe("clampZphDisplayDecimals — Zephyr ≤4 decimal places", () => {
  it("truncates (rounds DOWN) to 4 decimals", () => {
    expect(clampZphDisplayDecimals("1.234567890123")).toBe("1.2345");
    expect(clampZphDisplayDecimals("99.99999")).toBe("99.9999"); // NOT rounded to 100
  });

  it("is a no-op for amounts already within 4 decimals", () => {
    expect(clampZphDisplayDecimals("1.5")).toBe("1.5");
    expect(clampZphDisplayDecimals("1.2345")).toBe("1.2345");
    expect(clampZphDisplayDecimals("42")).toBe("42");
  });

  it("trims trailing zeros produced by truncation", () => {
    expect(clampZphDisplayDecimals("1.50000")).toBe("1.5");
    expect(clampZphDisplayDecimals("7.00009")).toBe("7"); // 0.00009 → "0000" → ""
  });

  it("respects a custom maxDecimals", () => {
    expect(clampZphDisplayDecimals("1.23456", 2)).toBe("1.23");
    expect(clampZphDisplayDecimals("1.23456", 0)).toBe("1");
  });

  it("a clamped MAX-like value lands on a ≤4dp atomic amount", () => {
    // The exact bug: MAX fills a 12-decimal balance; without the clamp the
    // daemon -4's it. Clamp first → the atomic amount has ≤4 significant dp.
    const maxLike = atomicToZph(1_234_567_890_123n); // "1.234567890123"
    const clamped = clampZphDisplayDecimals(maxLike, 4); // "1.2345"
    expect(clamped).toBe("1.2345");
    expect(zphToAtomic(clamped)).toBe(1_234_500_000_000n);
  });
});
