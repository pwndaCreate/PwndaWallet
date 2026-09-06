import { describe, it, expect, beforeEach } from "vitest";
import {
  SafetyInvariantError,
  assertDisplayedAmountReasonable,
  formatAtomicForDisplay,
} from "./safety-invariants";
import {
  clearPairMinimumCache,
  getPairMinimum,
  parseMinAtomicFromUpstreamError,
  setPairMinimum,
} from "./intents-pair-min-cache";

/**
 * Regression vectors locking the P0 fix for the display-units bug
 * (2026-05-08). Symptom was POL → AVAX showing
 * "10269776004666684 AVAX" when the correct display was "0.01 AVAX" —
 * atomic-units (wei) leaked into the display layer.
 *
 * Every assertion below traces back to a piece of that bug:
 *   - formatAtomicForDisplay vectors lock the conversion
 *   - assertDisplayedAmountReasonable locks the second-line-of-defence
 *     invariant that catches future regressions of the same bug class
 *   - parseMinAtomicFromUpstreamError + setPairMinimum/getPairMinimum
 *     lock the pair-minimum cache used to surface tighter floors after
 *     an upstream rejection
 */
describe("formatAtomicForDisplay — atomic → display conversion", () => {
  it("18 decimals: 5e15 wei → 0.005", () => {
    expect(formatAtomicForDisplay("5000000000000000", 18)).toBe("0.005");
  });

  it("8 decimals: 35127 sat → 0.00035127", () => {
    expect(formatAtomicForDisplay("35127", 8)).toBe("0.00035127");
  });

  it("9 decimals: lamports", () => {
    expect(formatAtomicForDisplay("1000000000", 9)).toBe("1");
    expect(formatAtomicForDisplay("1500000000", 9)).toBe("1.5");
  });

  it("0 decimals: passthrough", () => {
    expect(formatAtomicForDisplay("100", 0)).toBe("100");
  });

  it("zero: returns '0'", () => {
    expect(formatAtomicForDisplay("0", 18)).toBe("0");
    expect(formatAtomicForDisplay("0", 0)).toBe("0");
  });

  it("trims trailing zeros in the fractional part", () => {
    expect(formatAtomicForDisplay("1230000", 6)).toBe("1.23");
  });

  it("tolerates a fractional tail in the input", () => {
    expect(formatAtomicForDisplay("5000000000000000.0000022", 18)).toBe(
      "0.005"
    );
  });

  it("18 decimals: very small wei value", () => {
    // 1 wei → 0.000000000000000001
    expect(formatAtomicForDisplay("1", 18)).toBe("0.000000000000000001");
  });

  it("rejects malformed input", () => {
    expect(() => formatAtomicForDisplay("abc", 18)).toThrow();
    expect(() => formatAtomicForDisplay("1e18", 18)).toThrow();
  });

  it("lock — POL → AVAX bug repro", () => {
    // The bug surface: 1 POL → ~0.01 AVAX, but the form displayed
    // "10269776004666684 AVAX". With the fix, the atomic-unit string
    // 10269776004666684 (wei) at 18 decimals renders as
    // "0.010269776004666684" (≈ 0.01 AVAX) — matches the user's reported
    // expected receive value.
    const display = formatAtomicForDisplay("10269776004666684", 18);
    expect(display).toBe("0.010269776004666684");
    expect(Number(display)).toBeLessThan(0.1);
    expect(Number(display)).toBeGreaterThan(0.001);
  });

  it("lock — AVAX → BTC bug repro", () => {
    // 3 AVAX → 0.000351 BTC. The buggy display showed "35127 BTC"
    // (atomic sat units). Fix: 35127 sat at 8 decimals = 0.00035127 BTC.
    expect(formatAtomicForDisplay("35127", 8)).toBe("0.00035127");
  });
});

describe("assertDisplayedAmountReasonable — second-line-of-defence", () => {
  it("accepts plausible swap amounts", () => {
    expect(() =>
      assertDisplayedAmountReasonable({
        displayAmount: 0.005,
        ticker: "ETH",
        field: "you-receive",
      })
    ).not.toThrow();
    expect(() =>
      assertDisplayedAmountReasonable({
        displayAmount: 1234.56,
        ticker: "USDC",
        field: "min-received",
      })
    ).not.toThrow();
  });

  it("throws SafetyInvariantError when display exceeds 10M", () => {
    expect(() =>
      assertDisplayedAmountReasonable({
        // The bug repro: atomic wei displayed as ETH.
        displayAmount: 10_269_776_004_666_684,
        ticker: "AVAX",
        field: "you-receive",
      })
    ).toThrow(SafetyInvariantError);
  });

  it("error carries the invariant id + ticker + field", () => {
    try {
      assertDisplayedAmountReasonable({
        displayAmount: 35_127_000_000,
        ticker: "BTC",
        field: "rate",
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SafetyInvariantError);
      const err = e as SafetyInvariantError;
      expect(err.invariant).toBe("DISPLAY_AMOUNT_OVER_THRESHOLD");
      expect(err.context.ticker).toBe("BTC");
      expect(err.context.field).toBe("rate");
    }
  });

  it("rejects NaN / Infinity (render-layer bug)", () => {
    expect(() =>
      assertDisplayedAmountReasonable({
        displayAmount: NaN,
        ticker: "ETH",
        field: "you-receive",
      })
    ).toThrow(SafetyInvariantError);
    expect(() =>
      assertDisplayedAmountReasonable({
        displayAmount: Infinity,
        ticker: "ETH",
        field: "rate",
      })
    ).toThrow(SafetyInvariantError);
  });

  it("allowHigh escape hatch lets very-low-value tokens render", () => {
    expect(() =>
      assertDisplayedAmountReasonable({
        displayAmount: 50_000_000,
        ticker: "PEPE",
        field: "you-receive",
        allowHigh: true,
      })
    ).not.toThrow();
  });

  it("threshold lock: 10_000_001 trips, 10_000_000 does not", () => {
    expect(() =>
      assertDisplayedAmountReasonable({
        displayAmount: 10_000_000,
        ticker: "ANY",
        field: "you-receive",
      })
    ).not.toThrow();
    expect(() =>
      assertDisplayedAmountReasonable({
        displayAmount: 10_000_001,
        ticker: "ANY",
        field: "you-receive",
      })
    ).toThrow(SafetyInvariantError);
  });
});

describe("intents-pair-min-cache — learn from upstream rejection", () => {
  beforeEach(() => clearPairMinimumCache());

  it("set + get round-trips", () => {
    setPairMinimum("nep141:eth.omft.near", "nep141:btc.omft.near", "1000000");
    expect(
      getPairMinimum("nep141:eth.omft.near", "nep141:btc.omft.near")
    ).toBe("1000000");
  });

  it("returns null for unknown pairs", () => {
    expect(getPairMinimum("nep141:eth.omft.near", "nep141:btc.omft.near")).toBe(
      null
    );
  });

  it("parses 'minimum amount of X wei' shape", () => {
    const min = parseMinAtomicFromUpstreamError(
      "Amount is below the minimum amount of 1000000000000000 wei."
    );
    expect(min).toBe("1000000000000000");
  });

  it("parses 'minimum: X' shape", () => {
    const min = parseMinAtomicFromUpstreamError(
      "minimum: 50000000 (lamports)"
    );
    expect(min).toBe("50000000");
  });

  it("parses 'must be at least X yoctoNEAR' shape", () => {
    const min = parseMinAtomicFromUpstreamError(
      "Minimum deposit amount is 5000000000000 yoctoNEAR"
    );
    expect(min).toBe("5000000000000");
  });

  it("picks the largest integer when human + atomic both appear", () => {
    // "0.001 ETH (1000000000000000 wei)" — the wei integer wins.
    const min = parseMinAtomicFromUpstreamError(
      "must be at least 0.001 ETH (1000000000000000 wei)"
    );
    expect(min).toBe("1000000000000000");
  });

  it("returns null when no integer >= 4 digits is present", () => {
    expect(parseMinAtomicFromUpstreamError("invalid token")).toBe(null);
    expect(parseMinAtomicFromUpstreamError("1.5 ETH")).toBe(null);
  });

  it("end-to-end: parse + cache + retrieve", () => {
    const learned = parseMinAtomicFromUpstreamError(
      "minimum amount is 200000 (atomic)"
    );
    expect(learned).toBe("200000");
    setPairMinimum("nep141:a.omft.near", "nep141:b.omft.near", learned!);
    expect(getPairMinimum("nep141:a.omft.near", "nep141:b.omft.near")).toBe(
      "200000"
    );
  });
});
