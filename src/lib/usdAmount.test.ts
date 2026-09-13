/**
 * The Send / Swap USD entry (2026-09-12). The failure worth pinning is
 * precision: an adapter that refuses excess decimals turns a USD-typed amount
 * into a thrown send, and a float-floored quotient sends one unit short.
 */
import { describe, it, expect } from "vitest";
import { coinAmountFromUsd, usdEntryDecimals, usdTextFromCoin } from "./usdAmount";

describe("coinAmountFromUsd", () => {
  it("converts at the price and trims trailing zeros", () => {
    // $100 of BCH at $225 → 0.44444444 BCH (8 dp, rounded down)
    expect(coinAmountFromUsd("100", 225, "BCH")).toBe("0.44444444");
    expect(coinAmountFromUsd("50", 25, "LTC")).toBe("2");
  });

  it("rounds DOWN, never sending more than the typed dollars", () => {
    // 10 / 3 = 3.3333333333 → 3.33333333, not 3.33333334
    expect(coinAmountFromUsd("10", 3, "LTC")).toBe("3.33333333");
  });

  it("does not floor an exact quotient one unit short (binary float)", () => {
    // 0.29 / 1 * 1e8 is 28999999.999999996 in floating point.
    expect(coinAmountFromUsd("0.29", 1, "BTC")).toBe("0.29");
  });

  it("caps precision for chains with fewer decimals", () => {
    // $10 of XRP at $0.51234 = 19.51828864… — XRP carries 6 places.
    expect(coinAmountFromUsd("10", 0.51234, "XRP")).toBe("19.518288");
    expect(usdEntryDecimals("xlm")).toBe(7);
    expect(usdEntryDecimals("ETH")).toBe(8);
  });

  it("accepts the ways people type dollars", () => {
    expect(coinAmountFromUsd("$1,000", 500, "BCH")).toBe("2");
    expect(coinAmountFromUsd(" 12. ", 4, "LTC")).toBe("3");
  });

  it("empty clears; garbage or no price leaves the amount alone", () => {
    expect(coinAmountFromUsd("", 100, "LTC")).toBe("");
    expect(coinAmountFromUsd("abc", 100, "LTC")).toBeNull();
    expect(coinAmountFromUsd("1.2.3", 100, "LTC")).toBeNull();
    expect(coinAmountFromUsd("10", undefined, "LTC")).toBeNull();
    expect(coinAmountFromUsd("10", 0, "LTC")).toBeNull();
  });
});

describe("usdTextFromCoin", () => {
  it("prices a coin amount to cents", () => {
    // The Exodus screenshot: 0.54823434 BCH at ~$224.90 ≈ $123.30
    expect(usdTextFromCoin("0.54823434", 224.9)).toBe("123.30");
  });

  it("is blank rather than $0.00 when there is nothing to price", () => {
    expect(usdTextFromCoin("", 100)).toBe("");
    expect(usdTextFromCoin("1", undefined)).toBe("");
    expect(usdTextFromCoin("abc", 100)).toBe("");
  });
});
