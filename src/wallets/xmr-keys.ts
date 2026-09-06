/**
 * Pure-JS Monero key helpers (no WASM, no monero-ts).
 *
 * Implements the offline parts of Monero key handling that PwndaWallet
 * needs at wallet-creation / import time, before the monero-wallet-rpc
 * sidecar is running:
 *
 *   - generateXmrSeed()       — fresh 25-word legacy electrum-style seed
 *   - xmrAddressFromSeed(s)   — primary mainnet address ("4...") from a seed
 *   - validateXmrSeed(s)      — wordlist + checksum validation, no network
 *   - normalizeXmrSeed(s)     — whitespace cleanup
 *
 * The on-line parts (sync, balance, send) live in xmr-wallet.ts and go
 * through the sidecar via xmr-rpc.ts.
 *
 * ---
 *
 * Why pure JS:
 *
 * The previous implementation imported monero-ts (a wrapper around the
 * Monero project's wallet2 C++ code compiled to WebAssembly). monero-ts's
 * `LibraryUtils.loadKeysModule()` calls `require("../../../../dist/monero_wallet_keys")`
 * directly on the main thread. Vite/esbuild handled this in dev, but
 * Rollup-CJS in production builds left the literal `require(...)` call
 * in the bundle, so seed validation in the packaged .msi crashed with
 * `ReferenceError: require is not defined`.
 *
 * Reimplementing the four offline operations against @noble/curves and
 * @noble/hashes (already in the dependency tree) eliminates the entire
 * WASM/CJS pipeline for the offline path. The sidecar still owns
 * everything that touches the chain.
 *
 * ---
 *
 * Algorithm references:
 *   - https://www.getmonero.org/resources/moneropedia/mnemonicseed.html
 *   - monero/src/mnemonics/electrum-words.cpp (encoding/decoding)
 *   - monero/src/mnemonics/language_base.h    (checksum: crc32 of 3-char prefixes mod 24)
 *   - monero/src/cryptonote_basic/account.cpp (spend → view secret = sc_reduce32(keccak(spend)))
 *   - monero/src/cryptonote_basic/cryptonote_format_utils.cpp (address = base58(net || S || V || keccak4))
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  MONERO_ENGLISH_WORDS,
  MONERO_ENGLISH_PREFIX_LEN,
} from "./xmr-wordlist";
import { secureRandomBytes, bytesEqual } from "../secure-random";

// ---------- Wordlist helpers ----------

const N = MONERO_ENGLISH_WORDS.length; // 1626
const N_BIG = BigInt(N);

/**
 * Map of word OR 3-letter prefix → index, so users can paste either the
 * full word ("abbey") or the prefix form ("abb"), matching Monero CLI.
 */
const WORD_INDEX: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const w = MONERO_ENGLISH_WORDS[i];
    m.set(w, i);
    m.set(w.slice(0, MONERO_ENGLISH_PREFIX_LEN), i);
  }
  return m;
})();

// ed25519 group order l (mod for scalars)
const L = ed25519.Point.Fn.ORDER;

// Mainnet primary-address network byte
const MAINNET_NETWORK_BYTE = 0x12;

// Monero base58 alphabet
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Encoded length per binary block size: index = bytes, value = chars
const B58_ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const B58_FULL_BLOCK_SIZE = 8;
const B58_FULL_ENCODED_BLOCK_SIZE = 11;

// ---------- Whitespace normalization ----------

/**
 * Normalize a Monero seed string:
 *   - trim leading/trailing whitespace
 *   - collapse runs of whitespace (spaces, tabs, newlines) to a single space
 *   - lowercase (the Monero wordlist is all lowercase)
 *
 * Users routinely paste seeds copied from PDFs / OCR with stray newlines,
 * double spaces, and stray capitalization. Normalizing here prevents the
 * wordlist lookup from rejecting valid seeds for cosmetic reasons.
 */
export function normalizeXmrSeed(seed: string): string {
  return seed.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------- CRC32 (IEEE 802.3) ----------

/**
 * Standard CRC-32 / IEEE-802.3 (zlib polynomial 0xEDB88320, reflected).
 * Matches `boost::crc_32_type` used in monero/src/mnemonics/language_base.h.
 */
function crc32(input: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i);
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Monero checksum word for an array of 24 (or 25) seed words: take the
 * first 3 chars of each of the first 24 words, concatenate, CRC32,
 * mod 24, and the result is the index into the 24 words of the
 * checksum word. The 25th word is set to the word at that index.
 */
function checksumWord(words: string[]): string {
  const trimmed = words
    .slice(0, 24)
    .map((w) => w.slice(0, MONERO_ENGLISH_PREFIX_LEN))
    .join("");
  const idx = crc32(trimmed) % 24;
  return words[idx];
}

// ---------- Bytes ↔ Words ----------

/** Read a little-endian uint32 from a 4-byte slice. */
function readUInt32LE(b: Uint8Array, offset: number): number {
  return (
    (b[offset] |
      (b[offset + 1] << 8) |
      (b[offset + 2] << 16) |
      (b[offset + 3] << 24)) >>>
    0
  );
}

/** Write a little-endian uint32 into a 4-byte slice. */
function writeUInt32LE(b: Uint8Array, offset: number, value: number): void {
  b[offset] = value & 0xff;
  b[offset + 1] = (value >>> 8) & 0xff;
  b[offset + 2] = (value >>> 16) & 0xff;
  b[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Encode a 32-byte secret key into 25 Monero seed words (24 + checksum).
 * Mirrors monero/src/mnemonics/electrum-words.cpp::bytes_to_words.
 */
function bytesToWords(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new Error(
      `bytesToWords: expected 32 bytes, got ${bytes.length}`
    );
  }
  const words: string[] = [];
  for (let i = 0; i < 8; i++) {
    const val = readUInt32LE(bytes, i * 4);
    const w1 = val % N;
    const w2 = (Math.floor(val / N) + w1) % N;
    const w3 = (Math.floor(Math.floor(val / N) / N) + w2) % N;
    words.push(MONERO_ENGLISH_WORDS[w1]);
    words.push(MONERO_ENGLISH_WORDS[w2]);
    words.push(MONERO_ENGLISH_WORDS[w3]);
  }
  // Append the checksum word.
  words.push(checksumWord(words));
  return words.join(" ");
}

/**
 * Decode 24 (or 25, with checksum word ignored) words back into 32 bytes.
 * Mirrors monero/src/mnemonics/electrum-words.cpp::words_to_bytes.
 *
 * Throws with a user-facing error message on any failure.
 */
function wordsToBytes(words: string[]): Uint8Array {
  if (words.length !== 24 && words.length !== 25) {
    throw new Error(
      `Expected 24 or 25 words, got ${words.length}`
    );
  }
  const data = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const a = WORD_INDEX.get(words[i * 3]);
    const b = WORD_INDEX.get(words[i * 3 + 1]);
    const c = WORD_INDEX.get(words[i * 3 + 2]);
    if (a === undefined || b === undefined || c === undefined) {
      const bad =
        a === undefined
          ? words[i * 3]
          : b === undefined
            ? words[i * 3 + 1]
            : words[i * 3 + 2];
      throw new Error(`Word "${bad}" is not in the Monero English wordlist`);
    }
    const val =
      a +
      N * (((N - a) + b) % N) +
      N * N * (((N - b) + c) % N);
    if (val % N !== a) {
      throw new Error(
        `Seed word group ${i + 1} failed sanity check (encoding mismatch)`
      );
    }
    if (val > 0xffffffff) {
      throw new Error(
        `Seed word group ${i + 1} produced an out-of-range value`
      );
    }
    writeUInt32LE(data, i * 4, val);
  }
  return data;
}

// ---------- Scalar / curve ops ----------

/** Read a little-endian 32-byte buffer as a bigint. */
function leBytesToBig(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) {
    n = (n << 8n) | BigInt(b[i]);
  }
  return n;
}

/** Write a bigint to a little-endian 32-byte buffer. */
function bigToLeBytes(n: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len);
  let v = n;
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Reduce a 32-byte little-endian buffer mod l (curve order). */
function scReduce32(bytes: Uint8Array): Uint8Array {
  return bigToLeBytes(leBytesToBig(bytes) % L);
}

/**
 * Multiply the ed25519 base point by a scalar (little-endian 32 bytes)
 * and return the 32-byte compressed point encoding.
 */
function scalarMultBase(scalarLE: Uint8Array): Uint8Array {
  const k = leBytesToBig(scalarLE) % L;
  if (k === 0n) {
    throw new Error("Scalar is zero — refusing to derive identity point");
  }
  return ed25519.Point.BASE.multiply(k).toBytes();
}

/**
 * Derive (spend_secret, view_secret, spend_public, view_public) from a
 * 32-byte seed. The seed is the secret spend scalar (already < l for any
 * seed Monero produces, but we sc_reduce32 anyway to be defensive).
 */
function deriveKeys(seedBytes: Uint8Array): {
  spendSecret: Uint8Array;
  viewSecret: Uint8Array;
  spendPub: Uint8Array;
  viewPub: Uint8Array;
} {
  const spendSecret = scReduce32(seedBytes);
  // view secret = sc_reduce32(keccak256(spend_secret))
  const viewSecret = scReduce32(keccak_256(spendSecret));
  const spendPub = scalarMultBase(spendSecret);
  const viewPub = scalarMultBase(viewSecret);
  return { spendSecret, viewSecret, spendPub, viewPub };
}

// ---------- Monero base58 ----------

/**
 * Encode an arbitrary byte buffer using Monero's block-based base58 variant.
 * Each 8-byte block becomes 11 chars; partial trailing blocks use the
 * fixed-length encoding from B58_ENCODED_BLOCK_SIZES.
 */
function moneroBase58Encode(data: Uint8Array): string {
  let out = "";
  const fullBlocks = Math.floor(data.length / B58_FULL_BLOCK_SIZE);
  const lastBlockSize = data.length % B58_FULL_BLOCK_SIZE;

  for (let i = 0; i < fullBlocks; i++) {
    out += encodeBlock(
      data.subarray(i * B58_FULL_BLOCK_SIZE, (i + 1) * B58_FULL_BLOCK_SIZE),
      B58_FULL_ENCODED_BLOCK_SIZE
    );
  }
  if (lastBlockSize > 0) {
    out += encodeBlock(
      data.subarray(fullBlocks * B58_FULL_BLOCK_SIZE),
      B58_ENCODED_BLOCK_SIZES[lastBlockSize]
    );
  }
  return out;
}

function encodeBlock(block: Uint8Array, encodedLen: number): string {
  // Big-endian read
  let num = 0n;
  for (let i = 0; i < block.length; i++) {
    num = (num << 8n) | BigInt(block[i]);
  }
  const chars = new Array(encodedLen).fill("1");
  let idx = encodedLen - 1;
  while (num > 0n && idx >= 0) {
    const r = Number(num % 58n);
    num = num / 58n;
    chars[idx] = B58_ALPHABET[r];
    idx--;
  }
  return chars.join("");
}

// ---------- Public API ----------

/**
 * Generate a fresh 25-word Monero seed.
 *
 * Pulls 32 bytes of OS-backed entropy via the Rust `secureRandomBytes`
 * helper (see `src/secure-random.ts`), reduces mod l so the result is a
 * valid scalar, encodes via the Monero electrum-style word map, and
 * appends the checksum word. Output matches what
 * `monero-wallet-cli --generate-new-wallet` produces and is
 * interoperable with every Monero wallet that speaks the legacy 25-word
 * format (CLI, Cake, Feather, Monerujo, MyMonero with import).
 *
 * Post-generation sanity check: round-trips the encoded phrase back
 * through `wordsToBytes` and verifies the bytes match the originally
 * encoded scalar. This catches the bug class of "seed shown to user
 * doesn't decode back to the same key" before the user ever sees the
 * phrase. Cheap (microseconds) and catches whole-class encoder/wordlist
 * regressions.
 */
export async function generateXmrSeed(): Promise<string> {
  const random = await secureRandomBytes(32);
  const reduced = scReduce32(random);
  const phrase = bytesToWords(reduced);

  const roundTripped = wordsToBytes(phrase.split(" "));
  if (!bytesEqual(reduced, roundTripped)) {
    throw new Error(
      "XMR seed sanity check failed: encoded phrase does not round-trip back to the source bytes. Refusing to return a potentially corrupted seed."
    );
  }
  return phrase;
}

/**
 * Derive the primary mainnet address ("4..." prefix, 95 chars) from a
 * 25-word seed. Pure offline — no network, no WASM, no sidecar.
 *
 * Throws on any decoding / wordlist / checksum failure with a clear
 * user-facing message; callers should already have run validateXmrSeed.
 */
export async function xmrAddressFromSeed(seed: string): Promise<string> {
  const normalized = normalizeXmrSeed(seed);
  const words = normalized.split(" ");
  if (words.length !== 25) {
    throw new Error(
      `Expected 25 words, got ${words.length}. Monero seeds must be exactly 25 words.`
    );
  }
  // Validate checksum word against the first 24.
  const expected = checksumWord(words);
  if (expected !== words[24]) {
    throw new Error(
      `Seed checksum word doesn't match. Expected "${expected}", got "${words[24]}".`
    );
  }
  const seedBytes = wordsToBytes(words.slice(0, 24));
  const { spendPub, viewPub } = deriveKeys(seedBytes);

  // address payload = network_byte || spend_pub (32) || view_pub (32)
  const payload = new Uint8Array(1 + 32 + 32);
  payload[0] = MAINNET_NETWORK_BYTE;
  payload.set(spendPub, 1);
  payload.set(viewPub, 33);

  // 4-byte checksum from keccak256 of the payload
  const checksum = keccak_256(payload).slice(0, 4);

  const raw = new Uint8Array(payload.length + checksum.length);
  raw.set(payload, 0);
  raw.set(checksum, payload.length);

  return moneroBase58Encode(raw);
}

/**
 * Validates a 25-word Monero seed using only the wordlist + checksum.
 * Returns `{ ok: true }` on success or `{ ok: false, error }` with a
 * user-facing message on failure (wrong word count, unknown word,
 * bad checksum, etc.).
 *
 * Cheap (no WASM, no network) and synchronous-fast — typical call
 * is < 1ms.
 */
export async function validateXmrSeed(
  seed: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = normalizeXmrSeed(seed);
  const words = normalized.length === 0 ? [] : normalized.split(" ");

  if (words.length !== 25) {
    return {
      ok: false,
      error: `Expected 25 words, got ${words.length}. Monero seeds must be exactly 25 words.`,
    };
  }

  // All 25 words must be in the wordlist (full or 3-letter prefix).
  for (let i = 0; i < 25; i++) {
    if (!WORD_INDEX.has(words[i])) {
      return {
        ok: false,
        error: `Word ${i + 1} ("${words[i]}") is not in the Monero English wordlist.`,
      };
    }
  }

  // Checksum word must match the crc32-derived index.
  const expected = checksumWord(words);
  if (expected !== words[24]) {
    return {
      ok: false,
      error: `Seed checksum word is wrong. Expected "${expected}", got "${words[24]}". This usually means a typo in one of the first 24 words.`,
    };
  }

  // Decode bytes to catch the rare encoding-out-of-range edge case.
  try {
    wordsToBytes(words.slice(0, 24));
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Failed to decode seed" };
  }

  return { ok: true };
}

/**
 * Internal helper used by the polyseed path — given a 32-byte raw secret
 * (typically the output of `polyseedKeygen`), derive the complete set of
 * Monero keys and the primary address. Exported so `xmr-wallet.ts` can
 * reuse the derivation for the "import polyseed" / "generate polyseed"
 * flows without duplicating `deriveKeys` + `moneroBase58Encode`.
 */
export async function xmrKeysFromRawSecret(rawSecret: Uint8Array): Promise<{
  spendSecret: Uint8Array;
  viewSecret: Uint8Array;
  spendPub: Uint8Array;
  viewPub: Uint8Array;
  address: string;
}> {
  if (rawSecret.length !== 32) {
    throw new Error(
      `xmrKeysFromRawSecret: expected 32 bytes, got ${rawSecret.length}`
    );
  }
  const { spendSecret, viewSecret, spendPub, viewPub } = deriveKeys(rawSecret);

  const payload = new Uint8Array(1 + 32 + 32);
  payload[0] = MAINNET_NETWORK_BYTE;
  payload.set(spendPub, 1);
  payload.set(viewPub, 33);
  const checksum = keccak_256(payload).slice(0, 4);
  const raw = new Uint8Array(payload.length + checksum.length);
  raw.set(payload, 0);
  raw.set(checksum, payload.length);
  const address = moneroBase58Encode(raw);

  return { spendSecret, viewSecret, spendPub, viewPub, address };
}

/** Convert a little-endian byte array to a lowercase hex string. */
export function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// Re-export for tests / future use
export const _internal = {
  N,
  L,
  bytesToWords,
  wordsToBytes,
  checksumWord,
  scReduce32,
  scalarMultBase,
  moneroBase58Encode,
  deriveKeys,
};
void N_BIG;
