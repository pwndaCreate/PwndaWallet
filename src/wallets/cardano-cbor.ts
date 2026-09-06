/**
 * Minimal CBOR encoder for Cardano transactions. Implements only the
 * primitives Cardano txs need (uint, bytes, text, array, map, tagged) —
 * not a full CBOR library. The Cardano blockchain is strict about
 * canonical CBOR, so this encoder always uses the shortest possible
 * encoding for each value (RFC 8949 §4.2.1 "Core Deterministic Encoding").
 *
 * Why hand-rolled instead of `cbor-x` / `cborg`:
 *   - The encoder surface we need is ~80 lines.
 *   - Cardano's strictness rules (canonical key sort, definite-length
 *     containers, smallest-form integers) are easier to enforce when we
 *     own every byte produced.
 *   - Avoids a 50–100 KB dep for code that's only used by one chain.
 */

// ---------------------------------------------------------------------------
// Major-type constants
// ---------------------------------------------------------------------------

const MT_UINT = 0;
const MT_BYTES = 2;
const MT_TEXT = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;
const MT_TAGGED = 6;
const MT_OTHER = 7;

// ---------------------------------------------------------------------------
// Output buffer
// ---------------------------------------------------------------------------

class CborWriter {
  private chunks: Uint8Array[] = [];

  append(b: Uint8Array): void {
    this.chunks.push(b);
  }

  toBytes(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Header encoder (major type + length-or-value, smallest form)
// ---------------------------------------------------------------------------

function writeHead(w: CborWriter, mt: number, value: number | bigint): void {
  // RFC 8949 §3 — five length-encoding modes:
  //   0..23     : 1 byte  (mt<<5 | value)
  //   24..255   : 2 bytes (mt<<5 | 24, value)
  //   256..2^16-1 : 3 bytes (mt<<5 | 25, value-be16)
  //   2^16..2^32-1 : 5 bytes (mt<<5 | 26, value-be32)
  //   2^32..2^64-1 : 9 bytes (mt<<5 | 27, value-be64)
  const v = typeof value === "bigint" ? value : BigInt(value);
  const top = mt << 5;
  if (v < 24n) {
    w.append(new Uint8Array([top | Number(v)]));
  } else if (v < 256n) {
    w.append(new Uint8Array([top | 24, Number(v)]));
  } else if (v < 65536n) {
    const buf = new Uint8Array(3);
    buf[0] = top | 25;
    buf[1] = Number((v >> 8n) & 0xffn);
    buf[2] = Number(v & 0xffn);
    w.append(buf);
  } else if (v < 4294967296n) {
    const buf = new Uint8Array(5);
    buf[0] = top | 26;
    buf[1] = Number((v >> 24n) & 0xffn);
    buf[2] = Number((v >> 16n) & 0xffn);
    buf[3] = Number((v >> 8n) & 0xffn);
    buf[4] = Number(v & 0xffn);
    w.append(buf);
  } else {
    const buf = new Uint8Array(9);
    buf[0] = top | 27;
    for (let i = 0; i < 8; i++) {
      buf[1 + i] = Number((v >> BigInt((7 - i) * 8)) & 0xffn);
    }
    w.append(buf);
  }
}

// ---------------------------------------------------------------------------
// Type-level encoders
// ---------------------------------------------------------------------------

export type CborValue =
  | { kind: "uint"; value: bigint | number }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "text"; value: string }
  | { kind: "array"; values: CborValue[] }
  | { kind: "map"; entries: Array<[CborValue, CborValue]> }
  | { kind: "tagged"; tag: number; value: CborValue }
  | { kind: "bool"; value: boolean }
  | { kind: "null" };

export function uintCbor(n: bigint | number): CborValue {
  return { kind: "uint", value: n };
}
export function bytesCbor(b: Uint8Array): CborValue {
  return { kind: "bytes", value: b };
}
export function arrayCbor(values: CborValue[]): CborValue {
  return { kind: "array", values };
}
export function mapCbor(entries: Array<[CborValue, CborValue]>): CborValue {
  return { kind: "map", entries };
}
export function taggedCbor(tag: number, value: CborValue): CborValue {
  return { kind: "tagged", tag, value };
}
export function nullCbor(): CborValue {
  return { kind: "null" };
}
export function boolCbor(value: boolean): CborValue {
  return { kind: "bool", value };
}

function writeValue(w: CborWriter, v: CborValue): void {
  switch (v.kind) {
    case "uint":
      writeHead(w, MT_UINT, BigInt(v.value));
      return;
    case "bytes":
      writeHead(w, MT_BYTES, v.value.length);
      w.append(v.value);
      return;
    case "text": {
      const utf8 = new TextEncoder().encode(v.value);
      writeHead(w, MT_TEXT, utf8.length);
      w.append(utf8);
      return;
    }
    case "array":
      writeHead(w, MT_ARRAY, v.values.length);
      for (const x of v.values) writeValue(w, x);
      return;
    case "map":
      // Cardano canonical CBOR mandates definite-length maps with
      // smallest-form integer keys. We do NOT sort here — the caller
      // builds the map in the canonical order Cardano expects (numeric
      // keys ascending; tx body is { 0, 1, 2, 3 }). Adding a sort would
      // mishandle non-uint keys, so we trust the caller.
      writeHead(w, MT_MAP, v.entries.length);
      for (const [k, x] of v.entries) {
        writeValue(w, k);
        writeValue(w, x);
      }
      return;
    case "tagged":
      writeHead(w, MT_TAGGED, v.tag);
      writeValue(w, v.value);
      return;
    case "bool":
      // Major type 7, simple values 20 (false) / 21 (true).
      w.append(new Uint8Array([(MT_OTHER << 5) | (v.value ? 21 : 20)]));
      return;
    case "null":
      w.append(new Uint8Array([(MT_OTHER << 5) | 22]));
      return;
  }
}

export function encodeCbor(v: CborValue): Uint8Array {
  const w = new CborWriter();
  writeValue(w, v);
  return w.toBytes();
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
