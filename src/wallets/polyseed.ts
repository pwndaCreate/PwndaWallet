/**
 * Polyseed (16-word mnemonic) implementation for Monero.
 *
 * Pure TypeScript port of tevador's reference polyseed library
 * (https://github.com/tevador/polyseed, MIT). We use it to generate and
 * import Monero polyseeds without depending on the C reference lib or a
 * WASM bundle.
 *
 * Constants, GF(2^11) arithmetic, birthday encoding, feature masks,
 * checksum polynomial, bit layout, and PBKDF2 parameters all match the
 * reference implementation bit-for-bit. English wordlist is vendored in
 * `polyseed-wordlist.ts` straight from upstream `src/lang_en.c`.
 *
 * ---
 *
 * Key properties of a Monero polyseed vs. the legacy 25-word seed:
 *   - 16 words (vs 25), 128 bits of entropy (vs 256)
 *   - Creation date (~2-week precision) encoded inside the seed → the
 *     wallet-rpc's `restore_height` can be derived automatically and
 *     sync skips straight to the creation block instead of scanning
 *     genesis.
 *   - Multi-coin domain-separated via a 4-byte coin id in the KDF salt.
 *     Monero uses `POLYSEED_MONERO = 0`.
 *   - PBKDF2-HMAC-SHA256 with 10000 iterations over the 32-byte secret
 *     buffer (19 significant bytes of entropy, 13 zero bytes of padding
 *     for future-compat) → 32-byte Monero spend key (sc_reduce32 applied
 *     at the Monero layer).
 *
 * ---
 *
 * Cross-verification strategy:
 *   1. encode/decode round-trip — proves the GF checksum + bit packing match.
 *   2. decode of a known reference phrase from the upstream test suite
 *      ("raven tail swear ..." — see tevador/polyseed tests.c) must succeed.
 *   3. For key derivation, a Monero address derived from a polyseed via this
 *      module is cross-checked in an integration test against
 *      `monero-wallet-rpc`'s `generate_from_keys` output.
 */

import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  POLYSEED_ENGLISH_WORDS,
  POLYSEED_ENGLISH_PREFIX_LEN,
} from "./polyseed-wordlist";
import { secureRandomBytes, bytesEqual } from "../secure-random";

// =========================================================================
// Constants (match tevador/polyseed reference, src/storage.h + src/polyseed.c)
// =========================================================================

const POLYSEED_NUM_WORDS = 16;
const GF_BITS = 11;
const GF_SIZE = 1 << GF_BITS; // 2048
const POLY_NUM_CHECK_DIGITS = 1;
const DATA_WORDS = POLYSEED_NUM_WORDS - POLY_NUM_CHECK_DIGITS; // 15
const SHARE_BITS = 10;
const SECRET_BITS = 150;
const SECRET_SIZE = Math.ceil(SECRET_BITS / 8); // 19
const SECRET_BUFFER_SIZE = 32;
const CLEAR_BITS = SECRET_SIZE * 8 - SECRET_BITS; // 2
const CLEAR_MASK = ~(((1 << CLEAR_BITS) - 1) << (8 - CLEAR_BITS)) & 0xff; // 0x3f

const DATE_BITS = 10;
const DATE_MASK = (1 << DATE_BITS) - 1;
const FEATURE_BITS = 5;
const USER_FEATURES = 3;
const USER_FEATURES_MASK = (1 << USER_FEATURES) - 1;
const ENCRYPTED_MASK = 16;
const FEATURE_MASK = (1 << FEATURE_BITS) - 1;

/** Polyseed birthday epoch: 2021-11-01 12:00 UTC. */
const EPOCH = 1635768000;
/** Polyseed birthday step: 30.436875 days (one-twelfth of a Gregorian year). */
const TIME_STEP = 2629746;

const KDF_NUM_ITERATIONS = 10000;

/** Coin identifier for Monero polyseeds. */
export const POLYSEED_COIN_MONERO = 0;

// =========================================================================
// GF(2^11) arithmetic
// =========================================================================

/**
 * Lookup table for multiply-by-2 overflow in GF(2^11). Encodes the
 * irreducible polynomial used by polyseed. Do not modify.
 */
const MUL2_TABLE = [5, 7, 1, 3, 13, 15, 9, 11];

/** Multiply-by-2 in GF(2^11) as defined by the polyseed reference. */
function gfMul2(x: number): number {
  if (x < 1024) return (2 * x) & 0xffff;
  return MUL2_TABLE[x % 8] + 16 * Math.floor((x - 1024) / 8);
}

/**
 * Evaluate the polynomial at x = 2 using Horner's method (highest-degree
 * coefficient first). Returns 0 iff the polynomial is a valid polyseed
 * codeword.
 */
function gfPolyEval(coeffs: number[]): number {
  let result = coeffs[POLYSEED_NUM_WORDS - 1];
  for (let i = POLYSEED_NUM_WORDS - 2; i >= 0; i--) {
    result = gfMul2(result) ^ coeffs[i];
  }
  return result;
}

/**
 * Compute the checksum digit and store it at coeffs[0]. Assumes coeffs[0]
 * is 0 on entry. After this call, gfPolyEval(coeffs) === 0.
 */
function gfPolyEncode(coeffs: number[]): void {
  coeffs[0] = gfPolyEval(coeffs);
}

function gfPolyCheck(coeffs: number[]): boolean {
  return gfPolyEval(coeffs) === 0;
}

// =========================================================================
// Secret ↔ Polynomial coefficient packing (data_to_poly / poly_to_data)
// =========================================================================

export interface PolyseedData {
  /** 10-bit value counting TIME_STEP periods since EPOCH. */
  birthday: number;
  /** 5-bit feature flags (user-visible bits + internal flags). */
  features: number;
  /** 32-byte secret buffer; first 19 bytes are significant (150 bits). */
  secret: Uint8Array;
  /** Last-computed checksum digit (11-bit value). 0 until encoded. */
  checksum: number;
}

/**
 * Pack the (secret, birthday, features) trio into 15 polynomial coefficients
 * at positions [1..15]. coeffs[0] is reserved for the checksum and will be
 * set by gfPolyEncode. Bit layout is MSB-first within the secret bitstream:
 * each data coefficient is (10 secret bits << 1) | (1 extra bit), and the
 * extra bits together make up `(features << 10) | birthday` read MSB-first.
 */
function polyseedDataToPoly(data: PolyseedData, coeffs: number[]): void {
  let extraVal = (data.features << DATE_BITS) | data.birthday;
  let extraBits = FEATURE_BITS + DATE_BITS; // 15 total

  let wordBits = 0;
  let wordVal = 0;

  let secretIdx = 0;
  let secretVal = data.secret[secretIdx];
  let secretBitsRem = 8; // bits left in secretVal
  let seedRemBits = SECRET_BITS - 8; // bits of the secret not yet loaded into secretVal

  for (let i = 0; i < DATA_WORDS; i++) {
    while (wordBits < SHARE_BITS) {
      if (secretBitsRem === 0) {
        secretIdx++;
        secretBitsRem = Math.min(seedRemBits, 8);
        secretVal = data.secret[secretIdx];
        seedRemBits -= secretBitsRem;
      }
      const chunkBits = Math.min(secretBitsRem, SHARE_BITS - wordBits);
      secretBitsRem -= chunkBits;
      wordBits += chunkBits;
      wordVal = ((wordVal << chunkBits) | ((secretVal >> secretBitsRem) & ((1 << chunkBits) - 1))) >>> 0;
    }
    wordVal = (wordVal << 1) >>> 0;
    extraBits--;
    wordVal |= (extraVal >> extraBits) & 1;
    coeffs[POLY_NUM_CHECK_DIGITS + i] = wordVal & 0x7ff;
    wordVal = 0;
    wordBits = 0;
  }

  // These should all be zero at end; keep the asserts for safety.
  if (seedRemBits !== 0 || secretBitsRem !== 0 || extraBits !== 0) {
    throw new Error(
      `polyseed encode invariant broken (seedRem=${seedRemBits}, secretBits=${secretBitsRem}, extraBits=${extraBits})`
    );
  }
}

/**
 * Inverse of `polyseedDataToPoly`. Expects coeffs[0] = checksum and
 * coeffs[1..15] = data. Writes the secret bytes, birthday, features back
 * into `data`.
 */
function polyseedPolyToData(coeffs: number[], data: PolyseedData): void {
  data.birthday = 0;
  data.features = 0;
  data.secret.fill(0);
  data.checksum = coeffs[0];

  let extraVal = 0;
  let extraBits = 0;

  let secretIdx = 0;
  let secretBitsFilled = 0;
  let seedBitsWritten = 0;

  for (let i = POLY_NUM_CHECK_DIGITS; i < POLYSEED_NUM_WORDS; i++) {
    let wordVal = coeffs[i];

    extraVal = ((extraVal << 1) | (wordVal & 1)) >>> 0;
    wordVal >>= 1;
    let wordBits = GF_BITS - 1; // 10 bits of secret in this word
    extraBits++;

    while (wordBits > 0) {
      if (secretBitsFilled === 8) {
        secretIdx++;
        seedBitsWritten += secretBitsFilled;
        secretBitsFilled = 0;
      }
      const chunkBits = Math.min(wordBits, 8 - secretBitsFilled);
      wordBits -= chunkBits;
      const chunkMask = (1 << chunkBits) - 1;
      if (chunkBits < 8) {
        data.secret[secretIdx] = ((data.secret[secretIdx] << chunkBits) | 0) & 0xff;
      }
      data.secret[secretIdx] = ((data.secret[secretIdx] | ((wordVal >> wordBits) & chunkMask)) & 0xff) >>> 0;
      secretBitsFilled += chunkBits;
    }
  }
  seedBitsWritten += secretBitsFilled;

  if (seedBitsWritten !== SECRET_BITS || extraBits !== FEATURE_BITS + DATE_BITS) {
    throw new Error(
      `polyseed decode invariant broken (seed=${seedBitsWritten}, extra=${extraBits})`
    );
  }

  data.birthday = extraVal & DATE_MASK;
  data.features = (extraVal >> DATE_BITS) & FEATURE_MASK;
}

// =========================================================================
// Phrase encode / decode
// =========================================================================

/**
 * Build a lookup index for the English wordlist, keyed on both the full
 * word and its 4-char prefix (polyseed's standard prefix-based matching).
 */
const WORD_INDEX: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < POLYSEED_ENGLISH_WORDS.length; i++) {
    const w = POLYSEED_ENGLISH_WORDS[i];
    m.set(w, i);
    m.set(w.slice(0, POLYSEED_ENGLISH_PREFIX_LEN), i);
  }
  return m;
})();

/** Collapse runs of whitespace, trim, lowercase. */
export function normalizePolyseed(phrase: string): string {
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Encode a `PolyseedData` object as a 16-word phrase for the given coin.
 * Computes the checksum, XORs the coin id into the first data word, and
 * looks up the words in the English wordlist.
 */
export function polyseedEncode(
  data: PolyseedData,
  coin: number = POLYSEED_COIN_MONERO
): string {
  if (coin < 0 || coin >= GF_SIZE) {
    throw new Error(`polyseed: coin id ${coin} out of range`);
  }

  const coeffs = new Array<number>(POLYSEED_NUM_WORDS).fill(0);
  polyseedDataToPoly(data, coeffs);
  // Compute checksum AT coeffs[0] (depends on coeffs[1..15] with coeffs[0]=0)
  gfPolyEncode(coeffs);
  // Domain-separate by coin after checksum is computed.
  coeffs[POLY_NUM_CHECK_DIGITS] ^= coin;

  // Remember the checksum so callers can persist it in `data` too.
  data.checksum = coeffs[0];

  return coeffs.map((c) => POLYSEED_ENGLISH_WORDS[c]).join(" ");
}

/**
 * Decode a 16-word phrase into `PolyseedData`. Returns an error string if
 * any word is unknown, the word count is wrong, or the checksum fails.
 */
export function polyseedDecode(
  phrase: string,
  coin: number = POLYSEED_COIN_MONERO
):
  | { ok: true; data: PolyseedData }
  | { ok: false; error: string } {
  const words = normalizePolyseed(phrase)
    .split(" ")
    .filter((w) => w.length > 0);

  if (words.length !== POLYSEED_NUM_WORDS) {
    return {
      ok: false,
      error: `Expected ${POLYSEED_NUM_WORDS} words, got ${words.length}.`,
    };
  }

  const coeffs: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const key = words[i].slice(0, POLYSEED_ENGLISH_PREFIX_LEN);
    const idx = WORD_INDEX.get(words[i]) ?? WORD_INDEX.get(key);
    if (idx === undefined) {
      return {
        ok: false,
        error: `Word ${i + 1} ("${words[i]}") is not in the polyseed English wordlist.`,
      };
    }
    coeffs.push(idx);
  }

  // Un-mix the coin id before running the checksum check.
  coeffs[POLY_NUM_CHECK_DIGITS] ^= coin;

  if (!gfPolyCheck(coeffs)) {
    return {
      ok: false,
      error:
        "Polyseed checksum failed. One or more words contain a typo, or the phrase is for a different coin.",
    };
  }

  const data: PolyseedData = {
    birthday: 0,
    features: 0,
    secret: new Uint8Array(SECRET_BUFFER_SIZE),
    checksum: 0,
  };
  polyseedPolyToData(coeffs, data);

  if (!polyseedFeaturesSupported(data.features)) {
    return {
      ok: false,
      error:
        "Polyseed uses unsupported features (encryption or reserved bits). Decrypt the seed before importing.",
    };
  }

  return { ok: true, data };
}

function polyseedFeaturesSupported(features: number): boolean {
  // User features live in the low 3 bits; bit 4 (ENCRYPTED_MASK) is
  // allowed but means the secret is PBKDF-masked with a user password.
  // Bits 3 and others in the reserved range must be zero.
  const reservedMask = FEATURE_MASK ^ ENCRYPTED_MASK ^ USER_FEATURES_MASK;
  return (features & reservedMask) === 0;
}

export function polyseedIsEncrypted(data: PolyseedData): boolean {
  return (data.features & ENCRYPTED_MASK) !== 0;
}

// =========================================================================
// Birthday helpers
// =========================================================================

/** Encode a Unix timestamp to a 10-bit polyseed birthday. */
export function birthdayEncode(unixSeconds: number): number {
  if (unixSeconds < EPOCH) return 0;
  return Math.floor((unixSeconds - EPOCH) / TIME_STEP) & DATE_MASK;
}

/** Decode a polyseed birthday (10 bits) back to a Unix timestamp. */
export function birthdayDecode(birthday: number): number {
  return EPOCH + (birthday & DATE_MASK) * TIME_STEP;
}

/**
 * Approximate Monero block height corresponding to a birthday value.
 * Monero genesis (block 0) was 2014-04-18; block interval is ~120s.
 * We bias back one TIME_STEP (~30 days) to give the scanner slack
 * against clock skew at wallet creation time.
 */
export function birthdayToRestoreHeight(birthday: number): number {
  const MONERO_GENESIS = 1397818193; // 2014-04-18 UTC
  const MONERO_BLOCK_SEC = 120;
  const unix = birthdayDecode(birthday);
  const biased = unix - TIME_STEP;
  const h = Math.floor((biased - MONERO_GENESIS) / MONERO_BLOCK_SEC);
  return Math.max(0, h);
}

// =========================================================================
// Key derivation (polyseed_keygen)
// =========================================================================

/**
 * Derive the coin-specific secret key from a polyseed. Reproduces
 * `polyseed_keygen` from the reference library: PBKDF2-HMAC-SHA256 over
 * the full 32-byte secret buffer with a 32-byte salt that domain-separates
 * by `"POLYSEED key"` ASCII + coin / birthday / features (all LE u32).
 *
 * For Monero (`coin=0`, `keySize=32`) the returned 32 bytes are the raw
 * spend secret key — the caller should still apply `sc_reduce32` before
 * treating it as an ed25519 scalar.
 */
export function polyseedKeygen(
  data: PolyseedData,
  coin: number = POLYSEED_COIN_MONERO,
  keySize: number = 32
): Uint8Array {
  if (coin < 0 || coin >= GF_SIZE) {
    throw new Error(`polyseed: coin id ${coin} out of range`);
  }

  // salt[0..12]  = "POLYSEED key"
  // salt[12]     = 0  (null terminator in C)
  // salt[13..16] = 0xff 0xff 0xff 0
  // salt[16..20] = coin      (LE u32)
  // salt[20..24] = birthday  (LE u32)
  // salt[24..28] = features  (LE u32)
  // salt[28..32] = 0
  const salt = new Uint8Array(32);
  const label = new TextEncoder().encode("POLYSEED key"); // 12 bytes
  salt.set(label, 0);
  // Byte 12 stays 0 (null terminator).
  salt[13] = 0xff;
  salt[14] = 0xff;
  salt[15] = 0xff;
  writeUInt32LE(salt, 16, coin);
  writeUInt32LE(salt, 20, data.birthday);
  writeUInt32LE(salt, 24, data.features);
  // Bytes 28..32 stay zero.

  // Secret buffer must be exactly SECRET_BUFFER_SIZE = 32 bytes including
  // the zero padding. The reference passes `seed->secret` as password.
  const password = new Uint8Array(SECRET_BUFFER_SIZE);
  password.set(data.secret.subarray(0, SECRET_BUFFER_SIZE));

  return pbkdf2(sha256, password, salt, {
    c: KDF_NUM_ITERATIONS,
    dkLen: keySize,
  });
}

function writeUInt32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

// =========================================================================
// High-level generate helpers
// =========================================================================

/**
 * Create a fresh Monero polyseed with the current time as the birthday.
 * Returns the 16-word phrase plus the raw `PolyseedData` for callers that
 * want to derive keys without round-tripping through the phrase.
 *
 * Entropy is sourced from OS RNG via the Rust `secureRandomBytes` helper
 * (see `src/secure-random.ts`) — 19 bytes (152 bits) with the top 2 bits
 * cleared to fit the 150-bit polyseed secret field.
 *
 * Post-generation sanity check: encodes the data, decodes the resulting
 * phrase back through `polyseedDecode`, and verifies the recovered
 * secret + features + birthday match the inputs. Catches the bug class
 * of "phrase shown to user doesn't decode back to the same secret"
 * before the user ever sees it. The check runs in microseconds.
 */
export async function generatePolyseed(
  features: number = 0
): Promise<{ phrase: string; data: PolyseedData }> {
  const userFeatures = features & USER_FEATURES_MASK;
  // Reserved bits (everything except user features and ENCRYPTED_MASK) must
  // be zero. We never set ENCRYPTED_MASK at creation — the wallet is
  // unencrypted on disk; encryption happens at the vault layer.
  if ((features & ~USER_FEATURES_MASK) !== 0) {
    throw new Error("polyseed: unsupported features requested");
  }

  const secret = new Uint8Array(SECRET_BUFFER_SIZE);
  const entropy = await secureRandomBytes(SECRET_SIZE);
  secret.set(entropy, 0);
  // Clear the top 2 bits of the last significant byte so the 150-bit
  // secret fits exactly in the polynomial coefficients.
  secret[SECRET_SIZE - 1] &= CLEAR_MASK;

  const data: PolyseedData = {
    birthday: birthdayEncode(Math.floor(Date.now() / 1000)),
    features: userFeatures,
    secret,
    checksum: 0,
  };

  const phrase = polyseedEncode(data, POLYSEED_COIN_MONERO);

  const decoded = polyseedDecode(phrase, POLYSEED_COIN_MONERO);
  if (!decoded.ok) {
    throw new Error(
      `Polyseed sanity check failed: encoded phrase did not decode (${decoded.error}). Refusing to return a potentially corrupted seed.`
    );
  }
  if (
    decoded.data.features !== data.features ||
    decoded.data.birthday !== data.birthday ||
    !bytesEqual(
      decoded.data.secret.subarray(0, SECRET_SIZE),
      data.secret.subarray(0, SECRET_SIZE)
    )
  ) {
    throw new Error(
      "Polyseed sanity check failed: decoded data did not match the source data. Refusing to return a potentially corrupted seed."
    );
  }

  return { phrase, data };
}

/**
 * Convenience: decode a 16-word phrase, derive the 32-byte Monero spend
 * secret key, and return both alongside the decoded data.
 *
 * Throws on decode failure with a user-facing message — callers should
 * run `polyseedDecode` first if they want to distinguish error kinds.
 */
export function polyseedToMoneroSpendKey(phrase: string): {
  data: PolyseedData;
  spendKeyRaw: Uint8Array;
} {
  const result = polyseedDecode(phrase, POLYSEED_COIN_MONERO);
  if (!result.ok) throw new Error(result.error);
  const spendKeyRaw = polyseedKeygen(result.data, POLYSEED_COIN_MONERO, 32);
  return { data: result.data, spendKeyRaw };
}

// =========================================================================
// Public validation helper (mirrors validateXmrSeed for 25-word)
// =========================================================================

/**
 * Lightweight wordlist + checksum check, no key derivation. Cheap enough
 * to run on every keystroke in an import form.
 */
export function validatePolyseed(
  phrase: string
): { ok: true } | { ok: false; error: string } {
  const res = polyseedDecode(phrase);
  if (!res.ok) return res;
  return { ok: true };
}

// =========================================================================
// Internal exports for unit tests
// =========================================================================

export const _internal = {
  POLYSEED_NUM_WORDS,
  POLYSEED_COIN_MONERO,
  SECRET_BITS,
  SECRET_SIZE,
  CLEAR_MASK,
  EPOCH,
  TIME_STEP,
  KDF_NUM_ITERATIONS,
  gfMul2,
  gfPolyEval,
  gfPolyEncode,
  gfPolyCheck,
  polyseedDataToPoly,
  polyseedPolyToData,
  polyseedKeygen,
};
