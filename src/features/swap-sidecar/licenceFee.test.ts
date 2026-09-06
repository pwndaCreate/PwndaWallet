import { describe, expect, it } from "vitest";
import { feeLegFor, licenceFeeFrom, licenceFeeLabel } from "./licenceFee";

describe("feeLegFor", () => {
  /**
   * §1.13's ~9x bug, on the display side. The fee is denominated in the
   * SCRIPTED leg whichever position it sits in; reading the wrong one on
   * XMR<->LTC misprices by the rate.
   */
  it("picks the scripted leg by ticker, not by position", () => {
    // The operator's 2026-09-05 swap: sends XMR (scriptless), receives LTC.
    expect(feeLegFor("Monero", "0.00999999", "Litecoin", "0.10309278")).toEqual({
      ticker: "LTC",
      amount: "0.10309278",
    });
    // ...and the same pair the other way round.
    expect(feeLegFor("Litecoin", "0.10309278", "Monero", "0.00999999")).toEqual({
      ticker: "LTC",
      amount: "0.10309278",
    });
  });

  it("takes upstream's display names, which is what an offer carries", () => {
    expect(feeLegFor("Bitcoin Cash", "0.04", "Monero", "0.0186")?.ticker).toBe("BCH");
    expect(feeLegFor("BCH", "0.04", "XMR", "0.0186")?.ticker).toBe("BCH");
  });

  it("is null when the pair is not chargeable", () => {
    // Scripted <-> scripted is free by policy (the Phantom rule).
    expect(feeLegFor("Bitcoin", "1", "Litecoin", "100")).toBeNull();
    // Two scriptless legs have no scripted side to denominate in.
    expect(feeLegFor("Monero", "1", "Zano", "10")).toBeNull();
    expect(feeLegFor("Monero", "1", "Monero", "1")).toBeNull();
    expect(feeLegFor("", "1", "Monero", "1")).toBeNull();
  });
});

describe("licenceFeeFrom / licenceFeeLabel", () => {
  it("renders the charge as an amount AND the rate it works out to", () => {
    // The real first collection: 0.5% of 0.03999999 BCH = 19999 atomic.
    const fee = licenceFeeFrom({
      kind: "charge",
      ticker: "BCH",
      amount: 19_999,
      address: "bitcoincash:qrppd4xmtha3ys5cmpyus0decthtw69v8u4pntv8xc",
      notional: 3_999_999,
    });
    expect(fee).toEqual({
      state: "charged",
      amount: "0.00019999",
      ticker: "BCH",
      percent: expect.closeTo(0.5, 4),
    });
    expect(licenceFeeLabel(fee)).toBe("0.00019999 BCH (0.50%)");
  });

  it("says none, not zero, when the pair is free", () => {
    expect(licenceFeeLabel(licenceFeeFrom({ kind: "skip", reason: "noScriptlessLeg" }))).toBe(
      "none on this pair",
    );
    expect(licenceFeeLabel(licenceFeeFrom({ kind: "skip", reason: "guard" }))).toBe(
      "none on this swap",
    );
  });

  /**
   * The line must never claim a fact about collection it did not fetch. The
   * string it replaced was a literal `0.00 (not enabled)` that outlived
   * `SHIPPED_MODE` being turned on, so the quote screen said no fee while the
   * watcher was charging one.
   */
  it("never says a fee is off — that is not a question this line can answer", () => {
    for (const fee of [
      licenceFeeFrom({ kind: "skip", reason: "noScriptlessLeg" }),
      licenceFeeFrom({ kind: "charge", ticker: "LTC", amount: 1, address: "x", notional: 200 }),
      { state: "unknown" } as const,
      { state: "loading" } as const,
    ]) {
      expect(licenceFeeLabel(fee)).not.toMatch(/enabled|disabled|off\b/i);
    }
    expect(licenceFeeLabel({ state: "unknown" })).toBe("—");
  });

  it("does not divide by a zero notional", () => {
    const fee = licenceFeeFrom({
      kind: "charge",
      ticker: "LTC",
      amount: 546,
      address: "x",
      notional: 0,
    });
    expect(fee).toMatchObject({ state: "charged", percent: 0 });
    expect(licenceFeeLabel(fee)).toContain("0.00000546 LTC");
  });
});
