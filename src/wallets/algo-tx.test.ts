/**
 * Algorand canonical-msgpack encoder.
 *
 * These pin the RULES. They cannot prove the rules are the ones Algorand actually
 * uses — a unit test only ever proves the encoder matches my reading of the spec. The
 * authority is a node, so `scripts/verify-algo-tx.mjs` submits a real signed payment
 * from an unfunded account and checks that algod (a) decodes it, (b) verifies the
 * signature, and (c) echoes back the same transaction id we computed locally. Run that
 * after touching anything in `algo-tx.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  encodeCanonicalMap,
  addressToPublicKey,
  algoToMicro,
  encodePayTransaction,
  transactionId,
  ALGO_MIN_BALANCE_MICRO,
} from "./algo-tx";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("canonical msgpack — the three rules that silently break signatures", () => {
  it("omits zero, empty-string and empty-bytes fields entirely", () => {
    // Rule 2. Encoding `amt: 0` as an actual zero produces a transaction that
    // still submits and still fails, with no hint why — the signature covers
    // different bytes than the node hashes.
    const withZeros = encodeCanonicalMap({
      a: 0n,
      b: "",
      c: new Uint8Array(0),
      d: 1n,
    });
    const withoutZeros = encodeCanonicalMap({ d: 1n });
    expect(hex(withZeros)).toBe(hex(withoutZeros));
    // fixmap with exactly ONE entry
    expect(withZeros[0]).toBe(0x81);
  });

  it("sorts keys byte-wise, not in insertion order", () => {
    const a = encodeCanonicalMap({ snd: 1n, amt: 2n, fee: 3n });
    const b = encodeCanonicalMap({ fee: 3n, amt: 2n, snd: 1n });
    expect(hex(a)).toBe(hex(b));
    // "amt" must come first
    expect(hex(a).startsWith("83" + "a3" + Buffer.from("amt").toString("hex"))).toBe(true);
  });

  it("uses the shortest integer encoding for each width", () => {
    // positive fixint / uint8 / uint16 / uint32 / uint64
    expect(hex(encodeCanonicalMap({ v: 1n }))).toContain("01");
    expect(hex(encodeCanonicalMap({ v: 200n }))).toContain("ccc8");
    expect(hex(encodeCanonicalMap({ v: 1000n }))).toContain("cd03e8");
    expect(hex(encodeCanonicalMap({ v: 70000n }))).toContain("ce00011170");
    expect(hex(encodeCanonicalMap({ v: 5_000_000_000n }))).toContain("cf000000012a05f200");
  });

  it("encodes byte strings as bin and text as str", () => {
    // Rule 4 — addresses and the genesis hash are 32 RAW bytes, never base32 text.
    const asBin = encodeCanonicalMap({ k: new Uint8Array([1, 2, 3]) });
    expect(hex(asBin)).toContain("c403010203");
    const asStr = encodeCanonicalMap({ k: "pay" });
    expect(hex(asStr)).toContain("a3" + Buffer.from("pay").toString("hex"));
  });
});

describe("addresses", () => {
  // Algorand Foundation fee sink — a real mainnet address.
  const REAL = "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA";

  it("decodes a real address to 32 bytes", () => {
    expect(addressToPublicKey(REAL).length).toBe(32);
  });

  it("rejects a wrong-length address", () => {
    expect(() => addressToPublicKey("TOOSHORT")).toThrow(/58 characters/);
  });

  it("rejects a corrupted checksum rather than sending into the void", () => {
    // Flip one character in the checksum region. Base32 keeps it decodable, so
    // only the checksum catches it — which is the entire point of having one.
    const broken = REAL.slice(0, 55) + (REAL[55] === "A" ? "B" : "A") + REAL.slice(56);
    expect(() => addressToPublicKey(broken)).toThrow(/checksum/);
  });
});

describe("amounts", () => {
  it("converts decimal ALGO to microAlgos exactly", () => {
    expect(algoToMicro("1")).toBe(1_000_000n);
    expect(algoToMicro("0.000001")).toBe(1n);
    expect(algoToMicro("14.9")).toBe(14_900_000n);
  });

  it("refuses more precision than the chain has", () => {
    expect(() => algoToMicro("1.0000001")).toThrow(/6 decimal places/);
  });

  it("refuses junk instead of coercing it to a number", () => {
    expect(() => algoToMicro("1.2.3")).toThrow(/Invalid/);
    expect(() => algoToMicro("abc")).toThrow(/Invalid/);
  });

  it("keeps precision a float would lose", () => {
    // 9007199254740993 microAlgos is 2^53+1 — not representable as a double.
    expect(algoToMicro("9007199254.740993")).toBe(9_007_199_254_740_993n);
  });
});

describe("payment transaction", () => {
  const params = {
    fee: 1000n,
    minFee: 1000n,
    firstValid: 50_000_000n,
    lastValid: 50_001_000n,
    genesisId: "mainnet-v1.0",
    genesisHash: new Uint8Array(32).fill(7),
  };
  const from = new Uint8Array(32).fill(1);
  const to = new Uint8Array(32).fill(2);

  it("produces a stable encoding for identical inputs", () => {
    const a = encodePayTransaction({ from, to, amountMicro: 100n, params });
    const b = encodePayTransaction({ from, to, amountMicro: 100n, params });
    expect(hex(a)).toBe(hex(b));
  });

  it("drops the note field when there is no note", () => {
    const withNote = encodePayTransaction({
      from, to, amountMicro: 100n, params,
      note: new TextEncoder().encode("hi"),
    });
    const without = encodePayTransaction({ from, to, amountMicro: 100n, params });
    expect(withNote.length).toBeGreaterThan(without.length);
    expect(hex(without)).not.toContain(Buffer.from("note").toString("hex"));
  });

  it("gives a different transaction id for a different amount", () => {
    const a = transactionId(encodePayTransaction({ from, to, amountMicro: 100n, params }));
    const b = transactionId(encodePayTransaction({ from, to, amountMicro: 101n, params }));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]{52}$/); // unpadded base32, 32-byte digest
  });
});

describe("minimum balance", () => {
  it("is 0.1 ALGO", () => {
    // Not cosmetic: spending into the reserve fails at the node, so `sendAlgo`
    // checks it up front and explains it rather than letting algod reject after
    // the user has confirmed.
    expect(ALGO_MIN_BALANCE_MICRO).toBe(100_000n);
  });
});
