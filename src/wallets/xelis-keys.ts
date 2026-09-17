/**
 * Xelis seed and address helpers.
 *
 * Implemented 2026-09-15 against `xelis_wallet` v1.25.0, from the P0 spike
 * (`wiki/queries/2026-09-15-xelis-wallet-binary-spike.md`, sections A1/A2). Every
 * rule below is either read from the v1.25.0 source or observed against the real
 * binary; `xelis-keys.test.ts` pins all of them to binary-produced vectors.
 *
 * Seed shape: 25 words (24 data words + 1 checksum word) from a 1626-word list,
 * one private key per seed, no BIP-39 and no derivation path.
 *
 * # The wordlist is Monero's, exactly
 *
 * XELIS's English list (`xelis_wallet/src/mnemonics/languages/english.rs`) is
 * **the same 1626 words in the same order** as Monero's legacy electrum list —
 * checked programmatically, 1626/1626 at identical indices. So this module
 * imports `MONERO_ENGLISH_WORDS` rather than shipping a second 23 KB copy that
 * could drift from it silently. `xelis-keys.test.ts` pins that identity with a
 * digest of the list, so an edit to the Monero list fails HERE too, loudly,
 * instead of quietly re-deriving every Xelis address in the wallet.
 *
 * # Consequence: a 25-word seed cannot be attributed to a chain
 *
 * Same list, same order, same 3-words-to-u32 mapping, same CRC-32 checksum rule
 * as Monero and Zephyr. Every Monero/Zephyr seed is therefore ALSO a valid Xelis
 * seed and yields an unrelated, perfectly functional XEL wallet. Import must be
 * an explicit per-chain choice; see `seed-kind.ts`, which encodes exactly that.
 *
 * # Three places this differs from Monero's codec, each load-bearing
 *
 * 1. **Whole words only.** Monero accepts 3-letter prefixes; Xelis does not, and
 *    answers a prefix with `Error: No indices found`. Do NOT port prefix
 *    matching — it would accept seeds the binary refuses.
 * 2. **24 words are valid.** The checksum word is optional. With 24 words the
 *    binary skips the checksum check entirely and opens the same wallet.
 * 3. **No scalar reduction.** The 32 bytes must already be a canonical, non-zero
 *    Ristretto scalar (< l). Monero `sc_reduce32`-reduces; Xelis rejects with
 *    `Error: Invalid key from bytes`. That is why {@link XelisSeedCheck} carries
 *    a `key` verdict the other chains have no need for.
 */

import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { sha3_512 } from "@noble/hashes/sha3.js";
import { MONERO_ENGLISH_WORDS } from "./xmr-wordlist";
import { secureRandomBytes } from "../secure-random";

export type XelisNetwork = "mainnet" | "testnet";

export const XELIS_SEED_WORD_COUNT = 25;

/** Data words, i.e. everything before the checksum word. */
const DATA_WORDS = 24;

/** Words per list. `WORDS_LIST` in `xelis_wallet/src/mnemonics/mod.rs`. */
const N = MONERO_ENGLISH_WORDS.length; // 1626

/** English `prefix_length`: the checksum hashes 3-char prefixes, not whole words. */
const PREFIX_LENGTH = 3;

/** Ristretto255 / ed25519 group order l = 2^252 + 27742317777372353535851937790883648493. */
const L = (BigInt(1) << BigInt(252)) + BigInt("27742317777372353535851937790883648493");

const ZERO = BigInt(0);

/** Address prefix per network: `xel:` mainnet, `xet:` testnet. */
export function xelisAddressPrefix(network: XelisNetwork): string {
  return network === "testnet" ? "xet:" : "xel:";
}

/**
 * The network this build talks to. Shipped builds are always mainnet;
 * `VITE_XELIS_NETWORK=testnet` is honoured only in a dev server, so the
 * operator can rehearse a receive and send without real funds.
 */
export function xelisNetworkFromEnv(): XelisNetwork {
  if (import.meta.env.DEV && import.meta.env.VITE_XELIS_NETWORK === "testnet") {
    return "testnet";
  }
  return "mainnet";
}

/** Lower-case, trim, and collapse runs of whitespace to single spaces. */
export function normalizeXelisSeed(seed: string): string {
  return seed.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export type XelisSeedCheck =
  | { ok: true }
  /** Not 24 or 25 words. */
  | { ok: false; kind: "word-count"; count: number }
  /** Words that are not in the wordlist, in the order they appear. */
  | { ok: false; kind: "unknown-word"; words: string[] }
  /** Every word is known but the checksum word does not match the other 24. */
  | { ok: false; kind: "checksum" }
  /**
   * Every word is known and the checksum matches, but the 24 data words decode
   * to something XELIS will not accept as a private key: zero, or a scalar at
   * or above the group order l.
   *
   * Additive variant (2026-09-15), not in the original contract, because the
   * three kinds above cannot express this seed. The binary exits 1 with
   * `Error: Invalid key from bytes` for `abbey` x25 (zero) and for the ff*32
   * encoding (non-canonical), both of which pass the wordlist and checksum
   * checks. Reporting either as `checksum` would tell the user their 25th word
   * is wrong when it is provably right.
   */
  | { ok: false; kind: "key" };

// =========================================================================
// Wordlist index
// =========================================================================

/**
 * Whole word to index. Deliberately NOT a prefix map: `xmr-keys.ts` builds one
 * keyed by BOTH the word and its 3-letter prefix because the Monero CLI accepts
 * either. Xelis matches whole words only (spike A1, and the
 * `monero_style_3char_prefix` negative vector), so a prefix map here would
 * accept seeds the binary refuses — a wallet the user could create and never
 * restore.
 */
const WORD_INDEX: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < MONERO_ENGLISH_WORDS.length; i++) {
    m.set(MONERO_ENGLISH_WORDS[i], i);
  }
  return m;
})();

// =========================================================================
// CRC-32/IEEE — the checksum word
// =========================================================================

const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Index of the word the 25th must repeat: CRC-32/IEEE over the concatenated
 * 3-char prefixes of the 24 data words, mod 24.
 *
 * `words` must already be lowercased.
 */
function checksumIndex(words: readonly string[]): number {
  const joined = words.slice(0, DATA_WORDS).map((w) => w.slice(0, PREFIX_LENGTH)).join("");
  return crc32(new TextEncoder().encode(joined)) % DATA_WORDS;
}

// =========================================================================
// Words <-> 32 key bytes
// =========================================================================

/**
 * Three word indices to one little-endian u32, the inverse of
 * {@link keyBytesToWords}.
 *
 * ```rust
 * let val = a + WORDS_LIST * (((WORDS_LIST - a) + b) % WORDS_LIST)
 *             + WORDS_LIST * WORDS_LIST * (((WORDS_LIST - b) + c) % WORDS_LIST);
 * let val = val as u32;   // silent truncation
 * ```
 *
 * The `as u32` matters: the largest triple is 1626^3 - 1 = 4,298,942,875, which
 * is greater than u32::MAX, so ~0.1% of triples WRAP. The binary accepts such a
 * seed and derives the wrapped key (negative vector `u32_overflow_triple_24`,
 * reproduced here), which means two different word triples can name one key —
 * and the wallet's own `seed` command would then print different words than the
 * user typed. We reproduce the truncation rather than reject it, because
 * rejecting would refuse a seed the binary accepts, i.e. lock a user out of a
 * wallet that exists.
 *
 * Upstream also checks `val % WORDS_LIST == a` and errors otherwise. That is
 * arithmetically unreachable — `val = a + N*x + N^2*y` with `a < N`, so
 * `val % N == a` always — so it is deliberately NOT reproduced: a check that
 * cannot fail is not a check.
 *
 * All arithmetic stays under 2^53, so plain numbers are exact here; `>>> 0`
 * performs the u32 truncation.
 */
function tripleToU32(a: number, b: number, c: number): number {
  const val = a + N * ((N - a + b) % N) + N * N * ((N - b + c) % N);
  return val >>> 0;
}

/** 32 key bytes from 24 word indices. */
function indicesToKeyBytes(indices: readonly number[]): Uint8Array {
  const out = new Uint8Array(32);
  for (let t = 0; t < 8; t++) {
    const v = tripleToU32(indices[3 * t], indices[3 * t + 1], indices[3 * t + 2]);
    out[4 * t] = v & 0xff;
    out[4 * t + 1] = (v >>> 8) & 0xff;
    out[4 * t + 2] = (v >>> 16) & 0xff;
    out[4 * t + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

/**
 * 32 key bytes to the full 25-word seed (24 data words + checksum word).
 *
 * ```rust
 * let a = val % 1626;
 * let b = ((val / 1626) + a) % 1626;
 * let c = ((val / 1626 / 1626) + b) % 1626;
 * ```
 */
function keyBytesToWords(key: Uint8Array): string[] {
  const words: string[] = [];
  for (let t = 0; t < 8; t++) {
    const val =
      ((key[4 * t] | (key[4 * t + 1] << 8) | (key[4 * t + 2] << 16) | (key[4 * t + 3] << 24)) >>>
        0);
    const a = val % N;
    const b = (Math.floor(val / N) + a) % N;
    const c = (Math.floor(val / N / N) + b) % N;
    words.push(MONERO_ENGLISH_WORDS[a], MONERO_ENGLISH_WORDS[b], MONERO_ENGLISH_WORDS[c]);
  }
  words.push(words[checksumIndex(words)]);
  return words;
}

function leToBigInt(bytes: Uint8Array): bigint {
  let x = ZERO;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << BigInt(8)) | BigInt(bytes[i]);
  return x;
}

function bigIntToLe32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & BigInt(0xff));
    x >>= BigInt(8);
  }
  return out;
}

// =========================================================================
// Seed checking
// =========================================================================

/** Check a seed's word count, vocabulary, checksum word and resulting key. */
export function verifyXelisSeedIntegrity(seed: string): XelisSeedCheck {
  const words = normalizeXelisSeed(seed).split(" ").filter(Boolean);

  // 24 is valid: the checksum word is optional and the binary simply does not
  // check it (negative vector `words_24_no_checksum`, accepted, same address).
  if (words.length !== XELIS_SEED_WORD_COUNT && words.length !== DATA_WORDS) {
    return { ok: false, kind: "word-count", count: words.length };
  }

  const unknown: string[] = [];
  const indices: number[] = [];
  for (const w of words) {
    const i = WORD_INDEX.get(w);
    if (i === undefined) unknown.push(w);
    else indices.push(i);
  }
  if (unknown.length > 0) return { ok: false, kind: "unknown-word", words: unknown };

  if (words.length === XELIS_SEED_WORD_COUNT) {
    // Already lowercased by `normalizeXelisSeed`, which is what makes this
    // equivalent to upstream's `eq_ignore_ascii_case`.
    if (words[DATA_WORDS] !== words[checksumIndex(words)]) {
      return { ok: false, kind: "checksum" };
    }
  }

  const s = leToBigInt(indicesToKeyBytes(indices));
  if (s === ZERO || s >= L) return { ok: false, kind: "key" };

  return { ok: true };
}

export function validateXelisSeed(seed: string): boolean {
  return verifyXelisSeedIntegrity(seed).ok;
}

/**
 * A fresh 25-word English seed from OS-backed entropy.
 *
 * Picks a uniform scalar rather than 32 random bytes: about 1 in 16 random
 * 32-byte strings is >= l, and XELIS rejects those outright instead of reducing
 * (see {@link XelisSeedCheck}'s `key`). 64 bytes reduced mod l is the standard
 * wide-reduction construction and leaves negligible bias.
 */
export async function generateXelisSeed(): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wide = await secureRandomBytes(64);
    const s = leToBigInt(wide) % L;
    if (s === ZERO) continue; // ~2^-250; retried rather than reasoned about
    const seed = keyBytesToWords(bigIntToLe32(s)).join(" ");

    // Round-trip before handing back a phrase someone will write on paper: if
    // the encoder and decoder ever disagree, this is a generated wallet nobody
    // can restore. Microseconds, and it catches a whole class of edit.
    const check = verifyXelisSeedIntegrity(seed);
    if (!check.ok) {
      throw new Error(
        `Generated Xelis seed failed its own integrity check (${check.kind}). Refusing to return it.`
      );
    }
    return seed;
  }
  throw new Error("Could not generate a Xelis seed: the OS RNG returned an unusable scalar.");
}

// =========================================================================
// Key -> public key -> address
// =========================================================================

/**
 * `H`, the point every XELIS public key is derived from.
 *
 * `PublicKey::new(secret)` is `s.invert() * H` where `H` is bulletproofs'
 * `PedersenGens::default().B_blinding`, itself
 * `RistrettoPoint::hash_from_bytes::<Sha3_512>(compressed basepoint)`. Computed
 * rather than hardcoded, then pinned by the test against the spike's value
 * `8c9240b4…48871134`, so a noble-curves change that altered either the hash-to
 * -curve or the basepoint encoding fails loudly instead of deriving a different
 * wallet for every user.
 *
 * Memoised: `seed-kind.ts` calls into this module on every keystroke of a seed
 * field, and a hash-to-curve per keystroke is pure waste.
 */
/**
 * The Ristretto point type, taken from `hashToCurve` because it is the one
 * method noble's shared H2C interface declares as REQUIRED. `deriveToCurve` is
 * optional there (not every curve implements it), so naming it in a
 * `ReturnType<>` yields `… | undefined` and fails the constraint.
 */
type RistrettoPoint = ReturnType<typeof ristretto255_hasher.hashToCurve>;

let cachedH: RistrettoPoint | null = null;

function pedersenH(): RistrettoPoint {
  if (cachedH === null) {
    const hasher = ristretto255_hasher;
    // Narrowing, not a runtime safety net: ristretto255 does implement
    // `deriveToCurve`, and the optionality lives in the shared interface. It
    // throws rather than falling back to `hashToCurve`, which is a DIFFERENT
    // map — silently substituting it would change H, and so would change every
    // address this wallet has ever shown a user.
    if (typeof hasher.deriveToCurve !== "function") {
      throw new Error(
        "@noble/curves no longer exposes ristretto255 deriveToCurve; Xelis address " +
          "derivation cannot be done safely without it."
      );
    }
    cachedH = hasher.deriveToCurve(sha3_512(ristretto255.Point.BASE.toBytes()));
  }
  return cachedH;
}

/** s^-1 mod l, by Fermat: s^(l-2). */
function modInverse(s: bigint): bigint {
  let result = BigInt(1);
  let base = s % L;
  let exp = L - BigInt(2);
  while (exp > ZERO) {
    if (exp & BigInt(1)) result = (result * base) % L;
    base = (base * base) % L;
    exp >>= BigInt(1);
  }
  return result;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** BIP-173 polymod. Final constant 1 — bech32, NOT bech32m. */
function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ GENERATOR[i]) >>> 0;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const ch of hrp) {
    high.push(ch.charCodeAt(0) >> 5);
    low.push(ch.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}

/**
 * Regroup bits. With `pad: false` this is STRICT — it returns null on leftover
 * bits or non-zero padding, the BIP-173 rule XELIS's own decoder enforces.
 * A lenient version would accept malformed addresses the daemon rejects.
 */
function convertBits(
  data: readonly number[],
  from: number,
  to: number,
  pad: boolean
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = ((acc << from) | value) >>> 0;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/**
 * XELIS's bech32: standard BIP-173 checksum, but the separator is `:`, not `1`.
 * Payload is the 32-byte compressed public key followed by the address type
 * byte (0x00 normal).
 */
function encodeAddress(publicKey: Uint8Array, network: XelisNetwork): string {
  const hrp = network === "testnet" ? "xet" : "xel";
  const data = convertBits([...publicKey, 0x00], 8, 5, true);
  if (data === null) throw new Error("Xelis address encoding failed (bit conversion).");
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >>> (5 * (5 - i))) & 31);
  return `${hrp}:${[...data, ...checksum].map((v) => CHARSET[v]).join("")}`;
}

/**
 * The address a seed derives, computed offline.
 *
 * Returns null when the seed cannot produce one — a seed that fails
 * {@link verifyXelisSeedIntegrity}. Per the contract, callers treat null as
 * "not known yet" and never as a mismatch; the running wallet reports the
 * authoritative address either way.
 */
export function xelisAddressFromSeed(
  seed: string,
  network: XelisNetwork = "mainnet"
): string | null {
  const normalized = normalizeXelisSeed(seed);
  if (!verifyXelisSeedIntegrity(normalized).ok) return null;

  const words = normalized.split(" ").filter(Boolean);
  const indices = words.map((w) => WORD_INDEX.get(w) as number);
  const s = leToBigInt(indicesToKeyBytes(indices));
  const publicKey = pedersenH().multiply(modInverse(s)).toBytes();
  return encodeAddress(publicKey, network);
}

/**
 * Shape pre-filter: prefix, charset, length, bech32 checksum, bit padding and
 * address-type byte (spike A2). It does NOT prove the 32 bytes decompress to a
 * valid curve point — XELIS's own parser does not check that either
 * (`PublicKey` is a `CompressedPublicKey`), so the daemon's `validate_address`
 * stays the authority before a send.
 *
 * Rejects any uppercase: XELIS forbids mixed case and its data charset is
 * lowercase, so an all-uppercase address is refused by the node too
 * (`Invalid character value in human readable part: 81`).
 */
export function isXelisAddressShape(
  address: string,
  network: XelisNetwork = "mainnet"
): boolean {
  const a = address.trim();
  if (a !== a.toLowerCase()) return false;

  const prefix = xelisAddressPrefix(network);
  if (!a.startsWith(prefix)) return false;
  // The separator is the LAST ':'; a second one would move it and change the hrp.
  if (a.lastIndexOf(":") !== prefix.length - 1) return false;

  const hrp = a.slice(0, prefix.length - 1);
  const body = a.slice(prefix.length);
  if (body.length < 59) return false;

  const data: number[] = [];
  for (const ch of body) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return false;
    data.push(v);
  }

  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return false;

  const payload = convertBits(data.slice(0, -6), 5, 8, false);
  if (payload === null || payload.length < 33) return false;

  const type = payload[32];
  if (payload.length === 33) return type === 0x00;
  // Longer payloads are integrated addresses: type 1 plus a serialized
  // DataElement, capped upstream at EXTRA_DATA_LIMIT_SIZE (1 KB).
  return type === 0x01;
}
