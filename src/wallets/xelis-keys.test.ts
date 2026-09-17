/**
 * The Xelis seed codec, pinned to vectors PRODUCED BY THE REAL BINARY.
 *
 * Source: the P0 spike of 2026-09-15 against `xelis_wallet` v1.25.0
 * (`wiki/queries/2026-09-15-xelis-wallet-binary-spike.md`). The fixture in
 * `xelis-vectors.ts` is generated mechanically from that spike's `vectors.json`,
 * where every positive row is binary-create == binary-restore on BOTH networks.
 *
 * Why this file is the important one: a seed codec that merely looks right
 * produces VALID-LOOKING wallets that the real binary cannot restore. The
 * failure is silent, permanent and only discovered when someone tries to get
 * their money back. So nothing here asserts self-consistency — every expected
 * value came out of the binary.
 */
import { describe, it, expect, vi } from "vitest";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { sha3_512 } from "@noble/hashes/sha3.js";
import { createHash } from "node:crypto";

import { MONERO_ENGLISH_WORDS } from "./xmr-wordlist";
import { XELIS_VECTORS, XELIS_NEGATIVE_VECTORS } from "./xelis-vectors";

// `xelis-keys.ts` pulls OS entropy through the Tauri bridge, which does not
// exist in a node test. Mocked so the module graph never loads `lib/tauri`.
const mockEntropy = vi.fn(async (n: number) => new Uint8Array(n).fill(0x11));
vi.mock("../secure-random", () => ({
  secureRandomBytes: (n: number) => mockEntropy(n),
  bytesEqual: () => true,
}));

import {
  XELIS_SEED_WORD_COUNT,
  generateXelisSeed,
  isXelisAddressShape,
  normalizeXelisSeed,
  validateXelisSeed,
  verifyXelisSeedIntegrity,
  xelisAddressFromSeed,
  xelisAddressPrefix,
} from "./xelis-keys";

const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");

describe("the wordlist Xelis shares with Monero", () => {
  /**
   * XELIS's English list is Monero's legacy list: 1626 words, SAME ORDER,
   * verified word-for-word against `english-wordlist.json` extracted from
   * `xelis_wallet/src/mnemonics/languages/english.rs` at v1.25.0.
   *
   * `xelis-keys.ts` therefore imports `MONERO_ENGLISH_WORDS` instead of
   * shipping a second copy. That saves 23 KB and removes a drift risk, but it
   * creates a new one: an edit to the MONERO list would silently re-derive
   * every Xelis address in the wallet. This digest is the tripwire for that —
   * if it fails, do not "update the expected value".
   */
  it("is byte-identical to the list the Xelis binary uses", () => {
    expect(MONERO_ENGLISH_WORDS.length).toBe(1626);
    const digest = createHash("sha256").update(MONERO_ENGLISH_WORDS.join(" ")).digest("hex");
    expect(digest).toBe("3c381ebb6defd69ab7c1998641c8a047a1488fcebc393c5ef44828ca9128003b");
  });
});

describe("the curve constants XELIS derives keys from", () => {
  /**
   * `P = s^-1 * H`, where H is bulletproofs' `PedersenGens::default().B_blinding`
   * = `RistrettoPoint::hash_from_bytes::<Sha3_512>(compressed basepoint)`.
   *
   * Pinned against the spike's computed values so a @noble/curves change to
   * either the basepoint encoding or hash-to-curve fails HERE, with an obvious
   * message, rather than as six unexplained address mismatches below.
   */
  it("are the basepoint and H the spike measured", () => {
    const G = ristretto255.Point.BASE.toBytes();
    expect(hex(G)).toBe("e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76");

    // Optional on noble's shared H2C interface, implemented by ristretto255.
    // Asserted rather than assumed, so its disappearance reads as "noble
    // changed" instead of "H is wrong".
    expect(typeof ristretto255_hasher.deriveToCurve).toBe("function");
    const H = ristretto255_hasher.deriveToCurve!(sha3_512(G));
    expect(hex(H.toBytes())).toBe(
      "8c9240b456a9e6dc65c377a1048d745f94a08cdb7f44cbcd7b46f34048871134"
    );
  });
});

describe("seeds the binary produced", () => {
  it("has vectors to check against", () => {
    expect(XELIS_VECTORS.length).toBeGreaterThanOrEqual(6);
  });

  for (const v of XELIS_VECTORS) {
    describe(v.id, () => {
      it("passes the integrity check", () => {
        expect(verifyXelisSeedIntegrity(v.seed)).toEqual({ ok: true });
        expect(validateXelisSeed(v.seed)).toBe(true);
      });

      it("derives the MAINNET address the binary derived", () => {
        expect(xelisAddressFromSeed(v.seed, "mainnet")).toBe(v.mainnetAddress);
      });

      it("derives the TESTNET address the binary derived", () => {
        expect(xelisAddressFromSeed(v.seed, "testnet")).toBe(v.testnetAddress);
      });

      it("defaults to mainnet", () => {
        expect(xelisAddressFromSeed(v.seed)).toBe(v.mainnetAddress);
      });

      it("has the checksum word the binary chose", () => {
        const words = normalizeXelisSeed(v.seed).split(" ");
        expect(words).toHaveLength(XELIS_SEED_WORD_COUNT);
        expect(words[24]).toBe(v.checksumWord);
      });

      it("accepts the seed however it is spaced or cased", () => {
        const noisy = `  ${v.seed.toUpperCase().replace(/ /g, "   ")}\n`;
        expect(verifyXelisSeedIntegrity(noisy).ok).toBe(true);
        expect(xelisAddressFromSeed(noisy, "mainnet")).toBe(v.mainnetAddress);
      });
    });
  }

  it("derives a different address on each network for the same key", () => {
    for (const v of XELIS_VECTORS) {
      expect(v.mainnetAddress).not.toBe(v.testnetAddress);
      // Only the hrp and the 6 checksum chars differ — the 32-byte key is the
      // same, which is exactly why a cross-network paste looks plausible.
      expect(v.mainnetAddress.slice(4, -6)).toBe(v.testnetAddress.slice(4, -6));
    }
  });
});

/**
 * Every negative vector, by name, with the binary's VERBATIM stderr in the
 * expectation table so the next reader can grep for the message they saw.
 *
 * Three of these the binary ACCEPTS, which is the surprising half: 24 words
 * without a checksum, mixed case, and a triple that overflows u32 and wraps.
 */
const EXPECTED: Record<
  string,
  { accepted: boolean; kind?: "word-count" | "unknown-word" | "checksum" | "key"; note: string }
> = {
  // `Error: Invalid checksum`
  wrong_checksum_word: { accepted: false, kind: "checksum", note: "Error: Invalid checksum" },
  // `Error: No indices found` — an unknown word in position 0 gives the generic
  // message because no earlier word has pinned the language yet.
  unknown_word_position0: { accepted: false, kind: "unknown-word", note: "Error: No indices found" },
  // `Error: Unknown word: notaword at position 5`
  unknown_word_position5: {
    accepted: false,
    kind: "unknown-word",
    note: "Error: Unknown word: notaword at position 5",
  },
  // `Error: No indices found`. THE Monero divergence: "etc" for "etched" is a
  // valid Monero seed word and is NOT a valid Xelis one. Porting Monero's
  // prefix matching would accept a seed the binary refuses.
  monero_style_3char_prefix: {
    accepted: false,
    kind: "unknown-word",
    note: "Error: No indices found (Xelis matches whole words only)",
  },
  // `Error: Invalid words count`
  words_23: { accepted: false, kind: "word-count", note: "Error: Invalid words count" },
  words_26: { accepted: false, kind: "word-count", note: "Error: Invalid words count" },
  // ACCEPTED: the checksum word is optional.
  words_24_no_checksum: { accepted: true, note: "binary accepted 24 words, same address" },
  // ACCEPTED: comparison is ASCII case-insensitive.
  mixed_case_25: { accepted: true, note: "binary accepted mixed case, same address" },
  // `Error: Invalid key from bytes` — all 25 words are real and the checksum is
  // CORRECT; the 24 data words decode to the zero scalar, which XELIS rejects.
  // This is why XelisSeedCheck has a `key` verdict distinct from `checksum`.
  zero_key_25: { accepted: false, kind: "key", note: "Error: Invalid key from bytes (zero)" },
  // `Error: Invalid key from bytes` — bytes ff*32 is >= l. XELIS does NOT
  // reduce mod l the way Monero's sc_reduce32 does; it refuses.
  non_canonical_ff_key_25: {
    accepted: false,
    kind: "key",
    note: "Error: Invalid key from bytes (non-canonical, >= l)",
  },
  // ACCEPTED: `val as u32` wraps silently, and the binary derived the wrapped key.
  u32_overflow_triple_24: {
    accepted: true,
    note: "binary accepted a triple above u32::MAX and used the truncated key",
  },
};

describe("seeds the binary rejected (and the three it did not)", () => {
  it("has an expectation for every fixture case", () => {
    const cases = XELIS_NEGATIVE_VECTORS.map((n) => n.case).sort();
    expect(Object.keys(EXPECTED).sort()).toEqual(cases);
  });

  for (const n of XELIS_NEGATIVE_VECTORS) {
    const expected = EXPECTED[n.case];

    it(`${n.case}: ${expected.note}`, () => {
      // The fixture must agree with the expectation table about what the
      // binary did, so a regenerated fixture cannot quietly flip a case.
      expect(n.binaryAccepted).toBe(expected.accepted);

      const check = verifyXelisSeedIntegrity(n.seed);
      expect(check.ok).toBe(expected.accepted);
      if (!check.ok) expect(check.kind).toBe(expected.kind);
    });

    if (expected.accepted) {
      it(`${n.case}: derives the address the binary derived`, () => {
        expect(n.binaryTestnetAddress).toBeTruthy();
        expect(xelisAddressFromSeed(n.seed, "testnet")).toBe(n.binaryTestnetAddress);
      });
    } else {
      it(`${n.case}: derives no address`, () => {
        expect(xelisAddressFromSeed(n.seed, "mainnet")).toBeNull();
        expect(validateXelisSeed(n.seed)).toBe(false);
      });
    }
  }

  it("reports unknown words in the order they appear", () => {
    const seed = XELIS_VECTORS[1].seed.split(" ");
    seed[3] = "notaword";
    seed[9] = "alsonotaword";
    const check = verifyXelisSeedIntegrity(seed.join(" "));
    expect(check.ok).toBe(false);
    if (!check.ok && check.kind === "unknown-word") {
      expect(check.words).toEqual(["notaword", "alsonotaword"]);
    } else {
      throw new Error(`expected unknown-word, got ${JSON.stringify(check)}`);
    }
  });

  it("reports the word count it actually saw", () => {
    const check = verifyXelisSeedIntegrity("abbey abbey abbey");
    expect(check).toEqual({ ok: false, kind: "word-count", count: 3 });
  });

  it("treats an empty string as a word count, not a crash", () => {
    expect(verifyXelisSeedIntegrity("   ")).toEqual({ ok: false, kind: "word-count", count: 0 });
  });
});

describe("address shape pre-filter", () => {
  const mainnet = XELIS_VECTORS[0].mainnetAddress;
  const testnet = XELIS_VECTORS[0].testnetAddress;

  it("accepts an address the binary produced, on its own network", () => {
    expect(isXelisAddressShape(mainnet, "mainnet")).toBe(true);
    expect(isXelisAddressShape(testnet, "testnet")).toBe(true);
  });

  it("accepts every vector's address on both networks", () => {
    for (const v of XELIS_VECTORS) {
      expect(isXelisAddressShape(v.mainnetAddress, "mainnet")).toBe(true);
      expect(isXelisAddressShape(v.testnetAddress, "testnet")).toBe(true);
    }
  });

  /**
   * The daemon answers `Invalid params: Invalid network state` for this, and it
   * is the dangerous case: the checksum is CORRECT, only the hrp differs, so a
   * cross-network paste is a well-formed address for the wrong chain.
   */
  it("rejects a correctly-checksummed address from the OTHER network", () => {
    expect(isXelisAddressShape(mainnet, "testnet")).toBe(false);
    expect(isXelisAddressShape(testnet, "mainnet")).toBe(false);
  });

  /** Daemon: `Invalid params: Invalid character value in human readable part: 81`. */
  it("rejects the all-uppercase form", () => {
    expect(isXelisAddressShape(mainnet.toUpperCase(), "mainnet")).toBe(false);
    expect(
      isXelisAddressShape(
        "XEL:QC3HDKMSC0NQKS7JQZ8CPNZV5C3UR7MY6YY7CT6ULF5KUEXV53PQQJLAHT0",
        "mainnet"
      )
    ).toBe(false);
  });

  /** Daemon: `Invalid params: Invalid checksum` (last char altered). */
  it("rejects the spike's bad-checksum address", () => {
    expect(
      isXelisAddressShape("xet:qc3hdkmsc0nqks7jqz8cpnzv5c3ur7my6yy7ct6ulf5kuexv53pqq2vh88q", "testnet")
    ).toBe(false);
  });

  it("rejects a one-character mutation of every vector address", () => {
    for (const v of XELIS_VECTORS) {
      const body = v.mainnetAddress.slice(4);
      const swapped = body[0] === "q" ? "p" : "q";
      expect(isXelisAddressShape(`xel:${swapped}${body.slice(1)}`, "mainnet")).toBe(false);
    }
  });

  /**
   * An integrated address carries up to 1 KB of extra data after a 0x01 type
   * byte, so it is longer than 63 chars and must still pass. Captured live from
   * `get_address {"integrated_data":{"invoice":"pwnda-123"}}`, and confirmed by
   * the daemon as `{is_integrated: true, is_valid: true}`.
   */
  it("accepts an integrated address", () => {
    expect(
      isXelisAddressShape(
        "xet:9m48nqeevsk24ynmcqmvp35fldze3kkq00hvjwtzju485q5af3lszqspqyrkjmnkda5kxegqqyyhqamwv3sj6vfjxvuez469",
        "testnet"
      )
    ).toBe(true);
  });

  it("accepts the normal address that integrated one splits back into", () => {
    expect(
      isXelisAddressShape("xet:9m48nqeevsk24ynmcqmvp35fldze3kkq00hvjwtzju485q5af3lsqeuerh9", "testnet")
    ).toBe(true);
  });

  it("rejects junk, truncation and the wrong prefix", () => {
    expect(isXelisAddressShape("", "mainnet")).toBe(false);
    expect(isXelisAddressShape("xel:", "mainnet")).toBe(false);
    expect(isXelisAddressShape(mainnet.slice(0, -1), "mainnet")).toBe(false);
    expect(isXelisAddressShape(mainnet.replace("xel:", "xxx:"), "mainnet")).toBe(false);
    // A Monero address: right idea, wrong chain.
    expect(
      isXelisAddressShape(
        "4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge",
        "mainnet"
      )
    ).toBe(false);
    // `1` is not in the bech32 charset, and is not the separator here either.
    expect(isXelisAddressShape("xel:1111111111111111111111111111111111111111111111111111111111111", "mainnet")).toBe(false);
  });

  it("knows its own prefixes", () => {
    expect(xelisAddressPrefix("mainnet")).toBe("xel:");
    expect(xelisAddressPrefix("testnet")).toBe("xet:");
  });
});

describe("generating a seed", () => {
  it("asks for 64 bytes of OS entropy and returns a usable 25-word seed", async () => {
    mockEntropy.mockClear();
    const seed = await generateXelisSeed();

    // 64, not 32: about 1 in 16 random 32-byte strings is >= l, and XELIS
    // rejects those outright rather than reducing (unlike Monero's
    // sc_reduce32). 64 bytes reduced mod l is the wide-reduction construction.
    expect(mockEntropy).toHaveBeenCalledWith(64);

    const words = seed.split(" ");
    expect(words).toHaveLength(XELIS_SEED_WORD_COUNT);
    for (const w of words) expect(MONERO_ENGLISH_WORDS).toContain(w);
    expect(verifyXelisSeedIntegrity(seed)).toEqual({ ok: true });
  });

  it("produces a seed that derives an address on both networks", async () => {
    const seed = await generateXelisSeed();
    const main = xelisAddressFromSeed(seed, "mainnet");
    const test = xelisAddressFromSeed(seed, "testnet");
    expect(main).toMatch(/^xel:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{59}$/);
    expect(test).toMatch(/^xet:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{59}$/);
    expect(isXelisAddressShape(main as string, "mainnet")).toBe(true);
    expect(isXelisAddressShape(test as string, "testnet")).toBe(true);
  });

  it("writes a checksum word the checker agrees with", async () => {
    const seed = await generateXelisSeed();
    const words = seed.split(" ");
    // Break only the checksum word: everything else stays valid, so a failure
    // here is specifically the checksum rule and not word lookup.
    words[24] = words[24] === "abbey" ? "abducts" : "abbey";
    const check = verifyXelisSeedIntegrity(words.join(" "));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.kind).toBe("checksum");
  });

  it("refuses rather than returning an unusable scalar", async () => {
    // All-zero entropy reduces to the zero scalar, which XELIS rejects with
    // `Error: Invalid key from bytes`. The generator retries; with entropy that
    // is always zero it must give up loudly instead of emitting a dead seed.
    mockEntropy.mockImplementation(async (n: number) => new Uint8Array(n));
    await expect(generateXelisSeed()).rejects.toThrow(/unusable scalar/i);
    mockEntropy.mockImplementation(async (n: number) => new Uint8Array(n).fill(0x11));
  });
});
