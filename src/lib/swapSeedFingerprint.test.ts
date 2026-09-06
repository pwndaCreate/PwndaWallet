import { describe, it, expect } from "vitest";
import {
  normalizeMnemonic,
  swapSeedFingerprint,
  engineBelongsToWallet,
} from "./swapSeedFingerprint";

/**
 * The cross-language vector.
 *
 * The SAME constants are asserted in
 * `src-tauri/src/swap_sidecar.rs::tests::seed_fingerprint_matches_the_frontend_vector`.
 * If the two implementations ever diverge, every wallet looks mismatched — which
 * fails SAFE (balances fall back to the wallet's own adapter) but silently hides
 * a real shared-wallet balance. A shared vector is the only thing that catches
 * a one-sided change to the domain string, the normalisation or the truncation.
 *
 * Computed independently (Python `hashlib`), not copied from either side.
 */
const MNEMONIC_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FINGERPRINT_A = "8328ec3d75fcf950";

const MNEMONIC_B =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const FINGERPRINT_B = "0db344bf5a8169c3";

describe("swapSeedFingerprint", () => {
  it("matches the vector the Rust side asserts", async () => {
    await expect(swapSeedFingerprint(MNEMONIC_A)).resolves.toBe(FINGERPRINT_A);
    await expect(swapSeedFingerprint(MNEMONIC_B)).resolves.toBe(FINGERPRINT_B);
  });

  it("identifies different wallets differently", async () => {
    const a = await swapSeedFingerprint(MNEMONIC_A);
    const b = await swapSeedFingerprint(MNEMONIC_B);
    expect(a).not.toBe(b);
  });

  it("normalises whitespace, so a re-spaced phrase is the same wallet", async () => {
    const messy = `  ${MNEMONIC_A.split(" ").join("   ")}\t`;
    expect(normalizeMnemonic(messy)).toBe(MNEMONIC_A);
    await expect(swapSeedFingerprint(messy)).resolves.toBe(FINGERPRINT_A);
  });

  it("is one-way, short, and never carries the seed", async () => {
    const fp = await swapSeedFingerprint(MNEMONIC_A);
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    for (const word of MNEMONIC_A.split(" ")) {
      expect(fp).not.toContain(word);
    }
  });
});

describe("engineBelongsToWallet — unknown is NOT a match", () => {
  it("true only when both are known and equal", () => {
    expect(engineBelongsToWallet(FINGERPRINT_A, FINGERPRINT_A)).toBe(true);
    expect(engineBelongsToWallet(FINGERPRINT_A, FINGERPRINT_B)).toBe(false);
  });

  it("refuses to guess when either side is unknown", () => {
    // An install prepared before the binding existed reports no datadir
    // fingerprint. Treating that as a match would restore the exact bug this
    // module exists to catch: one engine's balance shown under every wallet.
    for (const [a, b] of [
      [null, FINGERPRINT_A],
      [FINGERPRINT_A, null],
      [undefined, undefined],
      ["", FINGERPRINT_A],
      [FINGERPRINT_A, ""],
    ] as [string | null | undefined, string | null | undefined][]) {
      expect(engineBelongsToWallet(a, b)).toBe(false);
    }
  });
});
