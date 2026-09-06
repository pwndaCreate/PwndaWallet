/**
 * Stablecoin registry — USDC / USDT / USDT0 across every EVM chain this
 * wallet can already sign for.
 *
 * # Why a registry and not thirteen loose adapters
 *
 * Before 2026-09-02 the wallet shipped exactly ONE stablecoin, `usdt-avax`,
 * as a standalone chain row. That is fine for one token and wrong for
 * thirteen: the user sees "USDT (AVAX)" next to "USDT (BSC)" next to
 * "USDC (Base)" as if they were unrelated coins, when what they actually
 * hold is *USDT, on several networks*. Exodus stacks them — one row per
 * symbol, a network breakdown behind it, one total — and that is the model
 * this file exists to support.
 *
 * Internally each (symbol, network) pair is still its own `ChainType` with
 * its own adapter, so send / receive / history / swap all work through the
 * machinery that already exists. Only the PRESENTATION is grouped; see
 * `groupStablecoins` and the assets rail in `WalletLandscapeView`.
 *
 * # Every address here was verified on-chain
 *
 * Not recalled, not copied from a doc. Each contract below was queried live
 * for `symbol()`, `name()` and `decimals()` before being added, because a
 * wrong contract address is a wrong balance or a send into a void. Two
 * results changed what shipped:
 *
 *  - **Polygon's USDT is now USDT0.** `0xc2132D05…` answers `symbol() =
 *    "USDT0"`, `name() = "USDT0"` — it migrated to the LayerZero OFT. Filing
 *    it under USDT would have mislabeled it.
 *  - **Bridged USDC still answers `symbol() = "USDC"`.** Arbitrum's
 *    `0xFF970A61…` ("USD Coin (Arb1)") and Optimism's `0x7F5c764c…` are
 *    USDC.e — a *different token* with its own liquidity that reports the
 *    same symbol. Shipping either as "USDC" would show a balance the user
 *    cannot spend as native USDC. Both are excluded, deliberately; the
 *    `symbol()` check alone would not have caught them, which is why the
 *    verification also read `name()`.
 *
 * Decimals are per-contract, never assumed: BSC's USDC and USDT are **18**,
 * everywhere else is 6.
 *
 * # Adding a network
 *
 * Verify first. `scripts/verify-stablecoins.mjs` reads symbol/name/decimals
 * from the chain and refuses anything that disagrees with the row.
 */
import type { ChainType } from "./types";

/** The three stablecoin families this wallet carries. */
export type StablecoinSymbol = "USDC" | "USDT" | "USDT0";

export interface StablecoinNetwork {
  /** The dedicated `ChainType` for this (symbol, network) pair. */
  chain: ChainType;
  /** The chain the token lives on — its native-gas parent. */
  parent: ChainType;
  /** Short label for the network row ("Ethereum", "BNB Smart Chain"). */
  network: string;
  /** ERC-20 contract. Verified on-chain — see the header. */
  contract: string;
  /** Verified via `decimals()`. BSC is 18; everything else is 6. */
  decimals: number;
  /**
   * Whether NEAR Intents carries this exact (symbol, network) leg AND this
   * wallet can sign a deposit from its parent chain. Drives the "swappable"
   * hint on the network row — the wallet should not offer a route it cannot
   * execute. See `intents-source-capability.ts` for the signer half.
   */
  nearIntents: boolean;
}

export interface StablecoinFamily {
  symbol: StablecoinSymbol;
  displayName: string;
  /** Brand fill used for the coin mark. */
  color: string;
  networks: StablecoinNetwork[];
}

export const STABLECOINS: StablecoinFamily[] = [
  {
    symbol: "USDC",
    displayName: "USD Coin",
    color: "#2775ca",
    networks: [
      { chain: "usdc-eth",  parent: "ethereum",  network: "Ethereum",        contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6,  nearIntents: true },
      { chain: "usdc-arb",  parent: "arbitrum",  network: "Arbitrum",        contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6,  nearIntents: true },
      { chain: "usdc-base", parent: "base",      network: "Base",            contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6,  nearIntents: true },
      { chain: "usdc-op",   parent: "optimism",  network: "Optimism",        contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6,  nearIntents: true },
      { chain: "usdc-pol",  parent: "polygon",   network: "Polygon",         contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6,  nearIntents: true },
      { chain: "usdc-avax", parent: "avalanche", network: "Avalanche",       contract: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6,  nearIntents: true },
      { chain: "usdc-bsc",  parent: "bsc",       network: "BNB Smart Chain", contract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, nearIntents: true },
      // SPL mint, not an ERC-20 contract. Verified: owner = SPL Token program,
      // parsed account type = `mint`, decimals from `getTokenSupply`.
      { chain: "usdc-sol",  parent: "solana",    network: "Solana",          contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, nearIntents: true },
    ],
  },
  {
    symbol: "USDT",
    displayName: "Tether USD",
    color: "#26a17b",
    networks: [
      { chain: "usdt-eth",  parent: "ethereum",  network: "Ethereum",        contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6,  nearIntents: true },
      // Pre-existing chain (the wallet's only stablecoin before this pass).
      // `symbol()` reports "USDt" and `name()` "TetherToken" — Avalanche's
      // Tether deployment, not a different token.
      { chain: "usdt-avax", parent: "avalanche", network: "Avalanche",       contract: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6,  nearIntents: true },
      { chain: "usdt-op",   parent: "optimism",  network: "Optimism",        contract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6,  nearIntents: true },
      { chain: "usdt-bsc",  parent: "bsc",       network: "BNB Smart Chain", contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, nearIntents: true },
      { chain: "usdt-sol",  parent: "solana",    network: "Solana",          contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, nearIntents: true },
      // TRC-20, verified symbol() = "USDT" / decimals() = 6. One of the most
      // widely held stablecoin legs anywhere, and the wallet could not read it
      // at all before 2026-09-02. `nearIntents: false` — NEAR Intents carries
      // USDT on Tron, but this wallet has no Tron SOURCE signer registered in
      // `intents-source-capability.ts`, so offering the route would offer a
      // swap the wallet cannot execute.
      { chain: "usdt-tron", parent: "tron",      network: "Tron",            contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, nearIntents: false },
    ],
  },
  {
    symbol: "USDT0",
    displayName: "USD₮0",
    color: "#26a17b",
    networks: [
      // Arbitrum's USDT migrated to this contract; `symbol()` = "USD₮0".
      { chain: "usdt0-arb", parent: "arbitrum", network: "Arbitrum", contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, nearIntents: true },
      // Same migration on Polygon — verified `symbol()` = "USDT0".
      { chain: "usdt0-pol", parent: "polygon",  network: "Polygon",  contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, nearIntents: false },
    ],
  },
];

/** Flat view of every (symbol, network) pair. */
export const STABLECOIN_NETWORKS: ReadonlyArray<
  StablecoinNetwork & { symbol: StablecoinSymbol }
> = STABLECOINS.flatMap((f) => f.networks.map((n) => ({ ...n, symbol: f.symbol })));

/** Every `ChainType` that is a stablecoin leg rather than a network of its own. */
export const STABLECOIN_CHAINS: ReadonlySet<ChainType> = new Set(
  STABLECOIN_NETWORKS.map((n) => n.chain),
);

export function isStablecoinChain(chain: ChainType): boolean {
  return STABLECOIN_CHAINS.has(chain);
}

/** The registry row for a stablecoin chain, or undefined for a normal chain. */
export function stablecoinNetworkFor(
  chain: ChainType,
): (StablecoinNetwork & { symbol: StablecoinSymbol }) | undefined {
  return STABLECOIN_NETWORKS.find((n) => n.chain === chain);
}

export function familyFor(symbol: StablecoinSymbol): StablecoinFamily | undefined {
  return STABLECOINS.find((f) => f.symbol === symbol);
}

/** One stacked row: the family plus its per-network balances and a total. */
export interface StablecoinGroup {
  symbol: StablecoinSymbol;
  displayName: string;
  color: string;
  /** Sum across networks. `null` when NOTHING could be read — distinct from a
   *  real zero, so the UI can show "—" rather than claiming $0. */
  total: number | null;
  rows: Array<{
    chain: ChainType;
    network: string;
    /** Raw decimal string as the adapter reported it, or undefined. */
    balance: string | undefined;
    amount: number | null;
    nearIntents: boolean;
  }>;
}

/**
 * Collapse per-network balances into one row per symbol.
 *
 * A network whose balance is missing or non-numeric ("—", an error string)
 * contributes `null`, not 0 — a chain that failed to load is NOT a chain
 * holding nothing, and summing it as zero is how a total quietly understates
 * what the user owns. The total is `null` only when EVERY network failed.
 */
export function groupStablecoins(
  balancesByChain: Partial<Record<ChainType, string>>,
): StablecoinGroup[] {
  return STABLECOINS.map((family) => {
    let total: number | null = null;
    const rows = family.networks.map((n) => {
      const balance = balancesByChain[n.chain];
      const parsed =
        balance != null && /^-?\d+(\.\d+)?$/.test(balance.trim())
          ? Number(balance)
          : null;
      if (parsed != null && Number.isFinite(parsed)) {
        total = (total ?? 0) + parsed;
      }
      return {
        chain: n.chain,
        network: n.network,
        balance,
        amount: parsed,
        nearIntents: n.nearIntents,
      };
    });
    return {
      symbol: family.symbol,
      displayName: family.displayName,
      color: family.color,
      total,
      rows,
    };
  });
}
