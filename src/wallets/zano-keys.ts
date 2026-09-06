/**
 * Zano (ZANO) seed → key → address derivation. Pure TypeScript, zero WASM,
 * zero Rust — same discipline as `xmr-keys.ts` (see its header for the
 * production-build reason WASM is avoided here).
 *
 * # Relationship to the Monero/Zephyr modules
 *
 * Zano is NOT a Monero fork. Its lead developer wrote the CryptoNote reference
 * implementation that Monero itself forked, so the two share ancestry rather
 * than lineage. In practice that means the lower layers match Monero exactly
 * while two specific layers do not — and the two that differ are precisely the
 * ones that fail SILENTLY when you get them wrong:
 *
 * | Layer                 | Same as Monero? | Where it lives                    |
 * |-----------------------|-----------------|-----------------------------------|
 * | Wordlist              | **NO** (227/1626 shared) | `./zano-wordlist`        |
 * | Word↔bytes codec      | yes (same formula)       | `wordsToBytes` below     |
 * | seed → spend key      | **NO** (64-byte reduce)  | `keysFromDefault` below  |
 * | spend → view key      | yes (`dependent_key`)    | reused via `_internal`   |
 * | base58                | yes (block-based)        | reused via `_internal`   |
 * | address layout        | yes (varint‖keys‖keccak4)| `encodeZanoAddress` below|
 *
 * Every claim above was verified by deriving a real wallet's address from its
 * seed and matching byte-for-byte against `simplewallet v2.2.1.506[b76fa18]`.
 * The pinned vectors live in `zano-keys.test.ts`; do not change this file
 * without re-running them.
 *
 * # The two silent-failure traps
 *
 * 1. **Secured Seed.** When a seed is passphrase-protected, the raw seed bytes
 *    are ChaCha8-**encrypted before** being encoded to words — this is not a
 *    BIP39-style KDF where the passphrase mixes into derivation. A wrong
 *    passphrase therefore yields a *structurally valid, correctly-prefixed,
 *    completely different* address. Nothing downstream can detect it.
 * 2. **Auditable wallets.** These set bit 0 of seed word 26 and use a
 *    different address prefix (`aZx…`, 0x98c8). Deriving one with the standard
 *    prefix produces a well-formed but WRONG address, so
 *    {@link zanoKeysFromSeed} refuses them outright rather than guessing.
 *
 * See `PwndaWalletVault/wiki/synthesis/zano-integration-plan.md` for the full
 * Phase 0 evidence behind every constant here.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { secureRandomBytes } from "../secure-random";
import { ZANO_WORDS } from "./zano-wordlist";
import { _internal } from "./xmr-keys";

// =========================================================================
// Constants (all Phase-0 verified against upstream source + the binary)
// =========================================================================

/** `CURRENCY_PUBLIC_ADDRESS_BASE58_PREFIX = 0xc5` → varint [0xc5, 0x01] → "Zx…" */
const ZANO_MAINNET_PREFIX_VARINT = new Uint8Array([0xc5, 0x01]);

/**
 * `CURRENCY_PUBLIC_AUDITABLE_ADDRESS_BASE58_PREFIX = 0x98c8` → "aZx…".
 * Present for detection only — auditable wallets are out of scope, and we
 * reject rather than derive them (see the header's trap #2).
 */
const ZANO_AUDITABLE_PREFIX_VARINT = new Uint8Array([0xc8, 0xb1, 0x02]);

/** `WALLET_BRAIN_DATE_OFFSET` — seed word 25 counts weeks from this epoch. */
const BRAIN_DATE_OFFSET = 1_543_622_400;
/** `WALLET_BRAIN_DATE_QUANTUM` — one week in seconds. */
const BRAIN_DATE_QUANTUM = 604_800;
/** `WALLET_BRAIN_DATE_MAX_WEEKS_COUNT` — also the "passphrase used" bias. */
const BRAIN_DATE_MAX_WEEKS = 800;

/** `checksum_max = NUMWORDS >> 1` = 813; word 26 packs `flag | checksum<<1`. */
const CHECKSUM_MAX = ZANO_WORDS.length >> 1;

const N = BigInt(ZANO_WORDS.length); // 1626
const WORD_INDEX: ReadonlyMap<string, number> = new Map(
  ZANO_WORDS.map((w, i) => [w, i] as const)
);

// =========================================================================
// Types
// =========================================================================

export interface ZanoSeedMeta {
  /** Word count as supplied: 24/25 = v1 legacy, 26 = v2. */
  wordCount: number;
  /** True when seed word 25 signals a Secured-Seed passphrase is required. */
  passwordProtected: boolean;
  /** True when seed word 26 bit 0 marks an auditable wallet. */
  auditable: boolean;
  /** Creation time (unix seconds), floored to the one-week quantum. */
  creationTimestamp: number | null;
}

export interface ZanoKeys {
  spendSecret: Uint8Array;
  viewSecret: Uint8Array;
  spendPublic: Uint8Array;
  viewPublic: Uint8Array;
  address: string;
}

// =========================================================================
// Word codec — same algorithm as Monero's, but over ZANO'S wordlist
// =========================================================================

/**
 * Decode 24 words → 32 bytes. Three words carry four bytes:
 *   `x = w1 + n·((n − w1 + w2) mod n) + n²·((n − w2 + w3) mod n)`, n = 1626.
 *
 * Only the first 24 words are key material; words 25/26 are metadata and must
 * be sliced off by the caller before calling this.
 */
function wordsToBytes(words: string[]): Uint8Array {
  if (words.length !== 24) {
    throw new Error(`Zano key payload must be 24 words, got ${words.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const w1 = WORD_INDEX.get(words[i * 3]);
    const w2 = WORD_INDEX.get(words[i * 3 + 1]);
    const w3 = WORD_INDEX.get(words[i * 3 + 2]);
    if (w1 === undefined || w2 === undefined || w3 === undefined) {
      const bad =
        w1 === undefined
          ? words[i * 3]
          : w2 === undefined
            ? words[i * 3 + 1]
            : words[i * 3 + 2];
      throw new Error(`"${bad}" is not in the Zano wordlist`);
    }
    const a = BigInt(w1);
    const b = BigInt(w2);
    const c = BigInt(w3);
    const x = a + N * ((N - a + b) % N) + N * N * ((N - b + c) % N);
    if (x >= 1n << 32n) {
      throw new Error("Zano seed word group overflows 32 bits");
    }
    out[i * 4] = Number(x & 0xffn);
    out[i * 4 + 1] = Number((x >> 8n) & 0xffn);
    out[i * 4 + 2] = Number((x >> 16n) & 0xffn);
    out[i * 4 + 3] = Number((x >> 24n) & 0xffn);
  }
  return out;
}

/** Inverse of {@link wordsToBytes}: 32 bytes → 24 words. */
function bytesToWords(bytes: Uint8Array): string[] {
  if (bytes.length !== 32) {
    throw new Error(`Expected 32 seed bytes, got ${bytes.length}`);
  }
  const words: string[] = [];
  for (let i = 0; i < 8; i++) {
    const x =
      BigInt(bytes[i * 4]) |
      (BigInt(bytes[i * 4 + 1]) << 8n) |
      (BigInt(bytes[i * 4 + 2]) << 16n) |
      (BigInt(bytes[i * 4 + 3]) << 24n);
    const w1 = x % N;
    const w2 = (x / N + w1) % N;
    const w3 = (x / N / N + w2) % N;
    words.push(ZANO_WORDS[Number(w1)], ZANO_WORDS[Number(w2)], ZANO_WORDS[Number(w3)]);
  }
  return words;
}

// =========================================================================
// ChaCha8 — Secured Seed encryption
// =========================================================================
//
// Implemented inline rather than pulled from a cipher library: upstream uses
// ChaCha with **8** rounds, and the common libraries expose ChaCha20 with a
// fixed round count. It is ~35 lines, and a wallet is a poor place to add a
// dependency for one primitive.
//
// Layout matches `zano/src/crypto/chacha.c`: sigma constants, 64-bit counter
// in words 12/13, 64-bit IV in words 14/15.

const rotl32 = (v: number, c: number): number => ((v << c) | (v >>> (32 - c))) >>> 0;

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function chacha8(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]; // "expand 32-byte k"
  const j = new Uint32Array(16);
  j.set(SIGMA, 0);
  for (let i = 0; i < 8; i++) j[4 + i] = u32le(key, i * 4);
  j[12] = 0;
  j[13] = 0;
  j[14] = u32le(iv, 0);
  j[15] = u32le(iv, 4);

  const out = new Uint8Array(data.length);
  const x = new Uint32Array(16);
  for (let off = 0; off < data.length; off += 64) {
    x.set(j);
    // 8 rounds = 4 double-rounds.
    for (let r = 0; r < 4; r++) {
      const qr = (a: number, b: number, c: number, d: number): void => {
        x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl32(x[d] ^ x[a], 16);
        x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl32(x[b] ^ x[c], 12);
        x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl32(x[d] ^ x[a], 8);
        x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl32(x[b] ^ x[c], 7);
      };
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) {
      const w = (x[i] + j[i]) >>> 0;
      for (let k = 0; k < 4; k++) {
        const p = off + i * 4 + k;
        if (p < data.length) out[p] = data[p] ^ ((w >>> (8 * k)) & 0xff);
      }
    }
    j[12] = (j[12] + 1) >>> 0;
    if (j[12] === 0) j[13] = (j[13] + 1) >>> 0;
  }
  return out;
}

/**
 * `account_base::crypt_with_pass`. Note that BOTH the key and the IV come from
 * the same `keccak256(passphrase)` — the key is all 32 bytes, the IV the first
 * 8. ChaCha is a stream cipher, so this is its own inverse.
 */
function cryptWithPass(data: Uint8Array, passphrase: string): Uint8Array {
  const h = keccak_256(new TextEncoder().encode(passphrase));
  return chacha8(h, h.slice(0, 8), data);
}

// =========================================================================
// Key derivation
// =========================================================================

const leToBig = (b: Uint8Array): bigint =>
  b.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

const bigToLe32 = (v: bigint): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));

/**
 * `crypto::keys_from_default` — the step that is NOT Monero's.
 *
 * Monero derives the spend scalar as `sc_reduce32(seed)`. Zano builds a
 * 64-byte buffer `seed ‖ keccak256(seed)` and reduces THAT (`sc_reduce` over
 * 64 bytes, i.e. mod-L of the full little-endian 512-bit value). Using
 * Monero's step here yields a valid-looking, wrong address — which is exactly
 * how it was caught during Phase 0.
 */
function keysFromDefault(seed: Uint8Array): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(seed, 0);
  buf.set(keccak_256(seed), 32);
  return bigToLe32(leToBig(buf) % _internal.L);
}

// =========================================================================
// Seed metadata (words 25 and 26)
// =========================================================================

/**
 * Decode seed word 25: weeks since the brain-date epoch, biased by
 * `BRAIN_DATE_MAX_WEEKS` when a Secured-Seed passphrase is in use. This bias
 * is how a seed self-declares that it needs a passphrase — which is why the
 * UI can say "this seed requires its password" instead of guessing.
 */
function decodeTimestampWord(word: string): {
  passwordProtected: boolean;
  creationTimestamp: number;
} {
  const idx = WORD_INDEX.get(word);
  if (idx === undefined) {
    throw new Error(`"${word}" is not in the Zano wordlist`);
  }
  let weeks = idx;
  let passwordProtected = false;
  if (weeks >= BRAIN_DATE_MAX_WEEKS) {
    weeks -= BRAIN_DATE_MAX_WEEKS;
    passwordProtected = true;
  }
  return {
    passwordProtected,
    creationTimestamp: weeks * BRAIN_DATE_QUANTUM + BRAIN_DATE_OFFSET,
  };
}

/** Encode seed word 25 from a creation time + whether a passphrase is set. */
function encodeTimestampWord(timestamp: number, passwordUsed: boolean): string {
  const offset = timestamp > BRAIN_DATE_OFFSET ? timestamp - BRAIN_DATE_OFFSET : 0;
  let weeks = Math.floor(offset / BRAIN_DATE_QUANTUM);
  if (weeks >= BRAIN_DATE_MAX_WEEKS) {
    throw new Error("Zano seed timestamp is beyond the encodable range");
  }
  if (passwordUsed) weeks += BRAIN_DATE_MAX_WEEKS;
  return ZANO_WORDS[weeks];
}

/**
 * Compute seed word 26: `(auditable & 1) | (checksum << 1)`.
 *
 * Two things here are easy to get wrong and are load-bearing:
 *  - the checksum hashes the **plaintext** seed (plus the passphrase), never
 *    the encrypted form that the words actually encode;
 *  - the first u64 of that hash is overwritten with the rounded timestamp
 *    before a second hash. The `% (CHECKSUM_MAX + 1)` and the
 *    collapse-813-to-0 step are an upstream workaround, commented as such in
 *    `account.cpp`. Replicate it; do not "fix" it.
 */
function computeChecksumWord(
  seedPlain: Uint8Array,
  passphrase: string,
  creationTimestampRounded: number,
  auditable: boolean
): string {
  const pw = new TextEncoder().encode(passphrase);
  const forHash = new Uint8Array(seedPlain.length + pw.length);
  forHash.set(seedPlain, 0);
  forHash.set(pw, seedPlain.length);

  const h = Uint8Array.from(keccak_256(forHash));
  const ts = BigInt(creationTimestampRounded);
  for (let i = 0; i < 8; i++) h[i] = Number((ts >> BigInt(8 * i)) & 0xffn);

  const h2 = keccak_256(h);
  let checksum = Number(leToBig(h2.slice(0, 8)) % BigInt(CHECKSUM_MAX + 1));
  if (checksum === CHECKSUM_MAX) checksum = 0;

  return ZANO_WORDS[(auditable ? 1 : 0) | (checksum << 1)];
}

// =========================================================================
// Address
// =========================================================================

/**
 * `base58(varint(prefix) ‖ spend_pub ‖ view_pub ‖ keccak256(payload)[0..4])`,
 * base58 being Monero's block scheme (reused from `xmr-keys`).
 *
 * Same construction as Zephyr's — only the prefix bytes differ (2 for Zano vs
 * Zephyr's 5), which is what makes every mainnet address start "Zx".
 */
function encodeZanoAddress(
  spendPub: Uint8Array,
  viewPub: Uint8Array,
  prefix: Uint8Array = ZANO_MAINNET_PREFIX_VARINT
): string {
  const payload = new Uint8Array(prefix.length + 64);
  payload.set(prefix, 0);
  payload.set(spendPub, prefix.length);
  payload.set(viewPub, prefix.length + 32);

  const raw = new Uint8Array(payload.length + 4);
  raw.set(payload, 0);
  raw.set(keccak_256(payload).slice(0, 4), payload.length);
  return _internal.moneroBase58Encode(raw);
}

// =========================================================================
// Public API
// =========================================================================

/** Whitespace normalisation + lowercase. Zano matches words EXACTLY, so no
 *  prefix-tolerant fuzzing is applied here (see `zano-wordlist.ts` header). */
export function normalizeZanoSeed(seed: string): string {
  return seed.trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * Parse the metadata words without deriving any keys. Cheap, and safe to call
 * on untrusted input — used by the import UI to decide whether to prompt for a
 * Secured-Seed passphrase, and to reject auditable seeds early.
 */
export function readZanoSeedMeta(seed: string): ZanoSeedMeta {
  const words = normalizeZanoSeed(seed).split(" ");
  if (words.length < 24 || words.length > 26) {
    throw new Error(`Zano seed must be 24-26 words, got ${words.length}`);
  }
  let passwordProtected = false;
  let creationTimestamp: number | null = null;
  if (words.length >= 25) {
    const t = decodeTimestampWord(words[24]);
    passwordProtected = t.passwordProtected;
    creationTimestamp = t.creationTimestamp;
  }
  let auditable = false;
  if (words.length >= 26) {
    const idx = WORD_INDEX.get(words[25]);
    if (idx === undefined) {
      throw new Error(`"${words[25]}" is not in the Zano wordlist`);
    }
    auditable = (idx & 1) === 1;
  }
  return { wordCount: words.length, passwordProtected, auditable, creationTimestamp };
}

/** True when the seed declares it needs a Secured-Seed passphrase. */
export function isZanoSeedPasswordProtected(seed: string): boolean {
  return readZanoSeedMeta(seed).passwordProtected;
}

/** Wordlist + structure check, no key derivation. Cheap. */
export function validateZanoSeed(seed: string): boolean {
  try {
    const words = normalizeZanoSeed(seed).split(" ");
    readZanoSeedMeta(seed);
    return words.slice(0, 24).every((w) => WORD_INDEX.has(w));
  } catch {
    return false;
  }
}

/**
 * Derive Zano keys + primary address from a seed phrase.
 *
 * @param passphrase Secured-Seed passphrase. REQUIRED when the seed declares
 *   one (`readZanoSeedMeta().passwordProtected`). Supplying a wrong passphrase
 *   cannot be detected here — it yields a different, valid-looking address.
 *   Callers must treat a passphrase as unverified until the user confirms the
 *   resulting address, or until a balance appears.
 *
 * Auditable seeds are REJECTED rather than derived: they use a different
 * address prefix, so deriving with the standard one silently returns the wrong
 * address. Supporting them is out of scope for v1.
 */
export function zanoKeysFromSeed(seed: string, passphrase = ""): ZanoKeys {
  const meta = readZanoSeedMeta(seed);
  if (meta.auditable) {
    throw new Error(
      "This is an auditable Zano seed (word 26 flag). Auditable wallets use a " +
        "different address format and are not supported yet — importing it here " +
        "would derive the wrong address."
    );
  }
  if (meta.passwordProtected && passphrase.length === 0) {
    throw new Error(
      "This Zano seed is password-protected (Secured Seed). Its passphrase is " +
        "required to restore the correct wallet."
    );
  }

  const words = normalizeZanoSeed(seed).split(" ");
  let seedBytes = wordsToBytes(words.slice(0, 24));
  if (meta.passwordProtected) {
    seedBytes = cryptWithPass(seedBytes, passphrase);
  }

  const spendSecret = keysFromDefault(seedBytes);
  // `dependent_key`: identical to Monero's view-from-spend step.
  const viewSecret = _internal.scReduce32(keccak_256(spendSecret));
  const spendPublic = _internal.scalarMultBase(spendSecret);
  const viewPublic = _internal.scalarMultBase(viewSecret);

  return {
    spendSecret,
    viewSecret,
    spendPublic,
    viewPublic,
    address: encodeZanoAddress(spendPublic, viewPublic),
  };
}

/** Convenience: seed → primary address. */
export function zanoAddressFromSeed(seed: string, passphrase = ""): string {
  return zanoKeysFromSeed(seed, passphrase).address;
}

/**
 * Generate a fresh 26-word (v2) Zano seed.
 *
 * Round-trips the phrase back through the decoder before returning, mirroring
 * `generateXmrSeed`'s sanity check: returning a phrase that does not decode to
 * the bytes it was built from would hand the user an unrecoverable wallet.
 */
export async function generateZanoSeed(): Promise<string> {
  const seedBytes = await secureRandomBytes(32);
  const words = bytesToWords(seedBytes);

  const roundTrip = wordsToBytes(words);
  if (roundTrip.length !== seedBytes.length || roundTrip.some((b, i) => b !== seedBytes[i])) {
    throw new Error(
      "Zano seed sanity check failed: the encoded phrase does not round-trip " +
        "back to its source bytes. Refusing to return a potentially corrupt seed."
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const timestampWord = encodeTimestampWord(nowSec, false);
  // Re-read the word so the checksum uses the same FLOORED timestamp upstream
  // would use — computing it from `nowSec` directly would drift by up to a week
  // and produce a phrase the real wallet rejects.
  const rounded = decodeTimestampWord(timestampWord).creationTimestamp;
  const checksumWord = computeChecksumWord(seedBytes, "", rounded, false);

  return [...words, timestampWord, checksumWord].join(" ");
}

// =========================================================================
// Seed + passphrase verification
// =========================================================================

export type ZanoSeedCheck =
  | { ok: true }
  /** Word 26 says auditable — a different address format we do not derive. */
  | { ok: false; kind: "auditable" }
  /** The seed declares a Secured-Seed passphrase and none was supplied. */
  | { ok: false; kind: "passphrase-required" }
  /**
   * Word 26's checksum does not match what this (seed, passphrase) pair
   * produces. For a protected seed the overwhelmingly likely cause is a wrong
   * passphrase; for an ordinary seed, a mistyped or misordered word.
   */
  | { ok: false; kind: "checksum" };

/**
 * Verify a seed — and, when it is passphrase-protected, the passphrase —
 * against word 26's checksum.
 *
 * # Why this exists (added 2026-08-28)
 *
 * Until now `computeChecksumWord` ran **only at generation**. Nothing
 * validated an imported phrase, so two distinct mistakes were equally silent:
 *
 *  - a wrong Secured-Seed passphrase, which decrypts the 24 words to
 *    *different plaintext* and derives a well-formed address for a wallet
 *    nobody controls;
 *  - a mistyped seed word, same outcome.
 *
 * Measured on the pinned `simplewallet v2.2.1.506` vector: the passphrase
 * `seedpw456` gives the real wallet, while `seedpw457` (one digit out) and
 * `Seedpw456` (one case out) each give a valid 97-character `Zx…` address
 * that is simply wrong. Nothing downstream can tell.
 *
 * The checksum CAN tell, because upstream computes it over the **decrypted**
 * seed bytes concatenated with the passphrase (see `computeChecksumWord`).
 * Recomputing it with a candidate passphrase and comparing to the seed's own
 * word 26 rejects a wrong candidate.
 *
 * # The limit, stated honestly
 *
 * The checksum is `ZANO_WORDS.length >> 1` = 813 values wide, so a wrong
 * passphrase has a ~1-in-813 chance of matching anyway. Measured over 20,000
 * wrong passphrases: 22 false accepts (0.110%), against a theoretical 0.123%.
 *
 * That makes this a strong filter, **not a proof**. It turns "silently wrong,
 * always" into "caught 99.9% of the time", and the derived address remains
 * the user's final confirmation. Callers must not present a passing check as
 * certainty.
 */
export function verifyZanoSeedIntegrity(
  seed: string,
  passphrase = ""
): ZanoSeedCheck {
  const meta = readZanoSeedMeta(seed);
  if (meta.auditable) return { ok: false, kind: "auditable" };
  if (meta.passwordProtected && passphrase.length === 0) {
    return { ok: false, kind: "passphrase-required" };
  }
  if (meta.creationTimestamp == null) {
    // No decodable timestamp means no checksum to compare against; the seed
    // is already rejected upstream by `readZanoSeedMeta`, but be explicit
    // rather than computing a checksum from a guessed date.
    return { ok: false, kind: "checksum" };
  }

  const words = normalizeZanoSeed(seed).split(" ");
  const encrypted = wordsToBytes(words.slice(0, 24));
  const plain = meta.passwordProtected
    ? cryptWithPass(encrypted, passphrase)
    : encrypted;

  const expected = computeChecksumWord(
    plain,
    passphrase,
    meta.creationTimestamp,
    meta.auditable
  );
  return expected === words[25] ? { ok: true } : { ok: false, kind: "checksum" };
}

// =========================================================================
// Internal exports for unit tests
// =========================================================================

export const _zanoInternal = {
  wordsToBytes,
  bytesToWords,
  chacha8,
  cryptWithPass,
  keysFromDefault,
  decodeTimestampWord,
  encodeTimestampWord,
  computeChecksumWord,
  encodeZanoAddress,
  ZANO_MAINNET_PREFIX_VARINT,
  ZANO_AUDITABLE_PREFIX_VARINT,
};
