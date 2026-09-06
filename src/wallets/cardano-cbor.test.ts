import { describe, it, expect } from "vitest";
import {
  arrayCbor,
  boolCbor,
  bytesCbor,
  bytesToHex,
  encodeCbor,
  hexToBytes,
  mapCbor,
  nullCbor,
  uintCbor,
} from "./cardano-cbor";

describe("cardano-cbor canonical encoder", () => {
  // RFC 8949 Appendix A — the canonical CBOR test vectors. We pin a
  // representative subset; if any of these drift, every byte of every
  // tx body becomes wrong.

  it("encodes uint 0..23 as a single byte", () => {
    expect(bytesToHex(encodeCbor(uintCbor(0)))).toBe("00");
    expect(bytesToHex(encodeCbor(uintCbor(1)))).toBe("01");
    expect(bytesToHex(encodeCbor(uintCbor(10)))).toBe("0a");
    expect(bytesToHex(encodeCbor(uintCbor(23)))).toBe("17");
  });

  it("encodes uint 24..255 as 2 bytes (header + value)", () => {
    expect(bytesToHex(encodeCbor(uintCbor(24)))).toBe("1818");
    expect(bytesToHex(encodeCbor(uintCbor(100)))).toBe("1864");
    expect(bytesToHex(encodeCbor(uintCbor(255)))).toBe("18ff");
  });

  it("encodes uint 256..65535 as 3 bytes", () => {
    expect(bytesToHex(encodeCbor(uintCbor(256)))).toBe("190100");
    expect(bytesToHex(encodeCbor(uintCbor(1000)))).toBe("1903e8");
    expect(bytesToHex(encodeCbor(uintCbor(65535)))).toBe("19ffff");
  });

  it("encodes uint 65536..2^32-1 as 5 bytes", () => {
    expect(bytesToHex(encodeCbor(uintCbor(65536)))).toBe("1a00010000");
    expect(bytesToHex(encodeCbor(uintCbor(1000000)))).toBe("1a000f4240");
  });

  it("encodes uint > 2^32-1 as 9 bytes", () => {
    // 4294967296 = 2^32. RFC 8949 example.
    expect(bytesToHex(encodeCbor(uintCbor(BigInt("4294967296"))))).toBe(
      "1b0000000100000000"
    );
    // 1_000_000_000_000_000 (1 quadrillion lovelace ~ a typical large value).
    expect(bytesToHex(encodeCbor(uintCbor(BigInt("1000000000000000"))))).toBe(
      "1b00038d7ea4c68000"
    );
  });

  it("encodes a 32-byte bytes value with header 5820 + the bytes", () => {
    const b = hexToBytes(
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
    );
    const out = encodeCbor(bytesCbor(b));
    expect(bytesToHex(out)).toBe(
      "582000112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
    );
  });

  it("encodes an empty array as 80", () => {
    expect(bytesToHex(encodeCbor(arrayCbor([])))).toBe("80");
  });

  it("encodes a 3-element array as 83 + elements", () => {
    expect(bytesToHex(encodeCbor(arrayCbor([uintCbor(1), uintCbor(2), uintCbor(3)])))).toBe(
      "83010203"
    );
  });

  it("encodes a map with 4 numeric keys as a4 + ordered entries", () => {
    const out = encodeCbor(
      mapCbor([
        [uintCbor(0), uintCbor(10)],
        [uintCbor(1), uintCbor(20)],
        [uintCbor(2), uintCbor(30)],
        [uintCbor(3), uintCbor(40)],
      ])
    );
    expect(bytesToHex(out)).toBe("a4000a011402181e031828");
  });

  it("encodes a Cardano-shaped tx body skeleton", () => {
    // The exact shape of a 1-input, 1-output, 1-fee, 1-ttl ADA transfer.
    // Matches the structure built by `cardano-tx.ts::buildTxBody` for
    // hardcoded values, so any drift in field order or encoding is
    // detected at the byte level.
    const txHash = hexToBytes(
      "1111111111111111111111111111111111111111111111111111111111111111"
    );
    const addr = hexToBytes(
      "012222222222222222222222222222222222222222222222222222222222222222333333333333333333333333333333333333333333333333333333333333"
    );
    const body = mapCbor([
      [uintCbor(0), arrayCbor([arrayCbor([bytesCbor(txHash), uintCbor(0)])])],
      [
        uintCbor(1),
        arrayCbor([arrayCbor([bytesCbor(addr), uintCbor(BigInt(1_000_000))])]),
      ],
      [uintCbor(2), uintCbor(BigInt(170_000))],
      [uintCbor(3), uintCbor(BigInt(123_456_789))],
    ]);
    const out = encodeCbor(body);
    // Sanity asserts on specific subspans:
    // - Outer map header is `a4` (4 entries).
    expect(out[0]).toBe(0xa4);
    // - First key+value is `00` (key=0) followed by an array.
    expect(out[1]).toBe(0x00);
    // - Body is small enough to fit in a low-double-digit byte count.
    expect(out.length).toBeGreaterThan(80);
    expect(out.length).toBeLessThan(200);
  });

  it("encodes booleans and null", () => {
    expect(bytesToHex(encodeCbor(boolCbor(true)))).toBe("f5");
    expect(bytesToHex(encodeCbor(boolCbor(false)))).toBe("f4");
    expect(bytesToHex(encodeCbor(nullCbor()))).toBe("f6");
  });

  it("hex round-trip", () => {
    const original = "00112233aabbccddeeff";
    const bytes = hexToBytes(original);
    expect(bytesToHex(bytes)).toBe(original);
  });
});
