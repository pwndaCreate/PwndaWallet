/**
 * BIP-85 deterministic entropy — the derivation that gives the BasicSwap swap
 * wallet its own seed **without a second backup phrase existing anywhere**.
 *
 * ## Why this module exists
 *
 * BasicSwap roots every coin wallet it manages in one particl master mnemonic
 * (`prepare.py` accepts it as `--particl_mnemonic`, and `extkeyimportmaster`
 * takes any BIP39 phrase). Left alone, prepare *generates* that phrase and
 * prints it once — a second secret the user must store, which is exactly the
 * friction [[pwnda-basicswap-convergence-plan]] C1 exists to remove.
 *
 * So we derive it instead: a dedicated child mnemonic from the vault master.
 * The user backs up one phrase; the swap wallet is reconstructible from it
 * forever (re-derive → re-run prepare with `--particl_mnemonic`).
 *
 * ## Why BIP-85 rather than "just reuse the vault mnemonic"
 *
 * BIP-85 is **one-way**: the child is `HMAC-SHA512` of a hardened-derived
 * private key, so compromising the swap node reveals the child and says
 * *nothing* about the vault master or any sibling application. Feeding the
 * vault mnemonic itself to prepare would put the wallet's most valuable secret
 * inside a networked Python process — see the plan's P3.
 *
 * ## The derivation, exactly as specified
 *
 * BIP-85 "Deterministic Entropy From BIP32 Keychains", BIP39 application:
 *
 * 1. derive `m/83696968'/39'/{language}'/{words}'/{index}'` from the master
 *    (`83696968` is BIP-85's own purpose; `39` selects the BIP39 application)
 * 2. `entropy = HMAC-SHA512(key = "bip-entropy-from-k", msg = <32-byte priv key>)`
 * 3. slice the **first** N bytes: 16 → 12 words, 24 → 18, 32 → 24
 * 4. `entropyToMnemonic(slice)`
 *
 * Every step is load-bearing and a silent mistake here produces a *valid but
 * wrong* wallet — funds land somewhere unrecoverable-by-the-user rather than
 * failing loudly. {@link bip85Bip39Mnemonic} is therefore pinned by the spec's
 * own published test vectors in `bip85.test.ts`; those vectors were verified
 * against these exact dependency versions before this file was written.
 *
 * Nothing in this module logs. The caller must treat the return value the same
 * way it treats the vault mnemonic.
 */
import { HDKey } from "@scure/bip32";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** BIP-85's fixed HMAC key. Not a salt and not configurable — part of the spec. */
const BIP85_HMAC_KEY = new TextEncoder().encode("bip-entropy-from-k");

/** BIP-85's registered purpose index (`83696968'`). */
const BIP85_PURPOSE = "83696968'";

/** Application number 39 = "BIP39 mnemonic". */
const BIP85_APP_BIP39 = "39'";

/** Word counts BIP-85 defines for the BIP39 application, and their entropy widths. */
const ENTROPY_BYTES_FOR_WORDS: Readonly<Record<number, number>> = {
  12: 16,
  18: 24,
  24: 32,
};

/** BIP-85 language index. Only English is used here; the wordlist import must
 *  match, so widening this needs both changed together. */
const LANGUAGE_ENGLISH = 0;

export type Bip85WordCount = 12 | 18 | 24;

/**
 * The swap wallet's fixed derivation coordinates.
 *
 * **Do not change these after any user has funded a swap wallet.** They are
 * part of the recovery path: restoring means re-deriving at exactly these
 * coordinates. A change silently orphans every existing swap wallet, and the
 * failure looks like "my balance is gone", not like an error.
 *
 * 24 words because BasicSwap's particl master is the root of every coin wallet
 * it manages — the strongest available entropy is the right default for a key
 * that sits at the top of a tree.
 */
export const SWAP_WALLET_BIP85 = {
  words: 24 as Bip85WordCount,
  index: 0,
  language: LANGUAGE_ENGLISH,
} as const;

/**
 * Derive a BIP39 mnemonic from a master seed via BIP-85.
 *
 * @param masterSeed the BIP39 seed of the vault master (64 bytes, from
 *   `mnemonicToSeedSync`) — **not** the mnemonic string
 * @returns a BIP39 mnemonic of `words` length, deterministic for these inputs
 *
 * Throws rather than guessing on an unsupported word count: a wrong-length
 * mnemonic would still be a *valid* one, so this must never fall back.
 */
export function bip85Bip39MnemonicFromRoot(
  root: HDKey,
  words: Bip85WordCount = SWAP_WALLET_BIP85.words,
  index: number = SWAP_WALLET_BIP85.index,
  language: number = SWAP_WALLET_BIP85.language,
): string {
  const entropyBytes = ENTROPY_BYTES_FOR_WORDS[words];
  if (!entropyBytes) {
    throw new Error(
      `BIP85: unsupported word count ${words} (expected 12, 18 or 24)`,
    );
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`BIP85: index must be a non-negative integer, got ${index}`);
  }

  const path = `m/${BIP85_PURPOSE}/${BIP85_APP_BIP39}/${language}'/${words}'/${index}'`;
  const node = root.derive(path);
  if (!node.privateKey) {
    // Hardened derivation from a master always yields a private key; if it ever
    // does not, deriving a wallet from public-only material would be a silent
    // catastrophe. Fail loudly instead.
    throw new Error(`BIP85: no private key at ${path}`);
  }

  const full = hmac(sha512, BIP85_HMAC_KEY, node.privateKey);
  // FIRST n bytes, per spec. Taking the tail would produce a valid-looking,
  // permanently wrong wallet.
  const entropy = full.slice(0, entropyBytes);
  return entropyToMnemonic(entropy, wordlist);
}

/**
 * Same derivation, entered from a master **seed** — what the wallet actually
 * holds.
 *
 * Delegates to {@link bip85Bip39MnemonicFromRoot} rather than duplicating the
 * math, so that BIP-85's published test vectors (which are stated from an
 * extended key, not a seed) exercise **this** code path rather than a parallel
 * re-implementation living in the test file. A vector test that recomputes the
 * derivation itself cannot fail for the reason it is run.
 */
export function bip85Bip39MnemonicFromSeed(
  masterSeed: Uint8Array,
  words: Bip85WordCount = SWAP_WALLET_BIP85.words,
  index: number = SWAP_WALLET_BIP85.index,
  language: number = SWAP_WALLET_BIP85.language,
): string {
  return bip85Bip39MnemonicFromRoot(
    HDKey.fromMasterSeed(masterSeed),
    words,
    index,
    language,
  );
}

/**
 * Convenience wrapper taking the vault's mnemonic directly.
 *
 * Uses an empty BIP39 passphrase, matching how the wallet derives every other
 * chain (`mnemonicToSeedSync(mnemonic)` with no passphrase in
 * `src/wallets/*`). If a passphrase is ever introduced there, it must be
 * threaded here too or the swap wallet silently detaches from the vault.
 */
export function bip85Bip39MnemonicFromMnemonic(
  masterMnemonic: string,
  words: Bip85WordCount = SWAP_WALLET_BIP85.words,
  index: number = SWAP_WALLET_BIP85.index,
  language: number = SWAP_WALLET_BIP85.language,
): string {
  const trimmed = masterMnemonic.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("BIP85: empty master mnemonic");
  return bip85Bip39MnemonicFromSeed(
    mnemonicToSeedSync(trimmed),
    words,
    index,
    language,
  );
}

/**
 * The swap wallet's mnemonic for a given vault mnemonic — the single call the
 * setup wizard should make.
 */
export function deriveSwapWalletMnemonic(masterMnemonic: string): string {
  return bip85Bip39MnemonicFromMnemonic(masterMnemonic);
}
