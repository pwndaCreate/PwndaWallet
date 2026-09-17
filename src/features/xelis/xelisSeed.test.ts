/**
 * The Xelis seed check the import panel and the vault share.
 *
 * The contract module (`wallets/xelis-keys.ts`) throws until WALLET-CORE
 * implements it, so its two functions are wrapped: each test says what they
 * answer, and the default stays the real implementation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkXelisSeed,
  describeXelisSeedProblem,
  xelisOfflineAddress,
  xelisWalletInfo,
  XELIS_SEED_CHECK_UNAVAILABLE,
} from "./xelisSeed";
import { verifyXelisSeedIntegrity, xelisAddressFromSeed } from "../../wallets/xelis-keys";

vi.mock("../../wallets/xelis-keys", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../wallets/xelis-keys")>();
  return {
    ...real,
    verifyXelisSeedIntegrity: vi.fn(real.verifyXelisSeedIntegrity),
    xelisAddressFromSeed: vi.fn(real.xelisAddressFromSeed),
  };
});
const verify = vi.mocked(verifyXelisSeedIntegrity);
const offlineAddress = vi.mocked(xelisAddressFromSeed);

const SEED = Array(25).fill("abbey").join(" ");

beforeEach(() => {
  verify.mockClear();
  offlineAddress.mockClear();
});

describe("checkXelisSeed", () => {
  it("normalises before checking and returns the normalised seed", () => {
    verify.mockReturnValueOnce({ ok: true });
    const pasted = `  ${SEED.toUpperCase().replace(/ /g, "\n  ")}  `;
    expect(checkXelisSeed(pasted)).toEqual({ status: "valid", seed: SEED });
    expect(verify).toHaveBeenCalledWith(SEED);
  });

  it("says how many words a Xelis seed needs", () => {
    // 24 is a valid length (the binary skips the checksum then), so the
    // sentence names both.
    verify.mockReturnValueOnce({ ok: false, kind: "word-count", count: 23 });
    const v = checkXelisSeed(SEED);
    expect(v.status).toBe("invalid");
    expect(v.status === "invalid" ? v.message : "").toBe(
      "A Xelis seed is 25 words (or 24 without the checksum word); this one has 23.",
    );
  });

  it("reports a check that cannot run as unavailable, never as valid", () => {
    verify.mockImplementationOnce(() => {
      throw new Error("Xelis seed handling is not available in this build yet.");
    });
    expect(checkXelisSeed(SEED)).toEqual({
      status: "unavailable",
      seed: SEED,
      message: XELIS_SEED_CHECK_UNAVAILABLE,
    });
  });
});

describe("describeXelisSeedProblem", () => {
  it("names one unknown word", () => {
    expect(describeXelisSeedProblem({ ok: false, kind: "unknown-word", words: ["abbeyy"] })).toBe(
      '"abbeyy" is not in the Xelis wordlist. Check the spelling against your backup.',
    );
  });

  it("names the first three unknown words and counts the rest", () => {
    expect(
      describeXelisSeedProblem({
        ok: false,
        kind: "unknown-word",
        words: ["one1", "two2", "three3", "four4", "five5"],
      }),
    ).toBe(
      '"one1", "two2", "three3" and 2 more are not in the Xelis wordlist. ' +
        "Check the spelling against your backup.",
    );
  });

  it("explains a checksum failure as a typo, not as the wrong wordlist", () => {
    const text = describeXelisSeedProblem({ ok: false, kind: "checksum" });
    expect(text).toContain("25th word does not match the first 24");
    expect(text).not.toContain("wordlist");
  });

  it("does not blame the checksum for a seed that decodes to an invalid key", () => {
    // Added with the contract's fourth verdict (2026-09-15). XELIS needs a
    // canonical, non-zero scalar and does not reduce, so the spike's `abbey`×25
    // (zero) and ff×32 (non-canonical) vectors pass the wordlist AND the
    // checksum and still fail. Calling that a checksum error would tell the
    // user their 25th word is wrong when it is provably right.
    const text = describeXelisSeedProblem({ ok: false, kind: "key" });
    expect(text).toContain("do not form a valid Xelis key");
    expect(text).not.toContain("25th word");
  });

  it("gives every check kind its own sentence", () => {
    // The compile-time half of this lives in `describeXelisSeedProblem`: the
    // switch ends in a `never` assignment, so a new variant fails check-types
    // instead of silently reusing another kind's wording. This is the runtime
    // half — no kind may share a sentence with another, or be left empty.
    type Problem = Parameters<typeof describeXelisSeedProblem>[0];
    const everyKind: Problem[] = [
      { ok: false, kind: "word-count", count: 3 },
      { ok: false, kind: "unknown-word", words: ["nope"] },
      { ok: false, kind: "checksum" },
      { ok: false, kind: "key" },
    ];
    const sentences = everyKind.map(describeXelisSeedProblem);
    expect(new Set(sentences).size).toBe(everyKind.length);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(20);
    }
  });
});

describe("xelisWalletInfo", () => {
  it("never puts the seed in mnemonic or privateKey", () => {
    offlineAddress.mockReturnValueOnce("xel:offline");
    expect(xelisWalletInfo(SEED)).toEqual({
      chain: "xelis",
      address: "xel:offline",
      mnemonic: "",
      privateKey: "",
    });
  });

  it("leaves the address empty when it cannot be derived offline", () => {
    offlineAddress.mockReturnValueOnce(null);
    expect(xelisWalletInfo(SEED).address).toBe("");
  });

  it("treats a derivation that throws as unknown", () => {
    offlineAddress.mockImplementationOnce(() => {
      throw new Error("not available");
    });
    expect(xelisOfflineAddress(SEED)).toBeNull();
  });
});
