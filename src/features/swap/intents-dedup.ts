/**
 * Deduplication + chain-sub-selection helpers for the NEAR Intents
 * asset surface.
 *
 * Many tokens are bridged across multiple chains — USDC alone has six
 * (Ethereum, Arbitrum, Base, Optimism, Polygon, Solana). Listing the
 * symbol six times in the swap dropdown wastes the user's attention.
 * Instead we group by underlying-asset symbol and surface a chain
 * sub-selector when the user picks a multi-chain symbol.
 *
 * Two views needed:
 *
 *   - **Source view**: only blockchains the wallet can sign on. If
 *     `USDC` has six entries but only EVM + Solana sources are
 *     wallet-signable, the source dropdown shows USDC and the chain
 *     sub-selector lists Ethereum / Arbitrum / Base / Optimism /
 *     Polygon / Solana — but not non-source-capable chains.
 *
 *   - **Destination view**: every chain NEAR Intents supports. The
 *     destination is just an address; the wallet doesn't need to sign
 *     anything there, so the full coverage is exposed.
 */

import {
  NEAR_INTENTS_ASSETS,
  type IntentsAsset,
  type IntentsBlockchain,
} from "./near-intents-assets.generated";
// Wallet capability is deliberately NOT imported from the generated file — see
// the header there and `intents-source-capability.ts` for why the two were split.
import { SOURCE_CAPABLE_BLOCKCHAINS } from "./intents-source-capability";

// ---------------------------------------------------------------------------
// Symbol-keyed grouping
// ---------------------------------------------------------------------------

const BY_SYMBOL: Map<string, IntentsAsset[]> = (() => {
  const m = new Map<string, IntentsAsset[]>();
  for (const a of NEAR_INTENTS_ASSETS) {
    const key = a.symbol.toUpperCase();
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(a);
  }
  // Stable-order each group by blockchain id for deterministic UI.
  for (const [, list] of m) {
    list.sort((a, b) => a.blockchain.localeCompare(b.blockchain));
  }
  return m;
})();

const BY_ASSET_ID: Map<string, IntentsAsset> = (() => {
  const m = new Map<string, IntentsAsset>();
  for (const a of NEAR_INTENTS_ASSETS) m.set(a.assetId, a);
  return m;
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Every entry in NEAR_INTENTS_ASSETS for a given symbol — across every
 * blockchain. Use this for the destination dropdown's chain sub-selector.
 */
export function chainsForSymbol(symbol: string): IntentsAsset[] {
  return BY_SYMBOL.get(symbol.toUpperCase()) ?? [];
}

/**
 * Subset of `chainsForSymbol(symbol)` filtered to chains the wallet can
 * sign on. Use for the source dropdown's chain sub-selector. Empty when
 * no entry for this symbol is source-capable (e.g. a token only bridged
 * to TON, which we don't sign on).
 */
export function sourceChainsForSymbol(symbol: string): IntentsAsset[] {
  return chainsForSymbol(symbol).filter((a) =>
    SOURCE_CAPABLE_BLOCKCHAINS.has(a.blockchain)
  );
}

/**
 * Pwnda-aware source-chain filter — stricter than {@link sourceChainsForSymbol}.
 * Returns only chains where:
 *   - The blockchain is in `SOURCE_CAPABLE_BLOCKCHAINS` (Rust signer exists), AND
 *   - Pwnda surfaces a balance for the underlying symbol on that chain
 *     (i.e. the symbol IS the chain's native gas token).
 *
 * Why this matters: NEAR Intents bridges ETH on Ethereum AND Arbitrum
 * AND Base AND Optimism. Pwnda's `evm-factory` signs on all of those
 * (one EVM key works for any chainId), but the dashboard only shows the
 * Ethereum L1 ETH balance — the same key on Arbitrum is a separate
 * balance the wallet doesn't fetch. Surfacing "ETH on Arbitrum" as a
 * source option would let the user pick a chain where their visible
 * balance is wrong/empty.
 *
 * For symbols whose native chain is in this map, only that chain is
 * returned. For ERC-20 / SPL tokens (USDC, USDT, ARB, etc.) where the
 * symbol has NO native chain, returns empty — those tokens shouldn't be
 * source-side until per-token balance fetching ships.
 */
const SYMBOL_NATIVE_CHAIN: Partial<Record<string, IntentsBlockchain>> = {
  ETH: "eth",
  BTC: "btc",
  SOL: "sol",
  LTC: "ltc",
  BCH: "bch",
  DOGE: "doge",
  XRP: "xrp",
  TRX: "tron",
  POL: "pol",
  AVAX: "avax",
  BNB: "bnb",
  NEAR: "near",
  TON: "ton",
  // 2026-06-21 — ADA is now bidirectional. `cardano` IS in
  // SOURCE_CAPABLE_BLOCKCHAINS (TS-signed source — see [[ada-swap-source]]),
  // so `pwndaSourceChainsForSymbol("ADA")` returns the single Cardano
  // entry and ADA surfaces on the FROM side too; the destination path
  // still returns it for the "on Cardano" chain pill.
  ADA: "cardano",
};

export function pwndaSourceChainsForSymbol(symbol: string): IntentsAsset[] {
  const sym = symbol.toUpperCase();
  const nativeBlockchain = SYMBOL_NATIVE_CHAIN[sym];
  if (!nativeBlockchain) {
    // ERC-20 / SPL token (USDC, USDT, ARB, OP, AAVE, LINK) — no native
    // chain means no balance pipeline in Pwnda. Source-side empty until
    // token balance fetching lands.
    return [];
  }
  // Restrict to the symbol's native chain entry, gated on source-capable.
  return chainsForSymbol(sym).filter(
    (a) =>
      a.blockchain === nativeBlockchain &&
      SOURCE_CAPABLE_BLOCKCHAINS.has(a.blockchain)
  );
}

/**
 * Pwnda-aware destination-chain filter. Mirrors {@link pwndaSourceChainsForSymbol}
 * for the receive side: only chains where the symbol IS that chain's
 * native gas token AND Pwnda has a wallet adapter for that L1.
 *
 * Why this is the right invariant for destination too:
 *   - The user wants to RECEIVE on a chain where they can later see and
 *     interact with the funds.
 *   - Pwnda has explicit chain adapters for `ethereum`, `polygon`,
 *     `avalanche`, `flare`, `bitcoin`, `solana`, `litecoin`, `dogecoin`,
 *     `bitcoin-cash`, `xrp`, `tron`, `ravencoin`, `conflux`, `hedera`,
 *     `algorand`, `cardano`, `monero`, `zephyr`. Pwnda does NOT have
 *     separate `arbitrum` / `base` / `optimism` / `bsc` adapters — those
 *     reuse the EVM key but only show as the parent chain's address in
 *     the dashboard. Receiving "ETH on Arbitrum" would land at the user's
 *     EVM address but they'd see nothing in Pwnda; they'd need a separate
 *     L2 explorer to confirm.
 *   - Per user request, the destination chain sub-selector now only
 *     shows L1 chains Pwnda surfaces directly. So ETH destination →
 *     "Ethereum" only; arb/base/op/bnb don't appear in the picker.
 *
 * For ERC-20 / SPL tokens (USDC etc.), this returns empty — same reason
 * as source-side. When token balance fetching ships, those land in the
 * dropdown with their corresponding native chain only.
 */
export function pwndaDestinationChainsForSymbol(symbol: string): IntentsAsset[] {
  const sym = symbol.toUpperCase();
  const nativeBlockchain = SYMBOL_NATIVE_CHAIN[sym];
  if (!nativeBlockchain) return [];
  return chainsForSymbol(sym).filter((a) => a.blockchain === nativeBlockchain);
}

/**
 * Deduplicated symbols, ordered for UI. Native chains first (ETH, BTC,
 * SOL, NEAR, …), then alphabetically. Optional source-capable filter.
 */
export function dedupSymbols(opts: { sourceOnly?: boolean } = {}): string[] {
  const NATIVE_ORDER = [
    "BTC",
    "ETH",
    "SOL",
    "NEAR",
    "POL",
    "AVAX",
    "BNB",
    "DOGE",
    "XRP",
    "TRX",
    "TON",
  ];
  const seen = new Set<string>();
  for (const a of NEAR_INTENTS_ASSETS) {
    if (opts.sourceOnly && !SOURCE_CAPABLE_BLOCKCHAINS.has(a.blockchain)) continue;
    seen.add(a.symbol.toUpperCase());
  }
  return Array.from(seen).sort((a, b) => {
    const ai = NATIVE_ORDER.indexOf(a);
    const bi = NATIVE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/**
 * True when the symbol exists on more than one blockchain Pwnda surfaces
 * for the requested side. Both source and destination sides restrict to
 * chains where Pwnda has a wallet adapter (i.e. the symbol IS that
 * chain's native gas token in Pwnda's adapter set). For most symbols
 * that's exactly one chain, so the sub-selector renders as a static
 * "on Bitcoin" / "on Ethereum" label rather than a dropdown.
 */
export function isMultiChainSymbol(
  symbol: string,
  opts: { sourceOnly?: boolean } = {}
): boolean {
  const list = opts.sourceOnly
    ? pwndaSourceChainsForSymbol(symbol)
    : pwndaDestinationChainsForSymbol(symbol);
  return list.length > 1;
}

/**
 * The default blockchain for a symbol — the L1 native chain Pwnda
 * surfaces for it. Same set on source + destination so the form's
 * default state never lands on a chain the dashboard doesn't display.
 * Used as the auto-pick when the user picks a symbol from the top-level
 * dropdown.
 */
export function defaultBlockchainFor(
  symbol: string,
  opts: { sourceOnly?: boolean } = {}
): IntentsBlockchain | null {
  const list = opts.sourceOnly
    ? pwndaSourceChainsForSymbol(symbol)
    : pwndaDestinationChainsForSymbol(symbol);
  return list[0]?.blockchain ?? null;
}

/**
 * Resolve a (symbol, blockchain) pair to its full IntentsAsset, including
 * the asset id we need for the quote body.
 */
export function resolveAsset(
  symbol: string,
  blockchain: IntentsBlockchain
): IntentsAsset | null {
  const list = chainsForSymbol(symbol);
  return list.find((a) => a.blockchain === blockchain) ?? null;
}

/** Reverse lookup — useful for tests / diagnostics. */
export function lookupByAssetId(assetId: string): IntentsAsset | null {
  return BY_ASSET_ID.get(assetId) ?? null;
}

// ---------------------------------------------------------------------------
// Routing capability
// ---------------------------------------------------------------------------

/**
 * Whether a (symbol, blockchain) pair is routable as a SOURCE in v1.x.
 * Wraps the `SOURCE_CAPABLE_BLOCKCHAINS` set + asset-existence check.
 */
export function isSourceCapableAsset(
  symbol: string,
  blockchain: IntentsBlockchain
): boolean {
  if (!SOURCE_CAPABLE_BLOCKCHAINS.has(blockchain)) return false;
  return resolveAsset(symbol, blockchain) !== null;
}

/**
 * True when both sides are valid Intents-known assets — quote can be
 * built. The destination side has no source-capability requirement.
 */
export function isAnyToAnyRoutable(
  fromSymbol: string,
  fromBlockchain: IntentsBlockchain,
  toSymbol: string,
  toBlockchain: IntentsBlockchain
): boolean {
  if (!isSourceCapableAsset(fromSymbol, fromBlockchain)) return false;
  return resolveAsset(toSymbol, toBlockchain) !== null;
}
