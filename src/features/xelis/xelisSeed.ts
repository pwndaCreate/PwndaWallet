/**
 * The Xelis seed check that the import panel and the vault share, and the
 * in-memory `WalletInfo` a Xelis seed becomes.
 *
 * Exported through `src/features/xelis/index.ts`, so `useVault` shows the same
 * words the import panel shows (BOUNDARIES.md, vault row). Pure: tested in
 * `xelisSeed.test.ts`.
 */
import type { WalletInfo } from "../../wallets";
import {
  XELIS_SEED_WORD_COUNT,
  normalizeXelisSeed,
  verifyXelisSeedIntegrity,
  xelisAddressFromSeed,
  xelisNetworkFromEnv,
  type XelisSeedCheck,
} from "../../wallets/xelis-keys";

export type XelisSeedProblem = Exclude<XelisSeedCheck, { ok: true }>;

export type XelisSeedVerdict =
  /** Passes every check `verifyXelisSeedIntegrity` makes. `seed` is normalised. */
  | { status: "valid"; seed: string }
  | { status: "invalid"; seed: string; problem: XelisSeedProblem; message: string }
  /** The check could not run. The contract module throws until it is implemented. */
  | { status: "unavailable"; seed: string; message: string };

export const XELIS_SEED_CHECK_UNAVAILABLE =
  "Xelis seed checking is not available in this build yet, so a Xelis seed cannot be saved.";

/**
 * Normalise and check a pasted seed. A check that throws is `unavailable`,
 * never `valid`: a seed nobody could check is not saved.
 */
export function checkXelisSeed(raw: string): XelisSeedVerdict {
  const seed = normalizeXelisSeed(raw);
  let check: XelisSeedCheck;
  try {
    check = verifyXelisSeedIntegrity(seed);
  } catch {
    return { status: "unavailable", seed, message: XELIS_SEED_CHECK_UNAVAILABLE };
  }
  if (check.ok) return { status: "valid", seed };
  return { status: "invalid", seed, problem: check, message: describeXelisSeedProblem(check) };
}

/**
 * One sentence for each way a seed can fail the check.
 *
 * EXHAUSTIVE over `XelisSeedCheck`'s discriminant, on purpose. This used to end
 * with the checksum sentence as a bare `return`, so when the contract gained a
 * fourth verdict (`key`, 2026-09-15) it would have compiled and told the user
 * their 25th word was wrong when it was provably right — a check that cannot
 * fail for the reason it is run. A new variant now fails `check-types` here.
 */
export function describeXelisSeedProblem(problem: XelisSeedProblem): string {
  switch (problem.kind) {
    case "word-count":
      return (
        `A Xelis seed is ${XELIS_SEED_WORD_COUNT} words (or 24 without the ` +
        `checksum word); this one has ${problem.count}.`
      );
    case "unknown-word": {
      const shown = problem.words.slice(0, 3).map((w) => `"${w}"`).join(", ");
      const more = problem.words.length > 3 ? ` and ${problem.words.length - 3} more` : "";
      const verb = problem.words.length === 1 ? "is" : "are";
      return `${shown}${more} ${verb} not in the Xelis wordlist. Check the spelling against your backup.`;
    }
    case "checksum":
      return (
        "The 25th word does not match the first 24, so a word is probably mistyped " +
        "or out of order. Check it against your backup."
      );
    case "key":
      // Every word is real and the checksum matches, but the 24 data words
      // decode to a scalar XELIS refuses (zero, or at/above the group order l;
      // it does not reduce). Saying "the 25th word is wrong" here would be
      // false: the spike's `abbey`×25 and ff×32 vectors pass both earlier
      // checks and still fail with `Invalid key from bytes`.
      return (
        "These words are all spelled correctly and the checksum matches, but " +
        "together they do not form a valid Xelis key. Check their order against " +
        "your backup."
      );
    default: {
      const unreachable: never = problem;
      return `That seed did not pass the Xelis check (${
        (unreachable as XelisSeedProblem).kind
      }).`;
    }
  }
}

/**
 * The address a Xelis seed derives offline, or null when this build cannot
 * derive it. The contract allows null ("the running wallet reports it"), and a
 * throw is treated the same way: unknown, never a mismatch.
 */
export function xelisOfflineAddress(seed: string): string | null {
  try {
    const address = xelisAddressFromSeed(normalizeXelisSeed(seed), xelisNetworkFromEnv());
    return typeof address === "string" && address.length > 0 ? address : null;
  } catch {
    return null;
  }
}

/**
 * The `walletsByChain.xelis` entry for a seed.
 *
 * - `address` is the offline address, or "" until the running wallet reports
 *   it (`useXelisSession`'s `onAddress`). The account card renders "" as
 *   "shown once the wallet opens" and offers nothing to copy.
 * - `mnemonic` and `privateKey` are "" on purpose. App code treats the first
 *   non-empty `mnemonic` in `walletsByChain` as the vault's BIP-39 phrase
 *   (`sharedMnemonic` in App.tsx, the swap node's key material), so a Xelis
 *   seed there would be revealed as "Mnemonic (all chains)" and fed to BIP-39
 *   derivation. The seed lives in its vault entry and in `xelisSeedLoaded`;
 *   the wallet process holds the key.
 */
export function xelisWalletInfo(seed: string): WalletInfo {
  return {
    chain: "xelis",
    address: xelisOfflineAddress(seed) ?? "",
    mnemonic: "",
    privateKey: "",
  };
}
