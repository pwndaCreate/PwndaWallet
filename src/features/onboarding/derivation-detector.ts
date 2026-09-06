/**
 * Derivation-path detection for imported mnemonics. When a user imports
 * a seed phrase from another wallet (Exodus, Phantom, Trust Wallet,
 * Atomic, etc.), the candidate derivation path on each chain depends on
 * which wallet they came from. This module scans the common paths in
 * parallel, queries each candidate address for on-chain activity, and
 * returns a list of `{path, address, hasActivity, balance}` rows the
 * picker UI surfaces.
 *
 * Standard paths supported per chain:
 *
 *   BTC:
 *     - bip84   m/84'/0'/0'/0/0   bc1q…   Exodus, Trust, Phantom, Trezor, Ledger Live, Sparrow
 *     - bip49   m/49'/0'/0'/0/0   3…      Older Electrum, BlueWallet, some Coinbase Wallet
 *     - bip44   m/44'/0'/0'/0/0   1…      Legacy P2PKH (Bitcoin Core <0.21)
 *     - pwnda   m/44'/0'/0'/0/0   bc1q…   Pre-2026-05-06 PwndaWallet ONLY (non-standard)
 *
 *   SOL:
 *     - phantom m/44'/501'/0'/0'  Phantom, Solflare, Trezor, Trust, modern Solflare
 *     - cli     m/44'/501'/0'      Solana CLI (`solana-keygen new`), Exodus on some versions
 *     - sollet  m/44'/501'/0'/0   Sollet, very old Solflare, some legacy paths
 *
 *   ADA:
 *     - cip1852 m/1852'/1815'/0'/0/0+m/1852'/1815'/0'/2/0  Exodus, Eternl, Yoroi, AdaLite, Daedalus
 *     - legacy  blake2b(seed)→ed25519                       Pre-2026-05-06 PwndaWallet ONLY
 *
 * The detector treats the standard / first entry as the default. The
 * picker UI only intervenes when activity is detected at a non-default
 * path (which is the "I imported from a different wallet" case).
 */

import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { sha512 } from "@noble/hashes/sha2.js";
import * as bitcoin from "bitcoinjs-lib";
import * as tinysecp from "tiny-secp256k1";
import { derivePath as solDerivePath } from "ed25519-hd-key";
import { Buffer } from "buffer";
import { Keypair } from "@solana/web3.js";
import {
  deriveCardanoKeySet,
  deriveCardanoKeySetAt,
  deriveCardanoKeySetFromMaster,
  deriveExodusCardanoKeySet,
  deriveExodusCardanoKeySetSplitStake,
  deriveExodusCardanoKeySetFromRoot,
  deriveExodusCardanoKeySetSplitStakeFromRoot,
  icarusMasterKey,
} from "../../wallets/cardano-cip1852";
import { deriveLegacyAdaFromMnemonic } from "../../wallets/ada-wallet";
import { getAddressBalance as getAdaAddressBalance } from "../../wallets/cardano-koios";
import { solAdapter } from "../../wallets/sol-wallet";
import { ltcAdapter, deriveLtcLegacyFromMnemonic } from "../../wallets/ltc-wallet";
import { xrpAdapter, deriveXrpAtPath } from "../../wallets/xrp-wallet";
import { trxAdapter, deriveTrxAtPath } from "../../wallets/trx-wallet";
import { rvnAdapter, deriveRvnAtPath } from "../../wallets/rvn-wallet";
import { dashAdapter, deriveDashAtPath } from "../../wallets/dash-wallet";
import {
  type ProfileId,
  type ProfileCoin,
  schemeFor,
  isTrustedWithoutProbe,
} from "./derivation-profiles";
import {
  algoAdapter,
  algoAddressFromPublicKey,
  deriveAlgoFromMnemonic,
  type AlgoDerivationId,
} from "../../wallets/algo-wallet";
import { ed25519 } from "@noble/curves/ed25519.js";

bitcoin.initEccLib(tinysecp);

/** A single candidate derivation result with on-chain activity check. */
export interface DerivationCandidate {
  /** Stable identifier for the path (used as form value). */
  id: string;
  /** Human-readable label shown in the picker. */
  label: string;
  /** Origin wallet hint for the user ("matches Exodus", etc.). */
  origin: string;
  /** Derived address. */
  address: string;
  /** Whether on-chain activity was found at the address. */
  hasActivity: boolean;
  /** Balance in chain's native unit (BTC, SOL, ADA). 0 if none / unknown. */
  balance: number;
  /** Whether this is the new default for fresh PwndaWallet imports. */
  isDefault: boolean;
  /**
   * True when the balance lookup FAILED, as opposed to returning zero.
   *
   * Those are different facts, and conflating them picks the wrong
   * derivation. Every probe in this file reports 0 on error, so a Koios/RPC
   * outage during import made every candidate look empty: `withActivity` came
   * back empty and the scan silently fell back to the standard path —
   * permanently, with no signal to the user. They then found their funded
   * address sitting in the derivation panel's fine print, because by the time
   * they opened it the probe was working again.
   *
   * Optional so detectors that don't track it yet still compile; `undefined`
   * means "not tracked", not "succeeded".
   */
  probeFailed?: boolean;
}

/** Top-level detection result for a single chain. */
export interface ChainDetectionResult {
  chain: "bitcoin" | "solana" | "cardano" | "algorand" | "litecoin";
  candidates: DerivationCandidate[];
  /** True if more than one candidate has activity → user must choose. */
  ambiguous: boolean;
  /** The candidate id the picker pre-selects (highest-balance, else default). */
  recommendedId: string;
  /**
   * True when NO candidate could be probed successfully, so "no activity
   * found" is unproven rather than established.
   *
   * `recommendedId` still falls back to the default path (there is nothing
   * better to choose), but callers must not treat that as a verified answer —
   * it's a guess made blind. Surfacing it lets the UI say "couldn't check"
   * instead of silently committing the user to a derivation.
   */
  probesInconclusive?: boolean;
}

// ---------------------------------------------------------------------------
// BTC
// ---------------------------------------------------------------------------

interface BtcDerivationSpec {
  id: string;
  label: string;
  origin: string;
  path: string;
  encoding: "p2wpkh" | "p2sh-p2wpkh" | "p2pkh";
  isDefault: boolean;
}

const BTC_SPECS: BtcDerivationSpec[] = [
  {
    id: "bip84",
    label: "BIP-84 native SegWit (m/84'/0'/0'/0/0 → bc1q…)",
    origin: "Exodus, Trust Wallet, Trezor, Ledger Live, Sparrow",
    path: "m/84'/0'/0'/0/0",
    encoding: "p2wpkh",
    isDefault: true,
  },
  {
    id: "bip49",
    label: "BIP-49 wrapped SegWit (m/49'/0'/0'/0/0 → 3…)",
    origin: "Older Electrum, BlueWallet, some Coinbase Wallet versions",
    path: "m/49'/0'/0'/0/0",
    encoding: "p2sh-p2wpkh",
    isDefault: false,
  },
  {
    id: "bip44",
    label: "BIP-44 legacy (m/44'/0'/0'/0/0 → 1…)",
    origin: "Bitcoin Core (legacy), older import paths",
    path: "m/44'/0'/0'/0/0",
    encoding: "p2pkh",
    isDefault: false,
  },
  {
    id: "pwnda-legacy",
    label: "PwndaWallet pre-2026-05-06 (m/44'/0'/0'/0/0 → bc1q…)",
    origin: "Older PwndaWallet builds ONLY — non-standard derivation",
    path: "m/44'/0'/0'/0/0",
    encoding: "p2wpkh",
    isDefault: false,
  },
];

function btcAddressForSpec(mnemonic: string, spec: BtcDerivationSpec): string {
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(spec.path);
  const pubkey = Buffer.from(child.publicKey!);
  if (spec.encoding === "p2wpkh") {
    return bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.bitcoin }).address!;
  }
  if (spec.encoding === "p2sh-p2wpkh") {
    return bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.bitcoin }),
      network: bitcoin.networks.bitcoin,
    }).address!;
  }
  // p2pkh
  return bitcoin.payments.p2pkh({ pubkey, network: bitcoin.networks.bitcoin }).address!;
}

// ---------------------------------------------------------------------------
// Probe plumbing shared by every detector
// ---------------------------------------------------------------------------
//
// Each detector picks the highest-balance derivation and falls back to the
// standard path when nothing is funded. That policy is right; what broke it
// was the evidence. Every probe used to `catch { return 0 }`, so an RPC blip
// during import was indistinguishable from "all derivations are empty" — the
// scan silently committed the user to the default path, permanently, and the
// funded address only surfaced later in the derivation panel once the network
// recovered. Reported for ADA on 2026-08-13; the other four chains had the
// identical defect.
//
// The helpers below make "we couldn't look" a first-class outcome.

/** A balance lookup that distinguishes failure from a genuine zero. */
interface ProbeResult {
  value: number;
  failed: boolean;
}

/** Run a balance lookup, capturing failure instead of flattening it to 0. */
async function probeBalance(fn: () => Promise<number>): Promise<ProbeResult> {
  try {
    return { value: await fn(), failed: false };
  } catch {
    return { value: 0, failed: true };
  }
}

/**
 * True when NO candidate could be probed successfully, so "nothing is funded"
 * is unproven rather than established. A probe that returned a real zero does
 * not set this — otherwise the UI would cry outage over an empty wallet.
 */
function sweepWasBlind(candidates: DerivationCandidate[]): boolean {
  const tracked = candidates.filter((c) => c.probeFailed !== undefined);
  return (
    !candidates.some((c) => c.hasActivity) &&
    tracked.length > 0 &&
    tracked.every((c) => c.probeFailed === true)
  );
}

/** Pause before the retry below. */
const BLIND_SWEEP_RETRY_MS = 1200;

/**
 * Run a detector sweep, retrying once if it came back blind.
 *
 * Only an all-probes-failed sweep is retried — a conclusive one (including a
 * genuinely empty wallet) returns immediately and never pays the delay. One
 * retry, not a backoff schedule: this runs inside the import spinner the user
 * is already watching. If the retry is also blind, its `probesInconclusive`
 * flag survives so callers can tell a blind guess from a verified answer.
 */
async function withBlindRetry(
  sweep: () => Promise<ChainDetectionResult>
): Promise<ChainDetectionResult> {
  const first = await sweep();
  if (!first.probesInconclusive) return first;
  await new Promise((r) => setTimeout(r, BLIND_SWEEP_RETRY_MS));
  // The retry is authoritative either way: if it saw the chain we want its
  // findings, and if it was also blind its flag is the freshest signal.
  return sweep();
}

/**
 * Probe a BTC address. Throws only when EVERY source failed — a successful
 * lookup of an unused address returns 0, which is a real answer.
 */
async function btcAddressBalance(address: string): Promise<number> {
  const bases = ["https://blockstream.info/api", "https://mempool.space/api"];
  let anySucceeded = false;
  for (const base of bases) {
    try {
      const resp = await fetch(`${base}/address/${address}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const sats =
        (data.chain_stats?.funded_txo_sum || 0) -
        (data.chain_stats?.spent_txo_sum || 0) +
        (data.mempool_stats?.funded_txo_sum || 0) -
        (data.mempool_stats?.spent_txo_sum || 0);
      const txCount =
        (data.chain_stats?.tx_count || 0) + (data.mempool_stats?.tx_count || 0);
      // Treat any tx_count > 0 as activity even if the address has been
      // emptied — the user might want to surface a fully-swept address.
      anySucceeded = true;
      return Math.max(sats, txCount > 0 ? 1 : 0) / 1e8;
    } catch {
      continue;
    }
  }
  // Every source errored or returned non-2xx. Throwing (rather than the old
  // `return 0`) is what lets the caller mark this candidate probeFailed
  // instead of asserting the address is empty.
  if (!anySucceeded) {
    throw new Error(`BTC balance probe failed for ${address} on all sources`);
  }
  return 0;
}

/** One full pass over the BTC candidates. `detectBtc` wraps this. */
async function sweepBTC(mnemonic: string): Promise<ChainDetectionResult> {
  const candidates = await Promise.all(
    BTC_SPECS.map(async (spec): Promise<DerivationCandidate> => {
      const address = btcAddressForSpec(mnemonic, spec);
      const probe = await probeBalance(() => btcAddressBalance(address));
      return {
        id: spec.id,
        label: spec.label,
        origin: spec.origin,
        address,
        hasActivity: probe.value > 0,
        balance: probe.value,
        probeFailed: probe.failed,
        isDefault: spec.isDefault,
      };
    })
  );
  const withActivity = candidates.filter((c) => c.hasActivity);
  const recommended =
    withActivity.length > 0
      ? withActivity.reduce((a, b) => (b.balance > a.balance ? b : a)).id
      : candidates.find((c) => c.isDefault)!.id;
  return {
    chain: "bitcoin",
    candidates,
    ambiguous: withActivity.length > 1,
    recommendedId: recommended,
    probesInconclusive: sweepWasBlind(candidates),
  };
}

// ---------------------------------------------------------------------------
// LTC — structurally identical to BTC (P2WPKH default vs P2PKH legacy), but
// only two paths matter in practice, so there's no brute-force layer: the
// panel just shows both candidates with live balances. The DEFAULT stays
// BIP-84 ltc1q… (Electrum/Trezor); the alternative is Exodus's BIP-44 legacy
// L… P2PKH. Address encoding + balance are reused verbatim from ltc-wallet so
// the picker can never disagree with the dashboard. SLIP-44 coin_type = 2.
// See [[2026-06-14-litecoin-derivation-exodus]].
// ---------------------------------------------------------------------------

interface LtcDerivationSpec {
  id: string;
  label: string;
  origin: string;
  path: string;
  encoding: "p2wpkh" | "p2pkh";
  isDefault: boolean;
}

const LTC_SPECS: LtcDerivationSpec[] = [
  {
    id: "bip84",
    label: "BIP-84 native SegWit (m/84'/2'/0'/0/0 → ltc1q…)",
    origin: "Electrum, Trezor, Ledger Live, modern standard",
    path: "m/84'/2'/0'/0/0",
    encoding: "p2wpkh",
    isDefault: true,
  },
  {
    id: "bip44-legacy",
    label: "BIP-44 legacy (m/44'/2'/0'/0/0 → L…)",
    origin: "Exodus, Atomic, older wallets",
    path: "m/44'/2'/0'/0/0",
    encoding: "p2pkh",
    isDefault: false,
  },
];

/** WalletInfo for an LTC spec — reuses ltc-wallet's audited encoders so the
 *  picker's address always matches what the adapter derives + signs from. */
function ltcWalletForSpec(mnemonic: string, choiceId: string): WalletInfo {
  return choiceId === "bip44-legacy"
    ? deriveLtcLegacyFromMnemonic(mnemonic)
    : ltcAdapter.deriveFromMnemonic(mnemonic);
}

// Routes through the same multi-source `ltcAdapter.getBalance` the dashboard
// uses (BlockCypher → Blockchair → litecoinspace) so a probe can't report a
// false zero that contradicts the balance card. Failure is now reported as
// failure rather than as an empty address.
async function ltcAddressActivity(address: string): Promise<ProbeResult> {
  return probeBalance(async () => {
    const parsed = parseFloat(await ltcAdapter.getBalance(address));
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/** One full pass over the LTC candidates. `detectLtc` wraps this. */
async function sweepLTC(mnemonic: string): Promise<ChainDetectionResult> {
  const candidates = await Promise.all(
    LTC_SPECS.map(async (spec): Promise<DerivationCandidate> => {
      const address = ltcWalletForSpec(mnemonic, spec.id).address;
      const probe = await ltcAddressActivity(address);
      return {
        id: spec.id,
        label: spec.label,
        origin: spec.origin,
        address,
        hasActivity: probe.value > 0,
        balance: probe.value,
        probeFailed: probe.failed,
        isDefault: spec.isDefault,
      };
    })
  );
  const withActivity = candidates.filter((c) => c.hasActivity);
  const recommended =
    withActivity.length > 0
      ? withActivity.reduce((a, b) => (b.balance > a.balance ? b : a)).id
      : candidates.find((c) => c.isDefault)!.id;
  return {
    chain: "litecoin",
    candidates,
    ambiguous: withActivity.length > 1,
    recommendedId: recommended,
    probesInconclusive: sweepWasBlind(candidates),
  };
}

// ---------------------------------------------------------------------------
// SOL
// ---------------------------------------------------------------------------

interface SolDerivationSpec {
  id: string;
  label: string;
  origin: string;
  path: string;
  isDefault: boolean;
}

const SOL_SPECS: SolDerivationSpec[] = [
  {
    id: "phantom",
    label: "Phantom standard (m/44'/501'/0'/0')",
    origin: "Phantom, Solflare, Trust Wallet, Trezor, modern Solflare",
    path: "m/44'/501'/0'/0'",
    isDefault: true,
  },
  {
    id: "cli",
    label: "Solana CLI default (m/44'/501'/0')",
    origin: "Solana CLI (`solana-keygen new`), Exodus (some versions)",
    path: "m/44'/501'/0'",
    isDefault: false,
  },
  {
    id: "sollet",
    label: "Sollet legacy (raw seed[0..32], no BIP-32)",
    origin: "Sollet, older Solflare, some Atomic Wallet versions",
    // Sollet uses a non-BIP-32 derivation — the BIP-39 seed's first 32
    // bytes ARE the secret key (no SLIP-10 walk). Path string is kept for
    // display only; `solAddressForSpec` special-cases id === "sollet".
    path: "(raw seed)",
    isDefault: false,
  },
];

function solAddressForSpec(mnemonic: string, spec: SolDerivationSpec): string {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  // Sollet didn't derive via BIP-32/SLIP-10 at all — it sliced the BIP-39
  // seed directly (`seed[0..32]`) and built a keypair from that. ed25519-hd-key
  // would reject the path string outright (it requires every step hardened).
  // We special-case it here with the raw-seed scheme.
  if (spec.id === "sollet") {
    return Keypair.fromSeed(seed.slice(0, 32)).publicKey.toBase58();
  }
  // Standard SLIP-10 / BIP-44 derivation via ed25519-hd-key.
  const derived = solDerivePath(spec.path, Buffer.from(seed).toString("hex"));
  const kp = Keypair.fromSeed(Uint8Array.from(derived.key));
  return kp.publicKey.toBase58();
}

/**
 * Exodus Solana address (account 0, index 0): secp256k1 BIP-32 walk at
 * `m/44'/501'/0'/0/0` → the 32-byte secp256k1 private key used directly as
 * the ed25519 seed. Same scheme `bruteForceFindSolana` probes and
 * `deriveSolAtChoice("exodus")` re-derives. Surfaced in the import scan
 * (`detectSol`) so an imported Exodus seed auto-detects without a manual
 * address paste; the full multi-account sweep stays in the brute-force
 * finder. Returns null if the secp256k1 walk yields no private key.
 */
function exodusSolAddress(mnemonic: string): string | null {
  try {
    const seed = mnemonicToSeedSync(mnemonic.trim());
    const node = HDKey.fromMasterSeed(seed).derive("m/44'/501'/0'/0/0");
    if (!node.privateKey) return null;
    return Keypair.fromSeed(node.privateKey).publicKey.toBase58();
  } catch {
    return null;
  }
}

async function solAddressActivity(address: string): Promise<ProbeResult> {
  // Route through the same `solAdapter.getBalance` the dashboard uses
  // — it races all 11 public RPC endpoints in parallel via the Rust
  // `sol_rpc_call` proxy. The earlier inline 4-endpoint sequential
  // loop was prone to false zeros when the first few endpoints
  // returned 429 / 403, while the dashboard's race found a working
  // one (producing the confusing "0 SOL probed" / "30 SOL on
  // dashboard" mismatch users saw 2026-05-16).
  // "Every RPC failed" is NO LONGER treated as 0 for the recommended-derivation
  // pick — that is exactly how a transient outage used to silently select the
  // wrong derivation. It is reported as a failed probe instead.
  return probeBalance(async () => {
    const parsed = parseFloat(await solAdapter.getBalance(address));
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/** One full pass over the SOL candidates. `detectSol` wraps this. */
async function sweepSOL(mnemonic: string): Promise<ChainDetectionResult> {
  const probes: Array<Promise<DerivationCandidate>> = SOL_SPECS.map(
    async (spec): Promise<DerivationCandidate> => {
      const address = solAddressForSpec(mnemonic, spec);
      const probe = await solAddressActivity(address);
      return {
        id: spec.id,
        label: spec.label,
        origin: spec.origin,
        address,
        hasActivity: probe.value > 0,
        balance: probe.value,
        probeFailed: probe.failed,
        isDefault: spec.isDefault,
      };
    }
  );
  // Exodus (account 0, index 0) — auto-detected on import so an Exodus seed
  // shows its funds without a manual address paste. The default stays
  // `phantom`; this only wins the recommendation when it has a balance.
  const exodusAddr = exodusSolAddress(mnemonic);
  if (exodusAddr) {
    probes.push(
      (async (): Promise<DerivationCandidate> => {
        const probe = await solAddressActivity(exodusAddr);
        return {
          id: "exodus",
          label: "Exodus (secp256k1 BIP-32 → ed25519, m/44'/501'/0'/0/0)",
          origin: "Exodus",
          address: exodusAddr,
          hasActivity: probe.value > 0,
          balance: probe.value,
          probeFailed: probe.failed,
          isDefault: false,
        };
      })()
    );
  }
  const candidates = await Promise.all(probes);
  const withActivity = candidates.filter((c) => c.hasActivity);
  const recommended =
    withActivity.length > 0
      ? withActivity.reduce((a, b) => (b.balance > a.balance ? b : a)).id
      : candidates.find((c) => c.isDefault)!.id;
  return {
    chain: "solana",
    candidates,
    ambiguous: withActivity.length > 1,
    recommendedId: recommended,
    probesInconclusive: sweepWasBlind(candidates),
  };
}

// ---------------------------------------------------------------------------
// ADA
// ---------------------------------------------------------------------------

/**
 * Cardano default candidate list. Just two:
 *   - cip1852       — Pwnda's standard CIP-1852 a=0 i=0 (matches Yoroi /
 *                     Eternl / Daedalus / cardano-serialization-lib
 *                     byte-for-byte against the abandon test vector)
 *   - pwnda-legacy  — pre-2026-05-06 enterprise (`addr1v…`)
 *
 * Multi-account / multi-index variants previously enumerated in the
 * default list (cip1852-acct1, acct2, idx1) added noise. As of 2026-06-21
 * `detectAda` ALSO probes the account-0/index-0 Exodus candidates (same-key
 * + split-stake) so an imported Exodus seed auto-detects on import. The full
 * multi-account / multi-index sweep + rarer variants still live behind the
 * brute-force `bruteForceFindCardano` probe, which only runs when the user
 * explicitly pastes an address from another wallet.
 */
interface AdaDerivationSpec {
  id: string;
  label: string;
  origin: string;
  account: number;
  index: number;
  isDefault: boolean;
}

const ADA_SPECS: AdaDerivationSpec[] = [
  {
    id: "cip1852",
    label: "CIP-1852 standard (m/1852'/1815'/0'/0/0)",
    origin: "Yoroi, Eternl, Daedalus, AdaLite, Lace, Trezor, cardano-serialization-lib",
    account: 0,
    index: 0,
    isDefault: true,
  },
];

/**
 * Koios works for both `addr1q…` base and `addr1v…` enterprise addresses via
 * /address_info. Returns ADA (1 ADA = 1_000_000 lovelace).
 *
 * Reports failure separately from zero. This used to `catch { return 0 }`,
 * which meant a Koios outage during import looked exactly like "every
 * derivation is empty" — and the scan then committed the user to the standard
 * path without telling them.
 */
async function adaAddressBalance(
  address: string
): Promise<{ ada: number; failed: boolean }> {
  try {
    const lovelace = await getAdaAddressBalance(address);
    return { ada: lovelace / 1_000_000, failed: false };
  } catch {
    return { ada: 0, failed: true };
  }
}

/** One full pass over the Cardano candidates. `detectAda` wraps this. */
async function sweepAda(mnemonic: string): Promise<ChainDetectionResult> {
  // Probe each Icarus variant + the legacy enterprise path. The standard
  // `cip1852` candidate's balance lookup is now wired through Koios's
  // /address_info (works for base addresses too; previous code skipped
  // it because Koios was incorrectly assumed to be enterprise-only).
  const variantCandidates = ADA_SPECS.map(
    async (spec): Promise<DerivationCandidate> => {
      const ks = deriveCardanoKeySetAt(mnemonic, spec.account, spec.index);
      const probe = await adaAddressBalance(ks.address);
      return {
        id: spec.id,
        label: spec.label,
        origin: spec.origin,
        address: ks.address,
        hasActivity: probe.ada > 0,
        balance: probe.ada,
        probeFailed: probe.failed,
        isDefault: spec.isDefault,
      };
    }
  );

  // Exodus (account 0, index 0) — secp256k1 + Byron-Legacy → Shelley base.
  // Probe BOTH builds: same-key (HeptaSean canonical) and split-stake (newer
  // Exodus; distinct payment/stake halves). Auto-detected on import so an
  // Exodus seed shows its funds without a manual address paste; the full a/i
  // sweep stays in `bruteForceFindCardano`. The default stays `cip1852`.
  const exodusProbes: Array<Promise<DerivationCandidate>> = [];
  try {
    const sameKey = deriveExodusCardanoKeySet(mnemonic, 0, 0);
    exodusProbes.push(
      (async (): Promise<DerivationCandidate> => {
        const probe = await adaAddressBalance(sameKey.address);
        return {
          id: "exodus-cardano",
          label: "Exodus (secp256k1 + Byron-Legacy, same-key stake)",
          origin: "Exodus",
          address: sameKey.address,
          hasActivity: probe.ada > 0,
          balance: probe.ada,
          probeFailed: probe.failed,
          isDefault: false,
        };
      })()
    );
  } catch {
    /* Exodus same-key derivation unavailable — skip this candidate. */
  }
  try {
    const split = deriveExodusCardanoKeySetSplitStake(mnemonic, 0, 0);
    exodusProbes.push(
      (async (): Promise<DerivationCandidate> => {
        const probe = await adaAddressBalance(split.address);
        return {
          id: "exodus-cardano-split",
          label:
            "Exodus split-stake (secp256k1 + Byron-Legacy, separate stake)",
          origin: "Exodus",
          address: split.address,
          hasActivity: probe.ada > 0,
          balance: probe.ada,
          probeFailed: probe.failed,
          isDefault: false,
        };
      })()
    );
  } catch {
    /* Exodus split-stake derivation unavailable — skip this candidate. */
  }

  const legacyProbe = (async (): Promise<DerivationCandidate> => {
    const legacy = deriveLegacyAdaFromMnemonic(mnemonic);
    // Uses `adaAddressBalance` rather than `getLegacyAdaBalanceLovelace`:
    // both issue the same Koios /address_info lookup, but only this one
    // reports failure instead of swallowing it into a 0. Without that, the
    // legacy candidate would be the one row still claiming "0 ADA probed"
    // during an outage while every sibling correctly says "unknown".
    // (`getLegacyAdaBalanceLovelace` keeps its swallow — AdaLegacyPanel
    // depends on that shape.)
    const probe = await adaAddressBalance(legacy.address);
    return {
      id: "pwnda-legacy",
      label: "PwndaWallet pre-2026-05-06 enterprise address",
      origin: "Older PwndaWallet builds ONLY — non-standard derivation",
      address: legacy.address,
      hasActivity: probe.ada > 0,
      balance: probe.ada,
      probeFailed: probe.failed,
      isDefault: false,
    };
  })();

  const candidates: DerivationCandidate[] = await Promise.all([
    ...variantCandidates,
    ...exodusProbes,
    legacyProbe,
  ]);
  const withActivity = candidates.filter((c) => c.hasActivity);
  const recommended =
    withActivity.length > 0
      ? withActivity.reduce((a, b) => (b.balance > a.balance ? b : a)).id
      : candidates.find((c) => c.isDefault)!.id;

  return {
    chain: "cardano",
    candidates,
    ambiguous: withActivity.length > 1,
    recommendedId: recommended,
    probesInconclusive: sweepWasBlind(candidates),
  };
}

export const detectAda = (mnemonic: string) =>
  withBlindRetry(() => sweepAda(mnemonic));

// ---------------------------------------------------------------------------
// ALGO
// ---------------------------------------------------------------------------
//
// Two real-world derivation families for BIP-39 ALGO wallets:
//
//   1. Exodus / Atomic — BIP-32 secp256k1 walk at the literal documented
//      path `m/44'/283'/0'/0/0` (last two segments unhardened — fine for
//      secp256k1) → take the 32-byte secp256k1 private key directly as
//      the ed25519 seed. Confirmed 2026-05-25 against a user-supplied
//      seed → Exodus ALGO address pair. Same algorithm as the Exodus SOL
//      scheme in `bruteForceFindSolana`.
//
//   2. Ledger / MyAlgo-BIP39 / Trust — SLIP-0010 ed25519 walk at
//      `m/44'/283'/0'/0'/0'` (5 hardened segments). Common BIP-44 + ed25519
//      interpretation for the ALGO coin type.
//
// Pera's own 25-word mnemonic uses a separate scheme entirely (the seed
// IS the ed25519 secret key, no BIP-39 / BIP-32 involved) and never has
// a BIP-39 equivalent.
//
// The pre-2026-05-25 PwndaWallet derivation (raw `sha512_256(seed[0..32])`)
// is also a candidate, kept around so anyone who funded a Pwnda-only ALGO
// address before the fix can still recover.

interface AlgoDerivationSpec {
  id: AlgoDerivationId;
  label: string;
  origin: string;
  isDefault: boolean;
}

const ALGO_SPECS: AlgoDerivationSpec[] = [
  {
    id: "exodus",
    label: "Exodus / Atomic (secp256k1 walk → ed25519, m/44'/283'/0'/0/0)",
    origin: "Exodus, Atomic Wallet",
    isDefault: true,
  },
  {
    id: "slip10-5h",
    label: "SLIP-0010 ed25519 (m/44'/283'/0'/0'/0')",
    origin: "Ledger Live, MyAlgo (BIP-39), Trust Wallet (some versions)",
    isDefault: false,
  },
  {
    id: "slip10-4h",
    label: "SLIP-0010 ed25519 (m/44'/283'/0'/0')",
    origin: "Solana-style 4-hardened path (rare for ALGO)",
    isDefault: false,
  },
  {
    id: "legacy-sha512_256",
    label: "PwndaWallet pre-2026-05-25 (sha512_256(seed[0..32]))",
    origin: "Older PwndaWallet builds ONLY — non-standard, no other wallet matches",
    isDefault: false,
  },
];

function algoAddressForSpec(mnemonic: string, spec: AlgoDerivationSpec): string {
  const { publicKey } = deriveAlgoFromMnemonic(mnemonic, spec.id);
  return algoAddressFromPublicKey(publicKey);
}

async function algoAddressBalance(address: string): Promise<ProbeResult> {
  return probeBalance(async () => {
    const parsed = parseFloat(await algoAdapter.getBalance(address));
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/** One full pass over the ALGO candidates. `detectAlgo` wraps this. */
async function sweepALGO(mnemonic: string): Promise<ChainDetectionResult> {
  const candidates = await Promise.all(
    ALGO_SPECS.map(async (spec): Promise<DerivationCandidate> => {
      const address = algoAddressForSpec(mnemonic, spec);
      const probe = await algoAddressBalance(address);
      return {
        id: spec.id,
        label: spec.label,
        origin: spec.origin,
        address,
        hasActivity: probe.value > 0,
        balance: probe.value,
        probeFailed: probe.failed,
        isDefault: spec.isDefault,
      };
    })
  );
  const withActivity = candidates.filter((c) => c.hasActivity);
  const recommended =
    withActivity.length > 0
      ? withActivity.reduce((a, b) => (b.balance > a.balance ? b : a)).id
      : candidates.find((c) => c.isDefault)!.id;
  return {
    chain: "algorand",
    candidates,
    ambiguous: withActivity.length > 1,
    recommendedId: recommended,
    probesInconclusive: sweepWasBlind(candidates),
  };
}

// ---------------------------------------------------------------------------
// Brute-force address-paste-and-find probe
// ---------------------------------------------------------------------------
//
// When the user pastes an address from another wallet (Exodus, Atomic,
// etc.) and clicks "Find", we iterate every plausible derivation
// candidate offline (no network), derive the address, and compare. The
// account-0/index-0 Exodus candidates are ALSO probed at import now (see
// `detectSol` / `detectAda` / `detectLtc` / `detectAlgo`); this brute-force
// covers the FULL multi-account / multi-index sweep + rarer variants, which
// still only run on an explicit address paste.
//
// Performance: ~1ms per candidate × ~70 candidates = <100ms total per
// chain. No balance fetch during the probe — only after a match (the UI
// can fetch the balance separately when the user picks the result).

/** A successful brute-force match. */
export interface BruteForceMatch {
  /** Stable identifier suitable for VaultPayload.derivationChoice. */
  id: string;
  /** Human-readable derivation description ("m/44'/501'/2'/0'"). */
  path: string;
  /** Friendly explanation of which wallet uses this path, if known. */
  label: string;
  /** The matched address. */
  address: string;
}

function normalizeBech32(addr: string): string {
  return addr.trim().toLowerCase();
}

function normalizeBase58(addr: string): string {
  return addr.trim();
}

/**
 * SOL brute-force: ~43 candidates spanning Phantom-style 4-step paths,
 * CLI-style 3-step paths, and the Sollet raw-seed scheme. Account/index
 * range 0..5 to catch multi-account flows. All ed25519-hd-key paths must
 * be fully hardened (SLIP-10 requirement); non-hardened experimental
 * paths are skipped with a try/catch to avoid crashing on Sollet-style
 * mixed paths that don't apply here.
 */
export function bruteForceFindSolana(
  mnemonic: string,
  targetAddressRaw: string
): BruteForceMatch | null {
  const target = normalizeBase58(targetAddressRaw);
  if (!target) return null;
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const seedHex = Buffer.from(seed).toString("hex");

  // Sollet variant — raw seed[0..32] keypair, no BIP-32 walk.
  try {
    const kp = Keypair.fromSeed(seed.slice(0, 32));
    if (kp.publicKey.toBase58() === target) {
      return {
        id: "sollet",
        path: "(raw BIP-39 seed[0..32])",
        label: "Sollet legacy / older Solflare / some Atomic Wallet versions",
        address: target,
      };
    }
  } catch {
    /* fall through */
  }

  // Phantom-style 4-step hardened paths: m/44'/501'/account'/index'
  for (let account = 0; account <= 5; account++) {
    for (let index = 0; index <= 5; index++) {
      const path = `m/44'/501'/${account}'/${index}'`;
      try {
        const derived = solDerivePath(path, seedHex);
        const kp = Keypair.fromSeed(Uint8Array.from(derived.key));
        if (kp.publicKey.toBase58() === target) {
          const isCanonical = account === 0 && index === 0;
          return {
            id: isCanonical ? "phantom" : `phantom-a${account}-i${index}`,
            path,
            label: isCanonical
              ? "Phantom standard (Phantom / Solflare / Trezor / Ledger / Trust)"
              : `Phantom path with account ${account}, address index ${index}`,
            address: target,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // CLI-style 3-step paths: m/44'/501'/account'
  for (let account = 0; account <= 5; account++) {
    const path = `m/44'/501'/${account}'`;
    try {
      const derived = solDerivePath(path, seedHex);
      const kp = Keypair.fromSeed(Uint8Array.from(derived.key));
      if (kp.publicKey.toBase58() === target) {
        const isCanonical = account === 0;
        return {
          id: isCanonical ? "cli" : `cli-a${account}`,
          path,
          label: isCanonical
            ? "Solana CLI (`solana-keygen new`) / Exodus on some versions"
            : `Solana CLI path with account ${account}`,
          address: target,
        };
      }
    } catch {
      continue;
    }
  }

  // Exodus Solana — most likely scheme per HeptaSean's house-style
  // analysis: secp256k1 BIP-32 walk at the literal documented path
  // `m/44'/501'/account'/0/index` (last two steps unhardened — fine for
  // secp256k1, which the standard SLIP-10 ed25519 walk can't do) →
  // 32-byte secp256k1 priv → use directly as ed25519 seed.
  //
  // No published test vector exists for Solana Exodus output. This
  // implementation is MEDIUM confidence — architecturally consistent
  // with the now-confirmed Exodus Cardano scheme, but unvalidated until
  // a user supplies a known seed → Exodus SOL address pair.
  //
  // See: PwndaWalletVault/wiki/sources/ExodusWalletSolanaAndCardanoResearch.md §A.1
  //
  // Performance: HDKey root hoisted once and reused across all 72
  // candidate probes (36 direct + 36 SHA-512 fold variant).
  const exodusSolRoot = HDKey.fromMasterSeed(seed);
  for (let account = 0; account <= 5; account++) {
    for (let index = 0; index <= 5; index++) {
      const path = `m/44'/501'/${account}'/0/${index}`;
      try {
        const node = exodusSolRoot.derive(path);
        if (!node.privateKey) continue;
        const kp = Keypair.fromSeed(node.privateKey);
        if (kp.publicKey.toBase58() === target) {
          const isCanonical = account === 0 && index === 0;
          return {
            id: isCanonical ? "exodus" : `exodus-a${account}-i${index}`,
            path,
            label: isCanonical
              ? "Exodus (secp256k1 BIP-32 walk → 32-byte priv as ed25519 seed)"
              : `Exodus secp256k1+ed25519 with account ${account}, address index ${index}`,
            address: target,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Exodus Solana variant 1a: same as above but with one SHA-512 fold
  // applied to the secp256k1 priv before using it as the ed25519 seed.
  // Some closed-source wallets do this to add an "extra step" while
  // keeping the same path; tried as a fallback if variant 1 misses.
  // See research §A.1 variant 1a.
  for (let account = 0; account <= 5; account++) {
    for (let index = 0; index <= 5; index++) {
      const path = `m/44'/501'/${account}'/0/${index}`;
      try {
        const node = exodusSolRoot.derive(path);
        if (!node.privateKey) continue;
        const folded = sha512(node.privateKey).slice(0, 32);
        const kp = Keypair.fromSeed(folded);
        if (kp.publicKey.toBase58() === target) {
          const isCanonical = account === 0 && index === 0;
          return {
            id: isCanonical
              ? "exodus-folded"
              : `exodus-folded-a${account}-i${index}`,
            path,
            label: isCanonical
              ? "Exodus (secp256k1 BIP-32 walk → SHA-512 fold → ed25519 seed)"
              : `Exodus secp256k1+SHA512+ed25519 with account ${account}, address index ${index}`,
            address: target,
          };
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * ALGO brute-force: ~80 candidates spanning:
 *   - Exodus / Atomic    (secp256k1 BIP-32 walk → 32B priv as ed25519 seed,
 *                         path m/44'/283'/0'/0/idx, idx 0..5)
 *   - Exodus folded      (same as above with SHA-512 fold — never observed
 *                         for ALGO but cheap to probe, mirrors SOL pattern)
 *   - SLIP-0010 5h       (m/44'/283'/0'/0'/idx', idx 0..5 — Ledger style)
 *   - SLIP-0010 4h       (m/44'/283'/0'/idx', idx 0..5 — Solana style)
 *   - SLIP-0010 3h       (m/44'/283'/idx', idx 0..5)
 *   - legacy sha512_256  (raw seed[0..32], pre-2026-05-25 Pwnda)
 *
 * Address format: 58-char base32 with embedded SHA-512/256 checksum.
 * Comparison is case-sensitive against the user-supplied address with
 * leading/trailing whitespace stripped.
 *
 * Total runtime ≤ 50ms on the abandon test mnemonic (synchronous, no
 * network). Pattern mirrors `bruteForceFindSolana`.
 */
export function bruteForceFindAlgorand(
  mnemonic: string,
  targetAddressRaw: string
): BruteForceMatch | null {
  const target = targetAddressRaw.trim().toUpperCase();
  if (!target || target.length !== 58) return null;

  const seed = mnemonicToSeedSync(mnemonic.trim());
  const seedHex = Buffer.from(seed).toString("hex");

  // Exodus (and Atomic) — secp256k1 BIP-32 walk → ed25519 seed.
  // Confirmed against user-supplied seed → address pair (2026-05-25).
  // Hoist HDKey root once; ~72 candidate probes amortize the master-key
  // computation.
  const exodusRoot = HDKey.fromMasterSeed(seed);
  for (let account = 0; account <= 5; account++) {
    for (let index = 0; index <= 5; index++) {
      const path = `m/44'/283'/${account}'/0/${index}`;
      try {
        const node = exodusRoot.derive(path);
        if (!node.privateKey) continue;
        const pk = ed25519.getPublicKey(node.privateKey);
        if (algoAddressFromPublicKey(pk) === target) {
          const isCanonical = account === 0 && index === 0;
          return {
            id: isCanonical ? "exodus" : `exodus-a${account}-i${index}`,
            path,
            label: isCanonical
              ? "Exodus / Atomic (secp256k1 BIP-32 walk → 32B priv as ed25519 seed)"
              : `Exodus secp256k1+ed25519 with account ${account}, address index ${index}`,
            address: target,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Exodus folded variant — speculative, mirrors the SOL pattern in case
  // a closed-source wallet ships an "extra SHA-512" twist for ALGO too.
  for (let account = 0; account <= 5; account++) {
    for (let index = 0; index <= 5; index++) {
      const path = `m/44'/283'/${account}'/0/${index}`;
      try {
        const node = exodusRoot.derive(path);
        if (!node.privateKey) continue;
        const folded = sha512(node.privateKey).slice(0, 32);
        const pk = ed25519.getPublicKey(folded);
        if (algoAddressFromPublicKey(pk) === target) {
          const isCanonical = account === 0 && index === 0;
          return {
            id: isCanonical
              ? "exodus-folded"
              : `exodus-folded-a${account}-i${index}`,
            path,
            label: isCanonical
              ? "Exodus-folded (secp256k1 BIP-32 walk → SHA-512 fold → ed25519 seed)"
              : `Exodus-folded with account ${account}, address index ${index}`,
            address: target,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // SLIP-0010 ed25519 — three common segment counts, account/index 0..5
  // within each. ed25519-hd-key auto-hardens all segments.
  const slip10Templates: Array<{ label: string; idTpl: string; build: (a: number, i: number) => string }> = [
    {
      label: "SLIP-0010 ed25519 5h",
      idTpl: "slip10-5h",
      build: (a, i) => `m/44'/283'/${a}'/0'/${i}'`,
    },
    {
      label: "SLIP-0010 ed25519 4h",
      idTpl: "slip10-4h",
      build: (a, i) => `m/44'/283'/${a}'/${i}'`,
    },
    {
      label: "SLIP-0010 ed25519 3h",
      idTpl: "slip10-3h",
      build: (a) => `m/44'/283'/${a}'`,
    },
  ];
  for (const tpl of slip10Templates) {
    const isThreeStep = tpl.idTpl === "slip10-3h";
    const maxAccount = isThreeStep ? 5 : 5;
    const maxIndex = isThreeStep ? 0 : 5;
    for (let account = 0; account <= maxAccount; account++) {
      for (let index = 0; index <= maxIndex; index++) {
        const path = tpl.build(account, index);
        try {
          const { key } = solDerivePath(path, seedHex);
          const pk = ed25519.getPublicKey(new Uint8Array(key));
          if (algoAddressFromPublicKey(pk) === target) {
            const isCanonical = account === 0 && index === 0;
            return {
              id: isCanonical ? tpl.idTpl : `${tpl.idTpl}-a${account}-i${index}`,
              path,
              label: isCanonical
                ? `${tpl.label} (${path})`
                : `${tpl.label} with account ${account}, index ${index}`,
              address: target,
            };
          }
        } catch {
          continue;
        }
      }
    }
  }

  // Legacy Pwnda — single deterministic address, no path.
  try {
    const { publicKey } = deriveAlgoFromMnemonic(mnemonic, "legacy-sha512_256");
    if (algoAddressFromPublicKey(publicKey) === target) {
      return {
        id: "legacy-sha512_256",
        path: "(no path)",
        label: "PwndaWallet pre-2026-05-25 (sha512_256(seed[0..32]))",
        address: target,
      };
    }
  } catch {
    /* fall through */
  }

  return null;
}

/**
 * ADA brute-force: ~67 candidates over CIP-1852 a∈0..5 i∈0..10, plus
 * the pre-fix enterprise legacy. Probes both standard Icarus and the
 * Trezor-Icarus variant (re-hashes on kL[31]&0x20 set; for the canonical
 * abandon mnemonic these collapse to identical output, but for some
 * entropies they differ — we accept either match).
 *
 * Ledger Cardano BIP-39-seed variant is NOT probed — separate master
 * key derivation, deferred per the round's scope.
 */
export function bruteForceFindCardano(
  mnemonic: string,
  targetAddressRaw: string
): BruteForceMatch | null {
  const target = normalizeBech32(targetAddressRaw);
  if (!target) return null;

  // Pwnda-legacy enterprise check first — cheapest derivation.
  try {
    const legacy = deriveLegacyAdaFromMnemonic(mnemonic);
    if (normalizeBech32(legacy.address) === target) {
      return {
        id: "pwnda-legacy",
        path: "blake2b-32(BIP-39 seed) → enterprise (header 0x61)",
        label: "Pre-2026-05-06 PwndaWallet ONLY — non-standard enterprise address",
        address: legacy.address,
      };
    }
  } catch {
    /* fall through */
  }

  // CIP-1852 base address with varying account / address index. The
  // Icarus master key is computed ONCE here and reused across the 66
  // candidate probes — without this hoist, PBKDF2(4096-iter SHA-512)
  // would run 66 times (~25ms each) and the probe would take ~1.7s
  // instead of <100ms.
  //
  // The stake key always lives at role=2 idx=0 per CIP-1852 — no need
  // to brute-force the stake side. Only payment account + index vary.
  const master = icarusMasterKey(mnemonic);
  for (let account = 0; account <= 5; account++) {
    for (let index = 0; index <= 10; index++) {
      try {
        const ks = deriveCardanoKeySetFromMaster(master, account, index);
        if (normalizeBech32(ks.address) === target) {
          const isCanonical = account === 0 && index === 0;
          return {
            id: isCanonical ? "cip1852" : `cip1852-a${account}-i${index}`,
            path: `m/1852'/1815'/${account}'/0/${index} + m/1852'/1815'/${account}'/2/0`,
            label: isCanonical
              ? "CIP-1852 standard (Yoroi / Eternl / Daedalus / cardano-serialization-lib)"
              : `CIP-1852 with account ${account}, address index ${index}`,
            address: ks.address,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Exodus's actual Cardano scheme (HeptaSean-reverse-engineered, 2024;
  // independently corroborated by ronaldjonkers, 2025). NOT the same
  // Icarus + BIP-44 we previously assumed — that was wrong and never
  // matched any Exodus output. See:
  //   PwndaWalletVault/wiki/sources/ExodusWalletSolanaAndCardanoResearch.md
  //
  // Algorithm: BIP-39 64-byte seed → secp256k1 BIP-32 walk at
  // m/44'/1815'/account'/0/index → 32-byte priv → Byron-Legacy
  // hashRepeatedly with key=that priv, msg="Root Seed Chain "+i →
  // tweakBits + bit-5 retry → 64-byte kPrv → ed25519 scalar mult →
  // blake2b-224 → Shelley base address with stakeCred == paymentCred
  // (SAME hash byte-for-byte twice).
  //
  // Validated against HeptaSean's canonical abandon vector:
  //   addr1q9av2w6nz9tzv8rc3vfqs95av844gkcqxm0qeezvlf07p3r6c5a4xy2kycw83zcjpqtf6c0t23dsqdk7pnjye7jlurzqm0pqxa
  // (see cardano-cip1852.test.ts).
  //
  // Two variants probed: same-key (HeptaSean canonical, halves equal)
  // and split-stake (fallback for newer Exodus builds — halves differ).
  // The user's reported addr1q8qf6lk… has DISTINCT halves on bech32
  // decode, so the split-stake variant is the more likely match.
  //
  // Performance: the secp256k1 HDKey root is hoisted once and reused
  // across all 72 candidate probes (36 same-key + 36 split-stake). A
  // single full ADA brute force (CIP-1852 + Exodus same-key + Exodus
  // split-stake) runs <~600ms total.
  const seed64 = mnemonicToSeedSync(mnemonic.trim());
  const exodusRoot = HDKey.fromMasterSeed(seed64);
  for (let account = 0; account <= 5; account++) {
    for (let index = 0; index <= 5; index++) {
      try {
        const ks = deriveExodusCardanoKeySetFromRoot(exodusRoot, account, index);
        if (normalizeBech32(ks.address) === target) {
          const isCanonical = account === 0 && index === 0;
          return {
            id: isCanonical
              ? "exodus-cardano"
              : `exodus-cardano-a${account}-i${index}`,
            path: `m/44'/1815'/${account}'/0/${index} → Byron-Legacy → Ed25519 (same key for stake)`,
            label: isCanonical
              ? "Exodus (HeptaSean canonical scheme — secp256k1+Byron-Legacy, same-key stake)"
              : `Exodus same-key scheme with account ${account}, address index ${index}`,
            address: ks.address,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Split-stake fallback: stake derived separately at /2/0 on the
  // same secp256k1+Byron-Legacy stack. Probed AFTER same-key because
  // the canonical HeptaSean scheme is same-key; split-stake is for
  // post-2025 Exodus builds where the user's address has distinct
  // payment vs stake halves.
  for (let account = 0; account <= 5; account++) {
    for (let index = 0; index <= 5; index++) {
      try {
        const ks = deriveExodusCardanoKeySetSplitStakeFromRoot(
          exodusRoot,
          account,
          index
        );
        if (normalizeBech32(ks.address) === target) {
          const isCanonical = account === 0 && index === 0;
          return {
            id: isCanonical
              ? "exodus-cardano-split"
              : `exodus-cardano-split-a${account}-i${index}`,
            path: `m/44'/1815'/${account}'/0/${index} (payment) + m/44'/1815'/${account}'/2/0 (stake) — secp256k1+Byron-Legacy, separate stake`,
            label: isCanonical
              ? "Exodus split-stake variant (secp256k1+Byron-Legacy, separate stake key)"
              : `Exodus split-stake with account ${account}, address index ${index}`,
            address: ks.address,
          };
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

export interface FullDetectionResult {
  bitcoin: ChainDetectionResult;
  solana: ChainDetectionResult;
  cardano: ChainDetectionResult;
  litecoin: ChainDetectionResult;
  algorand: ChainDetectionResult;
  /** True if any chain has activity at a non-default path. */
  needsUserInput: boolean;
}

/**
 * Run all three detectors in parallel. The picker UI consumes this and
 * decides whether to show itself based on `needsUserInput`. If every
 * chain is unambiguous and at the default path, the import flow can
 * skip the picker entirely and proceed straight to setPassword.
 */
/**
 * Public detectors. Each retries once if its first sweep came back blind —
 * see `withBlindRetry`. The selection policy itself is unchanged: highest
 * balance wins, standard path only when nothing is funded.
 */
export const detectBtc = (mnemonic: string) => withBlindRetry(() => sweepBTC(mnemonic));
export const detectLtc = (mnemonic: string) => withBlindRetry(() => sweepLTC(mnemonic));
export const detectSol = (mnemonic: string) => withBlindRetry(() => sweepSOL(mnemonic));
export const detectAlgo = (mnemonic: string) => withBlindRetry(() => sweepALGO(mnemonic));

export async function detectAll(mnemonic: string): Promise<FullDetectionResult> {
  const [bitcoin, solana, cardano, litecoin, algorand] = await Promise.all([
    detectBtc(mnemonic),
    detectSol(mnemonic),
    detectAda(mnemonic),
    detectLtc(mnemonic),
    detectAlgo(mnemonic),
  ]);
  // Vestigial since the import picker was removed (2026-05-16) — the import
  // flow now applies `recommendedId` per chain without prompting. Kept (and
  // extended to all five chains) so any future picker has a correct signal.
  const nonDefault = (r: ChainDetectionResult) =>
    r.recommendedId !== r.candidates.find((c) => c.isDefault)!.id;
  const needsUserInput =
    bitcoin.ambiguous ||
    solana.ambiguous ||
    cardano.ambiguous ||
    litecoin.ambiguous ||
    algorand.ambiguous ||
    nonDefault(bitcoin) ||
    nonDefault(solana) ||
    nonDefault(cardano) ||
    nonDefault(litecoin) ||
    nonDefault(algorand);
  return { bitcoin, solana, cardano, litecoin, algorand, needsUserInput };
}

/** Stable record of user choices, persisted to the vault. */
export interface DerivationChoice {
  bitcoin: string; // candidate id from BTC_SPECS
  solana: string; // candidate id from SOL_SPECS
  cardano: string; // "cip1852" | "pwnda-legacy"
  algorand?: string; // candidate id from ALGO_SPECS (optional for backward-compat with v=1 vaults)
  litecoin?: string; // candidate id from LTC_SPECS ("bip84" | "bip44-legacy"); optional for backward-compat
  // 2026-06-21 — profile-driven RAW HD paths for the secp256k1 coins that
  // diverge between wallets (Exodus/Atomic). Undefined = the standard path,
  // so existing vaults + fresh wallets are unchanged. Set by the derivation-
  // profile fingerprint at import; see [[derivation-profiles-plan]].
  xrp?: string;
  tron?: string;
  ravencoin?: string;
  dash?: string;
}

export const DEFAULT_DERIVATION_CHOICE: DerivationChoice = {
  bitcoin: "bip84",
  solana: "phantom",
  cardano: "cip1852",
  algorand: "exodus", // matches Exodus / Atomic — confirmed 2026-05-25
  litecoin: "bip84", // native SegWit ltc1q… (Electrum/Trezor); Exodus users switch to bip44-legacy post-hoc
};

/** Standard HD paths for the profile-driven secp256k1 coins — the fallback
 *  when a `DerivationChoice` doesn't override them. Each MUST match its
 *  adapter's own DERIVATION_PATH byte-for-byte (locked by round-trip tests). */
const STD_XRP_PATH = "m/44'/144'/0'/0/0";
const STD_TRX_PATH = "m/44'/60'/0'/0/0";
const STD_RVN_PATH = "m/44'/175'/0'/0/0";
const STD_DASH_PATH = "m/44'/5'/0'/0/0";

// ---------------------------------------------------------------------------
// Re-derivation given a chosen DerivationChoice
// ---------------------------------------------------------------------------

import type { WalletInfo } from "../../wallets/types";

/** Output of `derivePerChoice` — only the chains the picker covers. */
export interface DerivedChoiceWallets {
  bitcoin: WalletInfo;
  solana: WalletInfo;
  cardano: WalletInfo;
  algorand: WalletInfo;
  litecoin: WalletInfo;
  xrp: WalletInfo;
  tron: WalletInfo;
  ravencoin: WalletInfo;
  dash: WalletInfo;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function deriveBtcAtChoice(mnemonic: string, choiceId: string): WalletInfo {
  const spec = BTC_SPECS.find((s) => s.id === choiceId) ?? BTC_SPECS[0];
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(spec.path);
  const address = btcAddressForSpec(mnemonic, spec);
  return {
    chain: "bitcoin",
    address,
    mnemonic: mnemonic.trim(),
    privateKey: bytesToHex(child.privateKey!),
  };
}

function deriveSolAtChoice(mnemonic: string, choiceId: string): WalletInfo {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  let kp: Keypair;

  // Brute-force-derived dynamic IDs:
  //   "phantom-a{N}-i{M}"        → m/44'/501'/N'/M'     (Phantom 4-step)
  //   "cli-a{N}"                 → m/44'/501'/N'        (CLI 3-step)
  //   "exodus" / "exodus-a{N}-i{M}" → m/44'/501'/N'/0/M  via secp256k1 BIP-32
  //                                   → 32B priv used as ed25519 seed
  //   "exodus-folded-a{N}-i{M}"  → same path + SHA-512 fold variant
  // Standard "phantom"/"cli"/"sollet" IDs fall through to SOL_SPECS.
  const phantomVariant = choiceId.match(/^phantom-a(\d+)-i(\d+)$/);
  const cliVariant = choiceId.match(/^cli-a(\d+)$/);
  const exodusVariant = choiceId.match(/^exodus-a(\d+)-i(\d+)$/);
  const exodusFoldedVariant = choiceId.match(/^exodus-folded-a(\d+)-i(\d+)$/);
  if (phantomVariant) {
    const path = `m/44'/501'/${phantomVariant[1]}'/${phantomVariant[2]}'`;
    const derived = solDerivePath(path, Buffer.from(seed).toString("hex"));
    kp = Keypair.fromSeed(Uint8Array.from(derived.key));
  } else if (cliVariant) {
    const path = `m/44'/501'/${cliVariant[1]}'`;
    const derived = solDerivePath(path, Buffer.from(seed).toString("hex"));
    kp = Keypair.fromSeed(Uint8Array.from(derived.key));
  } else if (
    exodusVariant ||
    choiceId === "exodus" ||
    exodusFoldedVariant ||
    choiceId === "exodus-folded"
  ) {
    const account = exodusVariant
      ? Number(exodusVariant[1])
      : exodusFoldedVariant
        ? Number(exodusFoldedVariant[1])
        : 0;
    const index = exodusVariant
      ? Number(exodusVariant[2])
      : exodusFoldedVariant
        ? Number(exodusFoldedVariant[2])
        : 0;
    const path = `m/44'/501'/${account}'/0/${index}`;
    const node = HDKey.fromMasterSeed(seed).derive(path);
    if (!node.privateKey) {
      throw new Error("Exodus SOL derivation: secp256k1 walk produced no private key");
    }
    const seedForKp =
      exodusFoldedVariant || choiceId === "exodus-folded"
        ? sha512(node.privateKey).slice(0, 32)
        : node.privateKey;
    kp = Keypair.fromSeed(seedForKp);
  } else {
    const spec = SOL_SPECS.find((s) => s.id === choiceId) ?? SOL_SPECS[0];
    // Sollet: raw seed[0..32] keypair, no BIP-32 walk.
    if (spec.id === "sollet") {
      kp = Keypair.fromSeed(seed.slice(0, 32));
    } else {
      const derived = solDerivePath(spec.path, Buffer.from(seed).toString("hex"));
      kp = Keypair.fromSeed(Uint8Array.from(derived.key));
    }
  }

  return {
    chain: "solana",
    address: kp.publicKey.toBase58(),
    mnemonic: mnemonic.trim(),
    privateKey: bytesToHex(kp.secretKey),
  };
}

function deriveAdaAtChoice(mnemonic: string, choiceId: string): WalletInfo {
  if (choiceId === "pwnda-legacy") {
    return deriveLegacyAdaFromMnemonic(mnemonic);
  }

  // Brute-force-derived dynamic IDs:
  //   "cip1852-a{N}-i{M}"              → CIP-1852 with account N, index M
  //   "exodus-cardano"                 → Exodus same-key default (a=0 i=0)
  //   "exodus-cardano-a{N}-i{M}"       → Exodus same-key variant
  //   "exodus-cardano-split"           → Exodus split-stake default (a=0 i=0)
  //   "exodus-cardano-split-a{N}-i{M}" → Exodus split-stake variant
  const cip1852Variant = choiceId.match(/^cip1852-a(\d+)-i(\d+)$/);
  const exodusVariant = choiceId.match(/^exodus-cardano-a(\d+)-i(\d+)$/);
  const exodusSplitVariant = choiceId.match(
    /^exodus-cardano-split-a(\d+)-i(\d+)$/
  );

  if (cip1852Variant) {
    const account = Number(cip1852Variant[1]);
    const index = Number(cip1852Variant[2]);
    const ks = deriveCardanoKeySetAt(mnemonic, account, index);
    return {
      chain: "cardano",
      address: ks.address,
      mnemonic: mnemonic.trim(),
      privateKey: ks.paymentPrivateKey,
    };
  }

  if (exodusSplitVariant || choiceId === "exodus-cardano-split") {
    const account = exodusSplitVariant ? Number(exodusSplitVariant[1]) : 0;
    const index = exodusSplitVariant ? Number(exodusSplitVariant[2]) : 0;
    const ks = deriveExodusCardanoKeySetSplitStake(mnemonic, account, index);
    return {
      chain: "cardano",
      address: ks.address,
      mnemonic: mnemonic.trim(),
      privateKey: ks.paymentPrivateKey,
    };
  }

  if (exodusVariant || choiceId === "exodus-cardano") {
    const account = exodusVariant ? Number(exodusVariant[1]) : 0;
    const index = exodusVariant ? Number(exodusVariant[2]) : 0;
    const ks = deriveExodusCardanoKeySet(mnemonic, account, index);
    return {
      chain: "cardano",
      address: ks.address,
      mnemonic: mnemonic.trim(),
      privateKey: ks.paymentPrivateKey,
    };
  }

  const spec = ADA_SPECS.find((s) => s.id === choiceId) ?? ADA_SPECS[0];
  const ks = deriveCardanoKeySetAt(mnemonic, spec.account, spec.index);
  return {
    chain: "cardano",
    address: ks.address,
    mnemonic: mnemonic.trim(),
    privateKey: ks.paymentPrivateKey,
  };
}

/**
 * Re-derive the ALGO WalletInfo from the user's per-vault choice. Stable
 * choice ids:
 *   - "exodus"                       → m/44'/283'/0'/0/0 secp256k1 → ed25519
 *   - "exodus-a{N}-i{M}"             → same scheme, varying account/index
 *   - "exodus-folded[-a{N}-i{M}]"    → SHA-512 folded variant
 *   - "slip10-5h" / "slip10-4h" / "slip10-3h"
 *                                    → canonical SLIP-0010 ed25519 paths
 *   - "slip10-{Xh}-a{N}-i{M}"        → SLIP-0010 with varying account/index
 *   - "legacy-sha512_256"            → pre-2026-05-25 PwndaWallet
 */
function deriveAlgoAtChoice(mnemonic: string, choiceId: string): WalletInfo {
  const exodusVariant = choiceId.match(/^exodus-a(\d+)-i(\d+)$/);
  const exodusFoldedVariant = choiceId.match(/^exodus-folded-a(\d+)-i(\d+)$/);
  const slip5hVariant = choiceId.match(/^slip10-5h-a(\d+)-i(\d+)$/);
  const slip4hVariant = choiceId.match(/^slip10-4h-a(\d+)-i(\d+)$/);
  const slip3hVariant = choiceId.match(/^slip10-3h-a(\d+)-i(\d+)$/);

  let pathOrPreset: string = choiceId;
  if (exodusVariant) {
    pathOrPreset = `m/44'/283'/${exodusVariant[1]}'/0/${exodusVariant[2]}`;
  } else if (exodusFoldedVariant) {
    pathOrPreset = `exodus-folded:m/44'/283'/${exodusFoldedVariant[1]}'/0/${exodusFoldedVariant[2]}`;
  } else if (slip5hVariant) {
    pathOrPreset = `m/44'/283'/${slip5hVariant[1]}'/0'/${slip5hVariant[2]}'`;
  } else if (slip4hVariant) {
    pathOrPreset = `m/44'/283'/${slip4hVariant[1]}'/${slip4hVariant[2]}'`;
  } else if (slip3hVariant) {
    pathOrPreset = `m/44'/283'/${slip3hVariant[1]}'`;
  }
  const { privateKey, publicKey } = deriveAlgoFromMnemonic(mnemonic, pathOrPreset);
  return {
    chain: "algorand",
    address: algoAddressFromPublicKey(publicKey),
    mnemonic: mnemonic.trim(),
    privateKey: bytesToHex(privateKey),
  };
}

/**
 * Re-derive BTC / SOL / ADA / ALGO WalletInfo from a mnemonic + the
 * user's derivation choice. Called both after the picker confirms (fresh
 * import flow) and on every unlock (so the chosen path is honored
 * across sessions).
 */
export function derivePerChoice(
  mnemonic: string,
  choice: DerivationChoice
): DerivedChoiceWallets {
  return {
    bitcoin: deriveBtcAtChoice(mnemonic, choice.bitcoin),
    solana: deriveSolAtChoice(mnemonic, choice.solana),
    cardano: deriveAdaAtChoice(mnemonic, choice.cardano),
    algorand: deriveAlgoAtChoice(mnemonic, choice.algorand ?? DEFAULT_DERIVATION_CHOICE.algorand!),
    litecoin: ltcWalletForSpec(mnemonic, choice.litecoin ?? DEFAULT_DERIVATION_CHOICE.litecoin!),
    // Profile-driven secp256k1 coins — derive at the chosen path (or the
    // standard path when unset). Byte-identical to the adapter default at the
    // standard path, so this is a no-op until the fingerprint sets one.
    xrp: deriveXrpAtPath(mnemonic, choice.xrp ?? STD_XRP_PATH),
    tron: deriveTrxAtPath(mnemonic, choice.tron ?? STD_TRX_PATH),
    ravencoin: deriveRvnAtPath(mnemonic, choice.ravencoin ?? STD_RVN_PATH),
    dash: deriveDashAtPath(mnemonic, choice.dash ?? STD_DASH_PATH),
  };
}

/**
 * Phase 2 — for a fingerprinted source-wallet PROFILE, resolve the HD-path
 * overrides for the secp256k1 coins (XRP / TRX / RVN / DASH) that have no
 * candidate of their own in the standard import scan.
 *
 * Funds-safety: `standard`/`verified` schemes apply directly; `published`/
 * `inferred` schemes (everything Exodus/Atomic is, here) are **balance-probed
 * and applied ONLY when the derived address has funds**. So an Exodus user
 * with no XRP keeps the standard XRP path — we never strand a user on an
 * unverified path that isn't theirs (the [[post-mortem-derivation-paths]]
 * rule). Returns a partial `DerivationChoice` (only the coins that diverge AND
 * confirm); everything else stays standard.
 */
export async function detectProfilePaths(
  mnemonic: string,
  profile: ProfileId
): Promise<Pick<DerivationChoice, "xrp" | "tron" | "ravencoin" | "dash">> {
  if (profile === "standard") return {};
  const out: Pick<DerivationChoice, "xrp" | "tron" | "ravencoin" | "dash"> = {};
  const coins: Array<{
    coin: ProfileCoin;
    key: "xrp" | "tron" | "ravencoin" | "dash";
    std: string;
    derive: (m: string, p: string) => WalletInfo;
    balance: (a: string) => Promise<string>;
  }> = [
    { coin: "xrp", key: "xrp", std: STD_XRP_PATH, derive: deriveXrpAtPath, balance: (a) => xrpAdapter.getBalance(a) },
    { coin: "tron", key: "tron", std: STD_TRX_PATH, derive: deriveTrxAtPath, balance: (a) => trxAdapter.getBalance(a) },
    { coin: "ravencoin", key: "ravencoin", std: STD_RVN_PATH, derive: deriveRvnAtPath, balance: (a) => rvnAdapter.getBalance(a) },
    { coin: "dash", key: "dash", std: STD_DASH_PATH, derive: deriveDashAtPath, balance: (a) => dashAdapter.getBalance(a) },
  ];
  await Promise.all(
    coins.map(async (c) => {
      const scheme = schemeFor(profile, c.coin);
      if (!scheme.path || scheme.path === c.std) return; // no divergence
      if (isTrustedWithoutProbe(scheme)) {
        out[c.key] = scheme.path;
        return;
      }
      // published/inferred → confirm with an on-chain balance probe.
      try {
        const addr = c.derive(mnemonic, scheme.path).address;
        const bal = parseFloat(await c.balance(addr));
        if (Number.isFinite(bal) && bal > 0) out[c.key] = scheme.path;
      } catch {
        /* probe failed → keep the standard path */
      }
    })
  );
  return out;
}

// ── Generalised paste-to-find for the secp256k1 profile coins ────────────

/** The path-based profile coins (their `DerivationChoice` value is a raw HD
 *  path, not a named id). */
export type ProfilePathCoin = "xrp" | "tron" | "ravencoin" | "dash";

const PROFILE_COIN_TYPES: Record<ProfilePathCoin, number[]> = {
  xrp: [144],
  ravencoin: [175],
  dash: [5],
  // TRX: its own SLIP-44 coin-type (Exodus/Atomic) PLUS the EVM key Pwnda's
  // default reuses — sweep both so the find probe matches either source.
  tron: [195, 60],
};

const PROFILE_DERIVE_FN: Record<
  ProfilePathCoin,
  (m: string, p: string) => WalletInfo
> = {
  xrp: deriveXrpAtPath,
  tron: deriveTrxAtPath,
  ravencoin: deriveRvnAtPath,
  dash: deriveDashAtPath,
};

/** Candidate paths the paste-to-find probe sweeps: the three real-world
 *  forms (BIP-44 standard 5-seg, Exodus fully-hardened 5-seg, Atomic 3-seg)
 *  across account/index 0..5, for each of the coin's coin-types. */
function profileCandidatePaths(
  coin: ProfilePathCoin
): Array<{ path: string; label: string }> {
  const out: Array<{ path: string; label: string }> = [];
  const cts = PROFILE_COIN_TYPES[coin];
  for (const ct of cts) {
    const ctNote = cts.length > 1 ? ` (coin-type ${ct}')` : "";
    for (let a = 0; a <= 5; a++) {
      for (let i = 0; i <= 5; i++) {
        out.push({
          path: `m/44'/${ct}'/${a}'/0/${i}`,
          label:
            a === 0 && i === 0
              ? `BIP-44 standard${ctNote}`
              : `BIP-44 account ${a}, index ${i}${ctNote}`,
        });
        out.push({
          path: `m/44'/${ct}'/${a}'/0'/${i}'`,
          label:
            a === 0 && i === 0
              ? `Exodus (5-hardened)${ctNote}`
              : `Exodus 5-hardened account ${a}, index ${i}${ctNote}`,
        });
      }
      out.push({
        path: `m/44'/${ct}'/${a}'`,
        label: a === 0 ? `Atomic (3-step)${ctNote}` : `3-step account ${a}${ctNote}`,
      });
    }
  }
  return out;
}

/**
 * Paste-to-find for the secp256k1 profile coins (XRP / TRX / RVN / DASH) —
 * the generalised counterpart of `bruteForceFindSolana` etc. Sweeps the
 * standard / Exodus-5-hardened / Atomic-3-step forms across account+index
 * 0..5 (offline, ~1ms/candidate) and returns the matching `BruteForceMatch`
 * whose `id` IS the HD path (used directly as the `DerivationChoice` value).
 * Returns null if no candidate produces the pasted address.
 */
export function bruteForceFindCoinPath(
  coin: ProfilePathCoin,
  mnemonic: string,
  targetAddressRaw: string
): BruteForceMatch | null {
  const target = targetAddressRaw.trim();
  if (!target) return null;
  const derive = PROFILE_DERIVE_FN[coin];
  for (const { path, label } of profileCandidatePaths(coin)) {
    try {
      if (derive(mnemonic, path).address === target) {
        return { id: path, path, label, address: target };
      }
    } catch {
      continue;
    }
  }
  return null;
}
