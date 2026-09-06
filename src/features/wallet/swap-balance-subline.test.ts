import { describe, expect, it } from "vitest";
import {
  isPositiveAmount,
  swapBalanceLabel,
  trimAmount,
} from "./swap-balance-subline";

/**
 * C0.1 — the wallet-surface swap-balance sub-line.
 *
 * The requirement these tests exist to protect: **a user who does not swap
 * must see no change at all** on the wallet surface, and a user who does must
 * never see the node's balance rendered as their wallet's own. The first half
 * is entirely decided here — `swapBalanceLabel` returning `null` is what makes
 * the row render nothing.
 *
 * Each block below is written so that it goes red for the reason it is run:
 * the "renders nothing" tests assert `null` (not "some falsy value"), and the
 * formatting tests assert the exact string, because a test that only checked
 * `toBeTruthy()` would pass for a corrupted amount.
 */

describe("isPositiveAmount", () => {
  it("accepts well-formed positive decimal strings", () => {
    expect(isPositiveAmount("0.0421")).toBe(true);
    expect(isPositiveAmount("1")).toBe(true);
    expect(isPositiveAmount("100.00000001")).toBe(true);
    expect(isPositiveAmount("  0.5  ")).toBe(true); // surrounding space trimmed
  });

  it("rejects zero in every spelling — this is the 'no change for a non-swapper' guard", () => {
    expect(isPositiveAmount("0")).toBe(false);
    expect(isPositiveAmount("0.0")).toBe(false);
    expect(isPositiveAmount("0.00000000")).toBe(false);
    expect(isPositiveAmount("00")).toBe(false);
  });

  it("rejects absent values", () => {
    expect(isPositiveAmount(undefined)).toBe(false);
    expect(isPositiveAmount(null)).toBe(false);
    expect(isPositiveAmount("")).toBe(false);
    expect(isPositiveAmount("   ")).toBe(false);
  });

  it("rejects everything parseFloat would have swallowed", () => {
    // These are the exact inputs that make a `parseFloat(raw) > 0` check
    // wrong: each one is truthy-and-positive to parseFloat and none of them
    // is an amount we can honestly render.
    expect(isPositiveAmount("1e5")).toBe(false);
    expect(isPositiveAmount("0x10")).toBe(false);
    expect(isPositiveAmount("12abc")).toBe(false);
    expect(isPositiveAmount("Infinity")).toBe(false);
    expect(isPositiveAmount("+1")).toBe(false);
    expect(isPositiveAmount("1,000")).toBe(false);
    expect(isPositiveAmount(".5")).toBe(false);
    expect(isPositiveAmount("1.")).toBe(false);
  });

  it("rejects negatives rather than rendering a minus sign on a balance row", () => {
    expect(isPositiveAmount("-1")).toBe(false);
    expect(isPositiveAmount("-0.5")).toBe(false);
  });
});

describe("trimAmount", () => {
  it("drops insignificant trailing zeros only", () => {
    expect(trimAmount("0.04210000")).toBe("0.0421");
    expect(trimAmount("1.000")).toBe("1");
    expect(trimAmount("0.5")).toBe("0.5");
  });

  it("leaves integers alone — trailing zeros there are significant", () => {
    expect(trimAmount("100")).toBe("100");
    expect(trimAmount("1000")).toBe("1000");
    expect(trimAmount("10")).toBe("10");
  });
});

describe("swapBalanceLabel", () => {
  it("renders the amount verbatim, with the ticker uppercased", () => {
    expect(swapBalanceLabel("0.04210000", "btc")).toBe("0.0421 BTC");
    expect(swapBalanceLabel("2.5", "XMR")).toBe("2.5 XMR");
  });

  it("preserves precision a float round-trip would have lost", () => {
    // 20 significant digits — beyond an IEEE-754 double. A parseFloat/toFixed
    // implementation prints 0.10000000000000000555…; this must print what the
    // engine sent.
    expect(swapBalanceLabel("0.12345678901234567891", "BTC")).toBe(
      "0.12345678901234567891 BTC",
    );
  });

  it("returns null for every 'show nothing' case", () => {
    expect(swapBalanceLabel(undefined, "BTC")).toBeNull(); // sidecar off
    expect(swapBalanceLabel(null, "BTC")).toBeNull(); // coin not held
    expect(swapBalanceLabel("0", "BTC")).toBeNull(); // zero balance
    expect(swapBalanceLabel("0.000", "BTC")).toBeNull();
    expect(swapBalanceLabel("not a number", "BTC")).toBeNull();
  });
});
