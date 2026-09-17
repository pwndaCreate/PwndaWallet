/**
 * The fee box, 2026-09-12: LTC showed "ESTIMATED 10 sat/vB" — a bare rate, the
 * adapter's hardcoded fallback presented as live, and a tier selection the
 * signer never received. These pin the three halves of the fix.
 */
import { describe, it, expect } from "vitest";
import type { FeeEstimate } from "../../wallets";
import { feeNoteText, feeRateForSend, feeTotalFor, isPerByteRate } from "./feeDisplay";

describe("feeNoteText", () => {
  // 2026-09-15: a quote may carry one sentence about its fee (Xelis: the fee
  // includes 0.001 XEL for a recipient account not yet on chain).
  it("shows a quote's note, trimmed", () => {
    expect(
      feeNoteText({ feeNote: "  Includes 0.001 XEL for a new recipient account.  " }),
    ).toBe("Includes 0.001 XEL for a new recipient account.");
  });

  it("says nothing when there is no note, rather than an empty line", () => {
    expect(feeNoteText({})).toBeNull();
    expect(feeNoteText({ feeNote: "   " })).toBeNull();
    expect(feeNoteText(null)).toBeNull();
    expect(feeNoteText(undefined)).toBeNull();
  });
});

const ltc = (over: Partial<FeeEstimate> = {}): FeeEstimate => ({
  slow: { value: "1" },
  normal: { value: "2" },
  fast: { value: "5" },
  unit: "sat/vB",
  typicalTxVBytes: 141,
  fetchedAt: 0,
  ...over,
});

describe("isPerByteRate", () => {
  it("recognises the rate units the UTXO adapters return", () => {
    expect(isPerByteRate("sat/vB")).toBe(true);
    expect(isPerByteRate("sat/B")).toBe(true);
    expect(isPerByteRate("duffs/vB")).toBe(true);
  });

  it("rejects totals and account-model units", () => {
    expect(isPerByteRate("DOGE")).toBe(false);
    expect(isPerByteRate("Gwei")).toBe(false);
    expect(isPerByteRate(undefined)).toBe(false);
  });
});

describe("feeTotalFor", () => {
  it("turns a rate into a coin total for a typical send", () => {
    // 2 sat/vB × 141 vB = 282 lits
    expect(feeTotalFor(ltc(), "2", 53.85)).toEqual({ coin: "0.00000282", usd: "< $0.01" });
  });

  it("prices a larger total in dollars", () => {
    // BTC at 20 sat/vB × 141 vB = 0.00282 BTC; at $60,000 that is $169.20
    expect(feeTotalFor(ltc({ unit: "sat/vB" }), "20", 60_000)?.usd).toBe("$1.69");
  });

  it("uses the rounded-up rate the signer will apply", () => {
    expect(feeTotalFor(ltc(), "1.2", undefined)?.coin).toBe("0.00000282");
  });

  it("omits USD when there is no price, rather than printing $0.00", () => {
    expect(feeTotalFor(ltc(), "2", undefined)?.usd).toBeNull();
  });

  it("does not invent a total for a unit that is already a total", () => {
    expect(feeTotalFor(ltc({ unit: "DOGE", typicalTxVBytes: undefined }), "0.226", 0.2)).toBeNull();
  });
});

describe("feeRateForSend", () => {
  it("passes the selected tier to the signer, rounded up", () => {
    expect(feeRateForSend(ltc(), "5")).toBe(5);
    expect(feeRateForSend(ltc(), "1.5")).toBe(2);
  });

  it("never passes the fallback default as if the user had chosen it", () => {
    expect(feeRateForSend(ltc({ isFallback: true }), "10")).toBeUndefined();
  });

  it("never passes a total-denominated value as a rate", () => {
    expect(feeRateForSend(ltc({ unit: "DOGE" }), "0.226")).toBeUndefined();
  });

  it("rejects non-numbers — a click event must not become a fee rate", () => {
    expect(feeRateForSend(ltc(), "[object MouseEvent]")).toBeUndefined();
    expect(feeRateForSend(null, "5")).toBeUndefined();
  });
});
