import type { ChainType } from "../../wallets";
import { getAdapter } from "../../wallets";
import { assetRank } from "../../wallets/coin-metadata";
import type { ZphAssetType } from "../../wallets/zph-rpc";
import {
  ARB_RPCS,
  AVAX_RPCS,
  BASE_RPCS,
  BSC_RPCS,
  ETH_RPCS,
  FLR_RPCS,
  NEAR_RPCS,
  OP_RPCS,
  POL_RPCS,
  SOL_RPCS,
} from "../../wallets/chain-rpcs";
import {
  EVM_CHAIN_IDS,
  type IntentsBlockchain,
} from "./near-intents-assets.generated";
import { resolveAsset } from "./intents-dedup";
import {
  ASSET_CAPABILITIES,
  isIntentsRoutableFromRegistry,
  isSwapKitRoutableFromRegistry,
  type AssetCapability,
} from "./asset-capabilities";

/**
 * Atomic-exchange swap dashboard data.
 *
 * Today the actual atomic-swap engine isn't wired — this module ships
 * the *visual* swap dashboard the design specifies, with real prices
 * (cross-rate from CoinGecko USD spots) and real balances powering the
 * form. Pair metadata (fee, min/max, provider, est. time) and the
 * orderbook + recent-swaps lists are static placeholders carried over
 * from `view-swap.jsx`. The Swap button routes Zephyr-ecosystem pairs
 * to the existing `ZephyrSwapModal`; everything else is "coming soon".
 */

export interface SwapPairMeta {
  /** Static rate fallback when we don't have a live price for one
   *  side. The form prefers a live cross-rate when available. */
  rate: number;
  /** Pool / provider fee, percent points (e.g. 0.25 = 0.25 %). */
  fee: number;
  minAmt: number;
  maxAmt: number;
  /** Display string — shown in the rate summary. */
  est: string;
  provider: string;
}

/** Direction-keyed lookup, "FROM→TO" with the unicode arrow. */
export const SWAP_PAIRS: Record<string, SwapPairMeta> = {
  "XMR→BTC":  { rate: 0.00262, fee: 0.25, minAmt: 0.1,   maxAmt: 100,  est: "~15 min", provider: "Pwnda Atomic" },
  "XMR→ETH":  { rate: 0.0539,  fee: 0.30, minAmt: 0.1,   maxAmt: 80,   est: "~12 min", provider: "Pwnda Atomic" },
  "BTC→XMR":  { rate: 381.68,  fee: 0.20, minAmt: 0.001, maxAmt: 0.5,  est: "~20 min", provider: "Pwnda Atomic" },
  "ETH→XMR":  { rate: 18.55,   fee: 0.25, minAmt: 0.01,  maxAmt: 5,    est: "~10 min", provider: "Pwnda Atomic" },
  "BTC→ETH":  { rate: 20.58,   fee: 0.15, minAmt: 0.001, maxAmt: 1,    est: "~8 min",  provider: "Pwnda Bridge" },
  "ETH→BTC":  { rate: 0.0486,  fee: 0.15, minAmt: 0.01,  maxAmt: 10,   est: "~8 min",  provider: "Pwnda Bridge" },
  "XMR→ZEPH": { rate: 58.94,   fee: 0.35, minAmt: 0.5,   maxAmt: 50,   est: "~25 min", provider: "Pwnda Atomic" },
  "ZEPH→XMR": { rate: 0.01697, fee: 0.35, minAmt: 10,    maxAmt: 2000, est: "~25 min", provider: "Pwnda Atomic" },
  "SOL→ETH":  { rate: 0.0455,  fee: 0.20, minAmt: 0.5,   maxAmt: 100,  est: "~5 min",  provider: "Pwnda Bridge" },
  "ETH→SOL":  { rate: 21.97,   fee: 0.20, minAmt: 0.01,  maxAmt: 5,    est: "~5 min",  provider: "Pwnda Bridge" },
};

/**
 * The list of tickers the Swap dropdown surfaces. Three groups:
 *
 * 1. **SwapKit-routable** — chains the v1 Rust signing core can produce
 *    a signed broadcast for. ETH/AVAX/POL/FLR are EVM (signed via
 *    `swap_sign_evm`); BTC/LTC/DOGE/BCH are PSBT (signed via
 *    `swap_sign_psbt`); SOL would be Solana (final tx assembly is v2 so
 *    Solana flows through the modal as "coming soon" until then).
 * 2. **NEAR Intents-routable** — Solana / NEAR cross-chain via the 1Click
 *    flow; same EVM signer for the source-chain deposit when the source
 *    is EVM.
 * 3. **Zephyr ecosystem** — ZEPH/ZEPHUSD/ZEPHRSV/ZEPHYRS — routed through
 *    the existing `<ZephyrSwapModal>` for ecosystem-internal pairs;
 *    cross-ecosystem (e.g. ZEPH→BTC) is "coming soon".
 *
 * XMR stays in the list for dropdown continuity but XMR↔SwapKit is not
 * wired in v1.
 */
export const SWAP_COINS = [
  // EVM chains (Rust signer ready in v1)
  "ETH",
  "AVAX",
  "POL",
  "FLR",
  // PSBT chains (Rust signer ready in v1)
  "BTC",
  "LTC",
  "DOGE",
  "BCH",
  // Other natives
  "SOL",
  "NEAR",
  "XMR",
  // Destination-only: Pwnda has wallet adapter, no Rust source signer.
  // 2026-05-25 addition — unblocks AVAX→ADA and similar receive flows.
  "ADA",
  // Zephyr ecosystem (ZephyrSwapModal flow)
  "ZEPH",
  "ZEPHUSD",
  "ZEPHRSV",
  "ZEPHYRS",
] as const;
export type SwapCoin = (typeof SWAP_COINS)[number];

/** Where the swap orchestration sends a coin's signed tx for broadcast. */
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
  // Source + destination as of 2026-06-21. ADA source signs in the TS
  // Cardano stack (cardano-tx.ts), not Rust — see `tsSourceSigner` in
  // asset-capabilities.ts.
  | "CARDANO";

/**
 * Legacy SwapCoinMeta shape. Pre-2026-05-25 this was the per-asset
 * source of truth; today it's a backward-compat alias over the
 * `AssetCapability` interface in `asset-capabilities.ts`. The two
 * differ in two ways:
 *
 *   1. Field rename: legacy `sourceCapable` → registry `signerInRustCore`.
 *      The shim below remaps the field at read time so existing
 *      consumers reading `meta.sourceCapable` keep working.
 *   2. Field rename: legacy `evmChainId` → registry `chainId`.
 *      Same remapping at read time.
 *
 * New consumers should import `AssetCapability` directly from
 * `asset-capabilities.ts`. This alias exists so the migration can land
 * one consumer at a time without forcing a sweeping rename.
 */
export interface SwapCoinMeta {
  ticker: string;
  chainKind: SwapChainKind;
  swapKitAsset: string | null;
  nearIntentsAsset: string | null;
  /** Legacy alias for `chainId` in `AssetCapability`. */
  evmChainId?: number;
  decimals: number;
  defaultRpcUrl?: string;
  rpcFallbacks?: string[];
  explorerTxUrl: (hash: string) => string;
  explorerAddressUrl: (addr: string) => string;
  /** Legacy alias for `signerInRustCore` in `AssetCapability`. */
  sourceCapable: boolean;
  sourcePrerequisiteHint?: string;
  tokenContract?: string;
  coverageNote?: string;
}

/**
 * Per-coin chain metadata. AS OF 2026-05-25, this is a computed view
 * over `ASSET_CAPABILITIES` in `asset-capabilities.ts` — the registry
 * is the single source of truth. The legacy `sourceCapable` and
 * `evmChainId` fields are remapped from the registry's
 * `signerInRustCore` and `chainId` so existing consumers keep working
 * during the migration window. Delete this shim once every consumer
 * imports `ASSET_CAPABILITIES` directly.
 */
function capabilityToLegacyMeta(cap: AssetCapability): SwapCoinMeta {
  return {
    ticker: cap.ticker,
    chainKind: cap.chainKind,
    swapKitAsset: cap.swapKitAsset,
    nearIntentsAsset: cap.nearIntentsAsset,
    evmChainId: cap.chainId,
    decimals: cap.decimals,
    defaultRpcUrl: cap.defaultRpcUrl,
    rpcFallbacks: cap.rpcFallbacks,
    explorerTxUrl: cap.explorerTxUrl,
    explorerAddressUrl: cap.explorerAddressUrl,
    // Source-capable when the Rust core can sign it OR (ADA) the TS
    // Cardano stack can. `tsSourceSigner` keeps `signerInRustCore` honest
    // (false for ADA) while still surfacing ADA on the FROM side.
    sourceCapable: cap.signerInRustCore || !!cap.tsSourceSigner,
    sourcePrerequisiteHint: cap.sourcePrerequisiteHint,
    tokenContract: cap.tokenContract,
    coverageNote: cap.coverageNote,
  };
}

export const SWAP_COIN_META: Record<string, SwapCoinMeta> = Object.fromEntries(
  Object.entries(ASSET_CAPABILITIES).map(([ticker, cap]) => [
    ticker,
    capabilityToLegacyMeta(cap),
  ])
);

// The original SWAP_COIN_META literal table (~280 lines) lived here.
// It has moved to `asset-capabilities.ts::ASSET_CAPABILITIES` and is
// computed back into `SWAP_COIN_META` above via `capabilityToLegacyMeta`.
// See `wiki/concepts/adding-a-new-asset.md` for the registry-first runbook.


/** True when both sides have a SwapKit asset id — the pair can be quoted.
 *  Thin re-export over `asset-capabilities::isSwapKitRoutableFromRegistry`;
 *  this binding kept for the dozen-or-so existing consumers that
 *  `import { isSwapKitRoutable } from "./swap-data"`. New code should
 *  import directly from `./asset-capabilities`. */
export function isSwapKitRoutable(from: string, to: string): boolean {
  return isSwapKitRoutableFromRegistry(from, to);
}

/** True when both sides have a NEAR Intents asset id — the pair can be
 *  quoted via 1Click. Same shim pattern as `isSwapKitRoutable`. */
export function isIntentsRoutable(from: string, to: string): boolean {
  return isIntentsRoutableFromRegistry(from, to);
}

/** True when the wallet can build + sign + broadcast a SOURCE-chain tx
 *  for `ticker`. Form FROM dropdown filters on this. */
export function isSourceCapable(ticker: string): boolean {
  return SWAP_COIN_META[ticker.toUpperCase()]?.sourceCapable === true;
}

/** Map a chain kind to the `chainKind` string `swap_broadcast` expects.
 *  Destination-only kinds (CARDANO, XMR, ZEPH, ZANO) flow through the
 *  default arm — they pass through as the literal kind. Real broadcasts on
 *  these kinds are gated upstream by `sourceCapable: false`, so the
 *  Rust core never receives a broadcast request for them in v1.x. ZANO in
 *  particular is never even destination-routable yet (no swapKitAsset,
 *  no nearIntentsAsset, no atomicDesk — see asset-capabilities.ts), so this
 *  arm is unreachable for it today; kept total anyway for the same reason
 *  CARDANO's explicit case exists. */
export function broadcastChainKind(kind: SwapChainKind): string {
  switch (kind) {
    case "EVM":
      return "EVM";
    case "BTC":
    case "LTC":
    case "DOGE":
    case "BCH":
    case "DASH":
      return kind;
    case "SOLANA":
      return "SOLANA";
    case "NEAR":
      return "NEAR";
    case "STELLAR":
      return "STELLAR";
    case "SUI":
      return "SUI";
    case "CARDANO":
      // ADA source broadcasts via Koios in the TS layer
      // (executeCardanoTransfer), NOT the Rust `swap_broadcast` IPC, so
      // this kind never actually reaches the Rust broadcaster — it's
      // here only to keep the mapping total.
      return "CARDANO";
    default:
      return kind;
  }
}

/** The set of tickers the Zephyr swap modal natively handles. */
export const ZEPHYR_ECOSYSTEM_TICKERS = new Set<string>([
  "ZEPH",
  "ZEPHUSD",
  "ZEPHRSV",
  "ZEPHYRS",
]);

/** Map a swap-coin ticker to the protocol-level `ZphAssetType` the
 *  Zephyr swap modal expects (`ZPH` / `ZSD` / `ZRS` / `ZYS`). Returns
 *  null for non-ecosystem tickers. */
export function tickerToZphAssetType(ticker: string): ZphAssetType | null {
  switch (ticker.toUpperCase()) {
    case "ZEPH":
      return "ZPH";
    case "ZEPHUSD":
      return "ZSD";
    case "ZEPHRSV":
      return "ZRS";
    case "ZEPHYRS":
      return "ZYS";
    default:
      return null;
  }
}

export function pairKey(from: string, to: string): string {
  return `${from}→${to}`;
}

/** Look up the metadata for a (from, to) pair. Falls back to a synthetic
 *  default when the design's table doesn't have an entry — this keeps
 *  arbitrary cross-pair rendering honest. */
export function getPairMeta(from: string, to: string): SwapPairMeta {
  const key = pairKey(from, to);
  return (
    SWAP_PAIRS[key] ?? {
      rate: 0,
      fee: 0.3,
      minAmt: 0,
      maxAmt: Infinity,
      est: "~15 min",
      provider: "Pwnda Atomic",
    }
  );
}

/** Compute a live cross-rate from spot USD prices: rate(A→B) = USD(A) / USD(B).
 *  Returns null if either side isn't priced. */
export function liveCrossRate(
  from: string,
  to: string,
  pricesByTicker: Record<string, number>
): number | null {
  const a = pricesByTicker[from.toUpperCase()];
  const b = pricesByTicker[to.toUpperCase()];
  if (!a || !b || a <= 0 || b <= 0) return null;
  return a / b;
}

/** Map a swap-coin ticker to the matching ChainType so we can look up
 *  the user's wallet + balance. The four Zephyr ecosystem tickers all
 *  resolve to the `zephyr` chain — the Zephyr-specific asset balances
 *  for ZEPHUSD / ZEPHRSV / ZEPHYRS live in `zphSession.assetBalances`,
 *  not in `balancesByChain[zephyr]` (which only carries the ZEPH
 *  balance). Callers needing the per-asset balance should pass
 *  `zphAssetBalances` separately.
 *
 *  Returns null for tickers that don't have a first-party wallet
 *  adapter — bridged ERC-20 tokens (USDC, USDT, ARB, OP, AAVE, LINK)
 *  and chains we don't yet derive (NEAR, BNB, TON). Those entries
 *  render with no balance in the dropdown — the chain pill picker
 *  surfaces them but the balance column shows "—".
 */
export function tickerToChain(ticker: string): ChainType | null {
  const map: Record<string, ChainType> = {
    // Native + first-party adapters in `src/wallets/`. Every chain in
    // this map has a `getBalance` implementation that the App's
    // `refreshAllBalances` calls, so the result lands in
    // `balancesByChain[chain]` and is available here.
    XMR: "monero",
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    ADA: "cardano",
    POL: "polygon",
    AVAX: "avalanche",
    FLR: "flare",
    LTC: "litecoin",
    DOGE: "dogecoin",
    BCH: "bitcoin-cash",
    XRP: "xrp",
    TRX: "tron",
    HBAR: "hedera",
    ALGO: "algorand",
    RVN: "ravencoin",
    CFX: "conflux",
    // Zephyr ecosystem — the four asset tickers all map to the `zephyr`
    // chain; per-asset balances come from `zphAssetBalances` (a separate
    // arg to `balanceForTicker`).
    ZEPH: "zephyr",
    ZEPHUSD: "zephyr",
    ZEPHRSV: "zephyr",
    ZEPHYRS: "zephyr",
    // ── multi-chain-token-integration-plan (2026-05-08) ─────────────
    // The native gas tokens for the new chains. Stablecoins (USDC/USDT/DAI)
    // are intentionally NOT in this map — they're per-chain bridged ERC-20s
    // routed via the chain sub-selector through `getSwapCoinMeta(symbol,
    // blockchain)`, not a single canonical chain. The form's balance row
    // for those tickers reads from the per-(symbol, chain) adapter.
    BNB: "bsc",
    MON: "monad",
    DASH: "dash",
    XLM: "stellar",
    SUI: "sui",
  };
  return map[ticker.toUpperCase()] ?? null;
}

/** Detect whether a (from, to) pair is one the existing
 *  ZephyrSwapModal can handle. The modal handles every direct pair
 *  inside the four-asset family — non-direct routes are filtered
 *  inside the modal's own dropdowns. */
export function isZephyrEcosystemPair(from: string, to: string): boolean {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return false;
  return ZEPHYR_ECOSYSTEM_TICKERS.has(f) && ZEPHYR_ECOSYSTEM_TICKERS.has(t);
}


export interface SwapHistoryRow {
  from: string;
  to: string;
  fromAmt: number;
  toAmt: number;
  when: string;
  status: "complete" | "pending" | "failed";
}

export const SWAP_HISTORY: SwapHistoryRow[] = [
  { from: "XMR", to: "BTC",  fromAmt: 5.0,   toAmt: 0.0131,  when: "6h ago", status: "complete" },
  { from: "ETH", to: "ZEPH", fromAmt: 0.5,   toAmt: 1092,    when: "2d ago", status: "complete" },
  { from: "BTC", to: "XMR",  fromAmt: 0.008, toAmt: 3.053,   when: "5d ago", status: "complete" },
  { from: "SOL", to: "ETH",  fromAmt: 10.0,  toAmt: 0.455,   when: "1w ago", status: "complete" },
  { from: "XMR", to: "ZEPH", fromAmt: 2.0,   toAmt: 117.88,  when: "2w ago", status: "complete" },
];

/** Format a balance number for display in the swap form. Same rules as
 *  the rest of the app's balance display (≥1000 → 0 dp, ≥1 → 4 dp,
 *  ≥0.001 → 5 dp, else 8 dp); trailing zeros trimmed. */
export function fmtBal(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return "0";
  const dp =
    amount >= 1000
      ? 0
      : amount >= 1
        ? 4
        : amount >= 0.001
          ? 5
          : 8;
  const fixed = amount.toFixed(dp);
  return fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
}

/** Pretty chain display name for the wallet adapter behind a ticker. */
export function tickerDisplayName(ticker: string): string {
  const chain = tickerToChain(ticker);
  if (!chain) return ticker;
  return getAdapter(chain).displayName;
}

/* ──────────────────────────────────────────────────────────────────
   Per-blockchain RPC resolver

   For source-tx broadcasting, the right RPC list depends on the SOURCE
   blockchain — not the underlying ticker. USDC on Base broadcasts to a
   Base RPC; USDC on Arbitrum broadcasts to an Arbitrum RPC. The pre-
   2026-05-07 swap path read `fromMeta.rpcFallbacks` which was statically
   tied to the underlying-asset ticker (the static SWAP_COIN_META.ETH
   only knew about Ethereum L1). This helper resolves the correct list
   from the IntentsBlockchain id directly.
   ─────────────────────────────────────────────────────────────────*/

export function getRpcUrlsForBlockchain(blockchain: IntentsBlockchain): string[] {
  switch (blockchain) {
    case "eth":
      return ETH_RPCS();
    case "arb":
      return ARB_RPCS();
    case "base":
      return BASE_RPCS();
    case "op":
      return OP_RPCS();
    case "pol":
      return POL_RPCS();
    case "avax":
      return AVAX_RPCS();
    case "bnb":
      return BSC_RPCS();
    case "sol":
      return SOL_RPCS();
    case "near":
      return NEAR_RPCS();
    case "btc":
      return ["https://blockstream.info/api", "https://mempool.space/api"];
    case "ltc":
      // LTC source-tx broadcasts go through litecoinspace (Esplora-shaped
      // API matching what the BTC Esplora client expects).
      return ["https://litecoinspace.org/api", "https://blockchair.com/litecoin/raw"];
    case "doge":
      return [
        "https://api.blockcypher.com/v1/doge/main",
        "https://api.blockchair.com/dogecoin",
      ];
    case "bch":
      return [
        "https://api.blockchair.com/bitcoin-cash",
        "https://api.haskoin.com/bch",
      ];
    case "dash":
      return [
        "https://api.blockcypher.com/v1/dash/main",
        "https://api.blockchair.com/dash",
      ];
    case "monad":
      // Monad mainnet — chain id 143. Public RPC infrastructure is new
      // (Monad launched 2026 Q1) so the list is conservative; expand
      // post-launch verification.
      return [
        "https://rpc.monad.xyz",
        "https://monad-rpc.publicnode.com",
      ];
    case "stellar":
      // Horizon mainnet. Used for sequence + submit.
      return [
        "https://horizon.stellar.org",
        "https://horizon.stellar.lobstr.co",
      ];
    case "sui":
      // Sui RPC mainnet via the official endpoint.
      return [
        "https://fullnode.mainnet.sui.io:443",
        "https://sui-mainnet-rpc.nodereal.io",
      ];
    case "xrp":
    case "tron":
    case "ton":
    case "cardano":
      // Destination-only chains in v1.x. We never need to broadcast a
      // source tx for these, but return a sane default so the form's
      // "show explorer URL" path doesn't crash if it's hit by accident.
      // Cardano added 2026-05-25 — Pwnda has the CIP-1852 wallet adapter
      // for receive, no Rust source signer yet.
      return [];
  }
}

/* ──────────────────────────────────────────────────────────────────
   Synthetic SwapCoinMeta resolver

   The static `SWAP_COIN_META` map covers the 15 canonical tickers the
   v1 dropdown surfaced (ETH, BTC, SOL, NEAR, POL, AVAX, FLR, LTC, DOGE,
   BCH, XMR, ZEPH+three siblings). The any-to-any expansion adds new
   underlying symbols (USDC, USDT, BNB, XRP, TRX, TON, ARB, OP, AAVE,
   LINK) that didn't have static entries.

   `getSwapCoinMeta(symbol, blockchain)` is the new boundary every
   blockchain-aware caller goes through. It:
     - returns the matching static entry when one exists for the symbol
       AND the blockchain matches the static entry's chain (e.g.
       getSwapCoinMeta("ETH", "eth") → SWAP_COIN_META.ETH)
     - synthesizes a new SwapCoinMeta from the IntentsAsset map when
       no static entry covers the (symbol, blockchain) pair (e.g.
       USDC on Base, ETH on Arbitrum).

   Synthetic entries inherit RPC fallbacks via `getRpcUrlsForBlockchain`,
   chainKind via blockchain → ChainKind translation, and explorer URLs
   from a per-blockchain template registry.
   ─────────────────────────────────────────────────────────────────*/

const EXPLORER_BY_BLOCKCHAIN: Record<
  IntentsBlockchain,
  { tx: (h: string) => string; address: (a: string) => string }
> = {
  eth: {
    tx: (h) => `https://etherscan.io/tx/${h}`,
    address: (a) => `https://etherscan.io/address/${a}`,
  },
  arb: {
    tx: (h) => `https://arbiscan.io/tx/${h}`,
    address: (a) => `https://arbiscan.io/address/${a}`,
  },
  base: {
    tx: (h) => `https://basescan.org/tx/${h}`,
    address: (a) => `https://basescan.org/address/${a}`,
  },
  op: {
    tx: (h) => `https://optimistic.etherscan.io/tx/${h}`,
    address: (a) => `https://optimistic.etherscan.io/address/${a}`,
  },
  pol: {
    tx: (h) => `https://polygonscan.com/tx/${h}`,
    address: (a) => `https://polygonscan.com/address/${a}`,
  },
  avax: {
    tx: (h) => `https://snowtrace.io/tx/${h}`,
    address: (a) => `https://snowtrace.io/address/${a}`,
  },
  bnb: {
    tx: (h) => `https://bscscan.com/tx/${h}`,
    address: (a) => `https://bscscan.com/address/${a}`,
  },
  btc: {
    tx: (h) => `https://blockstream.info/tx/${h}`,
    address: (a) => `https://blockstream.info/address/${a}`,
  },
  sol: {
    tx: (h) => `https://solscan.io/tx/${h}`,
    address: (a) => `https://solscan.io/account/${a}`,
  },
  near: {
    tx: (h) => `https://nearblocks.io/txns/${h}`,
    address: (a) => `https://nearblocks.io/address/${a}`,
  },
  doge: {
    tx: (h) => `https://blockchair.com/dogecoin/transaction/${h}`,
    address: (a) => `https://blockchair.com/dogecoin/address/${a}`,
  },
  xrp: {
    tx: (h) => `https://xrpscan.com/tx/${h}`,
    address: (a) => `https://xrpscan.com/account/${a}`,
  },
  tron: {
    tx: (h) => `https://tronscan.org/#/transaction/${h}`,
    address: (a) => `https://tronscan.org/#/address/${a}`,
  },
  ton: {
    tx: (h) => `https://tonscan.org/tx/${h}`,
    address: (a) => `https://tonscan.org/address/${a}`,
  },
  ltc: {
    tx: (h) => `https://litecoinspace.org/tx/${h}`,
    address: (a) => `https://litecoinspace.org/address/${a}`,
  },
  bch: {
    tx: (h) => `https://blockchair.com/bitcoin-cash/transaction/${h}`,
    address: (a) => `https://blockchair.com/bitcoin-cash/address/${a}`,
  },
  // Phase 3+ additions (2026-05-08).
  monad: {
    tx: (h) => `https://explorer.monad.xyz/tx/${h}`,
    address: (a) => `https://explorer.monad.xyz/address/${a}`,
  },
  dash: {
    tx: (h) => `https://blockchair.com/dash/transaction/${h}`,
    address: (a) => `https://blockchair.com/dash/address/${a}`,
  },
  stellar: {
    tx: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
    address: (a) => `https://stellar.expert/explorer/public/account/${a}`,
  },
  sui: {
    tx: (h) => `https://suivision.xyz/txblock/${h}`,
    address: (a) => `https://suivision.xyz/account/${a}`,
  },
  // 2026-05-25 — destination-only. Explorer matches SWAP_COIN_META.ADA
  // so a tx hash or address surfaced from either path lands on the same
  // explorer page.
  cardano: {
    tx: (h) => `https://cardanoscan.io/transaction/${h}`,
    address: (a) => `https://cardanoscan.io/address/${a}`,
  },
};

/** Map an IntentsBlockchain to the matching SwapChainKind for routing. */
export function blockchainToChainKind(blockchain: IntentsBlockchain): SwapChainKind {
  switch (blockchain) {
    case "eth":
    case "arb":
    case "base":
    case "op":
    case "pol":
    case "avax":
    case "bnb":
    case "monad": // Phase 3 — EVM-compatible
      return "EVM";
    case "btc":
      return "BTC";
    case "sol":
      return "SOLANA";
    case "near":
      return "NEAR";
    case "doge":
      return "DOGE";
    case "ltc":
      return "LTC";
    case "bch":
      return "BCH";
    case "dash":
      return "DASH";
    case "stellar":
      return "STELLAR";
    case "sui":
      return "SUI";
    case "cardano":
      // 2026-06-21 — ADA source. Without this case a synthesized
      // (symbol, "cardano") meta would fall to the EVM default and
      // mis-route ADA through the EVM branch of executeIntentsTrade.
      return "CARDANO";
    // ton / xrp / tron don't have direct chain kinds in the existing
    // union; they're destination-only so the chainKind value is never
    // used for actual broadcasting. Pick a safe default.
    default:
      return "EVM";
  }
}

/**
 * Resolve effective metadata for a (symbol, blockchain) pair. Falls back
 * to the static `SWAP_COIN_META[symbol]` entry when (a) the static entry
 * exists AND (b) its blockchain matches the requested one (or no
 * blockchain was requested). Synthesizes a new entry from the IntentsAsset
 * map when needed.
 */
export function getSwapCoinMeta(
  symbol: string,
  blockchain?: IntentsBlockchain
): SwapCoinMeta | null {
  const upper = symbol.toUpperCase();
  const staticEntry = SWAP_COIN_META[upper];

  // No blockchain hint: the static entry is the canonical answer.
  if (!blockchain) return staticEntry ?? null;

  // If a static entry exists AND its evmChainId matches the requested
  // blockchain (or its chainKind matches a non-EVM blockchain), we can
  // return the static entry directly.
  if (staticEntry) {
    const staticBlockchain = staticEntryBlockchain(staticEntry);
    if (staticBlockchain === blockchain) return staticEntry;
  }

  // Otherwise synthesize. Required: an IntentsAsset row for (symbol, blockchain).
  const asset = resolveAsset(symbol, blockchain);
  if (!asset) return null;

  const chainKind = blockchainToChainKind(blockchain);
  const rpcUrls = getRpcUrlsForBlockchain(blockchain);
  const explorer = EXPLORER_BY_BLOCKCHAIN[blockchain];
  const evmChainId = EVM_CHAIN_IDS[blockchain];

  const synthetic: SwapCoinMeta = {
    ticker: asset.symbol,
    chainKind,
    swapKitAsset: null, // synthetic entries are Intents-only
    nearIntentsAsset: asset.assetId,
    decimals: asset.decimals,
    sourceCapable: true, // dedup ensures only source-capable chains reach here
    explorerTxUrl: explorer.tx,
    explorerAddressUrl: explorer.address,
  };
  if (evmChainId !== undefined) synthetic.evmChainId = evmChainId;
  if (rpcUrls.length > 0) {
    synthetic.defaultRpcUrl = rpcUrls[0];
    synthetic.rpcFallbacks = rpcUrls;
  }
  // Thread the ERC-20 / SPL contract through to the source-tx builder so
  // it can branch on token vs native asset. When `contractAddress` is set,
  // the EVM source flow builds `transfer(address,uint256)` calldata
  // (Phase 1) and the SPL flow uses `tokenMint` (Phase 2).
  if (asset.contractAddress) synthetic.tokenContract = asset.contractAddress;
  return synthetic;
}

/** Reverse-engineer the IntentsBlockchain a static SWAP_COIN_META entry
 *  represents. Returns null for entries whose chain doesn't map to an
 *  IntentsBlockchain (XMR, ZEPH).
 */
function staticEntryBlockchain(meta: SwapCoinMeta): IntentsBlockchain | null {
  if (meta.chainKind === "BTC") return "btc";
  if (meta.chainKind === "SOLANA") return "sol";
  if (meta.chainKind === "NEAR") return "near";
  if (meta.chainKind === "DOGE") return "doge";
  if (meta.chainKind === "CARDANO") return "cardano";
  if (meta.chainKind === "EVM") {
    // Map evmChainId back to an IntentsBlockchain key.
    const id = meta.evmChainId;
    const entry = (Object.entries(EVM_CHAIN_IDS) as Array<[IntentsBlockchain, number]>)
      .find(([, v]) => v === id);
    return entry ? entry[0] : null;
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────
   Swap dropdown roster.

   The dropdown shows ONLY symbols satisfying both:
     (a) NEAR Intents has a bridge (or it's a Zephyr ecosystem ticker
         which routes through `ZephyrSwapModal` instead of 1Click; or
         XMR which routes through atomic swap, not Intents).
     (b) Pwnda has a working wallet pipeline — `tickerToChain(sym)`
         returns a chain in `ALL_CHAINS`, the adapter exposes balance,
         and the user can derive an address.

   Symbols that NEAR Intents bridges but Pwnda hides:
     - NEAR / TON: no Pwnda adapter (NEAR has signing-only — no balance)
     - USDC / USDT / ARB / OP / AAVE / LINK: ERC-20 / SPL tokens; the
       wallet adapters don't yet fetch token balances. Listing them
       without a balance row would mislead users into thinking the
       feature works when the source side would always read zero.

   Per-side filtering:
     - SOURCE (FROM): also requires Pwnda's Rust signer can produce a
       deposit tx for the symbol's chain. Source signers exist for
       eth/arb/base/op/pol/avax/bnb (EVM family), btc, sol — that gives
       us BTC, ETH, SOL today. Source signers NOT yet wired for
       doge/xrp/tron, so DOGE/XRP/TRX are destination-only.
     - DESTINATION (TO): just needs Pwnda to derive an address. Adds
       DOGE/XRP/TRX which Pwnda has adapters for (receive works) but
       can't sign source transactions for.

   Full asset roster + Pwnda intersection documented at
   PwndaWalletVault/wiki/concepts/near-intents-asset-roster.md. Update
   that page when this allowlist changes.
   ─────────────────────────────────────────────────────────────────*/

/**
 * Pwnda × NEAR Intents source intersection. Symbols that satisfy:
 *   - Native NEAR Intents bridge exists at `nep141:<sym>.omft.near`
 *   - Pwnda has a chain adapter (balance + address derivation)
 *   - Pwnda has a Rust source signer for the underlying chain
 *
 * Source signers in Rust (`src-tauri/src/swap/`):
 *   - swap_sign_evm  → eth (ChainKind::EVM)
 *   - swap_sign_psbt → btc, ltc, doge, bch — all four UtxoChain variants
 *                      handled by the dispatch in btc.rs (P2WPKH segwit
 *                      for BTC/LTC; legacy P2PKH for DOGE; P2PKH with
 *                      hand-rolled BIP-143-FORKID for BCH).
 *   - swap_sign_solana → sol
 *   - swap_sign_near_tx → near (no Pwnda balance pipeline → hidden anyway)
 *
 * ERC-20 / SPL token symbols (USDC, USDT, ARB, OP, AAVE, LINK) are
 * intentionally excluded — the wallet adapters don't yet fetch token
 * balances, so the dropdown would surface a row that always reads 0.
 * When token balance fetching ships, extend this list.
 */
const PWNDA_INTENTS_SOURCE_TICKERS: readonly string[] = [
  "BTC",
  "ETH",
  "SOL",
  "LTC",
  "DOGE", // Promoted source-capable 2026-05-08 (Phase 1, bch-doge plan)
  "BCH",  // Promoted source-capable 2026-05-08 (Phase 2, bch-doge plan)
  // ── multi-chain-token-integration-plan (2026-05-08) ───────────────
  // Phase 1 (ERC-20): USDC / USDT / DAI on every EVM chain.
  "USDC",
  "USDT",
  "DAI",
  // Phase 3 (Monad): MON native + EVM-compatible signer (chainId 143).
  "MON",
  // Phase 4 (BSC + L2 surface): BNB native + ETH on Arbitrum/Base/Optimism.
  "BNB",
  // Phase 5 (Dash): UTXO chain, extends UtxoChain enum.
  "DASH",
  // Phase 6 (Stellar): XDR signer.
  "XLM",
  // Phase 7 (Sui): BCS signer.
  "SUI",
  // Native AVAX + POL: routed via HOT-Omni nep245 envelope (their OMFT
  // entries 400'd; nep245 form is live as of 2026-05-08). Both ride the
  // existing EVM signer + the chain's existing wallet adapter.
  "AVAX",
  "POL",
  // 2026-06-21 — ADA promoted source-capable. Unlike every other entry
  // here, its deposit tx is signed in the TS Cardano stack (cardano-tx.ts
  // via executeCardanoTransfer), not a Rust swap_sign_* command. See
  // [[ada-swap-source]].
  "ADA",
];

/**
 * Pwnda × NEAR Intents destination intersection. Superset of the source
 * list — XRP and TRX are still destination-only because their signing
 * schemes (XRP ed25519 + sequence numbers, TRX TRON-specific tx
 * encoding) are separate modules from the UTXO PSBT signer and haven't
 * been wired to the swap pipeline yet.
 */
const PWNDA_INTENTS_DESTINATION_TICKERS: readonly string[] = [
  "BTC",
  "ETH",
  "SOL",
  "LTC",
  "BCH",
  "DOGE",
  "XRP",
  "TRX",
  // 2026-05-08 multi-chain expansion (mirrors PWNDA_INTENTS_SOURCE_TICKERS
  // since destination receive works for every chain we have an adapter for).
  "USDC",
  "USDT",
  "DAI",
  "MON",
  "BNB",
  "DASH",
  "XLM",
  "SUI",
  "AVAX",
  "POL",
  // ADA — bidirectional as of 2026-06-21 (also in the source list above;
  // receives land in the dashboard's Cardano panel).
  "ADA",
];

/** Zephyr ecosystem assets are NOT in the NEAR Intents dropdown — they
 *  route through `ZephyrSwapModal` via the dedicated `ZephyrEcosystemSwapCard`
 *  on the swap dashboard. Mixing them into the cross-chain dropdown
 *  produced two UX bugs: (1) destination didn't auto-switch when source
 *  became Zephyr, and (2) the user got locked into Zephyr-only with no
 *  way to switch back to a normal cross-chain swap. Separating routing
 *  is cleaner — Zephyr has its own card the same way SwapKit and NEAR
 *  Intents are conceptually separate routers. */

/**
 * Assets tradable on the `pwnda-desk` atomic-swap desk, DERIVED from the
 * registry rather than duplicated as a parallel list (the whole point of
 * the 2026-05-25 capability-registry refactor — a hardcoded second list is
 * exactly how the three-bugs-in-a-day pattern started).
 *
 * This is what finally puts XMR and ZEPH in the cross-chain dropdowns:
 * before the desk they had no route at all (`swapKitAsset` and
 * `nearIntentsAsset` both null), so they were excluded and handled by the
 * separate Zephyr card / atomic placeholder. The desk gives them one, in
 * BOTH directions — the desk tier signs their side, so they contribute to
 * the source and destination rosters alike. The leader legs (LTC/ADA/AVAX)
 * are already in the Intents lists; the union just adds the followers.
 */
const DESK_TICKERS: readonly string[] = Object.values(ASSET_CAPABILITIES)
  .filter((c) => c.atomicDesk)
  .map((c) => c.ticker);

export function getDropdownTickers(opts: {
  sourceOnly?: boolean;
  /**
   * Narrow the roster to what THIS router can actually carry.
   *
   * Omit (or pass `"auto"`) for the union — correct for the Auto tab, where
   * any router may serve the pair. Pass `"intents"` when the user has pinned
   * NEAR Intents: the desk-only assets (XMR/ZEPH) are not on 1Click at all,
   * and offering them on that tab produces a pick that can only ever answer
   * "no route".
   */
  router?: string;
} = {}): string[] {
  // Destination side adds the receive-only natives (XRP/TRX/ADA…); source
  // side is the sign-capable subset. Desk-tradable assets (XMR/ZEPH) are
  // unioned in on both sides — the pair-level `isDeskRoutableFromRegistry`
  // check is what actually gates a quote, so a non-desk pairing like
  // XMR→BTC still falls through to "no route" rather than being offered.
  const base = opts.sourceOnly
    ? [...PWNDA_INTENTS_SOURCE_TICKERS]
    : [...PWNDA_INTENTS_DESTINATION_TICKERS];

  // On the NEAR tab, derive the roster from the CAPABILITY REGISTRY rather
  // than trusting the hand-kept arrays above to agree with it (2026-08-25).
  // They did not: LTC sat in `PWNDA_INTENTS_SOURCE_TICKERS` while
  // `ASSET_CAPABILITIES.LTC.nearIntentsAsset` was still null, so the picker
  // offered a coin the route gate then refused. Filtering by the same field
  // `isIntentsRoutableFromRegistry` reads makes the picker and the gate agree
  // BY CONSTRUCTION instead of by two lists being edited together.
  if (opts.router === "intents") {
    return base
      .filter((t) => !!ASSET_CAPABILITIES[t.toUpperCase()]?.nearIntentsAsset)
      .sort((a, b) => {
        const ra = assetRank(a);
        const rb = assetRank(b);
        return ra !== rb ? ra - rb : a.localeCompare(b);
      });
  }

  const list = [...new Set([...base, ...DESK_TICKERS])];
  // "Smart" order: a fixed market-cap / prominence rank (stablecoins last),
  // shared with the portfolio tiebreak via `assetRank` so the swap pickers
  // and the wallet list feel consistent. Sorting here (rather than
  // reordering the membership arrays) keeps "what's included" and "in what
  // order" as separate concerns.
  return list.sort((a, b) => {
    const ra = assetRank(a);
    const rb = assetRank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

/** True when the ticker is destination-only — Pwnda has the adapter to
 *  receive but lacks the Rust source signer to send. The dropdown UI
 *  uses this to label such rows so users understand why selecting them
 *  on the FROM side wouldn't work. */
export function isDestinationOnlyTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  if (PWNDA_INTENTS_SOURCE_TICKERS.includes(t)) return false;
  return PWNDA_INTENTS_DESTINATION_TICKERS.includes(t);
}
