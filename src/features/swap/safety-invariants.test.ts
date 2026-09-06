import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri's IPC layer so the telemetry call doesn't fail in tests
// (and so we can assert on it). The mock fires-and-forgets; the
// production module catches any rejection and logs a one-line warning.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import {
  SafetyInvariantError,
  assertNearTransferShape,
  assertPsbtOutputShape,
  assertQuoteAmountMatchesUserIntent,
  assertSignedTxValueMatches,
  assertSolTransferShape,
  assertTxFundable,
  assertTxNotPlausibleOverspend,
  assertTxValueMatchesQuote,
  assertVerifiedHashMatches,
  decodeEvmSignedTx,
} from "./safety-invariants";

import { keccak_256 } from "@noble/hashes/sha3.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────────
// Helper: build a minimal RLP-encoded signed legacy EVM tx.
// (Mirrors the helper in swap-execute.test.ts; copied to keep this
// file self-contained.)
// ───────────────────────────────────────────────────────────────────

function rlpEncodeBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && b[0] < 0x80) return b;
  if (b.length < 56) {
    const out = new Uint8Array(b.length + 1);
    out[0] = 0x80 + b.length;
    out.set(b, 1);
    return out;
  }
  throw new Error("test fixture: long-bytes not supported");
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const it of items) total += it.length;
  let header: Uint8Array;
  if (total < 56) header = new Uint8Array([0xc0 + total]);
  else if (total < 256) header = new Uint8Array([0xf8, total]);
  else if (total < 65536)
    header = new Uint8Array([0xf9, (total >> 8) & 0xff, total & 0xff]);
  else throw new Error("test fixture: list >= 64 KB not supported");
  const out = new Uint8Array(header.length + total);
  out.set(header, 0);
  let off = header.length;
  for (const it of items) {
    out.set(it, off);
    off += it.length;
  }
  return out;
}

function bigintToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  const padded = hex.length % 2 === 0 ? hex : "0" + hex;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function makeSignedLegacyTx(opts: { to: string; value: bigint }): string {
  const fields = [
    bigintToBytes(0n),
    bigintToBytes(1n),
    bigintToBytes(21000n),
    hexToBytes(opts.to),
    bigintToBytes(opts.value),
    new Uint8Array(0),
    bigintToBytes(27n),
    bigintToBytes(1n),
    bigintToBytes(1n),
  ].map(rlpEncodeBytes);
  return bytesToHex(rlpEncodeList(fields));
}

// ───────────────────────────────────────────────────────────────────
// Invariant #1 — quote.amountIn vs user-intended atomic amount
// ───────────────────────────────────────────────────────────────────

describe("assertQuoteAmountMatchesUserIntent", () => {
  it("passes when quote and user-intent are within ±1%", () => {
    expect(() =>
      assertQuoteAmountMatchesUserIntent({
        quoteAmountAtomic: 5_000_000_000_000_000n,
        userIntendedAtomic: 5_000_000_000_000_000n,
        ticker: "ETH",
        decimals: 18,
      })
    ).not.toThrow();
    // 0.5% drift — should pass.
    expect(() =>
      assertQuoteAmountMatchesUserIntent({
        quoteAmountAtomic: 4_975_000_000_000_000n,
        userIntendedAtomic: 5_000_000_000_000_000n,
        ticker: "ETH",
        decimals: 18,
      })
    ).not.toThrow();
  });

  it("throws when quote is 1000× user-intent (catches over-conversion bug)", () => {
    let caught: unknown = null;
    try {
      assertQuoteAmountMatchesUserIntent({
        quoteAmountAtomic: 5_000_000_000_000_000_000n, // 1000× too high
        userIntendedAtomic: 5_000_000_000_000_000n,
        ticker: "ETH",
        decimals: 18,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafetyInvariantError);
    const e = caught as SafetyInvariantError;
    expect(e.invariant).toBe("QUOTE_AMOUNT_VS_USER_INTENT");
  });

  it("throws on the historical 5-sextillion-ETH bug (10^18× drift)", () => {
    expect(() =>
      assertQuoteAmountMatchesUserIntent({
        quoteAmountAtomic: 5_000_000_000_000_000_000_000_000_000_000_000n, // 5×10^33
        userIntendedAtomic: 5_000_000_000_000_000n, // 5×10^15
        ticker: "ETH",
        decimals: 18,
      })
    ).toThrow(SafetyInvariantError);
  });

  it("throws on zero user-intended (catches form-state bug)", () => {
    expect(() =>
      assertQuoteAmountMatchesUserIntent({
        quoteAmountAtomic: 1n,
        userIntendedAtomic: 0n,
        ticker: "ETH",
        decimals: 18,
      })
    ).toThrow(SafetyInvariantError);
  });

  it("throws on >1% drift in either direction", () => {
    // 2% over.
    expect(() =>
      assertQuoteAmountMatchesUserIntent({
        quoteAmountAtomic: 1_020_000_000_000_000_000n,
        userIntendedAtomic: 1_000_000_000_000_000_000n,
        ticker: "ETH",
        decimals: 18,
      })
    ).toThrow(SafetyInvariantError);
    // 2% under.
    expect(() =>
      assertQuoteAmountMatchesUserIntent({
        quoteAmountAtomic: 980_000_000_000_000_000n,
        userIntendedAtomic: 1_000_000_000_000_000_000n,
        ticker: "ETH",
        decimals: 18,
      })
    ).toThrow(SafetyInvariantError);
  });
});

// ───────────────────────────────────────────────────────────────────
// Invariant #2 — built tx value === quote.amountIn (exact)
// ───────────────────────────────────────────────────────────────────

describe("assertTxValueMatchesQuote", () => {
  it("passes when tx value exactly matches quote", () => {
    expect(() =>
      assertTxValueMatchesQuote({
        txValueAtomic: 5_000_000_000_000_000n,
        quoteAmountAtomic: 5_000_000_000_000_000n,
        ticker: "ETH",
      })
    ).not.toThrow();
  });

  it("throws when tx value differs by 1 wei", () => {
    expect(() =>
      assertTxValueMatchesQuote({
        txValueAtomic: 5_000_000_000_000_001n,
        quoteAmountAtomic: 5_000_000_000_000_000n,
        ticker: "ETH",
      })
    ).toThrow(SafetyInvariantError);
  });

  it("throws when tx value is the historical 10^18× over-conversion", () => {
    let caught: unknown = null;
    try {
      assertTxValueMatchesQuote({
        txValueAtomic: 5_000_000_000_000_000_000_000_000_000_000_000n,
        quoteAmountAtomic: 5_000_000_000_000_000n,
        ticker: "ETH",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafetyInvariantError);
    expect((caught as SafetyInvariantError).invariant).toBe("TX_VALUE_VS_QUOTE");
  });
});

// ───────────────────────────────────────────────────────────────────
// Invariant #3 — tx is fundable
// ───────────────────────────────────────────────────────────────────

describe("assertTxFundable", () => {
  it("passes when value + gas <= balance", () => {
    expect(() =>
      assertTxFundable({
        valueAtomic: 1_000_000_000_000_000n,
        gasCostAtomic: 21_000_000_000_000n,
        balanceAtomic: 2_000_000_000_000_000n,
        ticker: "ETH",
      })
    ).not.toThrow();
  });

  it("throws on insufficient funds", () => {
    expect(() =>
      assertTxFundable({
        valueAtomic: 5_000_000_000_000_000n,
        gasCostAtomic: 1_000_000_000_000_000n,
        balanceAtomic: 5_000_000_000_000_000n, // can't cover gas
        ticker: "ETH",
      })
    ).toThrow(SafetyInvariantError);
  });
});

// ───────────────────────────────────────────────────────────────────
// Invariant #4 — tx value <= 2× balance
// ───────────────────────────────────────────────────────────────────

describe("assertTxNotPlausibleOverspend", () => {
  it("passes when value <= 2× balance", () => {
    expect(() =>
      assertTxNotPlausibleOverspend({
        valueAtomic: 1_000_000_000_000_000n,
        balanceAtomic: 1_000_000_000_000_000n,
        ticker: "ETH",
      })
    ).not.toThrow();
  });

  it("throws when value > 2× balance (5-sextillion-ETH scenario)", () => {
    let caught: unknown = null;
    try {
      assertTxNotPlausibleOverspend({
        valueAtomic: 5_000_000_000_000_000_000_000_000_000_000_000n,
        balanceAtomic: 5_000_000_000_000_000n,
        ticker: "ETH",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafetyInvariantError);
    expect((caught as SafetyInvariantError).invariant).toBe("TX_PLAUSIBLE_OVERSPEND");
  });

  it("returns silently when balance is zero (defers to fundability check)", () => {
    expect(() =>
      assertTxNotPlausibleOverspend({
        valueAtomic: 1n,
        balanceAtomic: 0n,
        ticker: "ETH",
      })
    ).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────
// Invariant #5 — signed tx value + recipient match what we built
// ───────────────────────────────────────────────────────────────────

describe("assertSignedTxValueMatches + decodeEvmSignedTx", () => {
  it("decodes a legacy EVM tx and round-trips to/value", () => {
    const raw = makeSignedLegacyTx({
      to: "0x0000000000000000000000000000000000000002",
      value: 5_000_000_000_000_000n,
    });
    const decoded = decodeEvmSignedTx(raw);
    expect(decoded.to.toLowerCase()).toBe("0x0000000000000000000000000000000000000002");
    expect(decoded.value).toBe(5_000_000_000_000_000n);
  });

  it("passes when signed tx matches expected value + recipient", () => {
    const raw = makeSignedLegacyTx({
      to: "0x0000000000000000000000000000000000000002",
      value: 5_000_000_000_000_000n,
    });
    expect(() =>
      assertSignedTxValueMatches({
        rawSignedTxHex: raw,
        expectedValueAtomic: 5_000_000_000_000_000n,
        expectedRecipient: "0x0000000000000000000000000000000000000002",
        ticker: "ETH",
      })
    ).not.toThrow();
  });

  it("throws when signed tx value differs from expected", () => {
    const raw = makeSignedLegacyTx({
      to: "0x0000000000000000000000000000000000000002",
      value: 9_999_999_999_999_999n, // wrong
    });
    let caught: unknown = null;
    try {
      assertSignedTxValueMatches({
        rawSignedTxHex: raw,
        expectedValueAtomic: 5_000_000_000_000_000n,
        expectedRecipient: "0x0000000000000000000000000000000000000002",
        ticker: "ETH",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafetyInvariantError);
    expect((caught as SafetyInvariantError).invariant).toBe("SIGNED_TX_VALUE_DRIFT");
  });

  it("throws when signed tx recipient differs from expected", () => {
    const raw = makeSignedLegacyTx({
      to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      value: 5_000_000_000_000_000n,
    });
    let caught: unknown = null;
    try {
      assertSignedTxValueMatches({
        rawSignedTxHex: raw,
        expectedValueAtomic: 5_000_000_000_000_000n,
        expectedRecipient: "0x0000000000000000000000000000000000000002",
        ticker: "ETH",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafetyInvariantError);
    expect((caught as SafetyInvariantError).invariant).toBe("SIGNED_TX_RECIPIENT_DRIFT");
  });
});

// ───────────────────────────────────────────────────────────────────
// Invariant #6 — verified hash matches local keccak256
// ───────────────────────────────────────────────────────────────────

describe("assertVerifiedHashMatches", () => {
  it("passes when verified hash equals keccak256(signedTx)", () => {
    const raw = makeSignedLegacyTx({
      to: "0x0000000000000000000000000000000000000002",
      value: 5_000_000_000_000_000n,
    });
    const expected =
      "0x" +
      Array.from(keccak_256(hexToBytes(raw.slice(2))))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    expect(() =>
      assertVerifiedHashMatches({
        rawSignedTxHex: raw,
        verifiedHash: expected,
      })
    ).not.toThrow();
  });

  it("throws when network returns a different hash than the signed tx produces", () => {
    const raw = makeSignedLegacyTx({
      to: "0x0000000000000000000000000000000000000002",
      value: 5_000_000_000_000_000n,
    });
    let caught: unknown = null;
    try {
      assertVerifiedHashMatches({
        rawSignedTxHex: raw,
        verifiedHash: "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafetyInvariantError);
    expect((caught as SafetyInvariantError).invariant).toBe("VERIFIED_HASH_MISMATCH");
  });
});

// ───────────────────────────────────────────────────────────────────
// Non-EVM invariants
// ───────────────────────────────────────────────────────────────────

describe("assertSolTransferShape", () => {
  const SYS = "11111111111111111111111111111111";
  it("passes for a plain SystemProgram.transfer with matching recipient + amount", () => {
    expect(() =>
      assertSolTransferShape({
        programIdBase58: SYS,
        expectedRecipient: "Recipient111",
        recipientFromTx: "Recipient111",
        amountAtomic: 1_000_000n,
        expectedAmountAtomic: 1_000_000n,
      })
    ).not.toThrow();
  });

  it("throws when program is not SystemProgram", () => {
    expect(() =>
      assertSolTransferShape({
        programIdBase58: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        expectedRecipient: "X",
        recipientFromTx: "X",
        amountAtomic: 1n,
        expectedAmountAtomic: 1n,
      })
    ).toThrow(SafetyInvariantError);
  });

  it("throws when recipient differs", () => {
    expect(() =>
      assertSolTransferShape({
        programIdBase58: SYS,
        expectedRecipient: "Expected1",
        recipientFromTx: "Different1",
        amountAtomic: 1n,
        expectedAmountAtomic: 1n,
      })
    ).toThrow(SafetyInvariantError);
  });

  it("throws when lamports value differs", () => {
    expect(() =>
      assertSolTransferShape({
        programIdBase58: SYS,
        expectedRecipient: "X",
        recipientFromTx: "X",
        amountAtomic: 1n,
        expectedAmountAtomic: 2n,
      })
    ).toThrow(SafetyInvariantError);
  });
});

describe("assertNearTransferShape", () => {
  it("passes for a Transfer action (tag 3) with matching recipient + amount", () => {
    expect(() =>
      assertNearTransferShape({
        actionTag: 3,
        expectedRecipient: "alice.near",
        recipientFromTx: "alice.near",
        yoctoAmountFromTx: 1_000_000_000_000_000_000_000_000n,
        expectedYoctoAmount: 1_000_000_000_000_000_000_000_000n,
      })
    ).not.toThrow();
  });

  it("throws when action tag is not Transfer (3)", () => {
    expect(() =>
      assertNearTransferShape({
        actionTag: 0, // CreateAccount
        expectedRecipient: "x",
        recipientFromTx: "x",
        yoctoAmountFromTx: 1n,
        expectedYoctoAmount: 1n,
      })
    ).toThrow(SafetyInvariantError);
  });
});

describe("assertPsbtOutputShape", () => {
  it("passes when the deposit output exists with the right value", () => {
    expect(() =>
      assertPsbtOutputShape({
        outputs: [
          { address: "bc1qdeposit", valueSat: 50_000n },
          { address: "bc1qchange", valueSat: 10_000n },
        ],
        expectedRecipient: "bc1qdeposit",
        expectedValueSat: 50_000n,
        ticker: "BTC",
      })
    ).not.toThrow();
  });

  it("throws when no output goes to the expected recipient", () => {
    expect(() =>
      assertPsbtOutputShape({
        outputs: [{ address: "bc1qattacker", valueSat: 50_000n }],
        expectedRecipient: "bc1qdeposit",
        expectedValueSat: 50_000n,
        ticker: "BTC",
      })
    ).toThrow(SafetyInvariantError);
  });

  it("throws when the deposit output's value differs from the quote", () => {
    expect(() =>
      assertPsbtOutputShape({
        outputs: [{ address: "bc1qdeposit", valueSat: 49_999n }],
        expectedRecipient: "bc1qdeposit",
        expectedValueSat: 50_000n,
        ticker: "BTC",
      })
    ).toThrow(SafetyInvariantError);
  });
});

// ───────────────────────────────────────────────────────────────────
// SafetyInvariantError surface
// ───────────────────────────────────────────────────────────────────

describe("SafetyInvariantError", () => {
  it("toCopyText produces a structured copy-friendly format", () => {
    const e = new SafetyInvariantError({
      invariant: "TX_VALUE_VS_QUOTE",
      message: "test",
      context: { ticker: "ETH", expected: "5", got: "5000000" },
    });
    const text = e.toCopyText();
    expect(text).toContain("[SafetyInvariantError]");
    expect(text).toContain("invariant: TX_VALUE_VS_QUOTE");
    expect(text).toContain("ticker: ETH");
    expect(text).toContain("expected: 5");
    expect(text).toContain("got: 5000000");
    // ISO timestamp present.
    expect(text).toMatch(/at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
