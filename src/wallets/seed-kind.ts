/**
 * What kind of wallet a pasted recovery phrase belongs to — for Settings ▸
 * Wallets ▸ Add / Import, which takes one text box for every seed kind.
 *
 * Moved out of `WalletsCard.tsx` and extended to Zano on 2026-09-13. The
 * original recognised BIP39, 16-word Monero polyseed and 25-word
 * Monero/Zephyr only, so a Zano seed pasted there was "Unrecognized" and there
 * was no way to add a second Zano wallet at all.
 *
 * Order matters and is the whole algorithm:
 *  1. BIP39 — checksum-validated against the English wordlist.
 *  2. Zano — its own wordlist and structure (`validateZanoSeed`), so neither a
 *     Monero nor a Zephyr phrase can pass it.
 *  3. 16 words — Monero polyseed.
 *  4. 24 or 25 words — Xelis, Monero legacy or Zephyr (Xelis added 2026-09-15).
 *     Measured against `xelis_wallet` v1.25.0 by the P0 spike:
 *     - Xelis's English wordlist IS Monero's: 1626 of 1626 words, same order,
 *       and Zephyr inherits Monero's list and format as well (`zph-keys.ts`).
 *       Xelis's checksum word is chosen the same way (CRC-32 of the 3-letter
 *       prefixes of words 1-24, mod 24), and Monero and Zephyr keys are
 *       `sc_reduce32`-reduced, so they are canonical scalars Xelis accepts.
 *       A 25-word phrase valid for one is therefore valid for all three, it
 *       opens an unrelated wallet on each, and the words cannot say which:
 *       `ambiguous` plus `xelisPossible`, and the caller must offer all three.
 *       Restored as the wrong coin they open a different, empty wallet.
 *     - The binary also accepts 24 words, with the checksum simply unchecked,
 *       so `verifyXelisSeedIntegrity` answers `{ok:true}` for them
 *       (`XELIS_SEED_WORD_COUNT` stays 25: that is the length a seed is
 *       WRITTEN as). Monero and Zephyr legacy seeds are always 25, so a
 *       24-word phrase the Xelis check accepts is Xelis alone.
 *     - Xelis matches whole words only; Monero also accepts 3-letter prefixes.
 *       A prefix-form phrase is therefore never ambiguous with Xelis.
 *     - A Xelis check that THROWS means "not Xelis". The contract module throws
 *       until WALLET-CORE implements it, and a check that cannot run must not
 *       classify a phrase as anything.
 *     Sources: `scratchpad/xelis-spike/SPIKE.md` §A1 and the wordlist table.
 */
import { validateMnemonic } from "@scure/bip39";
import { wordlist as bip39Wordlist } from "@scure/bip39/wordlists/english.js";
import { normalizeZanoSeed, readZanoSeedMeta, validateZanoSeed } from "./zano-keys";
import { normalizeXelisSeed, verifyXelisSeedIntegrity } from "./xelis-keys";
import { MONERO_ENGLISH_WORDS } from "./xmr-wordlist";
import { _internal as xmrKeysInternal } from "./xmr-keys";

export type DetectedSeedKind = "bip39" | "xmr" | "zph" | "zano" | "xelis";

export interface SeedDetection {
  kind: DetectedSeedKind | null;
  /** True for 25 words that could be Monero legacy or Zephyr, which cannot be
   *  told apart. `kind` is then "xmr" as a placeholder and the caller asks. */
  ambiguous: boolean;
  /** 25 words only: the phrase ALSO passes the Xelis check, so the caller must
   *  offer Xelis beside Monero and Zephyr. Absent when it does not. */
  xelisPossible?: boolean;
  /** Zano only — word 25 declares a Secured-Seed passphrase is required. */
  zanoPasswordProtected?: boolean;
  /** Zano only — an auditable-wallet seed, which this wallet cannot derive. */
  zanoAuditable?: boolean;
}

const MONERO_WORDS: ReadonlySet<string> = new Set(MONERO_ENGLISH_WORDS);

export function detectSeedKind(input: string): SeedDetection {
  const trimmed = input.trim();
  const n = trimmed.split(/\s+/).filter(Boolean).length;
  if (n === 0) return { kind: null, ambiguous: false };

  if ([12, 15, 18, 21, 24].includes(n) && validateMnemonic(trimmed, bip39Wordlist)) {
    return { kind: "bip39", ambiguous: false };
  }

  const zano = normalizeZanoSeed(trimmed);
  let zanoValid = false;
  try {
    zanoValid = validateZanoSeed(zano);
  } catch {
    zanoValid = false;
  }
  if (zanoValid) {
    let meta: ReturnType<typeof readZanoSeedMeta> | null = null;
    try {
      meta = readZanoSeedMeta(zano);
    } catch {
      meta = null;
    }
    return {
      kind: "zano",
      ambiguous: false,
      zanoPasswordProtected: meta?.passwordProtected === true,
      zanoAuditable: meta?.auditable === true,
    };
  }

  if (n === 16) return { kind: "xmr", ambiguous: false };
  if (n === 24 || n === 25) {
    if (!passesXelisCheck(trimmed)) {
      // 25 words are still Monero-or-Zephyr; 24 are nothing this app knows.
      return n === 25 ? { kind: "xmr", ambiguous: true } : { kind: null, ambiguous: false };
    }
    // 24 words cannot be a Monero or Zephyr legacy seed, which are always 25.
    if (n === 24) return { kind: "xelis", ambiguous: false };
    return passesMoneroLegacyChecksum(trimmed)
      ? { kind: "xmr", ambiguous: true, xelisPossible: true }
      : { kind: "xelis", ambiguous: false };
  }
  return { kind: null, ambiguous: false };
}

/** The contract's Xelis seed check. A throw is a "no" (see the header). */
function passesXelisCheck(input: string): boolean {
  try {
    return verifyXelisSeedIntegrity(normalizeXelisSeed(input)).ok === true;
  } catch {
    return false;
  }
}

/**
 * Monero's legacy 25-word check, which Zephyr seeds pass as well: every word in
 * Monero's English list, and the 25th equal to the checksum word. Whole words
 * only. Monero's own validator also accepts 3-letter prefixes, but Xelis
 * rejects those ("No indices found", SPIKE.md B2), so a prefix-form phrase can
 * never be ambiguous with a Xelis seed.
 */
function passesMoneroLegacyChecksum(input: string): boolean {
  const words = input.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 25 || !words.every((w) => MONERO_WORDS.has(w))) return false;
  return xmrKeysInternal.checksumWord(words) === words[24];
}
