/**
 * The frontend half of the engine-datadir binding.
 *
 * # What problem this solves
 *
 * The Grove sidecar's datadir is a single fixed path with no wallet id in it,
 * and `--particl_mnemonic` reaches upstream on prepare's argv only — so the
 * engine's Particl wallet is created ONCE, from whichever vault was active at
 * first prepare, and keeps those keys across every later wallet switch.
 *
 * That is invisible from the engine's own reporting. `swap_sidecar_coin_status`
 * keeps returning `adoption: "accountkey"` after a switch, because from the
 * engine's side nothing changed — it is still holding the account it was given.
 * So `verifiedSharedTickers` kept treating BTC/LTC as "this wallet's coins" and
 * `applySharedCoinBalances` kept overriding the displayed balance with the
 * engine's, which belongs to a DIFFERENT wallet.
 *
 * Reported 2026-08-29: after switching wallets, the LTC and BTC addresses
 * changed but their balances did not — both wallets showed `4.0573 LTC` with a
 * `SWAP NODE` badge, because both were reading one shared engine wallet.
 *
 * # Why a fingerprint and not an address comparison
 *
 * The obvious check — "does the engine's `deposit_address` equal this wallet's
 * address?" — does not work. `getCachedAddressForCoin` hands out a FRESH
 * receive address from the account, so it differs from the wallet's displayed
 * index-0 address even when they are the same account. Comparing them would
 * report a mismatch for every correctly-bound wallet.
 *
 * The fingerprint compares the thing that actually identifies the binding: the
 * seed the datadir was prepared with. Rust records it at first prepare
 * (`swap_sidecar::seed_fingerprint`) and returns it on
 * `SidecarStatus.swapSeedFingerprint`; this computes the same value for the
 * wallet currently on screen.
 *
 * # It must match Rust byte for byte
 *
 * `sha256("pwnda-swap-seed-v1:" + whitespace-normalised mnemonic)`, hex, first
 * 16 characters. Any divergence makes every wallet look mismatched, which fails
 * SAFE (balances fall back to the wallet's own adapter) but would hide a real
 * shared-wallet balance — so `swapSeedFingerprint.test.ts` pins the vector
 * against the Rust implementation's own test.
 *
 * One-way and truncated on purpose: the value is persisted in a PLAINTEXT
 * opt-in record on the Rust side, so it must never be reversible to a seed.
 */

const DOMAIN = "pwnda-swap-seed-v1:";

/** Collapse any run of whitespace to single spaces and trim. Mirrors Rust's
 *  `split_whitespace().join(" ")`, so a re-spaced phrase is the same wallet. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().split(/\s+/).join(" ");
}

/**
 * Fingerprint a swap mnemonic. Returns 16 lowercase hex characters.
 *
 * Pass the **BIP-85 swap mnemonic** (`deriveSwapWalletMaterial().mnemonic`),
 * not the vault mnemonic — that is what Rust receives as `particl_mnemonic` and
 * therefore what it fingerprints.
 */
export async function swapSeedFingerprint(mnemonic: string): Promise<string> {
  const bytes = new TextEncoder().encode(DOMAIN + normalizeMnemonic(mnemonic));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Does the engine datadir belong to the wallet currently on screen?
 *
 * Returns `true` only when both fingerprints are known AND equal. **Unknown is
 * not a match**: an install prepared before the binding existed reports no
 * datadir fingerprint, and treating that as "yes, it's yours" would restore
 * exactly the bug this exists to catch.
 *
 * The cost of a false negative is small and self-correcting — the wallet shows
 * its own adapter's balance instead of the engine's. The cost of a false
 * positive is showing another wallet's funds as this one's.
 */
export function engineBelongsToWallet(
  datadirFingerprint: string | null | undefined,
  activeWalletFingerprint: string | null | undefined
): boolean {
  if (!datadirFingerprint || !activeWalletFingerprint) return false;
  return datadirFingerprint === activeWalletFingerprint;
}


/**
 * Three-way answer to "whose engine is running?", for the cases where
 * `engineBelongsToWallet`'s boolean is too blunt.
 *
 * That predicate deliberately folds "no engine" and "someone else's engine"
 * into the same `false`, which is right for its job (never show another
 * wallet's balance as this one's) and wrong for telling the user anything: a
 * user with no swap node at all must not be warned that their engine belongs
 * to a different wallet.
 *
 *  - `"mine"`     — both fingerprints known and equal.
 *  - `"foreign"`  — both known and DIFFERENT. The Pwnda Grove engine is a
 *                   single sidecar bound to one seed, so after a wallet switch
 *                   it is still the previous wallet's. Worth saying out loud.
 *  - `"unknown"`  — either side missing: no node, not opted in, unreadable
 *                   status, or an install prepared before the datadir binding
 *                   existed. Say nothing.
 */
export type EngineOwnership = "mine" | "foreign" | "unknown";

export function engineOwnership(
  datadirFingerprint: string | null | undefined,
  activeWalletFingerprint: string | null | undefined
): EngineOwnership {
  if (!datadirFingerprint || !activeWalletFingerprint) return "unknown";
  return datadirFingerprint === activeWalletFingerprint ? "mine" : "foreign";
}
