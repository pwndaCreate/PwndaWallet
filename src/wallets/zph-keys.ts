/**
 * Pure-JS Zephyr Protocol key helpers.
 *
 * Zephyr is a Monero-lineage fork that inherits Monero's 25-word
 * electrum-style mnemonic format and the same English wordlist. Key
 * derivation is mathematically identical — the only thing that changes
 * is the base58 address prefix, which is a multi-byte varint of the
 * constant `CRYPTONOTE_PUBLIC_ADDRESS_BASE58_PREFIX = 0x6241d18c0` from
 * Zephyr's `src/cryptonote_config.h`, rather than Monero's single byte
 * `0x12`. Addresses begin with the literal string `"ZEPHYR"`.
 *
 * This module delegates the heavy lifting (wordlist, keccak → sc_reduce32
 * → ed25519 scalar mul, Monero-style block-based base58) to `xmr-keys.ts`
 * via its `_internal` export. No re-implementation of the underlying
 * cryptonote primitives.
 *
 * Exports:
 *   - generateZephyrSeed()      — fresh 25-word seed
 *   - zephyrAddressFromSeed(s)  — primary mainnet address ("ZEPHYR...")
 *   - validateZephyrSeed(s)     — wordlist + checksum validation
 *   - normalizeZephyrSeed(s)    — whitespace cleanup (re-export)
 *   - zphKeysFromRawSecret(b)   — key triple + ZEPHYR-prefix address
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  generateXmrSeed,
  validateXmrSeed,
  normalizeXmrSeed,
  _internal,
} from "./xmr-keys";

// =========================================================================
// Mainnet address prefix (CRYPTONOTE_PUBLIC_ADDRESS_BASE58_PREFIX = 0x6241d18c0)
//
// Encoded as a Monero-style varint (LEB128 with the high bit signaling a
// continuation). Worked out by hand and verified round-trip:
//
//   n = 0x6241d18c0  (26,375,690,432 decimal)
//   byte 0:  64  | 0x80 = 0xC0   n = 206060081
//   byte 1:  49  | 0x80 = 0xB1   n = 1609844
//   byte 2:  116 | 0x80 = 0xF4   n = 12576
//   byte 3:  32  | 0x80 = 0xA0   n = 98
//   byte 4:  98                  (no continuation, final byte)
//
// Decoded: 64 | (49<<7) | (116<<14) | (32<<21) | (98<<28) = 26375690432  ✓
//
// The first base58 block (first 8 bytes of `prefix || spend_pub`) starts
// with these five bytes, which is what produces the `ZEPHYR...` leading
// characters on every primary mainnet address.
// =========================================================================
const ZEPHYR_MAINNET_PREFIX_VARINT = new Uint8Array([
  0xc0, 0xb1, 0xf4, 0xa0, 0x62,
]);

// =========================================================================
// Public API
// =========================================================================

/**
 * Generate a fresh 25-word Zephyr seed.
 *
 * Output is indistinguishable from a Monero seed — same 25 words, same
 * wordlist, same checksum word format. Interoperable with
 * `zephyr-wallet-rpc restore_deterministic_wallet`.
 */
export async function generateZephyrSeed(): Promise<string> {
  return generateXmrSeed();
}

/** Wordlist + checksum check, no key derivation. Cheap. */
export async function validateZephyrSeed(
  seed: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  return validateXmrSeed(seed);
}

/** Whitespace normalization + lowercase. */
export function normalizeZephyrSeed(seed: string): string {
  return normalizeXmrSeed(seed);
}

/**
 * Derive the primary mainnet Zephyr address ("ZEPHYR..." prefix) from a
 * 25-word seed. Pure offline — no network, no sidecar, no WASM.
 */
export async function zephyrAddressFromSeed(seed: string): Promise<string> {
  const normalized = normalizeXmrSeed(seed);
  const words = normalized.split(" ");
  if (words.length !== 25) {
    throw new Error(
      `Expected 25 words, got ${words.length}. Zephyr seeds must be exactly 25 words.`
    );
  }
  const expected = _internal.checksumWord(words);
  if (expected !== words[24]) {
    throw new Error(
      `Seed checksum word doesn't match. Expected "${expected}", got "${words[24]}".`
    );
  }
  const seedBytes = _internal.wordsToBytes(words.slice(0, 24));
  return addressFromSpendScalar(seedBytes);
}

/**
 * Derive keys + address from a 32-byte raw secret. Mirror of Monero's
 * `xmrKeysFromRawSecret` but emits a ZEPHYR-prefixed address. Kept as a
 * standalone export in case a future path (e.g. importing from private
 * spend key directly) reuses this helper.
 */
export async function zphKeysFromRawSecret(rawSecret: Uint8Array): Promise<{
  spendSecret: Uint8Array;
  viewSecret: Uint8Array;
  spendPub: Uint8Array;
  viewPub: Uint8Array;
  address: string;
}> {
  if (rawSecret.length !== 32) {
    throw new Error(
      `zphKeysFromRawSecret: expected 32 bytes, got ${rawSecret.length}`
    );
  }
  const { spendSecret, viewSecret, spendPub, viewPub } =
    _internal.deriveKeys(rawSecret);
  const address = encodeZephyrAddress(spendPub, viewPub);
  return { spendSecret, viewSecret, spendPub, viewPub, address };
}

// =========================================================================
// Address encoding — shared between seed and raw-secret paths
// =========================================================================

async function addressFromSpendScalar(seedBytes: Uint8Array): Promise<string> {
  const { spendPub, viewPub } = _internal.deriveKeys(seedBytes);
  return encodeZephyrAddress(spendPub, viewPub);
}

/**
 * Assemble a Zephyr primary address from its public spend + public view
 * keys: `varint(prefix) || spend_pub || view_pub || keccak4_checksum`,
 * then base58-encode via the Monero block scheme.
 *
 * Layout length: 5 (prefix varint) + 32 + 32 + 4 = 73 bytes.
 * Base58 output length: 9 full 8-byte blocks × 11 chars + 1-byte tail × 2
 *   chars = 99 + 2 = 101 characters, all starting with "ZEPHYR" given
 *   the fixed prefix varint.
 */
function encodeZephyrAddress(spendPub: Uint8Array, viewPub: Uint8Array): string {
  const payload = new Uint8Array(
    ZEPHYR_MAINNET_PREFIX_VARINT.length + 32 + 32
  );
  payload.set(ZEPHYR_MAINNET_PREFIX_VARINT, 0);
  payload.set(spendPub, ZEPHYR_MAINNET_PREFIX_VARINT.length);
  payload.set(viewPub, ZEPHYR_MAINNET_PREFIX_VARINT.length + 32);

  const checksum = keccak_256(payload).slice(0, 4);
  const raw = new Uint8Array(payload.length + checksum.length);
  raw.set(payload, 0);
  raw.set(checksum, payload.length);
  return _internal.moneroBase58Encode(raw);
}

// =========================================================================
// Internal exports for unit tests
// =========================================================================

export const _zphInternal = {
  ZEPHYR_MAINNET_PREFIX_VARINT,
  encodeZephyrAddress,
};
