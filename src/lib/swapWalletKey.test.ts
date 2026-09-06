import { describe, expect, it } from "vitest";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { deriveSwapWalletMnemonic } from "./bip85";
import {
  deriveSwapWalletKey,
  deriveSwapWalletMaterial,
  swapWalletKeyFromSeed,
  SWAP_WALLET_KEY_BYTES,
  SWAP_WALLET_KEY_INFO,
} from "./swapWalletKey";

/**
 * The swap wallet key is `WALLET_ENCRYPTION_PWD` — the only thing standing
 * between an observer of the swap node's `wallet.dat` and the coin keys inside
 * it, and the only thing that can ever re-open that file. Two failure shapes
 * matter and neither announces itself:
 *
 * 1. **Wrong derivation.** Any change to the label, hash, length or encoding
 *    still yields a plausible 43-character key. The wallet encrypts fine and
 *    then never unlocks again. Pinned by an independent RFC 5869
 *    reimplementation plus a golden vector.
 * 2. **Collapsed domain separation.** If the key is secretly the same material
 *    as the swap mnemonic (or the vault seed) in another encoding, then leaking
 *    the password — which is *designed* to be handed to a Python subprocess —
 *    leaks spending authority. Pinned by asserting the key is not any encoding
 *    of its siblings, and that the label actually reaches HKDF.
 *
 * Tests here therefore avoid recomputing the implementation's own arithmetic:
 * the HKDF oracle is written from the RFC, and the base64url oracle uses the
 * platform's base64, so a bug in `swapWalletKey.ts` cannot be mirrored into the
 * expectation.
 */

/** BIP39's standard all-`abandon` test vector. World-public, zero funds. */
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** A second world-public BIP39 vector, for cross-mnemonic independence. */
const OTHER_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

/**
 * Golden vectors — the derivation coordinates are part of the recovery path.
 *
 * These are pinned for the same reason `SWAP_WALLET_BIP85` is: once a user has
 * an encrypted swap wallet, changing the label / hash / length / encoding
 * orphans it, and the user experiences that as "my swap wallet won't unlock"
 * with nothing in the logs naming the cause. Regenerating these values to make
 * a failing test pass is therefore always the wrong move — the failure means
 * the derivation changed.
 */
const GOLDEN = {
  [TEST_MNEMONIC]: "7OFSORPX-5WH6HGNHs0DoKy_-wr4JfEv8sJnBcjOU8Q",
  [OTHER_MNEMONIC]: "fQbYjOmzWr_RWHJ3CU5m8Ey34v5RHvDWmtvwgim7uao",
} as const;

// ── independent oracles ─────────────────────────────────────────────────────

/**
 * HKDF-SHA256 written straight from RFC 5869 §2.2/§2.3, using only `hmac`.
 *
 * Deliberately does NOT call `@noble/hashes/hkdf` — that is the function under
 * test's own dependency, and reusing it would make this oracle blind to the
 * single most dangerous mistake available here: passing the label into the
 * `salt` slot instead of the `info` slot. `hkdf(hash, ikm, salt, info, len)`
 * makes that a one-token error that changes the output permanently and errors
 * nowhere.
 */
function rfc5869HkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  const prk = hmac(sha256, salt, ikm); // extract
  const out = new Uint8Array(length);
  let t: Uint8Array = new Uint8Array(0);
  let filled = 0;
  for (let counter = 1; filled < length; counter++) {
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t, 0);
    input.set(info, t.length);
    input[t.length + info.length] = counter;
    t = hmac(sha256, prk, input); // expand
    const take = Math.min(t.length, length - filled);
    out.set(t.subarray(0, take), filled);
    filled += take;
  }
  return out;
}

/** base64url via the platform's own base64 — an encoder we did not write. */
function base64UrlOracle(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when `needle` appears as a contiguous run inside `hay`. */
function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// ── the derivation itself ───────────────────────────────────────────────────

describe("swap wallet key — derivation", () => {
  /**
   * THE load-bearing correctness test. Reproduces the whole pipeline from the
   * RFC and from the platform's base64, then compares against the real
   * implementation. Goes red on: a wrong hash, a wrong output length, a
   * salt/info argument swap, a changed label, a broken base64url encoder, or
   * seeding from anything other than the empty-passphrase BIP39 seed.
   */
  it("matches an independent RFC 5869 HKDF-SHA256 implementation", async () => {
    for (const mnemonic of [TEST_MNEMONIC, OTHER_MNEMONIC]) {
      const seed = await mnemonicToSeed(mnemonic);
      const expected = base64UrlOracle(
        rfc5869HkdfSha256(
          seed,
          new Uint8Array(0), // empty salt, per the module's documented choice
          new TextEncoder().encode(SWAP_WALLET_KEY_INFO),
          SWAP_WALLET_KEY_BYTES,
        ),
      );
      expect(await deriveSwapWalletKey(mnemonic)).toBe(expected);
    }
  });

  /**
   * The golden pin. The oracle test above proves we implement *a* correct
   * HKDF; this proves we implement the *same one we shipped*. If both go red
   * together, someone changed the derivation. If only this one goes red, the
   * oracle drifted with it — which is exactly the case a self-consistent test
   * suite would otherwise miss.
   */
  it("reproduces its pinned golden vectors", async () => {
    for (const [mnemonic, key] of Object.entries(GOLDEN)) {
      expect(await deriveSwapWalletKey(mnemonic)).toBe(key);
    }
  });

  it("is deterministic across repeated derivations", async () => {
    const a = await deriveSwapWalletKey(TEST_MNEMONIC);
    const b = await deriveSwapWalletKey(TEST_MNEMONIC);
    const c = await deriveSwapWalletKey(TEST_MNEMONIC);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  /**
   * The key and the swap mnemonic must agree on what "the vault phrase" is.
   * `bip85.ts` normalizes with `.trim().replace(/\s+/g, " ")`; if this module
   * diverged, a phrase pasted with a trailing newline would produce a swap
   * wallet whose keys came from one normalization and whose password came from
   * another — created successfully, then permanently unopenable, on that
   * machine only.
   */
  it("normalizes whitespace the same way the BIP-85 mnemonic derivation does", async () => {
    const padded = `  ${TEST_MNEMONIC.replace(/ /g, "   ")}\n`;
    expect(await deriveSwapWalletKey(padded)).toBe(
      await deriveSwapWalletKey(TEST_MNEMONIC),
    );
    // and the sibling derivation agrees, which is the property that matters
    expect(deriveSwapWalletMnemonic(padded)).toBe(
      deriveSwapWalletMnemonic(TEST_MNEMONIC),
    );
  });
});

// ── domain separation ───────────────────────────────────────────────────────

describe("swap wallet key — domain separation", () => {
  /**
   * The security property, stated as an inequality against every sibling
   * secret *and its plausible encodings*.
   *
   * The naive form of this test — `expect(key).not.toBe(mnemonic)` — is not
   * enough, and saying so matters: a mutation that makes the key literally be
   * the swap mnemonic's entropy in base64url leaves that naive assertion green
   * (words vs. base64 never compare equal) while the password and the spending
   * key have become the same secret. So the assertions below compare against
   * the *bytes*, in every encoding they could arrive in.
   */
  it("is not the swap mnemonic, the vault mnemonic, or a re-encoding of either", async () => {
    const key = await deriveSwapWalletKey(TEST_MNEMONIC);
    const swapMnemonic = deriveSwapWalletMnemonic(TEST_MNEMONIC);
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const keyBytes = base64UrlDecode(key);

    // the plain forms
    expect(key).not.toBe(swapMnemonic);
    expect(key).not.toBe(TEST_MNEMONIC);

    // the encodings — this is where a collapsed derivation actually shows up
    const swapEntropy = mnemonicToEntropy(swapMnemonic, wordlist);
    const vaultEntropy = mnemonicToEntropy(TEST_MNEMONIC, wordlist);
    expect(key).not.toBe(base64UrlOracle(swapEntropy));
    expect(key).not.toBe(base64UrlOracle(vaultEntropy));
    expect(key).not.toBe(base64UrlOracle(seed.subarray(0, 32)));
    expect(key).not.toBe(base64UrlOracle(seed.subarray(32)));

    // and byte-wise: the key material must not be a slice of any of them
    expect(containsBytes(swapEntropy, keyBytes)).toBe(false);
    expect(containsBytes(seed, keyBytes)).toBe(false);
  });

  /**
   * Proves the label actually reaches HKDF rather than being decorative.
   *
   * This is the direct falsifier for "remove the domain separation": drop the
   * `info` argument from the `hkdf(...)` call and every application collapses
   * onto one key, so these two derivations become equal and this goes red.
   */
  it("gives a different key for a different domain-separation label", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const ours = swapWalletKeyFromSeed(seed, SWAP_WALLET_KEY_INFO);
    const neighbour = swapWalletKeyFromSeed(
      seed,
      "pwnda/basicswap/some-other-application/v1",
    );
    const bip85Label = swapWalletKeyFromSeed(seed, "bip-entropy-from-k");
    expect(neighbour).not.toBe(ours);
    expect(bip85Label).not.toBe(ours);
    expect(neighbour).not.toBe(bip85Label);
    // the production default must be the frozen label, not merely "some label"
    expect(swapWalletKeyFromSeed(seed)).toBe(ours);
  });

  it("refuses to derive without a label", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    expect(() => swapWalletKeyFromSeed(seed, "")).toThrow(
      /domain-separation label/,
    );
  });

  /**
   * The label is frozen. It is quoted here literally so that changing the
   * constant cannot silently change what every existing wallet was encrypted
   * under — the diff has to touch this line, and this comment.
   */
  it("pins the frozen label and output width", () => {
    expect(SWAP_WALLET_KEY_INFO).toBe("pwnda/basicswap/wallet-encryption/v1");
    expect(SWAP_WALLET_KEY_BYTES).toBe(32);
  });
});

// ── independence + entropy ──────────────────────────────────────────────────

describe("swap wallet key — independence and entropy", () => {
  /**
   * 64 distinct vaults must give 64 distinct keys. Generated deterministically
   * (SHA-256 of a counter → 16 bytes → a valid 12-word mnemonic) so the test
   * has no randomness and cannot flake.
   */
  it("gives a different key for every different vault mnemonic", async () => {
    const keys: string[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const entropy = sha256(new TextEncoder().encode(`pwnda-vault-${i}`)).slice(
        0,
        16,
      );
      const key = await deriveSwapWalletKey(entropyToMnemonic(entropy, wordlist));
      keys.push(key);
      for (const b of base64UrlDecode(key)) seen.add(b);
    }
    expect(new Set(keys).size).toBe(64);

    // Entropy smell-test over 64 × 32 = 2048 derived bytes. Uniform bytes are
    // overwhelmingly likely to cover ~256 distinct values; a low-entropy or
    // structured key (a constant, a counter, hex-of-4-bytes, an ASCII string)
    // covers far fewer. Deterministic inputs ⇒ deterministic result, so this
    // threshold cannot flake.
    expect(seen.size).toBeGreaterThanOrEqual(250);
  });

  /**
   * The distinctness test above is weaker than it looks and this exists to say
   * so: HKDF over even a two-byte slice of the seed still yields 64 distinct,
   * high-looking keys, so "all 64 differ" cannot detect an implementation that
   * silently throws most of the seed away. This can — every byte position of
   * the 64-byte IKM must reach the output.
   */
  it("consumes the whole seed, not a prefix of it", () => {
    const base = new Uint8Array(64).fill(7);
    const baseKey = swapWalletKeyFromSeed(base);
    for (const pos of [0, 1, 31, 32, 62, 63]) {
      const tweaked = base.slice();
      tweaked[pos] ^= 0x01;
      expect(swapWalletKeyFromSeed(tweaked)).not.toBe(baseKey);
    }
  });

  it("has the shape a 256-bit machine secret should have", async () => {
    const key = await deriveSwapWalletKey(TEST_MNEMONIC);
    // unpadded base64url of 32 bytes
    expect(key).toHaveLength(43);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key).not.toContain("=");
    const bytes = base64UrlDecode(key);
    expect(bytes).toHaveLength(SWAP_WALLET_KEY_BYTES);
    // and our hand-rolled encoder agrees with the platform's base64
    expect(base64UrlOracle(bytes)).toBe(key);
  });

  it("refuses a seed too short to be a BIP39 seed", () => {
    expect(() => swapWalletKeyFromSeed(new Uint8Array(8))).toThrow(
      /at least 16 bytes/,
    );
  });

  it("refuses an empty vault mnemonic", async () => {
    await expect(deriveSwapWalletKey("   \n ")).rejects.toThrow(
      /empty vault mnemonic/,
    );
    await expect(deriveSwapWalletMaterial("")).rejects.toThrow(
      /empty vault mnemonic/,
    );
  });
});

// ── the bundle the setup wizard consumes ────────────────────────────────────

describe("deriveSwapWalletMaterial", () => {
  it("returns both halves, each equal to its own single-purpose derivation", async () => {
    const material = await deriveSwapWalletMaterial(TEST_MNEMONIC);
    expect(material.mnemonic).toBe(deriveSwapWalletMnemonic(TEST_MNEMONIC));
    expect(material.walletKey).toBe(await deriveSwapWalletKey(TEST_MNEMONIC));
    // 24 words, per SWAP_WALLET_BIP85 — the engine's particl master
    expect(material.mnemonic.split(" ")).toHaveLength(24);
    expect(material.walletKey).not.toBe(material.mnemonic);
  });

  it("is deterministic and whitespace-stable as a pair", async () => {
    const a = await deriveSwapWalletMaterial(TEST_MNEMONIC);
    const b = await deriveSwapWalletMaterial(`\t${TEST_MNEMONIC}  `);
    expect(b).toEqual(a);
  });
});
