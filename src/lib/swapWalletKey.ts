/**
 * The swap wallet's **encryption key** — the value that becomes
 * `WALLET_ENCRYPTION_PWD` for the BasicSwap engine's coin wallets (convergence
 * C5), derived from the vault master so the user never sees, chooses, or stores
 * a second password.
 *
 * ## What this is, and what it is not
 *
 * The convergence gives the swap wallet **two** distinct secrets, and confusing
 * them is the failure this module is written to prevent:
 *
 * | Secret | Derived by | Role |
 * |---|---|---|
 * | swap **mnemonic** | {@link deriveSwapWalletMnemonic} (BIP-85, `src/lib/bip85.ts`) | the engine's particl master — the *keys* |
 * | swap **wallet key** | this module (HKDF-SHA256) | `WALLET_ENCRYPTION_PWD` — the *lock on the keys at rest* |
 *
 * The mnemonic is spending authority. The wallet key is a passphrase for Core's
 * `wallet.dat` KDF. They must never be the same value, and neither must be
 * recoverable from the other — see § Domain separation.
 *
 * It is also **not** the vault password. The vault password is user-chosen,
 * unlocks `src/crypto.ts`'s AES-GCM vault, and is never derived from anything.
 * If the swap wallet key were the vault password, then a password the user
 * types (and reuses, and can be shoulder-surfed) would be handed to a Python
 * subprocess on argv/env. It is not; it is a 256-bit machine secret the user
 * never sees.
 *
 * ## The derivation
 *
 * ```
 * seed      = BIP39 mnemonicToSeed(vault mnemonic)        // 64 bytes, empty passphrase
 * okm       = HKDF-SHA256(ikm = seed, salt = ∅,
 *                         info = SWAP_WALLET_KEY_INFO, L = 32)
 * walletKey = base64url(okm)                              // 43 chars, unpadded
 * ```
 *
 * HKDF (RFC 5869) rather than "hash the seed with a prefix" because the `info`
 * parameter is the standard's *designated* domain-separation input: it is mixed
 * into every block of the expand step, so two labels over the same seed give
 * outputs that are independent under the PRF assumption. Rolling our own
 * prefix-hash would get the same property only by accident.
 *
 * Salt is intentionally empty. HKDF's salt is a *non-secret* diversifier; there
 * is no per-install non-secret here that would survive a wallet restore, and a
 * salt that does not survive restore silently destroys recoverability. The
 * label carries the separation instead.
 *
 * ## Domain separation — why the label is load-bearing
 *
 * Every swap-side secret in this design has the same ancestor: the vault's
 * 64-byte BIP39 seed. Without an application label, "derive 32 bytes from the
 * seed" is a *single function*, so every consumer that asks for 32 bytes gets
 * the **same** 32 bytes — the wallet-encryption password would equal some other
 * key in the system, and disclosure of the weakest one would be disclosure of
 * all of them.
 *
 * That matters here more than usual, because the wallet key is the
 * lowest-trust secret of the set by design. Per the frozen contract §1.1 it is
 * pushed into the engine's `prepare` and `addcoin` plans as the
 * `WALLET_ENCRYPTION_PWD` environment variable, lives in a networked Python
 * process's memory, and ends up stretched into a Core `wallet.dat`. Assume it
 * *will* be observed. The security claim is therefore one-wayness in this
 * direction:
 *
 * > knowing `walletKey` reveals nothing about the vault seed, the vault
 * > mnemonic, the BIP-85 swap mnemonic, or any coin key derived from either.
 *
 * HKDF-Expand's one-wayness gives the first half of that; the distinct label
 * gives the second — it is what stops `walletKey` from *being* a sibling secret
 * in another encoding. The BIP-85 path is separated from this one twice over
 * (different construction — HMAC-SHA512 keyed `"bip-entropy-from-k"` over a
 * hardened child private key, not the seed — and a different label), but the
 * label is the part that generalises to every future key we hang off the same
 * seed, so it is the invariant the tests pin.
 *
 * The label is **versioned** (`/v1`) so that the contract's
 * `swapSidecarRotateWalletPassword` can move to `/v2` deterministically: a
 * rotation stays derivable from the one phrase the user already backed up,
 * instead of minting a secret that needs its own backup.
 *
 * **Do not change {@link SWAP_WALLET_KEY_INFO}, the hash, the length, or the
 * encoding once any user has an encrypted swap wallet.** The old key is the
 * only thing that opens the old `wallet.dat`; a change presents to the user as
 * "my swap wallet won't unlock", with no error naming the cause.
 *
 * ## Zeroization — the guarantee this platform cannot give
 *
 * **Nothing in this module, and nothing that calls it, can erase these values
 * from memory.** That is stated plainly rather than gestured at:
 *
 * - JavaScript strings are immutable. There is no overwrite. The mnemonic, the
 *   wallet key, and the seed's string forms persist until the GC collects them,
 *   at an unspecified time, possibly after being copied by generational GC,
 *   possibly into swap-backed pages.
 * - `Uint8Array.fill(0)` does work on *that* array, but by the time a key has
 *   become a string (which it must, to cross the Tauri invoke boundary) at least
 *   one uncontrollable copy exists.
 * - So: no `zeroize()` helper is offered here, because offering one would imply
 *   a guarantee the runtime does not support. Rust's `Secret` newtype on the
 *   other side of the boundary (contract §1.1) is where redaction is actually
 *   enforceable; this side can only be disciplined.
 *
 * What the caller *can* do, and must:
 * 1. Keep the value's lifetime as short as possible — derive it immediately
 *    before the `invoke`, do not hoist it.
 * 2. Never place it in React state, a context, `localStorage`, the plugin
 *    store, or any module-level variable. This module holds no state by design.
 * 3. Never log it, never include it in an error message, never `JSON.stringify`
 *    a structure containing it. Nothing here logs.
 * 4. Never render it. The user has no reason to see it and no reason to write
 *    it down — its backup *is* the vault phrase.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { mnemonicToSeed } from "@scure/bip39";
import { deriveSwapWalletMnemonic } from "./bip85";

/**
 * The HKDF domain-separation label for the swap wallet's encryption key.
 *
 * Frozen by the convergence interface contract §2.3. Versioned so a future
 * rotation is a new label rather than a new backup. See § Domain separation.
 */
export const SWAP_WALLET_KEY_INFO = "pwnda/basicswap/wallet-encryption/v1";

/** Output length. 256 bits — the passphrase is machine-generated, so there is
 *  no reason to be shorter, and Core's KDF accepts arbitrary length. */
export const SWAP_WALLET_KEY_BYTES = 32;

/** base64url, RFC 4648 §5, **unpadded**. `=` and `+`/`/` are avoided because
 *  this string is passed through an environment variable and a process
 *  argument list on Windows, where quoting rules for `=` and `/` are a source
 *  of silent truncation. */
const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Encode bytes as unpadded base64url.
 *
 * Hand-rolled rather than routed through `btoa`/`Buffer` so this module stays
 * dependency-free and identical in the renderer, in Node, and under vitest —
 * an encoding that differs by environment would produce a wallet key that
 * differs by environment. The test cross-checks every output against the
 * platform's own base64 implementation.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const b0 = bytes[i];
    const b1 = remaining > 1 ? bytes[i + 1] : 0;
    const b2 = remaining > 2 ? bytes[i + 2] : 0;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (remaining > 1) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (remaining > 2) out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Normalize a mnemonic the same way `src/lib/bip85.ts` does before seeding.
 *
 * This must stay byte-identical to `bip85Bip39MnemonicFromMnemonic`'s
 * normalization. If the two diverge, a mnemonic with odd whitespace yields a
 * swap wallet whose *keys* come from one normalization and whose *encryption
 * password* comes from another — the wallet is created and then cannot be
 * unlocked, on that machine only.
 */
function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, " ");
}

/**
 * The derivation core, entered from a master **seed**.
 *
 * `info` is a parameter (defaulted, never varied in production) purely so the
 * domain-separation property is *falsifiable*: a test can assert that two
 * labels over one seed give different keys. A hard-coded label would make that
 * property untestable, and an untestable security property is one that quietly
 * stops holding.
 *
 * @param masterSeed the vault's BIP39 seed (64 bytes from `mnemonicToSeed`)
 * @param info the HKDF domain-separation label
 * @returns unpadded base64url of 32 derived bytes
 */
export function swapWalletKeyFromSeed(
  masterSeed: Uint8Array,
  info: string = SWAP_WALLET_KEY_INFO,
): string {
  if (!(masterSeed instanceof Uint8Array) || masterSeed.length < 16) {
    // A short or absent seed would still produce a well-formed-looking key.
    // Refuse rather than encrypt a wallet under something weak.
    throw new Error(
      `swapWalletKey: master seed must be at least 16 bytes, got ${
        masterSeed instanceof Uint8Array ? masterSeed.length : "non-bytes"
      }`,
    );
  }
  if (!info) {
    // An empty label is HKDF-legal and is exactly the mistake this module
    // exists to prevent: it collapses every application into one key.
    throw new Error(
      "swapWalletKey: refusing to derive without a domain-separation label",
    );
  }
  const okm = hkdf(
    sha256,
    masterSeed,
    undefined, // salt: see § The derivation
    new TextEncoder().encode(info),
    SWAP_WALLET_KEY_BYTES,
  );
  return base64UrlEncode(okm);
}

/**
 * The swap wallet's encryption key for a given vault mnemonic.
 *
 * Signature frozen by the convergence interface contract §2.3
 * (`deriveSwapWalletKey(mnemonic: string): Promise<string>`); `useVault`
 * wraps it so the master phrase stays inside that closure and the API layer
 * only ever sees the derived key.
 *
 * Pure: no I/O, no logging, no module state.
 */
export async function deriveSwapWalletKey(
  vaultMnemonic: string,
): Promise<string> {
  const normalized = normalizeMnemonic(vaultMnemonic);
  if (!normalized) throw new Error("swapWalletKey: empty vault mnemonic");
  const seed = await mnemonicToSeed(normalized);
  return swapWalletKeyFromSeed(seed);
}

/**
 * Both halves of the swap wallet's key material, from the one vault phrase.
 *
 * The mnemonic is the engine's particl master (`--particl_mnemonic`); the
 * wallet key is `WALLET_ENCRYPTION_PWD`. The setup wizard needs both at the
 * same moment and must not derive them from two different normalizations of
 * the phrase, so they are produced together here.
 *
 * Contract §1.2 fixes the *order* of use: `swapSidecarSetWalletKey(walletKey)`
 * before `swapSidecarStart({ particlMnemonic: mnemonic })`, always.
 */
export interface SwapWalletMaterial {
  /** BIP-85 child phrase — the engine's particl master. Spending authority. */
  mnemonic: string;
  /** `WALLET_ENCRYPTION_PWD`. A lock, not a key. */
  walletKey: string;
}

export async function deriveSwapWalletMaterial(
  vaultMnemonic: string,
): Promise<SwapWalletMaterial> {
  const normalized = normalizeMnemonic(vaultMnemonic);
  if (!normalized) throw new Error("swapWalletKey: empty vault mnemonic");
  return {
    mnemonic: deriveSwapWalletMnemonic(normalized),
    walletKey: await deriveSwapWalletKey(normalized),
  };
}
