import type { ChainType } from "./types";

/**
 * Pure-data per-chain display metadata.
 *
 * This file deliberately has NO runtime imports from `./*-wallet.ts` so it
 * can be linked into mining-only builds (e.g. Pwnda Lite) without dragging
 * in every chain adapter implementation. Anything mining UI needs from a
 * chain — ticker, display name, brand color, address placeholder — comes
 * from here.
 *
 * Keep this file in sync with the `displayName` / `ticker` / `color` /
 * `addressPlaceholder` fields on each `ChainAdapter`. The full wallet
 * still exposes `getAdapter(chain)` for code that needs the runtime
 * crypto methods; mining code must use `getCoinMeta(chain)` instead.
 *
 * Audited 2026-05-13 — every entry mirrors the corresponding adapter's
 * static fields. EVM placeholders all default to "0x..." (see
 * `evm-factory.ts::createEvmAdapter`).
 */
export interface CoinMeta {
  ticker: string;
  displayName: string;
  color: string;
  addressPlaceholder: string;
}

/**
 * NOTE ON `color`: these are readability colours, NOT brand reproductions.
 *
 * They are drawn on `#0a0a0a` — as the active coin's name, its icon tint and
 * a 2px selected border. Several entries were the brand's own near-black hex
 * (XRP #23292f, Algorand #000000, Zano #0e0e10, …) which renders as an
 * invisible smudge: reported 2026-08-28 as "zano is a black text and I cant
 * see it", and a contrast sweep then found six more with the same defect.
 *
 * `coin-metadata.contrast.test.ts` enforces >= 3.0:1 against the background,
 * for BOTH this table and every adapter's `color` — they must be identical,
 * because the asset rail reads `getAdapter(chain).color` and the mining picker
 * reads this one. Correcting only this table is what happened on 2026-08-28:
 * eight adapters kept their literal brand hex (algorand #000000, zano #0e0e10)
 * and the test passed anyway. See [[coin-colour-rules]] before adding a coin.
 * so pasting a dark brand hex here now fails a test instead of shipping an
 * invisible asset. Pick a lighter variant of the brand hue.
 */
export const COIN_METADATA: Record<ChainType, CoinMeta> = {
  ethereum: {
    ticker: "ETH",
    displayName: "Ethereum",
    color: "#627eea",
    addressPlaceholder: "0x...",
  },
  avalanche: {
    ticker: "AVAX",
    displayName: "Avalanche",
    color: "#e84142",
    addressPlaceholder: "0x...",
  },
  "usdt-avax": {
    ticker: "USDT",
    displayName: "USDT (AVAX)",
    color: "#26a17b",
    addressPlaceholder: "0x...",
  },
  "usdt-eth": {
    ticker: "USDT",
    displayName: "USDT (Ethereum)",
    color: "#26a17b",
    addressPlaceholder: "0x...",
  },
  "usdt-op": {
    ticker: "USDT",
    displayName: "USDT (Optimism)",
    color: "#26a17b",
    addressPlaceholder: "0x...",
  },
  "usdt-bsc": {
    ticker: "USDT",
    displayName: "USDT (BNB Chain)",
    color: "#26a17b",
    addressPlaceholder: "0x...",
  },
  "usdc-eth": {
    ticker: "USDC",
    displayName: "USDC (Ethereum)",
    color: "#2775ca",
    addressPlaceholder: "0x...",
  },
  "usdc-arb": {
    ticker: "USDC",
    displayName: "USDC (Arbitrum)",
    color: "#2775ca",
    addressPlaceholder: "0x...",
  },
  "usdc-base": {
    ticker: "USDC",
    displayName: "USDC (Base)",
    color: "#2775ca",
    addressPlaceholder: "0x...",
  },
  "usdc-op": {
    ticker: "USDC",
    displayName: "USDC (Optimism)",
    color: "#2775ca",
    addressPlaceholder: "0x...",
  },
  "usdc-pol": {
    ticker: "USDC",
    displayName: "USDC (Polygon)",
    color: "#2775ca",
    addressPlaceholder: "0x...",
  },
  "usdc-avax": {
    ticker: "USDC",
    displayName: "USDC (Avalanche)",
    color: "#2775ca",
    addressPlaceholder: "0x...",
  },
  "usdc-bsc": {
    ticker: "USDC",
    displayName: "USDC (BNB Chain)",
    color: "#2775ca",
    addressPlaceholder: "0x...",
  },
  "usdt0-arb": {
    ticker: "USDT0",
    displayName: "USD₮0 (Arbitrum)",
    color: "#1e9e78",
    addressPlaceholder: "0x...",
  },
  "usdt0-pol": {
    ticker: "USDT0",
    displayName: "USD₮0 (Polygon)",
    color: "#1e9e78",
    addressPlaceholder: "0x...",
  },
  "usdc-sol": {
    ticker: "USDC",
    displayName: "USDC (Solana)",
    color: "#2775ca",
    addressPlaceholder: "Solana address…",
  },
  "usdt-sol": {
    ticker: "USDT",
    displayName: "USDT (Solana)",
    color: "#26a17b",
    addressPlaceholder: "Solana address…",
  },
  "usdt-tron": {
    ticker: "USDT",
    displayName: "USDT (Tron)",
    color: "#26a17b",
    addressPlaceholder: "T...",
  },
  polygon: {
    ticker: "POL",
    displayName: "Polygon",
    color: "#8247e5",
    addressPlaceholder: "0x...",
  },
  flare: {
    ticker: "FLR",
    displayName: "Flare",
    color: "#e62058",
    addressPlaceholder: "0x...",
  },
  bitcoin: {
    ticker: "BTC",
    displayName: "Bitcoin",
    color: "#f7931a",
    addressPlaceholder: "bc1...",
  },
  solana: {
    ticker: "SOL",
    displayName: "Solana",
    color: "#9945ff",
    addressPlaceholder: "So1...",
  },
  xrp: {
    ticker: "XRP",
    displayName: "XRP",
    color: "#bac6d4",
    addressPlaceholder: "r...",
  },
  tron: {
    ticker: "TRX",
    displayName: "TRON",
    color: "#eb0029",
    addressPlaceholder: "T...",
  },
  cardano: {
    ticker: "ADA",
    displayName: "Cardano",
    color: "#4a8bf0",
    addressPlaceholder: "addr1...",
  },
  monero: {
    ticker: "XMR",
    displayName: "Monero",
    color: "#ff6600",
    addressPlaceholder: "4... or 8...",
  },
  zephyr: {
    ticker: "ZEPH",
    displayName: "Zephyr",
    color: "#3ab0ff",
    addressPlaceholder: "ZEPHYR... or ZEPHi...",
  },
  dogecoin: {
    ticker: "DOGE",
    displayName: "Dogecoin",
    color: "#c2a633",
    addressPlaceholder: "D...",
  },
  ravencoin: {
    ticker: "RVN",
    displayName: "Ravencoin",
    color: "#7681d4",
    addressPlaceholder: "R...",
  },
  conflux: {
    ticker: "CFX",
    displayName: "Conflux",
    color: "#8f8fe0",
    addressPlaceholder: "cfx:...",
  },
  hedera: {
    ticker: "HBAR",
    displayName: "Hedera",
    color: "#00d4aa",
    addressPlaceholder: "0.0.xxxxx",
  },
  algorand: {
    ticker: "ALGO",
    displayName: "Algorand",
    color: "#b8c2cc",
    addressPlaceholder: "ALGO...",
  },
  litecoin: {
    ticker: "LTC",
    displayName: "Litecoin",
    color: "#345d9d",
    addressPlaceholder: "ltc1...",
  },
  "bitcoin-cash": {
    ticker: "BCH",
    displayName: "Bitcoin Cash",
    color: "#0ac18e",
    addressPlaceholder: "bitcoincash:q...",
  },
  arbitrum: {
    ticker: "ETH",
    displayName: "Arbitrum",
    color: "#28a0f0",
    addressPlaceholder: "0x...",
  },
  base: {
    ticker: "ETH",
    displayName: "Base",
    color: "#0052ff",
    addressPlaceholder: "0x...",
  },
  optimism: {
    ticker: "ETH",
    displayName: "Optimism",
    color: "#ff0420",
    addressPlaceholder: "0x...",
  },
  bsc: {
    ticker: "BNB",
    displayName: "BNB Smart Chain",
    color: "#f3ba2f",
    addressPlaceholder: "0x...",
  },
  monad: {
    ticker: "MON",
    displayName: "Monad",
    color: "#7c3aed",
    addressPlaceholder: "0x...",
  },
  dash: {
    ticker: "DASH",
    displayName: "Dash",
    color: "#008de4",
    addressPlaceholder: "X...",
  },
  stellar: {
    ticker: "XLM",
    displayName: "Stellar",
    color: "#7b86ff",
    addressPlaceholder: "G...",
  },
  sui: {
    ticker: "SUI",
    displayName: "Sui",
    color: "#4ca3ff",
    addressPlaceholder: "0x...",
  },
  ergo: {
    ticker: "ERG",
    displayName: "Ergo",
    color: "#FF5829",
    addressPlaceholder: "9...",
  },
  aptos: {
    ticker: "APT",
    displayName: "Aptos",
    // Aptos brands near-black; #4ad4c4 keeps the teal accent and clears
    // the 3:1 floor. See [[coin-colour-rules]].
    color: "#4ad4c4",
    addressPlaceholder: "0x...",
  },
  near: {
    ticker: "NEAR",
    displayName: "NEAR Protocol",
    color: "#00c08b",
    addressPlaceholder: "<64-char hex implicit account>",
  },
  zano: {
    ticker: "ZANO",
    displayName: "Zano",
    // Zano's wordmark is near-black on white. Reproducing that literally
    // made the coin INVISIBLE on this wallet's dark surfaces — reported
    // 2026-08-28: the mining picker showed an empty row with only
    // "ProgPowZ" under it, because the name was rendered in #0e0e10 on
    // #0a0a0a. Every other entry in this table is a colour chosen to read
    // against the dark UI, not a brand hex copied verbatim, so this now uses
    // the blue from Zano's logo mark instead of the black from its wordmark.
    color: "#3ba0f5",
    addressPlaceholder: "Zx...",
  },
};

export function getCoinMeta(chain: ChainType): CoinMeta {
  return COIN_METADATA[chain];
}

/**
 * Frozen list of every supported `ChainType`. Equivalent to the
 * `ALL_CHAINS` export from `./index.ts` but lives here so mining code
 * can iterate over the chain list without importing the runtime adapter
 * barrel. Mining UI uses this for pickers, profitability strips, etc.
 */
export const ALL_CHAINS: ChainType[] = Object.keys(COIN_METADATA) as ChainType[];

/**
 * Canonical display order for assets — roughly market cap / prominence
 * (2026), with stablecoins grouped last. Display-only: it has NO effect on
 * derivation, balances, or routing. Two consumers share it so the wallet
 * and the swap feel consistent:
 *   - the swap asset pickers (`getDropdownTickers`) render in this order;
 *   - the portfolio list uses it as the tiebreak AFTER sorting by holdings
 *     value, so the biggest holdings lead and everything else follows this
 *     prominence order rather than the arbitrary derivation order.
 * Tickers not listed sort to the end — callers add a stable secondary key.
 */
export const CANONICAL_ASSET_ORDER: readonly string[] = [
  // Majors, descending market cap (approx, 2026).
  "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "TRX", "POL",
  "LTC", "BCH", "NEAR", "XLM", "SUI", "APT", "DASH", "MON", "FLR",
  // Long-tail L1s Pwnda surfaces.
  "RVN", "CFX", "HBAR", "ALGO", "ERG",
  // Privacy + Pwnda-native Zephyr ecosystem.
  "XMR", "ZEPH", "ZEPHUSD", "ZEPHRSV", "ZEPHYRS", "ZANO",
  // Stablecoins grouped last.
  "USDC", "USDT", "DAI",
];

const ASSET_RANK: ReadonlyMap<string, number> = new Map(
  CANONICAL_ASSET_ORDER.map((t, i) => [t, i] as const)
);

/**
 * Rank of a ticker in `CANONICAL_ASSET_ORDER` (lower = earlier). Unknown
 * tickers return `Number.MAX_SAFE_INTEGER` so they sort to the end; the
 * caller should add a stable secondary key (e.g. `localeCompare`).
 */
export function assetRank(ticker: string): number {
  return ASSET_RANK.get(ticker.toUpperCase()) ?? Number.MAX_SAFE_INTEGER;
}
