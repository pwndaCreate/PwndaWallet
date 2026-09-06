/**
 * Derivation PROFILES — the wallet-centric model (2026-06-21).
 *
 * Background: derivation divergence is a property of the SOURCE WALLET, not
 * a per-coin accident. If you came from Exodus, you diverge from the
 * standard on a whole *class* of coins (ADA, SOL, LTC, and — per Exodus's
 * own published KB — XRP / RVN / TRX with fully-hardened last two steps;
 * XLM does NOT diverge). The old model fought this by treating each coin
 * as a one-off
 * (its own `*_SPECS` + detector + panel). This registry flips it: a
 * **profile** maps each coin to the scheme that wallet uses.
 *
 * Two jobs:
 *   1. Be the single source of truth for "what path does wallet X use for
 *      coin Y" (sourced from the vendor tables transcribed in
 *      [[derivation-paths]] §Exodus / §Atomic + the reverse-engineered
 *      ADA/SOL/ALGO schemes).
 *   2. Supply CANDIDATE paths so the import scan + paste-to-find know where
 *      to look — per [[derivation-path-strategy]] and [[asset-ordering]].
 *
 * ── Funds-safety: confidence gates application ──────────────────────────
 * Most non-ADA/SOL/ALGO Exodus/Atomic paths come from the vendors' OWN
 * docs and have NOT been verified against a real seed→address pair. So a
 * scheme carries a `confidence`. A profile's scheme is only ever AUTO-
 * APPLIED to a coin when it's `standard`/`verified`, OR when a balance
 * probe confirms funds at that derived address. `published`/`inferred`
 * schemes with no on-chain funds are NEVER silently switched to — they
 * stay candidates surfaced by the paste-to-find diagnostic. This is the
 * [[post-mortem-derivation-paths]] rule (never strand a user on a path
 * that isn't theirs).
 */

import type { ChainType } from "../../wallets/types";

/** The BIP-39 chains that participate in derivation profiles. EVM L2s
 *  (arbitrum/base/optimism/bsc/avalanche/polygon/flare/monad) ride the
 *  `ethereum` key and never diverge, so they aren't listed. XMR/ZPH use
 *  independent 25-word seeds — out of scope entirely. */
export type ProfileCoin = Extract<
  ChainType,
  | "bitcoin"
  | "ethereum"
  | "solana"
  | "cardano"
  | "xrp"
  | "tron"
  | "hedera"
  | "algorand"
  | "dogecoin"
  | "ravencoin"
  | "conflux"
  | "litecoin"
  | "bitcoin-cash"
  | "dash"
  | "stellar"
  | "sui"
  | "near"
  | "ergo"
>;

export type ProfileId = "standard" | "exodus" | "atomic";

/**
 * How sure we are a scheme is correct:
 *   - `standard`  — Pwnda's default / the universal ecosystem path. Trusted.
 *   - `verified`  — confirmed against a real seed→address test vector
 *                   (e.g. the HeptaSean Exodus-ADA vector, the 2026-05-25
 *                   Exodus-ALGO user vector). Trusted.
 *   - `published` — from the vendor's OWN derivation-paths doc, but Pwnda
 *                   hasn't checked it against a real address. CANDIDATE only.
 *   - `inferred`  — reverse-engineered / pattern-guessed, no vector
 *                   (e.g. Exodus-SOL). CANDIDATE only.
 * Only `standard`/`verified` are auto-applied without an on-chain balance
 * confirmation; `published`/`inferred` must be probe-confirmed first.
 */
export type SchemeConfidence = "standard" | "verified" | "published" | "inferred";

/**
 * How to derive one coin under one profile. Exactly one of `choiceId` /
 * `path` is set:
 *   - `choiceId` — for the five coins already wired into the per-vault
 *     choice system (bitcoin/solana/cardano/algorand/litecoin); the value
 *     is a `derivePerChoice` id. Reuses the existing, tested derivers.
 *   - `path` — a raw HD path the generalized deriver feeds to the coin's
 *     own address encoder (XRP / TRX / XLM / RVN / DASH / …).
 */
export interface CoinScheme {
  choiceId?: string;
  path?: string;
  /** Advisory — the coin's adapter is the derivation authority. */
  curve?: "secp256k1" | "ed25519-slip10";
  confidence: SchemeConfidence;
  note?: string;
}

export interface DerivationProfile {
  id: ProfileId;
  label: string;
  blurb: string;
  /** Per-coin scheme. A coin ABSENT from a non-standard profile inherits
   *  the Standard scheme (resolved by `schemeFor`). */
  schemes: Partial<Record<ProfileCoin, CoinScheme>>;
}

/** True when this scheme may be applied WITHOUT an on-chain balance check. */
export function isTrustedWithoutProbe(s: CoinScheme): boolean {
  return s.confidence === "standard" || s.confidence === "verified";
}

// ── STANDARD — Pwnda's current defaults for every coin ───────────────────
// This mirrors the hardcoded adapter paths + DEFAULT_DERIVATION_CHOICE.
const STANDARD: DerivationProfile = {
  id: "standard",
  label: "Standard / MetaMask / Phantom / Ledger",
  blurb:
    "The modern ecosystem defaults — what MetaMask, Phantom, Trezor, Ledger Live, Yoroi/Eternl, and Electrum produce. Pwnda's default for fresh wallets.",
  schemes: {
    bitcoin: { choiceId: "bip84", confidence: "standard" },
    ethereum: { path: "m/44'/60'/0'/0/0", curve: "secp256k1", confidence: "standard" },
    solana: { choiceId: "phantom", confidence: "standard" },
    cardano: { choiceId: "cip1852", confidence: "standard" },
    xrp: { path: "m/44'/144'/0'/0/0", curve: "secp256k1", confidence: "standard" },
    tron: {
      path: "m/44'/60'/0'/0/0",
      curve: "secp256k1",
      confidence: "standard",
      note: "Pwnda reuses the EVM key (Exodus/Trust multi-chain convention).",
    },
    hedera: { path: "m/44'/3030'/0'/0/0", curve: "ed25519-slip10", confidence: "standard" },
    algorand: { choiceId: "exodus", confidence: "standard", note: "ALGO's default already IS the Exodus secp256k1→ed25519 scheme." },
    dogecoin: { path: "m/44'/3'/0'/0/0", curve: "secp256k1", confidence: "standard" },
    ravencoin: { path: "m/44'/175'/0'/0/0", curve: "secp256k1", confidence: "standard" },
    conflux: { path: "m/44'/503'/0'/0/0", curve: "secp256k1", confidence: "standard" },
    litecoin: { choiceId: "bip84", confidence: "standard" },
    "bitcoin-cash": { path: "m/44'/145'/0'/0/0", curve: "secp256k1", confidence: "standard" },
    dash: { path: "m/44'/5'/0'/0/0", curve: "secp256k1", confidence: "standard" },
    stellar: { path: "m/44'/148'/0'", curve: "ed25519-slip10", confidence: "standard" },
    sui: { path: "m/44'/784'/0'/0'/0'", curve: "ed25519-slip10", confidence: "standard" },
    near: { path: "m/44'/397'/0'", curve: "ed25519-slip10", confidence: "standard" },
    ergo: { path: "m/44'/429'/0'/0/0", curve: "secp256k1", confidence: "standard" },
  },
};

// ── EXODUS — overrides where Exodus diverges from Standard ───────────────
// Sourced from [[derivation-paths]] §"Exodus — default paths per asset" +
// the reverse-engineered ADA/SOL schemes. Coins not listed match Standard
// (ETH, DOGE, BCH, HBAR, DASH, SUI, BTC-segwit).
const EXODUS: DerivationProfile = {
  id: "exodus",
  label: "Exodus",
  blurb:
    "Exodus uses non-standard derivations for several coins (ADA, SOL, LTC, and — per Exodus's own KB — XRP / RVN / TRX with fully-hardened last two steps). XLM does NOT diverge (it uses the standard SEP-0005 path).",
  schemes: {
    // Reverse-engineered, vector-confirmed.
    cardano: {
      choiceId: "exodus-cardano",
      confidence: "verified",
      note: "HeptaSean secp256k1+Byron-Legacy scheme; split-stake variant for newer builds.",
    },
    // Reverse-engineered, no public vector (MEDIUM confidence).
    solana: {
      choiceId: "exodus",
      confidence: "inferred",
      note: "secp256k1 m/44'/501'/0'/0/0 → 32-byte priv as ed25519 seed (HeptaSean pattern, RE'd from a real Exodus wallet). 2026-06-27 web research couldn't corroborate this externally (one demo repo groups Exodus with the standard Phantom path) — kept as a probe-gated candidate; the project's own empirical scheme outranks an unsourced grouping until a real vector settles it.",
    },
    // Confirmed against Exodus's own KB (2026-06-27).
    litecoin: { choiceId: "bip44-legacy", confidence: "published", note: "BIP-44 legacy L… via LTC coin-type m/44'/2'/0'/0/0 (Exodus KB; NOT hardened tail — the hardening is XRP/RVN/TRX-specific)." },
    xrp: {
      path: "m/44'/144'/0'/0'/0'",
      curve: "secp256k1",
      confidence: "published",
      note: "Exodus fully-hardens the last two steps, XRP's own coin-type 144' (Exodus KB, confirmed 2026-06-27). No seed→address vector yet, so still probe-gated.",
    },
    ravencoin: {
      path: "m/44'/175'/0'/0'/0'",
      curve: "secp256k1",
      confidence: "published",
      note: "Exodus fully-hardens the last two steps (Exodus KB, confirmed 2026-06-27).",
    },
    // XLM removed 2026-06-27: research (SEP-0005 + SLIP-0010) showed Exodus
    // uses the STANDARD m/44'/148'/0' — a non-hardened-tail ed25519 path is
    // structurally invalid (SLIP-0010 fails on the first normal index), so
    // Stellar has NO Exodus divergence. STANDARD.stellar (now vector-verified
    // against SEP-0005 Test 5) already covers it; schemeFor falls back to it.
    tron: {
      path: "m/44'/195'/0'/0'/0'",
      curve: "secp256k1",
      confidence: "published",
      note: "TRX's own coin-type 195' fully-hardened, NOT the EVM key Pwnda reuses (Exodus KB, confirmed 2026-06-27).",
    },
    // BTC: Exodus default segwit matches Standard; legacy/taproot are extra
    // candidates surfaced by the BTC panel, not a profile override.
  },
};

// ── ATOMIC — overrides where Atomic Wallet diverges ──────────────────────
// Sourced from [[derivation-paths]] §"Atomic Wallet — published paths".
// Several Atomic entries are buggy (LTC at ETH coin-type, NEAR at AVAX) and
// kept as low-confidence candidates only.
const ATOMIC: DerivationProfile = {
  id: "atomic",
  label: "Atomic Wallet",
  blurb:
    "Atomic Wallet uses BIP-44 legacy for BTC, 3-step paths for several coins, and a few buggy coin-types. Mostly overlaps Exodus for ADA/SOL.",
  schemes: {
    bitcoin: { choiceId: "bip44", confidence: "published", note: "Atomic derives legacy 1… P2PKH only." },
    solana: { choiceId: "cli", confidence: "published", note: "Atomic uses the 3-step CLI path m/44'/501'/0'." },
    cardano: { choiceId: "exodus-cardano", confidence: "inferred", note: "Atomic's SLIP-44 matches Exodus; address composition unverified." },
    tron: { path: "m/44'/195'/0'", curve: "secp256k1", confidence: "published", note: "Atomic 3-step." },
    dash: { path: "m/44'/5'/0'", curve: "secp256k1", confidence: "published", note: "Atomic 3-step." },
    litecoin: {
      path: "m/44'/60'/0'/0/0",
      curve: "secp256k1",
      confidence: "published",
      note: "REAL Atomic behavior, NOT a bug: Atomic's KB #146 deliberately reuses ETH's coin-type 60' for LTC (legacy L… P2PKH). Confirmed 2026-06-27 — corroborated by BTCRecover's LTC.txt + coin.space. Atomic systematically reuses coin-types (it lists AVAX+NEAR both at 9000', INJ+LTC both at 60').",
    },
    near: {
      path: "m/44'/9000'/0'/0/0",
      curve: "ed25519-slip10",
      confidence: "published",
      note: "REAL Atomic behavior per its KB #146 (lists NEAR and AVAX both at 9000'); confirmed 2026-06-27. Vendor-documented but NOT reproduction-verified (no independent tool/vector) — stays probe-gated until a real Atomic NEAR address confirms the full ed25519 derivation around the reused coin-type.",
    },
  },
};

export const DERIVATION_PROFILES: Record<ProfileId, DerivationProfile> = {
  standard: STANDARD,
  exodus: EXODUS,
  atomic: ATOMIC,
};

export const PROFILE_IDS: readonly ProfileId[] = ["standard", "exodus", "atomic"];

/**
 * Resolve the scheme a profile uses for a coin. Non-standard profiles
 * inherit the Standard scheme for any coin they don't override — so
 * `schemeFor("exodus", "dogecoin")` returns Standard's DOGE scheme (they
 * agree), while `schemeFor("exodus", "xrp")` returns Exodus's 5-hardened
 * override. Always returns a scheme (never null) for a known coin.
 */
export function schemeFor(profile: ProfileId, coin: ProfileCoin): CoinScheme {
  return (
    DERIVATION_PROFILES[profile].schemes[coin] ??
    STANDARD.schemes[coin]!
  );
}

/** Coins where `profile` diverges from Standard (has an explicit override
 *  that isn't byte-identical to Standard's). Drives the "what changes if I
 *  pick this profile" UI + the import probe's candidate set. */
export function divergentCoins(profile: ProfileId): ProfileCoin[] {
  if (profile === "standard") return [];
  const out: ProfileCoin[] = [];
  for (const coin of Object.keys(DERIVATION_PROFILES[profile].schemes) as ProfileCoin[]) {
    const a = schemeFor(profile, coin);
    const b = STANDARD.schemes[coin]!;
    if ((a.choiceId ?? a.path) !== (b.choiceId ?? b.path)) out.push(coin);
  }
  return out;
}

// ── Fingerprinting: detection signals → source wallet (profile) ──────────

export interface ProfileFingerprint {
  profile: ProfileId;
  /** Coins whose detected choice matches (and diverges to) this profile. */
  corroborating: ProfileCoin[];
  /** True when a VERIFIED-confidence coin corroborates (e.g. ADA exodus-
   *  cardano via the HeptaSean vector) — a near-certain wallet identification. */
  strong: boolean;
}

/**
 * Infer the SOURCE WALLET from the per-coin choice ids the import scan
 * recommended. This is the bridge that lets the whole wallet's derivation
 * be resolved from one coherent fingerprint instead of coin-by-coin: if the
 * (vector-verified) Exodus-Cardano address has funds, the user is an Exodus
 * user, so the Exodus scheme is the prior for EVERY coin — including XRP /
 * XLM / TRX where a cheap balance probe isn't available.
 *
 * Only counts coins where the profile DIVERGES from Standard (matching the
 * standard choice fingerprints nothing). A `verified`-confidence match
 * (ADA / ALGO) makes the fingerprint `strong`. Returns `standard` when no
 * non-standard profile is corroborated.
 *
 * `observed` maps a coin → the detected choice id (today: the five flexible
 * coins resolved by `detectAll`).
 */
export function fingerprintProfile(
  observed: Partial<Record<ProfileCoin, string>>
): ProfileFingerprint {
  let best: ProfileFingerprint = {
    profile: "standard",
    corroborating: [],
    strong: false,
  };
  let bestScore = 0;
  for (const pid of ["exodus", "atomic"] as const) {
    const corroborating: ProfileCoin[] = [];
    let strong = false;
    for (const coin of Object.keys(observed) as ProfileCoin[]) {
      const scheme = schemeFor(pid, coin);
      const standardId = STANDARD.schemes[coin]?.choiceId;
      // Match only on choice-id coins, and only where the profile diverges
      // from Standard (so ALGO — whose Standard scheme IS the Exodus one —
      // never falsely fingerprints Exodus).
      if (
        scheme.choiceId &&
        scheme.choiceId === observed[coin] &&
        scheme.choiceId !== standardId
      ) {
        corroborating.push(coin);
        if (scheme.confidence === "verified") strong = true;
      }
    }
    const score = corroborating.length + (strong ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { profile: pid, corroborating, strong };
    }
  }
  return best;
}
