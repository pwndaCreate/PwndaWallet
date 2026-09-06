/**
 * Tests for the spread safety core.
 *
 * The one that matters most is `feed unavailable → RED`: every other assertion
 * here protects a number, that one protects the user from the wallet quietly
 * blessing a rate it never checked.
 */
import { describe, expect, it } from "vitest";

import {
  computeSpread,
  evaluateSpreadGate,
  formatSpreadSentence,
  isOverrideTyped,
  marketRateFromPrices,
  marketRateFromUsd,
  normalizeOverrideInput,
  SPREAD_AMBER_MAX_PCT,
  SPREAD_GREEN_MAX_PCT,
  SPREAD_OVERRIDE_PHRASE,
  SPREAD_THRESHOLDS,
} from "../spread";

// A reference of exactly 100 keeps every boundary value exactly representable
// as a double, so a band assertion tests the band and not IEEE-754.
const MARKET = 100;

describe("thresholds", () => {
  it("exposes the bands as configurable constants", () => {
    expect(SPREAD_GREEN_MAX_PCT).toBe(1);
    expect(SPREAD_AMBER_MAX_PCT).toBe(5);
    expect(SPREAD_THRESHOLDS).toEqual({ greenMaxPct: 1, amberMaxPct: 5 });
  });
});

describe("feed unavailable is RED, never green", () => {
  it("treats a null market rate as red and explicitly unverified", () => {
    const a = computeSpread(0.0041, null);
    expect(a.band).toBe("red");
    expect(a.verified).toBe(false);
    expect(a.blocked).toBe(true);
    expect(a.reason).toBe("feed-unavailable");
    expect(a.spreadPct).toBeNull();
    expect(a.sentence).toBe(
      "The market price is unavailable, so this rate cannot be checked.",
    );
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])(
    "treats market rate %p as red",
    (market) => {
      const a = computeSpread(0.0041, market as number | null | undefined);
      expect(a.band).toBe("red");
      expect(a.verified).toBe(false);
    },
  );

  it("maps an empty fetchUsdPrices result to no reference rate at all", () => {
    // fetchUsdPrices returns {} when every provider failed.
    expect(marketRateFromPrices("XMR", "LTC", {})).toBeNull();
    expect(computeSpread(0.0041, marketRateFromPrices("XMR", "LTC", {})).band).toBe(
      "red",
    );
  });

  it("maps a partially-covered price feed to no reference rate", () => {
    // ZEPH is absent from CoinPaprika entirely; a cooldown can leave it unpriced.
    const prices = { XMR: 390 };
    expect(marketRateFromPrices("XMR", "ZEPH", prices)).toBeNull();
    expect(marketRateFromPrices("ZEPH", "XMR", prices)).toBeNull();
  });

  it("does not silently substitute zero for a missing price", () => {
    expect(marketRateFromUsd(0, 390)).toBeNull();
    expect(marketRateFromUsd(390, 0)).toBeNull();
    expect(marketRateFromUsd(undefined, 390)).toBeNull();
  });

  it("treats an unreadable offer rate as red too", () => {
    const a = computeSpread(NaN, 100);
    expect(a.band).toBe("red");
    expect(a.verified).toBe(false);
    expect(a.reason).toBe("rate-unusable");
    expect(a.sentence).toBe(
      "This offer's rate could not be read, so it cannot be checked.",
    );
  });
});

describe("band boundaries", () => {
  it("is green at exactly the green ceiling", () => {
    const a = computeSpread(101, MARKET);
    expect(a.spreadPct).toBe(1);
    expect(a.band).toBe("green");
    expect(a.blocked).toBe(false);
  });

  it("is amber just above the green ceiling", () => {
    const a = computeSpread(101.5, MARKET);
    expect(a.spreadPct).toBe(1.5);
    expect(a.band).toBe("amber");
    expect(a.blocked).toBe(false);
  });

  it("is amber at exactly the amber ceiling", () => {
    const a = computeSpread(105, MARKET);
    expect(a.spreadPct).toBe(5);
    expect(a.band).toBe("amber");
    expect(a.blocked).toBe(false);
  });

  it("is red just above the amber ceiling", () => {
    const a = computeSpread(105.1, MARKET);
    expect(a.band).toBe("red");
    expect(a.blocked).toBe(true);
    expect(a.reason).toBe("far-worse-than-market");
  });

  it("is red for the +14% stale-bait offers the book actually carries", () => {
    const a = computeSpread(114, MARKET);
    expect(a.band).toBe("red");
    expect(a.verified).toBe(true);
    expect(a.sentence).toBe("This swap is 14.0% worse than market.");
  });

  it("is green when the offer is better than market", () => {
    const a = computeSpread(97, MARKET);
    expect(a.band).toBe("green");
    expect(a.reason).toBe("better-than-market");
  });

  it("is green at exactly market", () => {
    const a = computeSpread(MARKET, MARKET);
    expect(a.spreadPct).toBe(0);
    expect(a.band).toBe("green");
    expect(a.reason).toBe("within-tolerance");
  });

  it("honours custom thresholds", () => {
    const tight = { greenMaxPct: 0.25, amberMaxPct: 1 };
    expect(computeSpread(100.2, MARKET, tight).band).toBe("green");
    expect(computeSpread(100.5, MARKET, tight).band).toBe("amber");
    expect(computeSpread(102, MARKET, tight).band).toBe("red");
  });
});

describe("the plain sentence", () => {
  it("produces the plan's exact wording for a worse-than-market swap", () => {
    const a = computeSpread(103.2, MARKET);
    expect(a.sentence).toBe("This swap is 3.2% worse than market.");
    expect(formatSpreadSentence(a)).toBe(a.sentence);
  });

  it("names the better direction rather than showing a negative percent", () => {
    expect(computeSpread(99.6, MARKET).sentence).toBe(
      "This swap is 0.4% better than market.",
    );
  });

  it("says so plainly when the rate is at market", () => {
    expect(computeSpread(100.01, MARKET).sentence).toBe(
      "This swap matches the market rate.",
    );
    // -0 must not render as "0.0% better".
    expect(computeSpread(99.99, MARKET).sentence).toBe(
      "This swap matches the market rate.",
    );
  });

  it("never shows a bare rate — every sentence is a full sentence", () => {
    for (const offer of [90, 99, 100, 101, 105, 130]) {
      const s = computeSpread(offer, MARKET).sentence;
      expect(s.endsWith(".")).toBe(true);
      expect(s.split(" ").length).toBeGreaterThan(3);
    }
  });
});

describe("the red gate requires a TYPED override, not a checkbox", () => {
  const red = computeSpread(114, MARKET);
  const amber = computeSpread(103, MARKET);
  const green = computeSpread(100, MARKET);

  it("lets green and amber through with no override", () => {
    for (const a of [green, amber]) {
      const gate = evaluateSpreadGate(a);
      expect(gate.canProceed).toBe(true);
      expect(gate.requiresTypedOverride).toBe(false);
      expect(gate.overridePhrase).toBeNull();
    }
  });

  it("blocks red until the phrase is typed", () => {
    const blocked = evaluateSpreadGate(red);
    expect(blocked.canProceed).toBe(false);
    expect(blocked.requiresTypedOverride).toBe(true);
    expect(blocked.overridePhrase).toBe(SPREAD_OVERRIDE_PHRASE);
  });

  it("does not accept a truthy value in place of the phrase", () => {
    for (const attempt of ["", " ", "yes", "y", "true", "ok", "1", "accept"]) {
      expect(evaluateSpreadGate(red, attempt).canProceed).toBe(false);
    }
  });

  it("accepts the phrase regardless of case and spacing", () => {
    for (const attempt of [
      SPREAD_OVERRIDE_PHRASE,
      SPREAD_OVERRIDE_PHRASE.toLowerCase(),
      `  ${SPREAD_OVERRIDE_PHRASE}  `,
      "i  accept   this rate",
    ]) {
      const gate = evaluateSpreadGate(red, attempt);
      expect(gate.canProceed).toBe(true);
      expect(gate.overrideSatisfied).toBe(true);
    }
  });

  it("keeps an unverifiable rate overridable, so a dead feed cannot hard-block", () => {
    const unverified = computeSpread(0.0041, null);
    expect(evaluateSpreadGate(unverified).canProceed).toBe(false);
    expect(
      evaluateSpreadGate(unverified, SPREAD_OVERRIDE_PHRASE).canProceed,
    ).toBe(true);
  });

  it("puts the spread sentence in the gate message", () => {
    expect(evaluateSpreadGate(red).message).toContain(red.sentence);
  });

  it("never claims pwnda is the counterparty", () => {
    const unverified = computeSpread(0.0041, null);
    const msg = evaluateSpreadGate(unverified).message.toLowerCase();
    expect(msg).toContain("another user on an open network");
    expect(msg).not.toContain("we will");
    expect(msg).not.toContain("we'll");
  });
});

describe("override input handling", () => {
  it("normalises whitespace and case", () => {
    expect(normalizeOverrideInput("  i accept   this  rate ")).toBe(
      "I ACCEPT THIS RATE",
    );
    expect(normalizeOverrideInput(null)).toBe("");
  });

  it("rejects an empty override even against an empty phrase", () => {
    expect(isOverrideTyped("", "")).toBe(false);
    expect(isOverrideTyped(null)).toBe(false);
  });
});

describe("reference rate construction", () => {
  it("returns send-coin units per 1 receive-coin", () => {
    // Sending XMR at $390 to receive LTC at $78 costs 0.2 XMR per LTC.
    expect(marketRateFromUsd(390, 78)).toBeCloseTo(0.2, 12);
  });

  it("is case-insensitive about tickers", () => {
    const prices = { XMR: 390, LTC: 78 };
    expect(marketRateFromPrices("xmr", "ltc", prices)).toBeCloseTo(0.2, 12);
  });

  it("compares a real offer against the reference in the same direction", () => {
    const prices = { XMR: 390, LTC: 78 };
    const market = marketRateFromPrices("XMR", "LTC", prices);
    // The maker wants 0.206 XMR per LTC — 3% over market.
    const a = computeSpread(0.206, market);
    expect(a.band).toBe("amber");
    expect(a.sentence).toBe("This swap is 3.0% worse than market.");
  });
});
