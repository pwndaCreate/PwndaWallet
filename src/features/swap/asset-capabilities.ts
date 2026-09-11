/**
 * Single source of truth for per-asset capabilities.
 *
 * Background — the three-bugs-in-a-day pattern that motivated this.
 *
 *   2026-05-25 #1: SwapKit form silently fell to a "Pwnda Atomic"
 *   placeholder for any pair where `swapKitAsset === null` on either
 *   side, even when the same pair was perfectly routable via NEAR
 *   Intents. Cause: `isSwapKitRoutable` lived in `swap-data.ts`,
 *   `atomicPreviewFallback` lived in `SwapForm.tsx`, the two were
 *   wired manually, and the form's predicate only consulted SwapKit.
 *
 *   2026-05-25 #2: After fixing #1, the form still showed "Quote
 *   unavailable" for NEAR-only quotes because `SwapView.confirmReady`
 *   ALSO only consulted `isSwapKitRoutable`. Two parallel predicates
 *   with the same bug.
 *
 *   2026-05-25 #3: After fixing #2, the form STILL showed "Quote
 *   unavailable" because `addressFor(toCoin, walletsByChain)` had a
 *   chainKind switch with no `case "CARDANO":` — fell through to
 *   `default → null`. Same `addressFor` switch existed in
 *   `SwapView.tsx:537` AND `SwapLandscapeView.tsx:799` as parallel
 *   implementations; both needed the same fix.
 *
 * Root cause shared by all three: per-asset capabilities (routability,
 * wallet-key, signer-availability) were scattered across `swap-data.ts`,
 * `SwapView.tsx`, `SwapLandscapeView.tsx`, `useSwapQuote.ts`, and the
 * Rust signer modules with no single source of truth. Adding a new
 * asset required updating 8+ files; missing one created a silent gap.
 *
 * This registry collapses every per-asset capability into one entry
 * per asset. Every consuming layer reads from `ASSET_CAPABILITIES`
 * (or one of the helpers exported below). Compile-time
 * `keyof WalletsByChain` on `walletsByChainKey` catches drift when
 * `ChainType` changes shape.
 *
 * Adding a new asset is one entry here plus (optionally) a row in
 * `WalletsByChain` if the chain doesn't already have a wallet adapter,
 * plus a Rust signer module if you want to set `signerInRustCore: true`.
 * The invariant tests in `asset-capabilities.test.ts` will catch any
 * combination that doesn't hang together (e.g. a `swapKitAsset` set
 * without a corresponding signer when `signerInRustCore: true`).
 *
 * See `PwndaWalletVault/wiki/concepts/adding-a-new-asset.md` for the
 * end-to-end add-an-asset runbook.
 */

import type { ChainType, WalletInfo } from "../../wallets/types";

/**
 * The wallet-store shape every consumer threads around: one
 * `WalletInfo` per `ChainType`, populated lazily as the user imports
 * or derives. Named here so `keyof WalletsByChain` is the registry's
 * compile-time constraint for `walletsByChainKey`.
 */
export type WalletsByChain = Partial<Record<ChainType, WalletInfo>>;

/**
 * Where the swap orchestration sends a coin's signed tx for broadcast.
 * Mirrored verbatim from `swap-data.ts::SwapChainKind` — duplicated
 * here only so this module doesn't have to import `swap-data.ts` and
 * create an import cycle. `swap-data.ts` re-exports its own
 * `SwapChainKind` alias against this same shape.
 */
export type SwapChainKind =
  | "EVM"
  | "BTC"
  | "LTC"
  | "DOGE"
  | "BCH"
  | "DASH"
  | "SOLANA"
  | "NEAR"
  | "STELLAR"
  | "SUI"
  | "XMR"
  | "ZEPH"
  | "ZANO"
  | "CARDANO"
  | "XRP"
  | "TRON";

/**
 * Per-asset capability record. Subsumes the legacy `SwapCoinMeta`
 * shape (display, RPC, explorer URLs, etc.) plus the new capability
 * fields the registry refactor introduced (`walletsByChainKey`,
 * `signerInRustCore`, `rpcsAvailable`, `network`).
 *
 * The full set is held here so `SWAP_COIN_META` in `swap-data.ts`
 * can be a derived view, not parallel data.
 */
export interface AssetCapability {
  /** Ticker symbol as displayed (uppercase). Stable identifier. */
  ticker: string;
  /** Human-readable network name shown in dropdowns and labels
   *  (e.g. "Ethereum", "Avalanche C-Chain", "Cardano"). */
  network: string;
  /** Cryptographic chain family. Drives dispatch in
   *  `executeIntentsTrade` and `broadcastChainKind`. */
  chainKind: SwapChainKind;
  /** EVM chain id when `chainKind === "EVM"`. */
  chainId?: number;
  /** Atomic-unit decimals (e.g. 18 for ETH, 8 for BTC, 6 for ADA). */
  decimals: number;

  /**
   * Which `WalletsByChain` key holds the wallet address for this
   * asset. All EVM-family assets resolve to `"ethereum"` — the
   * BIP-44 EVM key derives the same address on every EVM chain, so
   * the wallet store keys the address once under `"ethereum"`.
   *
   * Omit when no first-party wallet adapter exists (e.g. NEAR in
   * v1.x — address is derived on-demand via `getNearAddress` from
   * the Rust session). The address resolver will return `null` for
   * such assets, gating them out of the form's confirm-ready path.
   *
   * Compile-time `keyof WalletsByChain` (= `ChainType`) — adding a
   * new asset whose wallet lives at a key not in `ChainType` is a
   * type error here, not a runtime null at the user's broadcast.
   */
  walletsByChainKey?: keyof WalletsByChain;

  /**
   * True when the Rust core can sign a source-chain tx for this
   * asset. Maps to the legacy `sourceCapable` flag. Drives the
   * source-side filter on `getDropdownTickers({ sourceOnly: true })`.
   */
  signerInRustCore: boolean;

  /**
   * Set when the SOURCE-chain deposit tx is built, signed, and submitted
   * in the TypeScript layer rather than the Rust core. An asset is
   * source-capable when EITHER `signerInRustCore` is true OR this is set —
   * see `isSourceCapable` / `capabilityToLegacyMeta` in `swap-data.ts`.
   * `signerInRustCore` stays the honest "is there a Rust signer" flag
   * (false for all three below) so the `signerInRustCore → rpcsAvailable`
   * invariant test doesn't trip.
   *
   * The three, and why each signs in TypeScript:
   *
   *  - `cardano` — BIP-32-Ed25519 (Icarus) + CBOR in `cardano-tx.ts` /
   *    `cardano-cip1852.ts`, broadcast via Koios. No `swap_sign_cardano`.
   *  - `xrp` — the `xrpl` library owns both signing and submission inside
   *    `xrp-wallet.ts`; there is no separate unsigned-tx step a Rust signer
   *    could slot into.
   *  - `tron` — secp256k1 over the node-assigned `txID`, in `trx-wallet.ts`
   *    (native TRX) and `trc20-wallet.ts` (TRC-20 `transfer`). Tron builds
   *    the transaction node-side, so the signer only ever sees a hash.
   *
   * Each names the SIGNER, not the chain: `TRX` and `USDT-TRON` are both
   * `chainKind: "TRON"` and share `tsSourceSigner: "tron"`, but they are
   * different assets with different transaction shapes (a native transfer
   * versus a contract call). The executor tells them apart by
   * `walletsByChainKey`, which resolves each to its own adapter.
   */
  tsSourceSigner?: "cardano" | "xrp" | "tron";

  /**
   * True when `defaultRpcUrl` is set OR `rpcFallbacks` is non-empty.
   * Derived field — the invariant test enforces it agrees with the
   * underlying RPC fields. Surfaces as a single-check predicate for
   * UI guards that need to know whether a broadcast is reachable.
   */
  rpcsAvailable: boolean;

  /** SwapKit asset notation (`CHAIN.SYMBOL`). Null when the asset
   *  can't be routed via SwapKit (XMR, ZEPH ecosystem, ADA where
   *  SwapKit defers to NEAR Intents under the hood). */
  swapKitAsset: string | null;
  /** NEAR Intents 1Click asset id (`nep141:...` / `nep245:...`).
   *  Null when not bridged via Intents in v1.x. */
  nearIntentsAsset: string | null;

  /**
   * Set when the asset is tradable on the `pwnda-desk` atomic-swap desk —
   * the THIRD routability axis, independent of `swapKitAsset` /
   * `nearIntentsAsset` (an asset can be desk-routable while being null on
   * both aggregators; XMR and ZEPH are exactly that case).
   *
   * The desk is a bilateral principal dealer running a leader/follower
   * atomic swap: one side is the "leader" chain (a scriptable/contract or
   * timelock-capable chain — LTC, ADA, AVAX) and the other is the
   * "follower" (the privacy coin whose lock is a joint 2-of-2 key — XMR,
   * ZEPH). A pair is desk-routable only when it has EXACTLY one of each
   * (see `isDeskRoutableFromRegistry`) — leader↔leader and
   * follower↔follower are not swaps the desk makes.
   *
   * Only the NATIVE Zephyr coin (ZEPH) is desk-tradable; the ZEPHUSD /
   * ZEPHRSV / ZEPHYRS ecosystem assets stay off the desk.
   */
  atomicDesk?: {
    role: "leader" | "follower";
    /**
     * Which client-side swap engine implements this leg, or `null` when the
     * client has no engine for it yet.
     *
     * This is deliberately separate from `role`. The DESK may offer a pair
     * (its `/pairs` roster lists all three leaders); whether the CLIENT can
     * execute it depends on whether the engine that does that leg's crypto is
     * vendored here. `null` therefore means "the desk may quote this, we
     * cannot settle it" — and a pair is only routable when BOTH legs name the
     * SAME engine, because a swap's two legs are two halves of one protocol,
     * not two independent operations.
     *
     * As of 2026-07-19 only `ada-xmr` is vendored (`src-tauri/engine/`), which
     * is why LTC and AVAX are `null`: LTC is BasicSwap's secp256k1<->ed25519
     * DLEq and AVAX is an EVM escrow pending a contract audit. Both are
     * genuinely different cryptography, not the same engine with another coin
     * plugged in, so neither can be enabled by flipping a flag here — each
     * needs its own vendored engine first.
     */
    engine: "ada-xmr" | null;
  };

  // ─── Display / UX fields (carried over from legacy SwapCoinMeta) ───

  /** Default chain RPC URL used by `swap_broadcast`. */
  defaultRpcUrl?: string;
  /** Full RPC fallback list (env-overridable per chain via
   *  `VITE_<CHAIN>_RPC_URL` — see `wallets/chain-rpcs.ts`). */
  rpcFallbacks?: string[];
  /** Explorer URL for a transaction hash. */
  explorerTxUrl: (hash: string) => string;
  /** Explorer URL for an address. */
  explorerAddressUrl: (addr: string) => string;
  /** ERC-20 / SPL token contract when this is a token, not native gas.
   *  When set, the EVM source-tx flow builds a `transfer(...)` calldata
   *  instead of a native-value transfer. */
  tokenContract?: string;
  /** Optional source-prerequisite hint shown when this chain is the
   *  source (e.g. NEAR's "needs ≥0.1 NEAR for fees"). */
  sourcePrerequisiteHint?: string;
  /** Optional short coverage note shown under the destination dropdown
   *  when route availability is partial or single-route. */
  coverageNote?: string;
}

// ─── Helper builders ──────────────────────────────────────────────────
//
// Imports for the RPC helper functions live at the bottom of the file
// so the AssetCapability interface above is readable without scrolling
// past 100 lines of import bookkeeping. Order matters only inasmuch as
// `ASSET_CAPABILITIES` below references these helpers.

import {
  ARB_RPCS,
  AVAX_RPCS,
  BASE_RPCS,
  BSC_RPCS,
  ETH_RPCS,
  FLR_RPCS,
  OP_RPCS,
  POL_RPCS,
} from "../../wallets/chain-rpcs";

function rpcEnv(name: string, fallback: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const v = env?.[name];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

// ─── The registry ─────────────────────────────────────────────────────
//
// One entry per asset. Migrated 1:1 from the legacy `SWAP_COIN_META`
// in `swap-data.ts` (pre-2026-05-25 scattered-capability era) plus
// the four new capability fields: `network`, `walletsByChainKey`,
// `signerInRustCore`, `rpcsAvailable`.
//
// Ordering is the legacy order from `SWAP_COIN_META` so a side-by-side
// diff with `git log -p src/features/swap/swap-data.ts` stays readable.

export const ASSET_CAPABILITIES: Record<string, AssetCapability> = {
  // ─── EVM chains (Rust EVM signer ready in v1) ────────────────────
  ETH: {
    ticker: "ETH",
    network: "Ethereum",
    chainKind: "EVM",
    chainId: 1,
    decimals: 18,
    walletsByChainKey: "ethereum",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "ETH.ETH",
    nearIntentsAsset: "nep141:eth.omft.near",
    defaultRpcUrl: ETH_RPCS()[0],
    rpcFallbacks: ETH_RPCS(),
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://etherscan.io/address/${a}`,
  },
  AVAX: {
    ticker: "AVAX",
    network: "Avalanche C-Chain",
    chainKind: "EVM",
    chainId: 43114,
    decimals: 18,
    // All EVM assets resolve to the shared `ethereum` wallet — the
    // BIP-44 EVM key is chain-agnostic. Same applies to POL, FLR,
    // MON, BNB, and every future EVM addition.
    walletsByChainKey: "ethereum",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "AVAX.AVAX",
    // 2026-05-08: native AVAX is on NEAR Intents under the HOT-Omni
    // nep245 envelope (was 400'd via the older `nep141:avax.omft.near`
    // OMFT route).
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:43114_11111111111111111111",
    // EVM SwapCreator leg on the desk. Gated on the contract audit before
    // it goes live with real funds (the desk keeps this leader disabled), and
    // the `evm-avax` engine is not vendored client-side either.
    atomicDesk: { role: "leader", engine: null },
    defaultRpcUrl: AVAX_RPCS()[0],
    rpcFallbacks: AVAX_RPCS(),
    explorerTxUrl: (h) => `https://snowtrace.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://snowtrace.io/address/${a}`,
  },
  POL: {
    ticker: "POL",
    network: "Polygon",
    chainKind: "EVM",
    chainId: 137,
    decimals: 18,
    walletsByChainKey: "ethereum",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "POL.POL",
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:137_11111111111111111111",
    defaultRpcUrl: POL_RPCS()[0],
    rpcFallbacks: POL_RPCS(),
    explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://polygonscan.com/address/${a}`,
  },
  FLR: {
    ticker: "FLR",
    network: "Flare",
    chainKind: "EVM",
    chainId: 14,
    decimals: 18,
    walletsByChainKey: "ethereum",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "FLR.FLR",
    nearIntentsAsset: null, // not bridged via OMFT
    defaultRpcUrl: FLR_RPCS()[0],
    rpcFallbacks: FLR_RPCS(),
    explorerTxUrl: (h) => `https://flare-explorer.flare.network/tx/${h}`,
    explorerAddressUrl: (a) =>
      `https://flare-explorer.flare.network/address/${a}`,
  },
  // ─── PSBT / UTXO chains ──────────────────────────────────────────
  BTC: {
    ticker: "BTC",
    network: "Bitcoin",
    chainKind: "BTC",
    decimals: 8,
    walletsByChainKey: "bitcoin",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "BTC.BTC",
    nearIntentsAsset: "nep141:btc.omft.near",
    defaultRpcUrl: rpcEnv("VITE_BTC_RPC", "https://blockstream.info/api"),
    explorerTxUrl: (h) => `https://blockstream.info/tx/${h}`,
    explorerAddressUrl: (a) => `https://blockstream.info/address/${a}`,
  },
  LTC: {
    ticker: "LTC",
    network: "Litecoin",
    chainKind: "LTC",
    decimals: 8,
    walletsByChainKey: "litecoin",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "LTC.LTC",
    // Was `null` with "not in OMFT canonical list as of 2026-05" — true
    // when written, stale by 2026-08. Upstream now routes it: the live
    // /api/intents/tokens feed carries `nep141:ltc.omft.near` (blockchain
    // "ltc", 8 decimals), the generated catalog already shipped it, and
    // `SOURCE_CAPABLE_BLOCKCHAINS` already listed "ltc" — this flag was
    // the ONLY thing gating the route, and the only capability entry in
    // the whole registry that disagreed with the shipped catalog.
    // `intentsCapabilityMatchesCatalog` now fails if that recurs.
    nearIntentsAsset: "nep141:ltc.omft.near",
    // secp256k1 + DLEq leg on the desk (BasicSwap engine). Cross-group DLEq
    // is different crypto from the ADA leg and `basicswap-ltc` is not vendored
    // client-side, so the client cannot settle it.
    atomicDesk: { role: "leader", engine: null },
    defaultRpcUrl: rpcEnv("VITE_LTC_RPC", "https://litecoinspace.org/api"),
    explorerTxUrl: (h) => `https://litecoinspace.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://litecoinspace.org/address/${a}`,
  },
  DOGE: {
    ticker: "DOGE",
    network: "Dogecoin",
    chainKind: "DOGE",
    decimals: 8,
    walletsByChainKey: "dogecoin",
    // Promoted source-capable 2026-05-08: Rust `swap_sign_psbt` now
    // handles UtxoChain::Doge (legacy P2PKH BIP-44 with SIGHASH_ALL).
    // See `wiki/synthesis/bch-doge-source-integration-plan.md` Phase 1.
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "DOGE.DOGE",
    nearIntentsAsset: "nep141:doge.omft.near",
    defaultRpcUrl: rpcEnv("VITE_DOGE_RPC", "https://dogechain.info/api"),
    explorerTxUrl: (h) => `https://blockchair.com/dogecoin/transaction/${h}`,
    explorerAddressUrl: (a) => `https://blockchair.com/dogecoin/address/${a}`,
  },
  BCH: {
    ticker: "BCH",
    network: "Bitcoin Cash",
    chainKind: "BCH",
    decimals: 8,
    walletsByChainKey: "bitcoin-cash",
    // Promoted source-capable 2026-05-08: Rust `swap_sign_psbt` now
    // handles UtxoChain::Bch (legacy P2PKH BIP-44 with SIGHASH_ALL |
    // SIGHASH_FORKID = 0x41 + BIP-143-style sighash, fork id 0).
    // CashAddr deposit addresses decoded via decodeCashAddr from
    // `bch-wallet.ts`. See plan Phase 2.
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "BCH.BCH",
    nearIntentsAsset: "nep141:bch.omft.near",
    defaultRpcUrl: rpcEnv("VITE_BCH_RPC", "https://api.haskoin.com/bch"),
    explorerTxUrl: (h) =>
      `https://blockchair.com/bitcoin-cash/transaction/${h}`,
    explorerAddressUrl: (a) =>
      `https://blockchair.com/bitcoin-cash/address/${a}`,
  },
  // ─── Other natives ───────────────────────────────────────────────
  SOL: {
    ticker: "SOL",
    network: "Solana",
    chainKind: "SOLANA",
    decimals: 9,
    walletsByChainKey: "solana",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "SOL.SOL",
    nearIntentsAsset: "nep141:sol.omft.near",
    defaultRpcUrl: rpcEnv(
      "VITE_SOL_RPC",
      "https://api.mainnet-beta.solana.com"
    ),
    explorerTxUrl: (h) => `https://solscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://solscan.io/account/${a}`,
  },
  NEAR: {
    ticker: "NEAR",
    network: "NEAR Protocol",
    chainKind: "NEAR",
    decimals: 24,
    // 2026-05-26: NEAR now has a first-party TS adapter
    // (`near-wallet.ts`) that derives the implicit account at
    // `m/44'/397'/0'` from the BIP-39 seed at vault-load. Mirrors the
    // Rust `derive::near_implicit_account` math byte-for-byte. Pre-
    // 2026-05-26 this field was undefined, which collapsed NEAR's
    // `addressForTicker` to null and silently disabled the swap
    // button for any NEAR-source pair despite the Rust signer
    // existing. Same bug class as the CARDANO blocker — registry
    // resolver invariant test now catches both.
    walletsByChainKey: "near",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "NEAR.NEAR",
    nearIntentsAsset: "nep141:wrap.near",
    sourcePrerequisiteHint:
      "Your NEAR account needs at least 0.1 NEAR for transaction fees.",
    defaultRpcUrl: rpcEnv("VITE_NEAR_RPC", "https://rpc.mainnet.near.org"),
    explorerTxUrl: (h) => `https://nearblocks.io/txns/${h}`,
    explorerAddressUrl: (a) => `https://nearblocks.io/address/${a}`,
  },
  XMR: {
    ticker: "XMR",
    network: "Monero",
    chainKind: "XMR",
    decimals: 12,
    walletsByChainKey: "monero",
    signerInRustCore: false,
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset: null,
    // Null on both aggregators, but tradable on the desk — the follower
    // side of the atomic swap (its lock is a joint 2-of-2 key, not a
    // script). This is the axis that finally makes XMR routable.
    atomicDesk: { role: "follower", engine: "ada-xmr" },
    explorerTxUrl: (h) => `https://xmrchain.net/tx/${h}`,
    explorerAddressUrl: (a) => `https://xmrchain.net/search?value=${a}`,
  },
  // ─── Zephyr ecosystem (ZephyrSwapModal flow, not SwapKit/Intents) ──
  ZEPH: {
    ticker: "ZEPH",
    network: "Zephyr Protocol",
    chainKind: "ZEPH",
    decimals: 12,
    // Same host-wallet pattern as ZANO below (see that entry's comment for
    // the full rationale): points at the one wallet slot the Zephyr panel
    // already reads, which is also the wallet-rpc the BasicSwap P2P sidecar
    // shares (C-RZ's `maybe_activate_zph_host_wallet`) — never a freshly
    // derived address.
    walletsByChainKey: "zephyr",
    signerInRustCore: false,
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset: null,
    // Follower side, same as XMR — the SAME `ada-xmr` engine, differing only
    // in the address prefix/env preset, so it needs no new crypto. ONLY the
    // native ZEPH trades on the DESK; the ZEPHUSD / ZEPHRSV / ZEPHYRS
    // ecosystem assets stay off it. (Separately, native ZEPH is ALSO
    // routable on the BasicSwap P2P sidecar as of 2026-09-03 — see ZANO's
    // comment above for the desk-vs-sidecar distinction; that axis isn't
    // modelled in this file at all, it lives in `useSidecarSwap.ts`.)
    atomicDesk: { role: "follower", engine: "ada-xmr" },
    explorerTxUrl: (h) => `https://explorer.zephyrprotocol.com/tx/${h}`,
    explorerAddressUrl: (a) =>
      `https://explorer.zephyrprotocol.com/address/${a}`,
  },
  ZEPHUSD: {
    ticker: "ZEPHUSD",
    network: "Zephyr Protocol",
    chainKind: "ZEPH",
    decimals: 12,
    walletsByChainKey: "zephyr",
    signerInRustCore: false,
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset: null,
    explorerTxUrl: (h) => `https://explorer.zephyrprotocol.com/tx/${h}`,
    explorerAddressUrl: (a) =>
      `https://explorer.zephyrprotocol.com/address/${a}`,
  },
  ZEPHRSV: {
    ticker: "ZEPHRSV",
    network: "Zephyr Protocol",
    chainKind: "ZEPH",
    decimals: 12,
    walletsByChainKey: "zephyr",
    signerInRustCore: false,
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset: null,
    explorerTxUrl: (h) => `https://explorer.zephyrprotocol.com/tx/${h}`,
    explorerAddressUrl: (a) =>
      `https://explorer.zephyrprotocol.com/address/${a}`,
  },
  ZEPHYRS: {
    ticker: "ZEPHYRS",
    network: "Zephyr Protocol",
    chainKind: "ZEPH",
    decimals: 12,
    walletsByChainKey: "zephyr",
    signerInRustCore: false,
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset: null,
    explorerTxUrl: (h) => `https://explorer.zephyrprotocol.com/tx/${h}`,
    explorerAddressUrl: (a) =>
      `https://explorer.zephyrprotocol.com/address/${a}`,
  },
  // ─── Zano (added 2026-08-27, see zano-integration-plan.md §10 Phase 7) ──
  ZANO: {
    ticker: "ZANO",
    network: "Zano",
    chainKind: "ZANO",
    decimals: 12,
    // Points at the SAME single wallet slot the Zano panel (ZanoSyncCard,
    // ZanoAssetsCard, ...) reads and displays — there is no separate
    // "swap address" derivation. This is deliberate and load-bearing for
    // the BasicSwap P2P sidecar route (`useSidecarSwap.ts`): ZANO's
    // wallet-rpc (`simplewallet`) is a HOST wallet the sidecar engine
    // shares (C-RX's `maybe_activate_zano_host_wallet`, per
    // grove-expansion-master-plan.md), not something BasicSwap derives a
    // fresh key for — so `addressForTicker("ZANO", ...)` returning this
    // one host address, rather than deriving a new one, is exactly the
    // "source from the host wallet, not derive one" behaviour that route
    // needs. Same pattern as XMR/ZEPH below.
    walletsByChainKey: "zano",
    signerInRustCore: false,
    rpcsAvailable: false,
    // Neither SwapKit nor NEAR Intents 1Click carry ZANO — verified against
    // the 2026-08 catalog. Deliberately NO `atomicDesk` field either — but
    // note what that field actually gates: the SEPARATE `pwnda-desk`
    // ADA<->XMR-style principal-dealer desk (see the interface doc above),
    // NOT the BasicSwap P2P sidecar. As of 2026-09-03 (Grove expansion plan
    // Phase B, patches 15-16) BasicSwap itself DOES carry ZANO — Grove's
    // own from-scratch `ZanoInterface`/`ZanoPrepare` chainclient — so ZANO
    // IS routable via `useSidecarSwap.ts`'s `isBasicswapRoutable` /
    // `basicswapLegsFor` (opposite BTC/LTC/BCH only — see
    // `FOLLOWER_COUNTERPARTY_TICKERS` there). This comment previously said
    // "BasicSwap does not carry ZANO upstream and no client engine exists
    // for it", conflating the desk with the sidecar; corrected here rather
    // than silently changed, per the bug-documentation protocol. The desk
    // conclusion itself stands unchanged: no `atomicDesk` entry until an
    // engine is actually vendored for it, per the same rule XMR/ZEPH's
    // `atomicDesk.engine` comment states. Net effect: ZANO is non-routable
    // on the two AGGREGATOR axes (SwapKit, NEAR Intents) and the DESK axis,
    // but IS routable on the fourth, P2P-sidecar axis this file doesn't
    // model (`isDeskRoutableFromRegistry` and `getDropdownTickers`'s
    // `DESK_TICKERS` filter are about the desk specifically, not about
    // swap routability in general — see `isBasicswapRoutable` for that).
    swapKitAsset: null,
    nearIntentsAsset: null,
    // /transaction/, singular — not /tx/ like every other CryptoNote-family
    // explorer here. Verified live 2026-08-27. No address-lookup page exists
    // (Zano's explorer only offers `find_outs_in_recent_blocks`, which needs
    // the wallet's VIEW KEY — a plain address has no browsable history on a
    // privacy chain), so `explorerAddressUrl` honestly falls back to the
    // explorer's homepage rather than fabricating an unverified path.
    explorerTxUrl: (h) => `https://explorer.zano.org/transaction/${h}`,
    explorerAddressUrl: () => `https://explorer.zano.org/`,
  },
  // ─── multi-chain-token-integration-plan (2026-05-08) ─────────────
  // Phase 3 (Monad).
  MON: {
    ticker: "MON",
    network: "Monad",
    chainKind: "EVM",
    chainId: 143,
    decimals: 18,
    walletsByChainKey: "ethereum",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:143_11111111111111111111",
    defaultRpcUrl: "https://rpc.monad.xyz",
    explorerTxUrl: (h) => `https://explorer.monad.xyz/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.monad.xyz/address/${a}`,
  },
  // Phase 4 (BSC native).
  BNB: {
    ticker: "BNB",
    network: "BNB Smart Chain",
    chainKind: "EVM",
    chainId: 56,
    decimals: 18,
    walletsByChainKey: "ethereum",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: "BNB.BNB",
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    defaultRpcUrl: "https://bsc-dataseed2.binance.org",
    explorerTxUrl: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://bscscan.com/address/${a}`,
  },
  // Phase 5 (Dash).
  DASH: {
    ticker: "DASH",
    network: "Dash",
    chainKind: "DASH",
    decimals: 8,
    walletsByChainKey: "dash",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:dash.omft.near",
    defaultRpcUrl: "https://api.blockcypher.com/v1/dash/main",
    explorerTxUrl: (h) => `https://blockchair.com/dash/transaction/${h}`,
    explorerAddressUrl: (a) => `https://blockchair.com/dash/address/${a}`,
  },
  // Phase 6 (Stellar).
  XLM: {
    ticker: "XLM",
    network: "Stellar",
    chainKind: "STELLAR",
    decimals: 7,
    walletsByChainKey: "stellar",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset:
      "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz",
    sourcePrerequisiteHint:
      "Your Stellar account needs at least 1 XLM (base reserve) plus a small fee.",
    defaultRpcUrl: "https://horizon.stellar.org",
    explorerTxUrl: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
    explorerAddressUrl: (a) =>
      `https://stellar.expert/explorer/public/account/${a}`,
  },
  // Phase 7 (Sui).
  SUI: {
    ticker: "SUI",
    network: "Sui",
    chainKind: "SUI",
    decimals: 9,
    walletsByChainKey: "sui",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:sui.omft.near",
    sourcePrerequisiteHint:
      "Your Sui account needs at least 0.01 SUI for gas (object refs + computation).",
    // fullnode.mainnet.sui.io deprecated its JSON-RPC surface 2026-08-22
    // (-32601 on every suix_* method) — matches src/wallets/sui-wallet.ts's
    // fix. Currently unreachable in practice: the SUI/STELLAR/DASH cases in
    // swap-execute.ts's generic dispatcher throw unconditionally (source-tx
    // routing for these three isn't implemented), so nothing reads this at
    // runtime today. Corrected anyway so it isn't stale if that changes.
    defaultRpcUrl: "https://sui-rpc.publicnode.com",
    explorerTxUrl: (h) => `https://suivision.xyz/txblock/${h}`,
    explorerAddressUrl: (a) => `https://suivision.xyz/account/${a}`,
  },
  // 2026-06-21 — ADA is now source-capable AND destination-capable.
  // Source signing happens in the TS Cardano stack (`tsSourceSigner:
  // "cardano"`), NOT the Rust core — Cardano's BIP-32-Ed25519 (Icarus) +
  // CBOR signing lives in `cardano-tx.ts` (the same code the dashboard
  // Send flow uses), so `signerInRustCore` stays false (there is no
  // `swap_sign_cardano`). `rpcsAvailable` stays false because the deposit
  // tx broadcasts via Koios through the http proxy, not a chain RPC.
  // swapKitAsset stays null because SwapKit routes ADA through NEAR
  // Intents under the hood — direct Intents is strictly better here.
  // See [[ada-swap-source]] in the vault for the full enablement.
  ADA: {
    ticker: "ADA",
    network: "Cardano",
    chainKind: "CARDANO",
    decimals: 6,
    walletsByChainKey: "cardano",
    signerInRustCore: false,
    tsSourceSigner: "cardano",
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:cardano.omft.near",
    // The contract-free `ada-xmr` desk engine: ed25519, SAME curve as the
    // XMR/ZEPH follower, so no DLEq. The simplest and most-proven desk leg,
    // and the first pair taken to testnet. The ONLY engine vendored so far.
    atomicDesk: { role: "leader", engine: "ada-xmr" },
    coverageNote:
      "Cardano is a single-route chain on NEAR Intents — if a quote returns empty, the bridge has no current liquidity.",
    explorerTxUrl: (h) => `https://cardanoscan.io/transaction/${h}`,
    explorerAddressUrl: (a) => `https://cardanoscan.io/address/${a}`,
  },

  // ─── XRP + Tron (2026-09-09) ─────────────────────────────────────
  //
  // Both were listed in `PWNDA_INTENTS_DESTINATION_TICKERS` and reached the
  // user as NEITHER source nor destination, because `getDropdownTickers`
  // filters the roster through `ASSET_CAPABILITIES[t].nearIntentsAsset` and
  // neither had an entry here at all. The same hole the stablecoin legs sat
  // in until earlier today: the roster is a wish, this registry is the fact.
  //
  // Both sign in TypeScript (`tsSourceSigner`), for the same reason Cardano
  // does: the signing already exists in the adapter the Send button uses, and
  // there is no unsigned-transaction seam a Rust signer could take over.
  // `signerInRustCore` stays false and honest.
  XRP: {
    ticker: "XRP",
    network: "XRP Ledger",
    chainKind: "XRP",
    decimals: 6,
    walletsByChainKey: "xrp",
    signerInRustCore: false,
    tsSourceSigner: "xrp",
    // `xrpl` opens its own websocket to a public cluster rather than going
    // through `chain-rpcs`, so there is no RPC url to advertise here.
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:xrp.omft.near",
    // No `atomicDesk` and no BasicSwap leg. Both omissions are deliberate:
    // the desk's leaders are the timelock-capable chains it can actually lead
    // (LTC, ADA, AVAX), and `basicswapLegsFor` pairs scripted UTXO chains with
    // the scriptless followers — XRP is neither. Writing `role: "leader",
    // engine: null` here would read as "vendoring pending" rather than "not a
    // desk leg", which is a different and untrue claim; the desk-roster test
    // caught exactly that when this entry was first drafted.
    explorerTxUrl: (h) => `https://xrpscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://xrpscan.com/account/${a}`,
  },
  TRX: {
    ticker: "TRX",
    network: "Tron",
    chainKind: "TRON",
    decimals: 6,
    walletsByChainKey: "tron",
    signerInRustCore: false,
    tsSourceSigner: "tron",
    // Tron builds the transaction node-side via TronGrid; `trx-wallet.ts`
    // talks to it through the http proxy, not `chain-rpcs`.
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:tron.omft.near",
    // No `atomicDesk` — see the XRP entry above for why that omission is the
    // honest encoding rather than a null engine.
    explorerTxUrl: (h) => `https://tronscan.org/#/transaction/${h}`,
    explorerAddressUrl: (a) => `https://tronscan.org/#/address/${a}`,
  },

  // ─── Stablecoin legs (2026-09-09) ────────────────────────────────
  //
  // ONE ENTRY PER (symbol, network), keyed to match the wallet's own
  // ChainType: `USDC-ARB` here is `usdc-arb` there. That is not a stylistic
  // choice — `AssetCapability` carries a single `chainId`,
  // `walletsByChainKey` and `nearIntentsAsset`, so a bare `USDC` key cannot
  // describe eight networks, and the wallet already settled this question
  // the same way ("Each (symbol, network) pair is its own chain … the ASSETS
  // RAIL groups them back into one row per symbol", `wallets/types.ts`).
  //
  // Why they were missing until now: the roster arrays in `swap-data.ts`
  // have listed "USDC"/"USDT"/"DAI" since 2026-05-08, but the NEAR tab
  // filters the roster through `ASSET_CAPABILITIES[t].nearIntentsAsset` —
  // and no stablecoin had an entry, so all three were silently dropped from
  // the picker. Sixteen wallet legs, every one of them present in the
  // 1Click catalog, none reachable. Same shape as the LTC regression the
  // filter comment describes, at a larger scale.
  //
  // Every `nearIntentsAsset` below was matched to the catalog by CONTRACT
  // ADDRESS, never by symbol — see the USDT0 rows for why that matters.
  // DAI is deliberately absent: the roster lists it, but the wallet has no
  // DAI adapter at all, so it was a phantom entry and is removed there.
  "USDC-ETH": {
    ticker: "USDC",
    network: "Ethereum",
    chainKind: "EVM",
    chainId: 1,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdc-eth",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    defaultRpcUrl: ETH_RPCS()[0],
    rpcFallbacks: ETH_RPCS(),
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://etherscan.io/address/${a}`,
  },
  "USDC-OP": {
    ticker: "USDC",
    network: "Optimism",
    chainKind: "EVM",
    chainId: 10,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdc-op",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",
    defaultRpcUrl: OP_RPCS()[0],
    rpcFallbacks: OP_RPCS(),
    explorerTxUrl: (h) => `https://optimistic.etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://optimistic.etherscan.io/address/${a}`,
  },
  "USDC-BSC": {
    ticker: "USDC",
    network: "BNB Smart Chain",
    chainKind: "EVM",
    chainId: 56,
    decimals: 18,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdc-bsc",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r",
    defaultRpcUrl: BSC_RPCS()[0],
    rpcFallbacks: BSC_RPCS(),
    explorerTxUrl: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://bscscan.com/address/${a}`,
  },
  "USDC-POL": {
    ticker: "USDC",
    network: "Polygon",
    chainKind: "EVM",
    chainId: 137,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdc-pol",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
    defaultRpcUrl: POL_RPCS()[0],
    rpcFallbacks: POL_RPCS(),
    explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://polygonscan.com/address/${a}`,
  },
  "USDC-BASE": {
    ticker: "USDC",
    network: "Base",
    chainKind: "EVM",
    chainId: 8453,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdc-base",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    defaultRpcUrl: BASE_RPCS()[0],
    rpcFallbacks: BASE_RPCS(),
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://basescan.org/address/${a}`,
  },
  "USDC-ARB": {
    ticker: "USDC",
    network: "Arbitrum",
    chainKind: "EVM",
    chainId: 42161,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdc-arb",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    defaultRpcUrl: ARB_RPCS()[0],
    rpcFallbacks: ARB_RPCS(),
    explorerTxUrl: (h) => `https://arbiscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://arbiscan.io/address/${a}`,
  },
  "USDC-AVAX": {
    ticker: "USDC",
    network: "Avalanche",
    chainKind: "EVM",
    chainId: 43114,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdc-avax",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
    defaultRpcUrl: AVAX_RPCS()[0],
    rpcFallbacks: AVAX_RPCS(),
    explorerTxUrl: (h) => `https://snowtrace.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://snowtrace.io/address/${a}`,
  },
  "USDT-ETH": {
    ticker: "USDT",
    network: "Ethereum",
    chainKind: "EVM",
    chainId: 1,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdt-eth",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    defaultRpcUrl: ETH_RPCS()[0],
    rpcFallbacks: ETH_RPCS(),
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://etherscan.io/address/${a}`,
  },
  "USDT-OP": {
    ticker: "USDT",
    network: "Optimism",
    chainKind: "EVM",
    chainId: 10,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdt-op",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo",
    defaultRpcUrl: OP_RPCS()[0],
    rpcFallbacks: OP_RPCS(),
    explorerTxUrl: (h) => `https://optimistic.etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://optimistic.etherscan.io/address/${a}`,
  },
  "USDT-BSC": {
    ticker: "USDT",
    network: "BNB Smart Chain",
    chainKind: "EVM",
    chainId: 56,
    decimals: 18,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdt-bsc",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
    defaultRpcUrl: BSC_RPCS()[0],
    rpcFallbacks: BSC_RPCS(),
    explorerTxUrl: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://bscscan.com/address/${a}`,
  },
  "USDT-AVAX": {
    ticker: "USDT",
    network: "Avalanche",
    chainKind: "EVM",
    chainId: 43114,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdt-avax",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp",
    defaultRpcUrl: AVAX_RPCS()[0],
    rpcFallbacks: AVAX_RPCS(),
    explorerTxUrl: (h) => `https://snowtrace.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://snowtrace.io/address/${a}`,
  },
  "USDT0-POL": {
    ticker: "USDT0",
    network: "Polygon",
    chainKind: "EVM",
    chainId: 137,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdt0-pol",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    // 1Click lists this contract under `USDT`, the wallet under
    // `USDT0`. Same token: matched on CONTRACT, not symbol. Routing
    // uses the catalog's id below; the UI keeps the wallet's label.
    nearIntentsAsset: "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr",
    defaultRpcUrl: POL_RPCS()[0],
    rpcFallbacks: POL_RPCS(),
    explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://polygonscan.com/address/${a}`,
  },
  "USDT0-ARB": {
    ticker: "USDT0",
    network: "Arbitrum",
    chainKind: "EVM",
    chainId: 42161,
    decimals: 6,
    // Token legs keep their OWN wallet key — the address is the shared EVM
    // one, but balance / history / send all resolve per leg.
    walletsByChainKey: "usdt0-arb",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    // 1Click lists this contract under `USDT`, the wallet under
    // `USDT0`. Same token: matched on CONTRACT, not symbol. Routing
    // uses the catalog's id below; the UI keeps the wallet's label.
    nearIntentsAsset: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
    defaultRpcUrl: ARB_RPCS()[0],
    rpcFallbacks: ARB_RPCS(),
    explorerTxUrl: (h) => `https://arbiscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://arbiscan.io/address/${a}`,
  },

  // Solana SPL legs. `chainKind: "SOLANA"` routes them through the same
  // signer the native SOL leg uses; the mint lives in `wallets/stablecoins.ts`
  // and was verified on chain when those adapters landed (2026-09-02).
  "USDC-SOL": {
    ticker: "USDC",
    network: "Solana",
    chainKind: "SOLANA",
    decimals: 6,
    walletsByChainKey: "usdc-sol",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    defaultRpcUrl: rpcEnv("VITE_SOL_RPC", "https://api.mainnet-beta.solana.com"),
    explorerTxUrl: (h) => `https://solscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://solscan.io/account/${a}`,
  },
  "USDT-SOL": {
    ticker: "USDT",
    network: "Solana",
    chainKind: "SOLANA",
    decimals: 6,
    walletsByChainKey: "usdt-sol",
    signerInRustCore: true,
    rpcsAvailable: true,
    swapKitAsset: null,
    nearIntentsAsset: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
    defaultRpcUrl: rpcEnv("VITE_SOL_RPC", "https://api.mainnet-beta.solana.com"),
    explorerTxUrl: (h) => `https://solscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://solscan.io/account/${a}`,
  },
  // TRC-20 USDT — `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, the same contract
  // `stablecoins.ts` carries, matched by CONTRACT against 1Click's catalog
  // rather than by symbol (the rule that saved USDT0 on Arbitrum from being
  // dropped as "not USDT").
  //
  // NOTE: there is deliberately no `USDC-TRON` sibling. USDC is a real TRC-20
  // token on Tron, and 1Click does not carry it: its catalog lists USDC on
  // sixteen chains and Tron is not among them, while USDT on Tron IS there.
  // An entry would be a row the picker offers and no venue can route.
  "USDT-TRON": {
    ticker: "USDT",
    network: "Tron",
    chainKind: "TRON",
    decimals: 6,
    walletsByChainKey: "usdt-tron",
    signerInRustCore: false,
    // Same signer as native TRX; a different adapter builds the transaction
    // (`triggersmartcontract` with `transfer(address,uint256)` rather than a
    // native `TransferContract`), which `walletsByChainKey` selects.
    tsSourceSigner: "tron",
    rpcsAvailable: false,
    swapKitAsset: null,
    nearIntentsAsset:
      "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
    explorerTxUrl: (h) => `https://tronscan.org/#/transaction/${h}`,
    explorerAddressUrl: (a) => `https://tronscan.org/#/address/${a}`,
  },
};

/**
 * The secret a TS-signed source chain needs, tagged with which kind it is.
 *
 * Cardano needs the seed phrase (its Icarus derivation rebuilds a key set);
 * XRP and Tron need a single chain private key. A tagged union rather than
 * one optional field per chain, so adding a fourth TS-signed chain does not
 * widen the executor's input again, and so passing the wrong kind is a type
 * error at the call site instead of a failure inside a signer.
 */
export type SourceSecret =
  | { kind: "mnemonic"; value: string }
  | { kind: "privateKey"; value: string };

/**
 * Which secret (if any) a source asset needs, and where to read it from.
 *
 * The mapping lives here, once, because it is the kind of decision that
 * otherwise gets re-derived at each call site and then drifts. Both swap
 * surfaces mount the same confirm modal, and portrait had been the only one
 * threading ADA's mnemonic; the landscape copy repeating the same ternary is
 * a second place to forget XRP. It is also the exact shape of the
 * `SwapChainKind` duplication that broke the build earlier today.
 *
 * Returns `undefined` for every Rust-signed chain — they sign inside the swap
 * session and need nothing here — and for a TS-signed chain whose wallet has
 * not been derived yet, so the executor raises the actionable "open the chain
 * in the dashboard" error rather than this returning a half-built secret.
 *
 * Exported so a test can pin the mapping without rendering a modal.
 */
export function sourceSecretFor(
  fromAsset: string,
  walletsByChain: Partial<
    Record<string, { mnemonic?: string; privateKey?: string } | undefined>
  >,
): SourceSecret | undefined {
  const cap = ASSET_CAPABILITIES[fromAsset.toUpperCase()];
  const signer = cap?.tsSourceSigner;
  // `walletsByChainKey` is required on every registry entry, but the lookup
  // above can miss, so both are checked together rather than asserted.
  if (!signer || !cap?.walletsByChainKey) return undefined;
  if (signer === "cardano") {
    // Cardano rebuilds a whole key set from the seed; a single private key
    // cannot express its Icarus derivation.
    const m = walletsByChain[cap.walletsByChainKey]?.mnemonic;
    return m ? { kind: "mnemonic", value: m } : undefined;
  }
  // xrp / tron — one chain key, which is what those adapters take. Read
  // through `walletsByChainKey` rather than the signer name, because TRX and
  // USDT-TRON share the signer and hold separate wallet entries.
  const pk = walletsByChain[cap.walletsByChainKey]?.privateKey;
  return pk ? { kind: "privateKey", value: pk } : undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────
//
// The three load-bearing concerns the three-bug pattern surfaced
// (address resolution, SwapKit routability, NEAR Intents routability)
// each get one canonical implementation here. Consumers must call
// these helpers rather than re-implementing the lookup.

/**
 * Resolve the user's wallet address for a given asset ticker. Replaces
 * the two parallel `addressFor` switch statements that previously lived
 * in `SwapView.tsx` and `SwapLandscapeView.tsx` and silently dropped
 * any asset whose `chainKind` wasn't in the switch (the 2026-05-25
 * CARDANO blocker).
 *
 * Returns `null` when:
 *   - The ticker isn't in `ASSET_CAPABILITIES`.
 *   - The asset has no `walletsByChainKey` (e.g. NEAR — derived on-
 *     demand via Rust, not stored in `walletsByChain`).
 *   - The wallet for that key hasn't been derived yet.
 *
 * Null short-circuits the form's `confirmReady` predicate, which is
 * the correct behavior — the user can't sign a tx from an address
 * we don't have.
 */
export function addressForTicker(
  ticker: string,
  walletsByChain: WalletsByChain
): string | null {
  const cap = ASSET_CAPABILITIES[ticker.toUpperCase()];
  if (!cap || !cap.walletsByChainKey) return null;
  return walletsByChain[cap.walletsByChainKey]?.address ?? null;
}

/** True when both ends of the pair have a SwapKit asset id. */
export function isSwapKitRoutableFromRegistry(
  from: string,
  to: string
): boolean {
  const f = ASSET_CAPABILITIES[from.toUpperCase()];
  const t = ASSET_CAPABILITIES[to.toUpperCase()];
  return !!(f?.swapKitAsset && t?.swapKitAsset);
}

/** True when both ends of the pair have a NEAR Intents asset id. */
export function isIntentsRoutableFromRegistry(
  from: string,
  to: string
): boolean {
  const f = ASSET_CAPABILITIES[from.toUpperCase()];
  const t = ASSET_CAPABILITIES[to.toUpperCase()];
  return !!(f?.nearIntentsAsset && t?.nearIntentsAsset);
}

/**
 * True when the pair is tradable on the `pwnda-desk` atomic-swap desk:
 * EXACTLY one leader and one follower, in either direction.
 *
 * Unlike the two aggregator predicates above (which need the SAME field
 * set on both ends), the desk needs the two ends to be DIFFERENT roles —
 * a leader↔leader or follower↔follower pair is not a swap the desk makes.
 * Direction is irrelevant to routability: XMR→ADA and ADA→XMR are both
 * routable, they just resolve to different desk roles (SELL_FOLLOWER vs
 * BUY_FOLLOWER — see `deskDirectionFor`).
 */
export function isDeskRoutableFromRegistry(from: string, to: string): boolean {
  const f = ASSET_CAPABILITIES[from.toUpperCase()]?.atomicDesk;
  const t = ASSET_CAPABILITIES[to.toUpperCase()]?.atomicDesk;
  if (!f || !t) return false;
  // Exactly one leader and one follower.
  if (f.role === t.role) return false;
  // ...and one engine that can actually settle BOTH legs. The two legs of an
  // atomic swap are two halves of a single protocol, so they must be the same
  // engine — a null engine (LTC, AVAX) is a leg the client cannot settle at
  // all, and two DIFFERENT engines would be two unrelated protocols, not a
  // swap. Gating here rather than at the call sites keeps the rule in the one
  // place every other desk helper already delegates to.
  return f.engine !== null && f.engine === t.engine;
}

/**
 * The desk `direction` for a routable pair, from the USER's point of view:
 * selling the follower coin (XMR/ZEPH → leader) is `SELL_FOLLOWER` and the
 * desk leads; buying it (leader → XMR/ZEPH) is `BUY_FOLLOWER` and the
 * CLIENT leads. Returns null when the pair isn't desk-routable.
 *
 * This is the single place the direction is derived — the Rust tier reads
 * the desk's own `deskRole` off the quote/accept response rather than
 * recomputing it, so the two can never disagree.
 */
export function deskDirectionFor(
  from: string,
  to: string
): "SELL_FOLLOWER" | "BUY_FOLLOWER" | null {
  if (!isDeskRoutableFromRegistry(from, to)) return null;
  const f = ASSET_CAPABILITIES[from.toUpperCase()]?.atomicDesk?.role;
  return f === "follower" ? "SELL_FOLLOWER" : "BUY_FOLLOWER";
}

/**
 * The desk `pair` label for a routable pair, always `FOLLOWER/LEADER`
 * (e.g. "XMR/ADA") regardless of the user's swap direction — that is the
 * form the desk's `/quote` and `/pairs` endpoints use.
 */
export function deskPairLabel(from: string, to: string): string | null {
  if (!isDeskRoutableFromRegistry(from, to)) return null;
  const F = from.toUpperCase();
  const T = to.toUpperCase();
  const fRole = ASSET_CAPABILITIES[F]?.atomicDesk?.role;
  return fRole === "follower" ? `${F}/${T}` : `${T}/${F}`;
}

/**
 * Split a desk `FOLLOWER/LEADER` pair label back into its two legs, verifying
 * the roles are actually what the label claims.
 *
 * This is the ONLY place in the codebase that may split a desk pair string.
 * Everywhere else takes the result of this (or of [`deskCoinsFor`] /
 * [`deskAmountsFor`]) — a second `pair.split("/")` somewhere in the UI is how
 * the 2026-05-25 scattered-capability bugs started.
 */
function splitDeskPair(pair: string): { follower: string; leader: string } | null {
  const parts = pair.toUpperCase().split("/");
  if (parts.length !== 2) return null;
  const [follower, leader] = parts;
  if (ASSET_CAPABILITIES[follower]?.atomicDesk?.role !== "follower") return null;
  if (ASSET_CAPABILITIES[leader]?.atomicDesk?.role !== "leader") return null;
  // Same engine gate as `isDeskRoutableFromRegistry`, and NOT redundant with
  // it: this function is reached from the rehydrate path, which parses a pair
  // label handed back by the DESK rather than one the user picked. The desk's
  // roster is wider than ours, so without this a desk-side XMR/LTC swap would
  // parse cleanly here and render as though the client could act on it.
  if (!isDeskRoutableFromRegistry(follower, leader)) return null;
  return { follower, leader };
}

/**
 * The user-facing in/out coins for a desk swap, from the desk's own `pair` +
 * `direction` (rather than from a UI from/to selection).
 *
 * `SELL_FOLLOWER` means the user sells the follower coin: in = follower,
 * out = leader. `BUY_FOLLOWER` is the reverse. Returns null for an
 * unrecognized pair or direction.
 *
 * Needed because `desk_list_active` hands back only `pair` + `direction` +
 * `amountA`/`amountB` with no quote in hand — the rehydrate path has to
 * re-derive which asset is which.
 */
export function deskCoinsFor(
  pair: string,
  direction: string
): { coinIn: string; coinOut: string } | null {
  const legs = splitDeskPair(pair);
  if (!legs) return null;
  if (direction === "SELL_FOLLOWER") {
    return { coinIn: legs.follower, coinOut: legs.leader };
  }
  if (direction === "BUY_FOLLOWER") {
    return { coinIn: legs.leader, coinOut: legs.follower };
  }
  return null;
}

/**
 * The user-facing in/out AMOUNTS for a desk swap.
 *
 * The trap this exists to prevent: `amountA` and `amountB` are CHAIN legs, not
 * in/out. `amountA` is always the chain-A (leader) leg and `amountB` the
 * chain-B (follower) leg, so which one is "in" flips with the direction:
 *
 * - `SELL_FOLLOWER` — sell 0.1 XMR for 27 ADA -> amountIn = amountB (0.1),
 *   amountOut = amountA (27).
 * - `BUY_FOLLOWER` — buy 0.009 XMR with 3 ADA -> amountIn = amountA (3),
 *   amountOut = amountB (0.009).
 *
 * (Both examples are the literal values from the reference wire trace.)
 * Reading them as in/out would silently invert every rehydrated swap's
 * displayed amounts.
 */
export function deskAmountsFor(s: {
  pair: string;
  direction: string;
  amountA: string;
  amountB: string;
}): { amountIn: string; amountOut: string } | null {
  if (!splitDeskPair(s.pair)) return null;
  if (s.direction === "SELL_FOLLOWER") {
    return { amountIn: s.amountB, amountOut: s.amountA };
  }
  if (s.direction === "BUY_FOLLOWER") {
    return { amountIn: s.amountA, amountOut: s.amountB };
  }
  return null;
}
