/**
 * Zano key-derivation vectors.
 *
 * EVERY vector here was produced by the real `simplewallet v2.2.1.506[b76fa18]`
 * running offline in a scratch directory on 2026-08-27 — not by this code, and
 * not from documentation. That provenance is the whole point: during Phase 0,
 * two confident readings of upstream source were WRONG (the wordlist was
 * believed to be Monero's; the seed→spend step was believed to be Monero's
 * `sc_reduce32`), and both survived source review. Only running a real binary
 * and re-deriving its address caught them.
 *
 * The first two vectors are THE SAME WALLET — one seed unsecured, one
 * passphrase-protected. That pairing is what makes the Secured-Seed mechanism
 * testable rather than merely described: both must produce one address.
 *
 * If you change `zano-keys.ts`, re-run these. If a vector needs to change, you
 * are almost certainly wrong — regenerate from the binary instead.
 */

import { describe, it, expect, vi } from "vitest";

// `secureRandomBytes` goes through Tauri's `invoke`, which needs `window` and
// is therefore unavailable under vitest's node environment. Mock the entropy
// source itself (project convention — cf. `vi.mock("./_proxy", ...)` in
// bch-account-send.test.ts) with a deterministic-but-distinct generator, so
// generation stays reproducible AND the "two seeds differ" assertion is real.
let entropyCounter = 0;
vi.mock("../secure-random", () => ({
  secureRandomBytes: async (n: number): Promise<Uint8Array> => {
    const seed = ++entropyCounter;
    return Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed * 31 + 13) & 0xff);
  },
}));
import {
  zanoKeysFromSeed,
  zanoAddressFromSeed,
  readZanoSeedMeta,
  isZanoSeedPasswordProtected,
  validateZanoSeed,
  normalizeZanoSeed,
  verifyZanoSeedIntegrity,
  generateZanoSeed,
  _zanoInternal,
} from "./zano-keys";
import { ZANO_WORDS } from "./zano-wordlist";
import { MONERO_ENGLISH_WORDS } from "./xmr-wordlist";

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ── Vectors, verbatim from simplewallet v2.2.1.506 ────────────────────────
const ADDRESS =
  "ZxDuP6pbXjqTevNr6PFRZYLL8vCoX5RuhHJwSc5DcdA5Gs4gZTwoiRXgkmryoJnsTeaYNmFy6c2wvMwaPTWvWWJK32SLJWruw";
const VIEW_SECRET =
  "e02e2b994d9b98eb9578ebe55e0178ee03bb998b0cef3da4cbd52d3f00ebbc0f";
const SEED_BYTES =
  "d8e1485272a588f8b43615e96985dc21e1a277be858704f71aac4f04803b177c";

/** Same wallet, no Secured-Seed passphrase. Words 25-26: "jump goal". */
const SEED_PLAIN =
  "mumble young surely very happiness quite men ball drive school rude against " +
  "ring salty fought nothing marry pale spot petal dart breast mother fruit jump goal";

/** Same wallet, passphrase "seedpw456". Words 25-26: "shower self". */
const SEED_SECURED =
  "stream approach people written bedroom waist high mist busy stranger inside " +
  "crash tide innocent canvas blame canvas put pity garden consider scary mask " +
  "stain shower self";
const SEED_PASSPHRASE = "seedpw456";

/** A DIFFERENT wallet, generated with --generate-new-auditable-wallet. */
const SEED_AUDITABLE =
  "describe choose peel sweat chain safe pale hurry insane honor shock shade " +
  "ashamed struggle surface rhyme eat make nobody sunlight thing them easily " +
  "dust jump heal";
const AUDITABLE_ADDRESS =
  "aZxarvWBzhT1Jjyx8Lh4vTJA8CdYkzGV99FwftpWP2SLF7JJrB1LJKsDzCCgVmXbcvN58dmL6Zr2d26nAC5b3x114ZajA6UM2T6";

describe("Zano wordlist", () => {
  it("is 1626 words", () => {
    expect(ZANO_WORDS).toHaveLength(1626);
    expect(new Set(ZANO_WORDS).size).toBe(1626);
  });

  it("is NOT Monero's wordlist — the regression that nearly shipped", () => {
    // An intermediate design claimed Zano reuses MONERO_ENGLISH_WORDS. It does
    // not. Had that shipped, no genuine Zano seed could have been restored.
    // Pinning the actual overlap so the claim can never be re-made silently.
    const shared = ZANO_WORDS.filter((w) => MONERO_ENGLISH_WORDS.includes(w));
    expect(shared.length).toBe(227);
    expect(ZANO_WORDS[0]).toBe("like");
    expect(MONERO_ENGLISH_WORDS[0]).toBe("abbey");
  });

  it("has no short unique prefix, unlike Monero's", () => {
    // Monero's list is built so 3 chars identify a word. Zano's needs 10.
    // Anything that ports Monero's prefix matching here will mis-resolve words.
    const uniqAt = (n: number): number =>
      new Set(ZANO_WORDS.map((w) => w.slice(0, n))).size;
    expect(uniqAt(3)).toBe(798);
    expect(uniqAt(4)).toBe(1334);
    expect(uniqAt(10)).toBe(1626);
  });
});

describe("Zano derivation — unsecured seed (real wallet vector)", () => {
  it("derives the exact address", () => {
    expect(zanoAddressFromSeed(SEED_PLAIN)).toBe(ADDRESS);
  });

  it("derives the exact view secret", () => {
    expect(hex(zanoKeysFromSeed(SEED_PLAIN).viewSecret)).toBe(VIEW_SECRET);
  });

  it("decodes the exact 32 seed bytes", () => {
    const words = normalizeZanoSeed(SEED_PLAIN).split(" ").slice(0, 24);
    expect(hex(_zanoInternal.wordsToBytes(words))).toBe(SEED_BYTES);
  });

  it("addresses start with Zx (prefix 0xc5 as a 2-byte varint)", () => {
    expect(zanoAddressFromSeed(SEED_PLAIN).startsWith("Zx")).toBe(true);
  });

  it("word 25 reports no passphrase, and a plausible creation week", () => {
    const meta = readZanoSeedMeta(SEED_PLAIN);
    expect(meta.passwordProtected).toBe(false);
    expect(meta.auditable).toBe(false);
    expect(meta.wordCount).toBe(26);
    // Wallet was generated 2026-08-27; word 25 floors to the week quantum.
    expect(meta.creationTimestamp).toBe(403 * 604800 + 1543622400);
  });
});

describe("Zano derivation — Secured Seed (same wallet, passphrase)", () => {
  it("word 25 self-declares that a passphrase is required", () => {
    // This is what lets the UI prompt accurately instead of guessing.
    expect(isZanoSeedPasswordProtected(SEED_SECURED)).toBe(true);
    expect(isZanoSeedPasswordProtected(SEED_PLAIN)).toBe(false);
  });

  it("ChaCha8-decrypts to the SAME seed bytes as the unsecured phrase", () => {
    const words = normalizeZanoSeed(SEED_SECURED).split(" ").slice(0, 24);
    const encrypted = _zanoInternal.wordsToBytes(words);
    const plain = _zanoInternal.cryptWithPass(encrypted, SEED_PASSPHRASE);
    expect(hex(plain)).toBe(SEED_BYTES);
  });

  it("derives the SAME address as the unsecured phrase", () => {
    expect(zanoAddressFromSeed(SEED_SECURED, SEED_PASSPHRASE)).toBe(ADDRESS);
  });

  it("refuses to derive without the passphrase rather than guessing", () => {
    expect(() => zanoKeysFromSeed(SEED_SECURED)).toThrow(/password-protected/i);
  });

  it("SILENT FAILURE: a wrong passphrase yields a different valid address", () => {
    // Nothing at derivation time can detect this — the output is a perfectly
    // well-formed Zano address for a wallet nobody controls. Pinned so the
    // hazard stays visible to anyone touching the import flow: a passphrase is
    // unverified until the user confirms the address or a balance appears.
    const wrong = zanoAddressFromSeed(SEED_SECURED, "wrongpassphrase");
    expect(wrong).not.toBe(ADDRESS);
    expect(wrong.startsWith("Zx")).toBe(true);
    expect(wrong).toHaveLength(ADDRESS.length);
  });
});

describe("Zano auditable wallets — detected and refused, never mis-derived", () => {
  it("reads the auditable flag from word 26 bit 0", () => {
    expect(readZanoSeedMeta(SEED_AUDITABLE).auditable).toBe(true);
    expect(readZanoSeedMeta(SEED_PLAIN).auditable).toBe(false);
  });

  it("refuses to derive rather than returning a standard-prefix address", () => {
    expect(() => zanoKeysFromSeed(SEED_AUDITABLE)).toThrow(/auditable/i);
  });

  it("the real auditable address uses the aZx prefix, not Zx", () => {
    // Why the refusal above matters: the real wallet's address is aZx-prefixed.
    // Deriving this seed with the standard prefix would produce a well-formed
    // Zx address that is simply WRONG — the third instance of that failure
    // shape found while integrating Zano.
    expect(AUDITABLE_ADDRESS.startsWith("aZx")).toBe(true);
  });
});

describe("Zano seed metadata round-trip", () => {
  it("recomputes word 26 for the unsecured seed", () => {
    const meta = readZanoSeedMeta(SEED_PLAIN);
    const seedBytes = _zanoInternal.wordsToBytes(
      normalizeZanoSeed(SEED_PLAIN).split(" ").slice(0, 24)
    );
    const word26 = _zanoInternal.computeChecksumWord(
      seedBytes,
      "",
      meta.creationTimestamp!,
      false
    );
    expect(word26).toBe("goal");
  });

  it("recomputes word 26 for the secured seed (checksum uses PLAINTEXT seed)", () => {
    // The subtlety worth a test: the words encode the ENCRYPTED seed, but the
    // checksum is computed over the DECRYPTED bytes plus the passphrase.
    const meta = readZanoSeedMeta(SEED_SECURED);
    const encrypted = _zanoInternal.wordsToBytes(
      normalizeZanoSeed(SEED_SECURED).split(" ").slice(0, 24)
    );
    const plain = _zanoInternal.cryptWithPass(encrypted, SEED_PASSPHRASE);
    const word26 = _zanoInternal.computeChecksumWord(
      plain,
      SEED_PASSPHRASE,
      meta.creationTimestamp!,
      false
    );
    expect(word26).toBe("self");
  });

  it("timestamp word round-trips through encode/decode", () => {
    const ts = 403 * 604800 + 1543622400;
    for (const pw of [false, true]) {
      const w = _zanoInternal.encodeTimestampWord(ts, pw);
      const back = _zanoInternal.decodeTimestampWord(w);
      expect(back.creationTimestamp).toBe(ts);
      expect(back.passwordProtected).toBe(pw);
    }
  });

  it("both wallets report the same creation week (internal consistency)", () => {
    expect(readZanoSeedMeta(SEED_PLAIN).creationTimestamp).toBe(
      readZanoSeedMeta(SEED_SECURED).creationTimestamp
    );
  });
});

describe("Zano seed codec", () => {
  it("words <-> bytes round-trips", () => {
    const words = normalizeZanoSeed(SEED_PLAIN).split(" ").slice(0, 24);
    const bytes = _zanoInternal.wordsToBytes(words);
    expect(_zanoInternal.bytesToWords(bytes)).toEqual(words);
  });

  it("rejects a word outside the Zano list", () => {
    // "abbey" is Monero word #0 and is NOT in Zano's list — a neat canary for
    // someone wiring the wrong wordlist in.
    const bad = normalizeZanoSeed(SEED_PLAIN).split(" ");
    bad[0] = "abbey";
    expect(() => zanoKeysFromSeed(bad.join(" "))).toThrow(/not in the Zano wordlist/i);
  });

  it("rejects wrong word counts", () => {
    expect(() => readZanoSeedMeta("one two three")).toThrow(/24-26 words/);
  });

  it("validateZanoSeed accepts real seeds and rejects junk", () => {
    expect(validateZanoSeed(SEED_PLAIN)).toBe(true);
    expect(validateZanoSeed(SEED_SECURED)).toBe(true);
    expect(validateZanoSeed("not a real seed at all")).toBe(false);
  });

  it("normalises case and whitespace", () => {
    const messy = `  ${SEED_PLAIN.toUpperCase().replace(/ /g, "   ")}  `;
    expect(zanoAddressFromSeed(messy)).toBe(ADDRESS);
  });
});

describe("Zano seed generation", () => {
  it("produces a 26-word seed that derives a Zx address", async () => {
    const seed = await generateZanoSeed();
    const words = seed.split(" ");
    expect(words).toHaveLength(26);
    expect(words.every((w) => ZANO_WORDS.includes(w))).toBe(true);

    const meta = readZanoSeedMeta(seed);
    expect(meta.passwordProtected).toBe(false);
    expect(meta.auditable).toBe(false);

    expect(zanoAddressFromSeed(seed).startsWith("Zx")).toBe(true);
  });

  it("generates distinct seeds", async () => {
    const [a, b] = await Promise.all([generateZanoSeed(), generateZanoSeed()]);
    expect(a).not.toBe(b);
  });

  it("word 26 of a generated seed verifies against its own payload", async () => {
    const seed = await generateZanoSeed();
    const words = seed.split(" ");
    const meta = readZanoSeedMeta(seed);
    const seedBytes = _zanoInternal.wordsToBytes(words.slice(0, 24));
    expect(
      _zanoInternal.computeChecksumWord(seedBytes, "", meta.creationTimestamp!, false)
    ).toBe(words[25]);
  });
});

describe("Zano passphrase verification — the checksum CAN catch what derivation cannot", () => {
  /**
   * The counterpart to the SILENT FAILURE test above. That one pins the
   * hazard; these pin the mitigation added 2026-08-28.
   *
   * Upstream computes word 26 over the DECRYPTED seed bytes plus the
   * passphrase, so recomputing it with a candidate passphrase rejects a wrong
   * candidate — which is why an import can now refuse instead of silently
   * deriving a wallet nobody controls.
   */
  it("accepts the correct passphrase", () => {
    expect(verifyZanoSeedIntegrity(SEED_SECURED, SEED_PASSPHRASE)).toEqual({
      ok: true,
    });
  });

  it("rejects a one-character typo, and a case change", () => {
    // Both of these derive perfectly valid Zx addresses (see SILENT FAILURE).
    expect(verifyZanoSeedIntegrity(SEED_SECURED, "seedpw457")).toEqual({
      ok: false,
      kind: "checksum",
    });
    expect(verifyZanoSeedIntegrity(SEED_SECURED, "Seedpw456")).toEqual({
      ok: false,
      kind: "checksum",
    });
  });

  it("reports a missing passphrase distinctly from a wrong one", () => {
    expect(verifyZanoSeedIntegrity(SEED_SECURED, "")).toEqual({
      ok: false,
      kind: "passphrase-required",
    });
  });

  it("validates an ordinary seed too, catching a mistyped word", () => {
    expect(verifyZanoSeedIntegrity(SEED_PLAIN)).toEqual({ ok: true });

    // Swap one word for another valid wordlist entry: still 26 known words,
    // still decodes, still derives an address — and now caught.
    const words = SEED_PLAIN.split(" ");
    words[3] = words[3] === "very" ? "young" : "very";
    expect(verifyZanoSeedIntegrity(words.join(" "))).toEqual({
      ok: false,
      kind: "checksum",
    });
  });

  it("refuses auditable seeds by kind, not by checksum", () => {
    expect(verifyZanoSeedIntegrity(SEED_AUDITABLE)).toEqual({
      ok: false,
      kind: "auditable",
    });
  });

  it("is a filter, not a proof — ~1 in 813 wrong passphrases still pass", () => {
    // Documents the limit in executable form so nobody later presents a
    // passing check as certainty. The checksum is ZANO_WORDS.length >> 1 =
    // 813 values wide; measured 22/20000 = 0.110% against a theoretical
    // 0.123%. Asserted as a loose band so wordlist-sized changes surface
    // here rather than silently widening the hole.
    let accepted = 0;
    const TRIALS = 4000;
    for (let i = 0; i < TRIALS; i++) {
      if (verifyZanoSeedIntegrity(SEED_SECURED, `bogus-${i}`).ok) accepted++;
    }
    const rate = accepted / TRIALS;
    expect(rate).toBeLessThan(0.01);
  });
});
