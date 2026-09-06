/**
 * C6 — the faults these tests exist to catch.
 *
 * **Float arithmetic at 12 decimals.** Monero's atomic unit is 1e-12. Computing
 * `balance - reserved` as numbers is exact often enough to look fine in a demo
 * and wrong in the direction that matters when it is not: a spendable figure
 * slightly *higher* than reality invites a sweep that cannot fund. The
 * arithmetic is done in `BigInt` on the digit strings, and the test that proves
 * it is the one where the float answer differs.
 *
 * **A placeholder rendered as an address (§R18).** Upstream puts human-readable
 * status text in `deposit_address` ("Refresh necessary", "WARNING: Unknown
 * wallet seed", "Error: unowned address"). A copy button on any of those hands
 * the user a string that cannot receive coins, and a QR encoder will encode it
 * without complaint. The rotated value gets the same treatment as the polled
 * one — a rotation that answers with a placeholder must not bypass the filter.
 */
import { describe, it, expect } from "vitest";
import {
  displayAddress,
  isNegativeAmount,
  spendableXmr,
  subtractAmount,
  XMR_DECIMALS,
} from "../dexXmrWallet";
import { DEPOSIT_ADDRESS_PLACEHOLDERS } from "../../../api/basicswap";
import type { BasicSwapWalletInfo } from "../../../api/basicswap";

const ADDR =
  "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";

describe("subtractAmount — exact on decimal strings", () => {
  it("keeps the full precision of the wider operand", () => {
    expect(subtractAmount("1.0", "0.000000000001")).toBe("0.999999999999");
    expect(XMR_DECIMALS).toBe(12);
  });

  it("gets a case the float path gets wrong", () => {
    // 0.3 - 0.1 in IEEE-754 is 0.19999999999999998. Rendered at 12 decimals
    // that is 0.199999999999 — one atomic unit short of the truth, every time.
    expect(subtractAmount("0.300000000000", "0.100000000000")).toBe("0.200000000000");
    expect(0.3 - 0.1).not.toBe(0.2);
  });

  it("handles operands with different fraction lengths", () => {
    expect(subtractAmount("2", "0.5")).toBe("1.5");
    expect(subtractAmount("2.50", "0.5")).toBe("2.00");
    expect(subtractAmount("3", "1")).toBe("2");
  });

  it("returns the reported balance untouched when nothing is reserved", () => {
    expect(subtractAmount("1.25", null)).toBe("1.25");
    expect(subtractAmount("1.25", undefined)).toBe("1.25");
    expect(subtractAmount("1.25", "")).toBe("1.25");
    expect(subtractAmount("1.25", "   ")).toBe("1.25");
  });

  it("returns null when the balance itself is unknown", () => {
    // Unknown must not render as zero: "0 spendable" is a claim, "—" is not.
    expect(subtractAmount(null, "1")).toBeNull();
    expect(subtractAmount(undefined, "1")).toBeNull();
    expect(subtractAmount("", "1")).toBeNull();
    expect(subtractAmount("not-a-number", "1")).toBeNull();
    expect(subtractAmount("1.2.3", "1")).toBeNull();
    expect(subtractAmount("1e3", "1")).toBeNull();
  });

  it("returns null rather than guessing when the reserved figure is garbage", () => {
    expect(subtractAmount("1.0", "abc")).toBeNull();
  });

  it("returns a NEGATIVE result with its sign instead of clamping", () => {
    // Reserved exceeding the balance is a real anomaly. Clamping to zero hides
    // the one number that says something is wrong.
    expect(subtractAmount("0.5", "0.75")).toBe("-0.25");
    expect(subtractAmount("0", "0.000000000001")).toBe("-0.000000000001");
    expect(isNegativeAmount(subtractAmount("0.5", "0.75"))).toBe(true);
    expect(isNegativeAmount(subtractAmount("0.75", "0.5"))).toBe(false);
    expect(isNegativeAmount(null)).toBe(false);
  });

  it("handles an exactly-zero difference without a sign", () => {
    expect(subtractAmount("1.5", "1.5")).toBe("0.0");
    expect(isNegativeAmount(subtractAmount("1.5", "1.5"))).toBe(false);
  });
});

describe("spendableXmr", () => {
  it("subtracts the caller-supplied reserved amount from the reported balance", () => {
    const info: BasicSwapWalletInfo = { balance: "3.500000000000" };
    expect(spendableXmr(info, "0.250000000000")).toBe("3.250000000000");
  });

  it("is null when there is no wallet info at all", () => {
    expect(spendableXmr(null, "1")).toBeNull();
    expect(spendableXmr({}, "1")).toBeNull();
  });

  it("is the whole balance when reserved is unknown", () => {
    // There is no endpoint reporting XMR committed to live bids; `null` means
    // the caller has no view of it, not that the figure is zero. The card is
    // what says "unknown" — the arithmetic cannot invent a reservation.
    expect(spendableXmr({ balance: "2.0" }, null)).toBe("2.0");
  });
});

describe("displayAddress", () => {
  const info = (deposit_address?: string): BasicSwapWalletInfo => ({ deposit_address });

  it("prefers a freshly rotated address over the polled one", () => {
    expect(displayAddress(ADDR, info("8Bold…other"))).toBe(ADDR);
  });

  it("falls back to the polled address when nothing was rotated", () => {
    expect(displayAddress(null, info(ADDR))).toBe(ADDR);
    expect(displayAddress(undefined, info(ADDR))).toBe(ADDR);
  });

  it("maps EVERY upstream placeholder to null — rotated side included", () => {
    // The rotated value goes through the same filter. A rotation that answers
    // with a placeholder must not get a copy button just because it is fresher.
    for (const p of DEPOSIT_ADDRESS_PLACEHOLDERS) {
      expect(displayAddress(p, info(ADDR))).toBe(ADDR); // falls through
      expect(displayAddress(null, info(p))).toBeNull();
      expect(displayAddress(p, info(p))).toBeNull();
    }
  });

  it("maps upstream's '?' and blanks to null", () => {
    expect(displayAddress(null, info("?"))).toBeNull();
    expect(displayAddress(null, info("   "))).toBeNull();
    expect(displayAddress(null, info(undefined))).toBeNull();
    expect(displayAddress(null, null)).toBeNull();
  });
});
