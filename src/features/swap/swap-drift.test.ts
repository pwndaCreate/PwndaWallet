/**
 * Regression locks for the quote→settle drift tracking added 2026-05-26
 * (#22). Covers the schema's tolerant-read contract, the drift
 * computation, the tone-bucket logic, and the actual-amount
 * extractors for both NEAR Intents and SwapKit response shapes.
 *
 * The drift tracking sits at the intersection of the swap polling
 * layer (writes `actualReceived` at terminal SUCCESS) and the History
 * UI (reads it + computes the displayed drift chip). These tests pin
 * both directions of that contract so a future change to the
 * extractor or the chip's tone thresholds doesn't drift silently.
 */
import { describe, expect, it } from "vitest";
import {
  computeDriftFraction,
  driftTone,
  formatDriftPercent,
  type SwapHistoryEntry,
} from "./swap-history-store";
import {
  extractActualReceivedFromIntents,
  extractActualReceivedFromSwapKit,
  formatActualReceived,
} from "./swap-actual-received";

describe("computeDriftFraction — quote→settle ratio math", () => {
  it("returns null when actual is missing (pre-2026-05-26 historical entries)", () => {
    expect(computeDriftFraction("3.78", undefined)).toBeNull();
  });

  it("returns null when expected is missing (defensive)", () => {
    expect(computeDriftFraction(undefined, "3.61")).toBeNull();
  });

  it("returns null when either side is unparseable", () => {
    expect(computeDriftFraction("not-a-number", "3.61")).toBeNull();
    expect(computeDriftFraction("3.78", "garbage")).toBeNull();
  });

  it("returns null when expected is zero (avoid divide-by-zero)", () => {
    expect(computeDriftFraction("0", "3.61")).toBeNull();
  });

  it("computes a negative drift for the AVAX→ADA canary case (~-4.5%)", () => {
    // The actual production canary: quoted 3.78 ADA, received 3.61 ADA.
    const drift = computeDriftFraction("3.78", "3.61");
    expect(drift).not.toBeNull();
    expect(drift!).toBeCloseTo(-0.0449, 3);
  });

  it("computes a positive drift on the rare upside-surprise case", () => {
    const drift = computeDriftFraction("100", "103");
    expect(drift).toBeCloseTo(0.03, 3);
  });

  it("returns 0 when the two amounts are exactly equal", () => {
    expect(computeDriftFraction("3.78", "3.78")).toBe(0);
  });
});

describe("driftTone — color-bucket thresholds", () => {
  it("returns null when drift is null (no chip rendered)", () => {
    expect(driftTone(null)).toBeNull();
  });

  it("returns 'neutral' for drift inside ±2% absolute", () => {
    expect(driftTone(0)).toBe("neutral");
    expect(driftTone(0.01)).toBe("neutral");
    expect(driftTone(-0.02)).toBe("neutral");
    expect(driftTone(0.02)).toBe("neutral");
  });

  it("returns 'warn' for drift in (2%, 5%] absolute", () => {
    expect(driftTone(0.03)).toBe("warn");
    expect(driftTone(-0.045)).toBe("warn"); // the AVAX→ADA canary
    expect(driftTone(0.05)).toBe("warn");
  });

  it("returns 'bad' for drift outside ±5% absolute", () => {
    expect(driftTone(-0.06)).toBe("bad");
    expect(driftTone(0.1)).toBe("bad");
    expect(driftTone(-1)).toBe("bad");
  });

  it("treats positive and negative drift the same magnitude for tone (signed-agnostic)", () => {
    // +6% upside is just as "anomalous" as a -6% loss from a
    // calibration standpoint. The user-facing sign comes from
    // formatDriftPercent, not the tone bucket.
    expect(driftTone(0.06)).toBe("bad");
    expect(driftTone(-0.06)).toBe("bad");
  });
});

describe("formatDriftPercent — chip display string", () => {
  it("returns empty string when drift is null", () => {
    expect(formatDriftPercent(null)).toBe("");
  });

  it("formats with sign, one decimal, percent suffix", () => {
    expect(formatDriftPercent(0.045)).toBe("+4.5%");
    expect(formatDriftPercent(-0.045)).toBe("-4.5%");
    expect(formatDriftPercent(0)).toBe("+0.0%");
  });

  it("matches the AVAX→ADA canary's expected display string", () => {
    expect(formatDriftPercent(-0.0449)).toBe("-4.5%");
  });
});

describe("extractActualReceivedFromIntents — NEAR Intents response shapes", () => {
  it("reads from resp.swap.amountOut (canonical 1Click SUCCESS shape)", () => {
    const resp = { status: "SUCCESS" as const, swap: { amountOut: "3610000" } };
    expect(extractActualReceivedFromIntents(resp)).toBe("3610000");
  });

  it("falls back to resp.amountOut when swap.amountOut is absent", () => {
    const resp = { status: "SUCCESS" as const, amountOut: "3610000" };
    expect(extractActualReceivedFromIntents(resp)).toBe("3610000");
  });

  it("falls back to resp.quote.amountOut for very old response variants", () => {
    const resp = {
      status: "SUCCESS" as const,
      quote: { amountOut: "3610000" },
    };
    expect(extractActualReceivedFromIntents(resp)).toBe("3610000");
  });

  it("returns undefined when no recognizable field is present", () => {
    const resp = { status: "SUCCESS" as const, totallyDifferentField: 42 };
    expect(extractActualReceivedFromIntents(resp)).toBeUndefined();
  });

  it("returns undefined on undefined / null input", () => {
    expect(extractActualReceivedFromIntents(undefined)).toBeUndefined();
  });

  it("converts numeric amountOut to string", () => {
    const resp = { status: "SUCCESS" as const, swap: { amountOut: 3610000 } };
    expect(extractActualReceivedFromIntents(resp)).toBe("3610000");
  });
});

describe("extractActualReceivedFromSwapKit — /track response shapes", () => {
  it("reads from resp.amountOut when present", () => {
    const resp = { status: "completed" as const, amountOut: "182000000000000000" };
    expect(extractActualReceivedFromSwapKit(resp)).toBe("182000000000000000");
  });

  it("falls back to legs[last].amount", () => {
    const resp = {
      status: "completed" as const,
      legs: [
        { amount: "100" },
        { amount: "182000000000000000" }, // destination leg
      ],
    };
    expect(extractActualReceivedFromSwapKit(resp)).toBe("182000000000000000");
  });

  it("returns undefined when neither field is present (SwapKit shapes vary)", () => {
    const resp = { status: "completed" as const };
    expect(extractActualReceivedFromSwapKit(resp)).toBeUndefined();
  });

  it("does NOT fall back to resp.expectedBuyAmount (would lie about drift)", () => {
    // The historical quote-time expectation, NOT the settled amount.
    // Falling back to it would make drift always read zero —
    // misleading. The extractor returns undefined instead.
    const resp = {
      status: "completed" as const,
      expectedBuyAmount: "182000000000000000",
    };
    expect(extractActualReceivedFromSwapKit(resp)).toBeUndefined();
  });

  it("returns undefined on undefined input", () => {
    expect(extractActualReceivedFromSwapKit(undefined)).toBeUndefined();
  });
});

describe("formatActualReceived — atomic → display conversion via registry decimals", () => {
  it("formats 1e6 atomic ADA as '1' (6 decimals)", () => {
    expect(formatActualReceived("1000000", "ADA")).toBe("1");
  });

  it("formats 3.61 ADA correctly (canary case)", () => {
    expect(formatActualReceived("3610000", "ADA")).toBe("3.61");
  });

  it("formats wei → ETH (18 decimals)", () => {
    expect(formatActualReceived("182000000000000000", "ETH")).toBe("0.182");
  });

  it("formats satoshis → BTC (8 decimals)", () => {
    expect(formatActualReceived("12345678", "BTC")).toBe("0.12345678");
  });

  it("returns null for unknown ticker", () => {
    expect(formatActualReceived("12345", "NOT_A_TICKER")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(formatActualReceived("not-a-number", "ADA")).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(formatActualReceived(undefined, "ADA")).toBeNull();
  });

  it("tolerates fractional tail (some servers return '1234.0' even for atomic units)", () => {
    expect(formatActualReceived("3610000.0", "ADA")).toBe("3.61");
  });

  it("trims trailing zeros for visual density", () => {
    // 3.500000 → "3.5", not "3.500000"
    expect(formatActualReceived("3500000", "ADA")).toBe("3.5");
  });
});

describe("SwapHistoryEntry schema — tolerant-read for historical entries", () => {
  // Pre-2026-05-26 entries don't have actualReceived / actualReceivedAt.
  // The schema's optional fields + History UI's fallback-to-quote-only
  // path must handle these without crashing.
  it("computes drift as null when actualReceived is missing (no chip rendered)", () => {
    const historical: SwapHistoryEntry = {
      id: "abc",
      fromAsset: "AVAX",
      toAsset: "ADA",
      fromAmount: "0.1",
      toAmount: "3.78", // quote-time only — no actualReceived
      status: "success",
      sourceTxHash: "0xd36293",
      sourceExplorerUrl: "",
      createdAt: "2026-05-25T10:00:00.000Z",
    };
    expect(historical.actualReceived).toBeUndefined();
    expect(computeDriftFraction(historical.toAmount, historical.actualReceived)).toBeNull();
    expect(driftTone(null)).toBeNull(); // no chip
  });

  it("renders the drift chip for entries with actualReceived populated", () => {
    const current: SwapHistoryEntry = {
      id: "def",
      fromAsset: "AVAX",
      toAsset: "ADA",
      fromAmount: "0.1",
      toAmount: "3.78",
      actualReceived: "3.61",
      actualReceivedAt: "2026-05-25T10:02:00.000Z",
      status: "success",
      sourceTxHash: "0xd36293",
      sourceExplorerUrl: "",
      createdAt: "2026-05-25T10:00:00.000Z",
      completedAt: "2026-05-25T10:02:00.000Z",
    };
    const drift = computeDriftFraction(current.toAmount, current.actualReceived);
    expect(drift).toBeCloseTo(-0.0449, 3);
    expect(driftTone(drift)).toBe("warn");
    expect(formatDriftPercent(drift)).toBe("-4.5%");
  });
});
