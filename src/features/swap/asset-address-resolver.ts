/**
 * NEAR Intents asset → user address resolver.
 *
 * 1Click's `recipient` and `refundTo` fields must match the destination /
 * origin chain's native address format. The mapping is purely a function
 * of the asset id namespace:
 *
 *   destinationAsset prefix    →    recipient format
 *   ─────────────────────────────────────────────────
 *   nep141:btc.omft.near       →    BTC bech32      (bc1q… / bc1p…)
 *   nep141:ltc.omft.near       →    LTC bech32      (ltc1…)
 *   nep141:doge.omft.near      →    DOGE legacy     (D…)
 *   nep141:bch.omft.near       →    BCH cashaddr    (bitcoincash:q…)
 *   nep141:eth.omft.near       →    EVM hex         (0x[40 hex])
 *   nep141:arb-*.omft.near     →    EVM hex         (Arbitrum)
 *   nep141:base-*.omft.near    →    EVM hex         (Base)
 *   nep141:bsc-*.omft.near     →    EVM hex         (BSC)
 *   nep141:pol.omft.near       →    EVM hex         (Polygon)
 *   nep141:sol.omft.near       →    SOL base58
 *   nep141:wrap.near           →    NEAR account    (*.near or 64-hex)
 *   nep141:usdt.tether-token.near, nep141:17208628…  →  NEAR account
 *                                   (the USDT/USDC legs, 2026-10-06)
 *   nep141:aptos-<hash>.omft.near →  Aptos account  (0x + 64 hex; the
 *                                   USDT/USDC legs only, 2026-10-06)
 *   nep141:xrp.omft.near       →    XRP classic     (r…)
 *   nep141:tron.omft.near      →    TRON base58     (T…)  — the TRX entry
 *   nep141:tron-<usdt>.omft.near →  TRON base58     (T…)  — the USDT-TRON entry
 *
 * Same mapping applies to `refundTo` based on `originAsset` when
 * `refundType: "ORIGIN_CHAIN"`.
 *
 * Per the May 2026 server-side diagnosis, the wallet was sending the
 * *origin chain's* address as the recipient when the destination
 * chain's wallet wasn't loaded. That produced 502s on the proxy because
 * 1Click could not parse a hex EVM address as a BTC recipient. This
 * resolver makes the per-chain lookup explicit and validates the
 * address format before the proxy call goes out.
 *
 * Round 1 scope per the brief: only BTC and EVM are wired. Other chains
 * throw `IntentsValidationError("not yet supported as NEAR Intents
 * endpoint")` so the user gets a clean message rather than a 5xx after
 * a wasted round trip.
 */

import bs58check from "bs58check";
// Re-exported by `xrpl` from `ripple-address-codec`, which is only a
// transitive dependency; `xrpl` is the direct one (`xrp-wallet.ts`).
import { isValidClassicAddress } from "xrpl";

import { ASSET_CAPABILITIES } from "./asset-capabilities";
import type { ChainType } from "../../wallets/types";

/** The minimal address bundle the resolver needs. The view layer fills
 *  it in from `walletsByChain` — fields are optional so the view can
 *  populate progressively. */
export interface WalletAddresses {
  /** Same EVM address used on Ethereum mainnet, Arbitrum, Base, BSC,
   *  Polygon, Monad, etc. — secp256k1 public key + Keccak-256 → checksummed
   *  0x-hex. */
  evm?: string;
  /** Bitcoin mainnet P2WPKH (bc1q…). Round 1 doesn't expose Taproot
   *  receive, but the resolver treats bc1p… as valid in case the wallet
   *  starts producing them later. */
  btc?: string;
  /** Litecoin mainnet P2WPKH (ltc1…). Filled by `ltcAdapter`. */
  ltc?: string;
  /** Dogecoin mainnet P2PKH (D…). */
  doge?: string;
  /** Bitcoin Cash mainnet cashaddr (`bitcoincash:q…`). */
  bch?: string;
  /** Dash mainnet P2PKH (X…). Filled by `dashAdapter` (Phase 5). */
  dash?: string;
  /** Solana mainnet base58. */
  sol?: string;
  /** NEAR mainnet — either a named account (`alice.near`) or the 64-char
   *  hex implicit account id. */
  near?: string;
  /** Stellar mainnet StrKey (G…). Filled by `stellarAdapter` (Phase 6). */
  stellar?: string;
  /** Sui mainnet 0x + 64 hex. Filled by `suiAdapter` (Phase 7). */
  sui?: string;
  /** Cardano mainnet CIP-19 base address (`addr1…`). Filled by
   *  `adaAdapter` using CIP-1852 derivation — payment cred at
   *  `m/1852'/1815'/0'/0/0` paired with stake cred at
   *  `m/1852'/1815'/0'/2/0`, encoded as a 103-char bech32 base
   *  address. Destination-only in v1.x (no Rust source signer). */
  cardano?: string;
  /** XRP Ledger classic address (`r…`). Filled by `xrpAdapter`. */
  xrp?: string;
  /** TRON base58check address (`T…`) that holds native TRX. Filled from
   *  the `tron` wallet entry, at whatever path the vault chose for TRON. */
  tron?: string;
  /** TRON address that holds USDT (TRC-20). A TRC-20 balance lives on its
   *  owner's TRON account, so this is normally the same string as `tron`,
   *  but it is read from the `usdt-tron` wallet entry: a swap must deliver
   *  USDT to exactly the address the dashboard shows USDT under. */
  usdtTron?: string;
  /** Aptos account (0x + 64 hex) that holds the USDT/USDC fungible-asset
   *  legs (2026-10-06). Read from those legs' wallet entries; native APT is
   *  not a NEAR Intents asset here. */
  aptos?: string;
}

/** Thrown by the resolver and the format validators. The confirm modal
 *  + form catch this specifically and render the message inline rather
 *  than spending a daily-cap point on a guaranteed-bad upstream call. */
export class IntentsValidationError extends Error {
  readonly name = "IntentsValidationError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, IntentsValidationError.prototype);
  }
}

/**
 * The NEP-141 and Aptos fungible-asset ids the wallet holds a leg for
 * (2026-10-06), from the registry rather than a second hand-kept list: a token
 * entry on the chain kind, with the contract `withStablecoinContracts` gave it.
 */
function tokenAssetIdsOn(kind: "NEAR" | "APTOS"): ReadonlySet<string> {
  return new Set(
    Object.values(ASSET_CAPABILITIES)
      .filter((c) => c.chainKind === kind && !!c.tokenContract && !!c.nearIntentsAsset)
      .map((c) => c.nearIntentsAsset as string),
  );
}
const NEAR_TOKEN_ASSET_IDS = tokenAssetIdsOn("NEAR");
const APTOS_TOKEN_ASSET_IDS = tokenAssetIdsOn("APTOS");

/**
 * HOT-Omni chain id → chain key for the `nep245:v2_1.omni.hot.tg:<id>_…`
 * namespace. Mirror of HOT_OMNI_CHAIN_TO_KEY in `near-intents-assets.generated.ts`
 * but locked to chains the resolver actually routes (the generated map
 * also lists nulls for out-of-scope chains; here we only enumerate the
 * routable subset).
 */
const HOT_OMNI_CHAIN_TO_WALLET_KEY: Record<string, keyof WalletAddresses> = {
  "10": "evm", // Optimism
  "56": "evm", // BSC
  "137": "evm", // Polygon
  "143": "evm", // Monad
  "1100": "stellar", // Stellar
  "43114": "evm", // Avalanche
  // 1117 (TON), 196 (X Layer), 9745 (Plasma), 534352 (Scroll), 36900 (Aditi)
  // are intentionally absent — they throw IntentsValidationError below.
};

/**
 * Resolve a 1Click asset id to the user's address on that chain. Throws
 * `IntentsValidationError` when:
 *   - the asset id is unrecognized,
 *   - we don't yet support the chain on the wallet side, or
 *   - the wallet hasn't derived an address for the matching chain yet.
 *
 * Dispatches across three asset-id namespaces: `nep141:` (the historical
 * OMFT bridge), `nep245:v2_1.omni.hot.tg:<chainId>_*` (HOT-Omni multi-token
 * envelope used by BSC, Polygon, Optimism, Avalanche, TON, Stellar, Monad,
 * X Layer, Plasma, Scroll, Aditi), and `1cs_v1:<chain>:<kind>:<addr>` (the
 * One-Click-Swap envelope used by BTC native, Solana SPL ZEC, Base CFI,
 * BSC nrUsdt, NEAR ZEC).
 */
export function addressForAssetId(
  assetId: string,
  wallet: WalletAddresses
): string {
  const id = assetId.trim();

  // ─── nep245 (HOT-Omni) namespace ──────────────────────────────────
  // Format: `nep245:v2_1.omni.hot.tg:<chainId>_<fingerprint>`. The
  // chainId tail tells us which user address to use — every HOT-Omni
  // chain in scope is either an EVM-family chain (uses `wallet.evm`) or
  // Stellar (uses `wallet.stellar`).
  const NEP245_PREFIX = "nep245:v2_1.omni.hot.tg:";
  if (id.startsWith(NEP245_PREFIX)) {
    const tail = id.slice(NEP245_PREFIX.length);
    const sep = tail.indexOf("_");
    const chainIdStr = sep >= 0 ? tail.slice(0, sep) : tail;
    const walletKey = HOT_OMNI_CHAIN_TO_WALLET_KEY[chainIdStr];
    if (!walletKey) {
      throw new IntentsValidationError(
        `HOT-Omni chain id ${chainIdStr} is not yet supported in PwndaWallet.`
      );
    }
    if (walletKey === "evm") {
      if (!wallet.evm) {
        throw new IntentsValidationError(
          `No derived EVM address — make sure your Ethereum wallet has been derived in this session.`
        );
      }
      assertValidEvmAddress(wallet.evm);
      return wallet.evm;
    }
    if (walletKey === "stellar") {
      if (!wallet.stellar) {
        throw new IntentsValidationError(
          `No derived Stellar address — open the Stellar chain in the dashboard so the wallet derives one, then retry.`
        );
      }
      assertValidStellarAddress(wallet.stellar);
      return wallet.stellar;
    }
    // Defensive: every entry in HOT_OMNI_CHAIN_TO_WALLET_KEY is one of
    // the two branches above. If a future entry routes elsewhere, add
    // a branch here.
    throw new IntentsValidationError(
      `HOT-Omni dispatch incomplete for wallet key ${walletKey}.`
    );
  }

  // ─── 1cs_v1 (One-Click-Swap envelope) namespace ───────────────────
  // Format: `1cs_v1:<chain>:<kind>:<addr>`. Today's covered chains
  // are btc/sol/base/bsc/near. Pwnda routes by the leading `<chain>` field.
  if (id.startsWith("1cs_v1:")) {
    const body = id.slice("1cs_v1:".length);
    const [chain] = body.split(":", 1);
    if (chain === "btc") {
      if (!wallet.btc) {
        throw new IntentsValidationError(
          `No derived BTC address — open the Bitcoin chain in the dashboard so the wallet derives one, then retry.`
        );
      }
      assertValidBtcAddress(wallet.btc);
      return wallet.btc;
    }
    if (chain === "sol") {
      if (!wallet.sol) {
        throw new IntentsValidationError(
          `No derived Solana address — open the Solana chain in the dashboard so the wallet derives one, then retry.`
        );
      }
      assertValidSolAddress(wallet.sol);
      return wallet.sol;
    }
    if (chain === "base" || chain === "bsc" || chain === "eth") {
      if (!wallet.evm) {
        throw new IntentsValidationError(
          `No derived EVM address — make sure your Ethereum wallet has been derived in this session.`
        );
      }
      assertValidEvmAddress(wallet.evm);
      return wallet.evm;
    }
    if (chain === "near") {
      if (!wallet.near) {
        throw new IntentsValidationError(
          `No derived NEAR address — make sure your NEAR account has been derived (Settings → swap unlock).`
        );
      }
      assertValidNearAddress(wallet.near);
      return wallet.near;
    }
    throw new IntentsValidationError(
      `1cs_v1 chain "${chain}" is not yet supported in PwndaWallet.`
    );
  }

  // ─── nep141 namespace ─────────────────────────────────────────────
  if (!id.startsWith("nep141:")) {
    throw new IntentsValidationError(
      `Asset id "${assetId}" is not in any recognized NEAR Intents namespace (nep141 / nep245 / 1cs_v1).`
    );
  }
  const body = id.slice("nep141:".length);

  // EVM family — the Omni Bridge chain prefix determines which chain,
  // but the address format is the same 0x-hex EVM address regardless.
  // Native-EVM canonical ids: eth.omft.near, pol.omft.near, op.omft.near,
  // bnb.omft.near, avax.omft.near, base.omft.near, arb.omft.near.
  // Bridged-token ids carry a `<chain>-<contract>` prefix.
  if (
    body === "eth.omft.near" ||
    body === "pol.omft.near" ||
    body === "op.omft.near" ||
    body === "bnb.omft.near" ||
    body === "avax.omft.near" ||
    body === "base.omft.near" ||
    body === "arb.omft.near" ||
    body.startsWith("arb-") ||
    body.startsWith("base-") ||
    body.startsWith("bsc-") ||
    body.startsWith("bnb-") ||
    body.startsWith("op-") ||
    body.startsWith("avax-") ||
    body.startsWith("eth-") ||
    body.startsWith("pol-")
  ) {
    if (!wallet.evm) {
      throw new IntentsValidationError(
        `No derived EVM address — make sure your Ethereum wallet has been derived in this session.`
      );
    }
    assertValidEvmAddress(wallet.evm);
    return wallet.evm;
  }

  if (body === "btc.omft.near") {
    if (!wallet.btc) {
      throw new IntentsValidationError(
        `No derived BTC address — open the Bitcoin chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    assertValidBtcAddress(wallet.btc);
    return wallet.btc;
  }

  // Solana — both native (sol.omft.near) and SPL tokens (sol-…).
  if (body === "sol.omft.near" || body.startsWith("sol-")) {
    if (!wallet.sol) {
      throw new IntentsValidationError(
        `No derived Solana address — open the Solana chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    assertValidSolAddress(wallet.sol);
    return wallet.sol;
  }

  // NEAR mainnet native — `wrap.near` — and, since 2026-10-06, the NEP-141
  // tokens the wallet has a leg for (USDT `usdt.tether-token.near`, USDC
  // `17208628…6133a1`): each is held BY the NEAR account, so it is delivered
  // to it. Matched against the registry's own ids, like the TRON tokens
  // below: any other NEP-141 token would land on an account where no balance
  // row ever shows it.
  if (body === "wrap.near" || NEAR_TOKEN_ASSET_IDS.has(id)) {
    if (!wallet.near) {
      throw new IntentsValidationError(
        `No derived NEAR address — make sure your NEAR account has been derived (Settings → swap unlock).`
      );
    }
    assertValidNearAddress(wallet.near);
    return wallet.near;
  }

  // Aptos fungible assets (2026-10-06): `nep141:aptos-<hash>.omft.near`.
  // Only the USDT and USDC legs resolve, for the reason the NEAR tokens
  // above give.
  if (body.startsWith("aptos-") || body === "aptos.omft.near") {
    if (!APTOS_TOKEN_ASSET_IDS.has(id)) {
      throw new IntentsValidationError(
        `"${assetId}" is an Aptos asset PwndaWallet has no wallet entry for — only USDT and USDC on Aptos are supported.`
      );
    }
    if (!wallet.aptos) {
      throw new IntentsValidationError(
        `No derived Aptos address — open the Aptos chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    assertValidAptosAddress(wallet.aptos);
    return wallet.aptos;
  }

  // Other native chains — destination-only in v1.x. The wallet doesn't
  // have signers for these, but it CAN receive (the Intents solver
  // delivers the swap output directly to the user's address on that
  // chain). Source-chain validation is handled separately by
  // `isSourceCapableAsset` in `intents-dedup.ts`.
  if (body === "doge.omft.near") {
    if (!wallet.doge) {
      throw new IntentsValidationError(
        `No derived DOGE address — open the Dogecoin chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    return wallet.doge;
  }
  if (body === "ltc.omft.near") {
    if (!wallet.ltc) {
      throw new IntentsValidationError(
        `No derived LTC address — open the Litecoin chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    return wallet.ltc;
  }
  if (body === "bch.omft.near") {
    if (!wallet.bch) {
      throw new IntentsValidationError(
        `No derived BCH address — open the Bitcoin Cash chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    return wallet.bch;
  }
  // Dash native (Phase 5).
  if (body === "dash.omft.near") {
    if (!wallet.dash) {
      throw new IntentsValidationError(
        `No derived DASH address — open the Dash chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    return wallet.dash;
  }
  // Sui native + Sui-USDC (Phase 7).
  if (body === "sui.omft.near" || body.startsWith("sui-")) {
    if (!wallet.sui) {
      throw new IntentsValidationError(
        `No derived SUI address — open the Sui chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    return wallet.sui;
  }
  // XRP, TRX and USDT on TRON (2026-09-29). Until this date these three
  // branches threw unconditionally ("…supported but the wallet has no
  // derived … address yet"), whatever the wallet held: there was no bundle
  // field to read. The main quote path hid it by falling back to the view's
  // own per-ticker address; every caller without that fallback — the MIN
  // probe, the pair-change minimum probe, the Earn/convert estimates —
  // failed on all three. See log.md 2026-09-29.
  if (body === "xrp.omft.near") {
    if (!wallet.xrp) {
      throw new IntentsValidationError(
        `No derived XRP address — open the XRP chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    assertValidXrpAddress(wallet.xrp);
    return wallet.xrp;
  }
  if (body === "tron.omft.near") {
    if (!wallet.tron) {
      throw new IntentsValidationError(
        `No derived TRON address — open the TRON chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    assertValidTronAddress(wallet.tron);
    return wallet.tron;
  }
  if (body.startsWith("tron-")) {
    // TRC-20 tokens. Only USDT has a wallet entry, so only USDT resolves:
    // delivering any other token to the TRON account would land it where no
    // balance row ever shows it.
    const usdtTron = ASSET_CAPABILITIES["USDT-TRON"]?.nearIntentsAsset;
    if (id !== usdtTron) {
      throw new IntentsValidationError(
        `"${assetId}" is a TRON token PwndaWallet has no wallet entry for — only USDT on TRON is supported.`
      );
    }
    if (!wallet.usdtTron) {
      throw new IntentsValidationError(
        `No derived USDT (TRON) address — open the TRON chain in the dashboard so the wallet derives one, then retry.`
      );
    }
    assertValidTronAddress(wallet.usdtTron);
    return wallet.usdtTron;
  }
  if (body === "ton.omft.near") {
    throw new IntentsValidationError(
      "TON destination is supported but TON address derivation is out of scope for v1.x."
    );
  }
  // Cardano native ADA — destination-only. Pwnda has the CIP-1852
  // wallet adapter; this branch returns the user's `addr1…` base
  // address so 1Click delivers swap output to the dashboard's Cardano
  // panel. The CIP-1852 derivation choice is the post-2026-05-06
  // standard (NOT the Exodus same-key fork) per
  // [[derivation-path-strategy]].
  if (body === "cardano.omft.near") {
    if (!wallet.cardano) {
      throw new IntentsValidationError(
        `No derived ADA address — open the Cardano chain in the dashboard so the wallet derives one (CIP-1852 path), then retry.`
      );
    }
    assertValidCardanoAddress(wallet.cardano);
    return wallet.cardano;
  }

  throw new IntentsValidationError(
    `Unrecognized NEAR Intents asset id "${assetId}".`
  );
}

/* ─── format validators ───────────────────────────────────────── */

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Bech32 / bech32m: bc1 (mainnet BTC) — minimum 14 chars total. P2WPKH
// is 42 chars, P2WSH is 62, P2TR is 62. Test against any known length.
const BTC_BECH32_MAINNET = /^bc1[a-z0-9]{25,87}$/;

export function assertValidEvmAddress(addr: string): void {
  if (!EVM_ADDRESS.test(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid EVM address (expected 0x + 40 hex chars).`
    );
  }
}

export function assertValidBtcAddress(addr: string): void {
  // Mainnet bech32 only — the wallet derives `bc1q…` P2WPKH at
  // m/84'/0'/0'/0/0 (BIP-84 spec). If we ever add legacy `1…` / P2SH
  // `3…` outputs, extend this.
  if (!BTC_BECH32_MAINNET.test(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid BTC mainnet bech32 address (expected bc1…).`
    );
  }
}

// Solana base58 public keys are 32–44 chars; the alphabet excludes 0 / O / I / l.
const SOL_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function assertValidSolAddress(addr: string): void {
  if (!SOL_BASE58.test(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid Solana mainnet base58 address.`
    );
  }
}

// NEAR: either a 64-char hex implicit account id (lowercase) or a named
// account ending in `.near` / `.testnet`. Implicit accounts are the
// raw ed25519 public-key hex; named accounts are dot-separated lowercase
// alphanumeric.
const NEAR_IMPLICIT = /^[0-9a-f]{64}$/;
const NEAR_NAMED = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9_-]*[a-z0-9])?)*$/;

export function assertValidNearAddress(addr: string): void {
  if (!NEAR_IMPLICIT.test(addr) && !NEAR_NAMED.test(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid NEAR account id (expected 64-hex implicit or named account like alice.near).`
    );
  }
}

// Stellar StrKey: starts with `G` (account public key prefix), followed by
// 55 base32 chars. Total 56 chars. The base32 alphabet excludes 0/1/8.
const STELLAR_STRKEY = /^G[A-Z2-7]{55}$/;

export function assertValidStellarAddress(addr: string): void {
  if (!STELLAR_STRKEY.test(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid Stellar account StrKey (expected G + 55 base32 chars).`
    );
  }
}

// Aptos account address (2026-10-06): 0x + 64 lowercase hex chars, the padded
// form the wallet derives (`apt-wallet.ts`). Never a short form: padding one
// out names a different account.
const APTOS_ADDRESS = /^0x[0-9a-f]{64}$/;

export function assertValidAptosAddress(addr: string): void {
  if (!APTOS_ADDRESS.test(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid Aptos address (expected 0x + 64 lowercase hex chars).`
    );
  }
}

// Sui address: 0x + 64 lowercase hex chars (32 bytes).
const SUI_ADDRESS = /^0x[0-9a-f]{64}$/;

export function assertValidSuiAddress(addr: string): void {
  if (!SUI_ADDRESS.test(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid Sui address (expected 0x + 64 hex chars).`
    );
  }
}

// TRON: base58check of 0x41 ‖ 20-byte account id. Always 34 characters and
// always a leading "T". Unlike the shape-only checks above, this one verifies
// the checksum and the version byte as well: it is two lines with `bs58check`
// (already the codec `trx-wallet.ts` encodes with), and a well-shaped string
// with a bad checksum is exactly what cost DASH its minimum hint on
// 2026-09-09.
const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function assertValidTronAddress(addr: string): void {
  let ok = TRON_BASE58.test(addr);
  if (ok) {
    try {
      const raw = bs58check.decode(addr);
      ok = raw.length === 21 && raw[0] === 0x41;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid TRON mainnet address (expected T… base58check, 34 chars).`
    );
  }
}

// XRP classic address: "r" + 24–34 characters of the XRPL base58 alphabet
// (Bitcoin's character set in a different order). `isValidClassicAddress`
// also verifies the checksum. X-addresses (`X…`) are not accepted: the wallet never
// produces one, and one would smuggle a destination tag into the recipient.
export function assertValidXrpAddress(addr: string): void {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr) || !isValidClassicAddress(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid XRP Ledger classic address (expected r…).`
    );
  }
}

// Cardano mainnet CIP-19 base address: bech32-encoded, HRP `addr`,
// starts with `addr1` (mainnet). A standard CIP-1852 base address
// (payment + stake credentials) is 103 chars total = "addr1" + 98
// bech32 data chars. Enterprise addresses are shorter (~58 chars).
// Accept any `addr1`-prefixed bech32 string of plausible length so we
// don't reject a valid variant the wallet ever produces. We do NOT
// validate the bech32 checksum here — that's the wallet adapter's
// job at derivation time; we just guard against obvious garbage
// before the proxy round-trip.
const CARDANO_BASE = /^addr1[02-9ac-hj-np-z]{45,108}$/;

export function assertValidCardanoAddress(addr: string): void {
  if (!CARDANO_BASE.test(addr)) {
    throw new IntentsValidationError(
      `"${addr}" is not a valid Cardano mainnet address (expected bech32 addr1…). ` +
        `Make sure your Cardano wallet is on the CIP-1852 derivation path — the post-2026-05-06 fix put this on by default.`
    );
  }
}

/**
 * Translate a `WalletsByChain` key (the ChainType under which the wallet
 * store keys the address — e.g. `"ethereum"`, `"bitcoin-cash"`) to the
 * crypto-family bundle field name the resolver expects (e.g. `"evm"`,
 * `"bch"`). The two namespaces don't map 1:1 because the wallet store
 * keys per-chain while the resolver thinks per-crypto-family:
 *
 *   - All six EVM-family registry entries (ETH, AVAX, POL, FLR, MON, BNB)
 *     share `walletsByChainKey: "ethereum"` because the BIP-44 EVM key
 *     derives the same address on every EVM chain. They all map to
 *     `bundle.evm`.
 *   - Wallet-store keys with no Intents-resolver presence (`monero`,
 *     `zephyr`, and the EVM L2 / token entries that ride `ethereum`'s
 *     key) map to `null` and are skipped during bundle population.
 *
 * Pre-2026-05-26 this lookup was implicit in a hand-maintained switch
 * statement inside `deriveWalletAddresses`. Pulling it out into an
 * explicit map means adding a new asset to `ASSET_CAPABILITIES` with
 * an already-known `walletsByChainKey` automatically populates the
 * right bundle field — no second-source-of-truth to forget to update.
 * Only when a brand-new wallet-store chain lands (the kind that
 * unblocks a NEW crypto family in the resolver) does this map need a
 * row added. See `wiki/concepts/adding-a-new-asset.md`.
 */
const WALLETS_BY_CHAIN_KEY_TO_BUNDLE_FIELD: Partial<
  Record<ChainType, keyof WalletAddresses | null>
> = {
  ethereum: "evm",
  bitcoin: "btc",
  litecoin: "ltc",
  dogecoin: "doge",
  "bitcoin-cash": "bch",
  dash: "dash",
  solana: "sol",
  near: "near",
  stellar: "stellar",
  sui: "sui",
  cardano: "cardano",
  xrp: "xrp",
  tron: "tron",
  // Its own field, not `tron`: TRX and USDT-TRON are separate wallet
  // entries, and each asset is delivered where the dashboard shows it.
  "usdt-tron": "usdtTron",
  // The NEP-141 legs are held by the NEAR account itself (one derivation,
  // no alternative paths), so they share `near` (2026-10-06).
  "usdt-near": "near",
  "usdc-near": "near",
  // The Aptos legs' account. Native APT has no registry entry, so these two
  // are the only keys that fill `aptos`.
  "usdt-aptos": "aptos",
  "usdc-aptos": "aptos",
  // Intentional `null`s — wallet chains the NEAR Intents resolver
  // never targets. Listed explicitly so a future reader sees the
  // omissions are deliberate, not a missing-row oversight.
  monero: null,
  zephyr: null,
  // EVM L2 / per-chain balance-pipeline entries that share the
  // `"ethereum"` address key — left out entirely because they're
  // never the `walletsByChainKey` for any registry entry (every EVM
  // asset uses `"ethereum"`). Listing them as `null` would be noise.
};

/**
 * Build the `WalletAddresses` bundle from the App's `walletsByChain`
 * map. Iterates `ASSET_CAPABILITIES` so a registry entry with a
 * `walletsByChainKey` automatically populates the matching bundle
 * field — see the docstring on `WALLETS_BY_CHAIN_KEY_TO_BUNDLE_FIELD`
 * above for the wallet-key → bundle-field mapping rationale.
 *
 * Pre-2026-05-26 this function was a hand-maintained per-asset switch.
 * It missed the NEAR adapter shipped the same morning and was
 * actively serving `near: undefined` with a "no first-party NEAR
 * adapter in v1" comment. Same drift class as the CARDANO blocker
 * that motivated the asset-capabilities registry refactor. The
 * registry-derived version below can't drift — adding a new asset is
 * one ASSET_CAPABILITIES entry, no second edit here.
 */
export function deriveWalletAddresses(
  walletsByChain: Partial<Record<string, { address: string }>>
): WalletAddresses {
  const bundle: WalletAddresses = {};
  // Track which wallet keys we've already populated so multiple registry
  // entries sharing one key (e.g. ETH + AVAX + POL all → "ethereum")
  // don't repeat the address read.
  const seen = new Set<ChainType>();
  for (const cap of Object.values(ASSET_CAPABILITIES)) {
    const key = cap.walletsByChainKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const bundleField = WALLETS_BY_CHAIN_KEY_TO_BUNDLE_FIELD[key];
    if (!bundleField) continue;
    // Several keys can fill one field since 2026-10-06 (`near` and the NEP-141
    // legs; the two Aptos legs). They hold the same address; a key whose
    // wallet is missing must not blank a field another key already filled.
    const address = walletsByChain[key]?.address;
    if (address !== undefined || !(bundleField in bundle)) bundle[bundleField] = address;
  }
  return bundle;
}
