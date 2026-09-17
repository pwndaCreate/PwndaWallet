/**
 * Quote relay rules (2026-09-15, Zephyr send pricing).
 *
 * The Send modal now prices a Zephyr send by building it without broadcasting.
 * `useSend` broadcasts THAT transaction only when it is exactly the send being
 * made and recent; anything else is rebuilt. Relaying a quote for a different
 * recipient, amount or asset would send something the user did not confirm, so
 * every way a quote can stop matching is pinned here.
 */
import { describe, it, expect } from "vitest";
import type { SendQuote } from "./types";
import {
  SEND_QUOTE_MAX_AGE_MS,
  SendQuoteError,
  isDefinitiveQuoteError,
  quoteErrorKind,
  quoteMatchesSend,
} from "./send-quote";

const TO = "ZEPHYR2qjmpfgEjnpvUnmcW84J5q3uvP5Z5oc8h6F9zsTrhpFkPg";
const NOW = 1_800_000_000_000;

const quote = (over: Partial<SendQuote> = {}): SendQuote => ({
  to: TO,
  amount: "1.5",
  assetType: "ZSD",
  fee: "0.0012",
  feeTicker: "ZEPHUSD",
  quotedAt: NOW - 10_000,
  ticket: { txMetadata: "abcd" },
  ...over,
});

describe("quoteMatchesSend", () => {
  const send = { to: TO, amount: "1.5", assetType: "ZSD" };

  it("relays a recent quote for exactly this send", () => {
    expect(quoteMatchesSend(quote(), send, NOW)).toBe(true);
  });

  it("compares the trimmed form the modal priced", () => {
    expect(quoteMatchesSend(quote(), { to: ` ${TO} `, amount: " 1.5", assetType: "ZSD" }, NOW)).toBe(true);
  });

  it("never relays for a different recipient, amount or asset", () => {
    expect(quoteMatchesSend(quote(), { ...send, to: TO + "x" }, NOW)).toBe(false);
    expect(quoteMatchesSend(quote(), { ...send, amount: "1.50" }, NOW)).toBe(false);
    expect(quoteMatchesSend(quote(), { ...send, assetType: "ZRS" }, NOW)).toBe(false);
    // A ZEPH quote is not a ZEPHUSD send, and vice versa.
    expect(quoteMatchesSend(quote({ assetType: undefined }), send, NOW)).toBe(false);
    expect(quoteMatchesSend(quote(), { ...send, assetType: undefined }, NOW)).toBe(false);
  });

  it("rebuilds instead of relaying once the quote is 90 s old", () => {
    expect(quoteMatchesSend(quote({ quotedAt: NOW - (SEND_QUOTE_MAX_AGE_MS - 1) }), send, NOW)).toBe(true);
    expect(quoteMatchesSend(quote({ quotedAt: NOW - SEND_QUOTE_MAX_AGE_MS }), send, NOW)).toBe(false);
    // A quote from the future (clock moved backwards) is not trusted either.
    expect(quoteMatchesSend(quote({ quotedAt: NOW + 1 }), send, NOW)).toBe(false);
  });

  it("rejects non-quotes: a click event, null, a quote with no transaction", () => {
    expect(quoteMatchesSend({ type: "click", target: {} }, send, NOW)).toBe(false);
    expect(quoteMatchesSend(undefined, send, NOW)).toBe(false);
    expect(quoteMatchesSend(null, send, NOW)).toBe(false);
    expect(quoteMatchesSend(quote({ ticket: null }), send, NOW)).toBe(false);
    expect(quoteMatchesSend(quote({ quotedAt: Number.NaN }), send, NOW)).toBe(false);
  });
});

describe("quote failure classification", () => {
  it("blocks only on insufficient funds or an invalid address", () => {
    expect(isDefinitiveQuoteError(new SendQuoteError("insufficient-funds", "x"))).toBe(true);
    expect(isDefinitiveQuoteError(new SendQuoteError("invalid-address", "x"))).toBe(true);
    expect(isDefinitiveQuoteError(new SendQuoteError("not-ready", "x"))).toBe(false);
    expect(isDefinitiveQuoteError(new SendQuoteError("other", "x"))).toBe(false);
  });

  it("treats unclassified rejections, including Tauri's plain strings, as advisory", () => {
    expect(quoteErrorKind("RPC error -32601: Method not found")).toBe("other");
    expect(isDefinitiveQuoteError("RPC error -32601: Method not found")).toBe(false);
    expect(isDefinitiveQuoteError(new Error("not enough money"))).toBe(false);
  });
});
