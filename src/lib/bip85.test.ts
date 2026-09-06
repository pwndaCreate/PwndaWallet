import { describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  bip85Bip39MnemonicFromMnemonic,
  bip85Bip39MnemonicFromRoot,
  bip85Bip39MnemonicFromSeed,
  deriveSwapWalletMnemonic,
  SWAP_WALLET_BIP85,
} from "./bip85";

/**
 * BIP-85 correctness is fund-critical in a way most code is not: a wrong
 * derivation produces a **valid** mnemonic for a **different** wallet. Nothing
 * errors, nothing looks wrong, and the user's swap balance simply is not where
 * recovery will look for it.
 *
 * So the primary tests are the BIP-85 specification's own published vectors,
 * not properties we invented. If a dependency changes its HMAC or derivation
 * behaviour, these go red.
 *
 * Vectors: BIP-85 "Deterministic Entropy From BIP32 Keychains", BIP39
 * application (`m/83696968'/39'/0'/{words}'/0'`).
 */

/** The master key BIP-85's test vectors are stated against. */
const SPEC_ROOT_XPRV =
  "xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb";

describe("BIP-85 BIP39 application", () => {
  /**
   * THE load-bearing test. Reproduces all three published spec vectors through
   * the real implementation.
   *
   * The spec publishes vectors from an xprv while the public API takes a seed,
   * so this drives the shared internals the same way the implementation does:
   * `HDKey.fromExtendedKey(spec root)` → same path → same HMAC → same slice.
   * A divergence in any of those four steps turns this red.
   */
  it("reproduces the published spec vectors", () => {
    // Drives the REAL implementation. The spec states its vectors from an
    // extended key, so bip85Bip39MnemonicFromRoot exists precisely so this can
    // enter the same code path the wallet uses rather than a copy of it living
    // here — a vector test that recomputes the derivation itself would stay
    // green with bip85.ts completely broken.
    const root = HDKey.fromExtendedKey(SPEC_ROOT_XPRV);
    const cases = [
      {
        words: 12 as const,
        mnemonic:
          "girl mad pet galaxy egg matter matrix prison refuse sense ordinary nose",
      },
      {
        words: 18 as const,
        mnemonic:
          "near account window bike charge season chef number sketch tomorrow excuse sniff circle vital hockey outdoor supply token",
      },
      {
        words: 24 as const,
        mnemonic:
          "puppy ocean match cereal symbol another shed magic wrap hammer bulb intact gadget divorce twin tonight reason outdoor destroy simple truth cigar social volcano",
      },
    ];
    for (const c of cases) {
      expect(bip85Bip39MnemonicFromRoot(root, c.words, 0)).toBe(c.mnemonic);
    }
  });

  /** The public seed-taking API must produce a real, checksum-valid mnemonic
   *  of the requested length — the shape callers depend on. */
  it("produces valid BIP39 mnemonics of the requested length", () => {
    const seed = mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    for (const words of [12, 18, 24] as const) {
      const m = bip85Bip39MnemonicFromSeed(seed, words);
      expect(m.split(" ")).toHaveLength(words);
      expect(validateMnemonic(m, wordlist)).toBe(true);
    }
  });

  /** Determinism is the whole recovery story: same phrase in, same swap wallet
   *  out, forever. */
  it("is deterministic for the same inputs", () => {
    const master =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(deriveSwapWalletMnemonic(master)).toBe(
      deriveSwapWalletMnemonic(master),
    );
  });

  /** Different masters must not collide, and the child must never equal its
   *  parent — if it did, the "one-way partition" claim in the plan would be
   *  false and the swap node would hold the vault phrase. */
  it("separates child from master and master from master", () => {
    const a =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const b =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    expect(deriveSwapWalletMnemonic(a)).not.toBe(deriveSwapWalletMnemonic(b));
    expect(deriveSwapWalletMnemonic(a)).not.toBe(a);
    expect(deriveSwapWalletMnemonic(b)).not.toBe(b);
  });

  /** Index and word-count must each change the output, or the coordinates in
   *  SWAP_WALLET_BIP85 would be decorative and a future change would silently
   *  reuse an existing wallet. */
  it("separates by index and by word count", () => {
    const seed = mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(bip85Bip39MnemonicFromSeed(seed, 24, 0)).not.toBe(
      bip85Bip39MnemonicFromSeed(seed, 24, 1),
    );
    expect(bip85Bip39MnemonicFromSeed(seed, 12, 0)).not.toBe(
      bip85Bip39MnemonicFromSeed(seed, 24, 0).split(" ").slice(0, 12).join(" "),
    );
  });

  /** Whitespace normalisation: a pasted phrase with stray spacing must derive
   *  the SAME wallet, or a user's own copy/paste would lose their funds. */
  it("normalises whitespace in the master mnemonic", () => {
    const clean =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const messy = `  abandon abandon  abandon abandon abandon abandon
      abandon abandon abandon abandon abandon about  `;
    expect(bip85Bip39MnemonicFromMnemonic(messy)).toBe(
      bip85Bip39MnemonicFromMnemonic(clean),
    );
  });

  /** Unsupported inputs must throw, never silently fall back — a wrong-length
   *  mnemonic is still a valid one, so a fallback would be unrecoverable. */
  it("refuses unsupported word counts, bad indices and empty input", () => {
    const seed = mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    // @ts-expect-error deliberately out of contract
    expect(() => bip85Bip39MnemonicFromSeed(seed, 15)).toThrow(/word count/i);
    expect(() => bip85Bip39MnemonicFromSeed(seed, 24, -1)).toThrow(/index/i);
    expect(() => bip85Bip39MnemonicFromMnemonic("   ")).toThrow(/empty/i);
  });

  /** The swap wallet's coordinates are a recovery contract. Changing them
   *  orphans every existing swap wallet, and the symptom is a missing balance
   *  rather than an error — so pin them. */
  it("pins the swap wallet's derivation coordinates", () => {
    expect(SWAP_WALLET_BIP85.words).toBe(24);
    expect(SWAP_WALLET_BIP85.index).toBe(0);
    expect(SWAP_WALLET_BIP85.language).toBe(0);
    expect(deriveSwapWalletMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").split(" ")).toHaveLength(24);
  });
});
