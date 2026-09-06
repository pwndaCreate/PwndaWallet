// UPSTREAM FACTS ONLY — safe to regenerate wholesale.
//
//   npm run sync-intents-assets          # rewrite this file from the live feed
//   npm run check-intents-assets         # report drift, change nothing (CI)
//
// Source: GET /api/intents/tokens (via the user-controlled wallet-proxy).
//
// Everything in this file is something only the upstream 1Click catalog can
// answer: which assets exist, on which chain, with what id and decimals.
// WALLET capability — which chains we can actually SIGN A DEPOSIT FROM — is
// NOT here. It lives in the hand-owned `./intents-source-capability.ts`.
//
// That split is load-bearing. This file previously carried BOTH, under a
// "DO NOT EDIT" header while simultaneously being the only correct copy of the
// wallet-side set — so a routine regeneration on 2026-08-19 silently downgraded
// it and broke four tests. Regeneration is now mechanically safe: this file
// cannot clobber wallet knowledge, because wallet knowledge is not in it.
//
// Editing by hand is fine for comments; anything structural will be overwritten
// on the next sync.
//
// The shape mirrors what the proxy returns. Each row is one asset on one
// blockchain — bridged tokens (USDC on ETH vs USDC on Arbitrum) appear as
// SEPARATE entries with the same `symbol` but distinct `assetId` /
// `blockchain`. The deduplication for the swap UI lives in
// `intents-dedup.ts`.
//
// ## Asset-id namespaces
//
// 1Click uses three different namespaces in the same response:
//   - `nep141:*.omft.near`             — OMFT bridge (the dominant form)
//   - `nep245:v2_1.omni.hot.tg:<chainId>_<fingerprint>` — HOT-Omni multi-token
//     bridge. Used by BSC, Polygon, Optimism, Avalanche, TON, Stellar,
//     Monad, X Layer, Plasma, Scroll, Aditi.
//   - `1cs_v1:<chain>:<kind>:<addr>`   — One-Click-Swap envelope. Used today
//     for BTC native, Solana SPL ZEC, Base ERC-20 CFI, BSC bep20 nrUsdt,
//     NEAR ZEC.
//
// `asset-address-resolver.ts` dispatches across all three namespaces.

/**
 * Blockchains that NEAR Intents 1Click currently routes through. Keep
 * the keys lower-case so they're cheap to compare against the
 * `blockchain` field in the tokens response.
 *
 * Subset of the 32 upstream chains — only the ones Pwnda either
 * already integrates or is targeting in v2.x. Other upstream chains
 * (abs, adi, aleo, aptos, bera, cardano, gnosis, plasma, scroll,
 * starknet, xlayer, zec) appear in the catalog page but are not
 * surfaced in PwndaWallet today.
 */
export type IntentsBlockchain =
  | "eth" // Ethereum L1
  | "arb" // Arbitrum One
  | "base" // Base
  | "op" // Optimism
  | "pol" // Polygon
  | "avax" // Avalanche C-Chain
  | "bnb" // BNB Smart Chain
  | "btc" // Bitcoin L1
  | "sol" // Solana
  | "near" // NEAR Protocol
  | "doge" // Dogecoin
  | "xrp" // XRP Ledger
  | "tron" // TRON
  | "ton" // The Open Network
  | "ltc" // Litecoin
  | "bch" // Bitcoin Cash
  // Phase 3+ additions (2026-05-08):
  | "monad" // Monad — EVM-compatible, chain id 143 (HOT-Omni envelope)
  | "dash" // Dash — UTXO chain (own omft entry)
  | "stellar" // Stellar — chain id 1100 in HOT-Omni envelope
  | "sui" // Sui — own omft entry, plus Sui-USDC
  // 2026-06-21: ADA is now BOTH source and destination. cardano IS in
  // SOURCE_CAPABLE_BLOCKCHAINS — its deposit tx is signed in the TS
  // Cardano stack (cardano-tx.ts), not the Rust core (so there is no
  // swap_sign_cardano). Per the upstream catalog
  // (wiki/concepts/near-intents-asset-catalog.md), Cardano is a
  // single-asset chain on NEAR Intents (native ADA only).
  | "cardano";

export interface IntentsAsset {
  /** Asset id in any of the three NEAR Intents namespaces. */
  assetId: string;
  /** Underlying-asset symbol used for UI grouping (e.g. "USDC"). */
  symbol: string;
  /** Display name when distinguishing chains in a sub-selector. */
  displayName: string;
  /** Native chain decimals — atomic = display × 10^decimals. */
  decimals: number;
  /** Which chain this token lives on. Drives source-tx routing + RPC choice. */
  blockchain: IntentsBlockchain;
  /** Optional ERC-20 / SPL contract address (omitted for native assets). */
  contractAddress?: string;
}

/**
 * HOT-Omni chain-id → IntentsBlockchain key map.
 *
 * 1Click's `nep245:v2_1.omni.hot.tg:<chainId>_<fingerprint>` envelope
 * encodes the chain id in the suffix. This table inverts that mapping
 * so the address resolver can route HOT-Omni assets without parsing
 * the contract address. Verified against the 2026-05-08 upstream
 * catalog — see [[near-intents-asset-catalog]] for the full table.
 *
 * Chains we don't surface in v2.x (xlayer/plasma/scroll/aditi) map
 * to `null` so the resolver can throw a clear error rather than
 * silently routing to EVM.
 */
export const HOT_OMNI_CHAIN_TO_KEY: Record<string, IntentsBlockchain | null> = {
  "10": "op",
  "56": "bnb",
  "137": "pol",
  "143": "monad",
  "196": null, // X Layer — out of scope
  "534352": null, // Scroll — out of scope
  "1100": "stellar",
  "1117": "ton",
  "9745": null, // Plasma — out of scope
  "36900": null, // Aditi — out of scope
  "43114": "avax",
};

/**
 * Hand-curated coverage as of 2026-05-08. Synced from the upstream
 * catalog at `PwndaWalletVault/wiki/concepts/near-intents-asset-catalog.md`.
 *
 * Rows the user's NEAR Intents v2.x scope explicitly targets are tagged
 * with `// scope:v2x`. Older entries that pre-date the v2.x effort stay
 * as-is so existing source flows (BTC, ETH, SOL, LTC, DOGE, BCH, NEAR,
 * XRP, TRX) continue to work.
 */
export const NEAR_INTENTS_ASSETS: readonly IntentsAsset[] = [
  // ───── Native: ETH on L1 + L2s ─────
  {
    assetId: "nep141:eth.omft.near",
    symbol: "ETH",
    displayName: "ETH (Ethereum)",
    decimals: 18,
    blockchain: "eth",
  },
  {
    assetId: "nep141:arb.omft.near",
    symbol: "ETH",
    displayName: "ETH (Arbitrum)",
    decimals: 18,
    blockchain: "arb",
  },
  {
    assetId: "nep141:base.omft.near",
    symbol: "ETH",
    displayName: "ETH (Base)",
    decimals: 18,
    blockchain: "base",
  },
  // OP migrated upstream to nep245 envelope (2026-05-08).
  {
    assetId: "nep245:v2_1.omni.hot.tg:10_11111111111111111111",
    symbol: "ETH",
    displayName: "ETH (Optimism)",
    decimals: 18,
    blockchain: "op",
  },

  // ───── Native: BTC, SOL, NEAR ─────
  {
    assetId: "nep141:btc.omft.near",
    symbol: "BTC",
    displayName: "BTC",
    decimals: 8,
    blockchain: "btc",
  },
  {
    assetId: "nep141:sol.omft.near",
    symbol: "SOL",
    displayName: "SOL",
    decimals: 9,
    blockchain: "sol",
  },
  {
    assetId: "nep141:wrap.near",
    symbol: "NEAR",
    displayName: "NEAR",
    decimals: 24,
    blockchain: "near",
  },

  // ───── Native: UTXO chains ─────
  {
    assetId: "nep141:doge.omft.near",
    symbol: "DOGE",
    displayName: "DOGE",
    decimals: 8,
    blockchain: "doge",
  },
  {
    assetId: "nep141:ltc.omft.near",
    symbol: "LTC",
    displayName: "LTC",
    decimals: 8,
    blockchain: "ltc",
  },
  {
    assetId: "nep141:bch.omft.near",
    symbol: "BCH",
    displayName: "BCH",
    decimals: 8,
    blockchain: "bch",
  },
  // scope:v2x — Phase 5
  {
    assetId: "nep141:dash.omft.near",
    symbol: "DASH",
    displayName: "DASH",
    decimals: 8,
    blockchain: "dash",
  },

  // ───── Native: account-based destination-only ─────
  {
    assetId: "nep141:xrp.omft.near",
    symbol: "XRP",
    displayName: "XRP",
    decimals: 6,
    blockchain: "xrp",
  },
  {
    assetId: "nep141:tron.omft.near",
    symbol: "TRX",
    displayName: "TRX",
    decimals: 6,
    blockchain: "tron",
  },
  // TON migrated upstream to nep245 (2026-05-08).
  {
    assetId: "nep245:v2_1.omni.hot.tg:1117_",
    symbol: "TON",
    displayName: "TON",
    decimals: 9,
    blockchain: "ton",
  },

  // ───── Native: alt-EVM (POL / AVAX / BNB) — restored under nep245 (2026-05-08) ─────
  // scope:v2x
  {
    assetId: "nep245:v2_1.omni.hot.tg:137_11111111111111111111",
    symbol: "POL",
    displayName: "POL (Polygon)",
    decimals: 18,
    blockchain: "pol",
  },
  // scope:v2x
  {
    assetId: "nep245:v2_1.omni.hot.tg:43114_11111111111111111111",
    symbol: "AVAX",
    displayName: "AVAX (Avalanche)",
    decimals: 18,
    blockchain: "avax",
  },
  // scope:v2x
  {
    assetId: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    symbol: "BNB",
    displayName: "BNB (BSC)",
    decimals: 18,
    blockchain: "bnb",
  },

  // ───── Native: net-new chains (Phase 3, 6, 7) ─────
  // scope:v2x — Phase 3 (Monad)
  {
    assetId: "nep245:v2_1.omni.hot.tg:143_11111111111111111111",
    symbol: "MON",
    displayName: "MON (Monad)",
    decimals: 18,
    blockchain: "monad",
  },
  // scope:v2x — Phase 6 (Stellar)
  {
    assetId: "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz",
    symbol: "XLM",
    displayName: "XLM (Stellar)",
    decimals: 7,
    blockchain: "stellar",
  },
  // scope:v2x — Phase 7 (Sui)
  {
    assetId: "nep141:sui.omft.near",
    symbol: "SUI",
    displayName: "SUI",
    decimals: 9,
    blockchain: "sui",
  },
  // ADA is BOTH source and destination capable (2026-06-21). Its deposit tx is
  // signed in the TS Cardano stack (`cardano-tx.ts`), which is why there is no
  // `swap_sign_cardano` in the Rust core — an implementation detail, not a
  // limitation. Source capability is declared in `./intents-source-capability.ts`.
  //
  // (A 2026-05-25 comment here previously said "destination-only ... cardano
  // stays out of SOURCE_CAPABLE_BLOCKCHAINS". That was superseded on
  // 2026-06-21 but left in place, so the file contradicted itself for two
  // months and misread as a Cardano limitation. Removed 2026-08-19.)
  //
  // Upstream constraint that DOES still apply: NEAR Intents carries NATIVE ADA
  // ONLY on Cardano — no Cardano-native tokens — so it is a single-asset chain
  // on this route.
  {
    assetId: "nep141:cardano.omft.near",
    symbol: "ADA",
    displayName: "ADA",
    decimals: 6,
    blockchain: "cardano",
  },

  // ───── USDC across major chains ─────
  {
    assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    symbol: "USDC",
    displayName: "USDC (Ethereum)",
    decimals: 6,
    blockchain: "eth",
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
  {
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    symbol: "USDC",
    displayName: "USDC (Arbitrum)",
    decimals: 6,
    blockchain: "arb",
    contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    symbol: "USDC",
    displayName: "USDC (Base)",
    decimals: 6,
    blockchain: "base",
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  // OP USDC migrated to nep245 (2026-05-08).
  {
    assetId: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",
    symbol: "USDC",
    displayName: "USDC (Optimism)",
    decimals: 6,
    blockchain: "op",
    contractAddress: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  },
  // Polygon USDC under nep245 (2026-05-08).
  {
    assetId: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
    symbol: "USDC",
    displayName: "USDC (Polygon)",
    decimals: 6,
    blockchain: "pol",
    contractAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  },
  // scope:v2x — Avalanche USDC under nep245.
  {
    assetId: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
    symbol: "USDC",
    displayName: "USDC (Avalanche)",
    decimals: 6,
    blockchain: "avax",
    contractAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
  },
  // scope:v2x — BSC USDC. NOTE 18 decimals (not 6 like every other chain).
  {
    assetId: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r",
    symbol: "USDC",
    displayName: "USDC (BSC)",
    decimals: 18,
    blockchain: "bnb",
    contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  },
  // scope:v2x — Monad USDC.
  {
    assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
    symbol: "USDC",
    displayName: "USDC (Monad)",
    decimals: 6,
    blockchain: "monad",
    contractAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  },
  // Solana USDC: asset id changed shape upstream 2026-05-08
  // (was sol-EPjFWdd…omft.near; now sol-5ce3bf3a…omft.near).
  // Contract address still resolves to the same SPL mint.
  {
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    symbol: "USDC",
    displayName: "USDC (Solana)",
    decimals: 6,
    blockchain: "sol",
    contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  // scope:v2x — Stellar USDC. NOTE 7 decimals (Stellar precision).
  {
    assetId: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
    symbol: "USDC",
    displayName: "USDC (Stellar)",
    decimals: 7,
    blockchain: "stellar",
    contractAddress: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  // scope:v2x — Sui USDC.
  {
    assetId: "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near",
    symbol: "USDC",
    displayName: "USDC (Sui)",
    decimals: 6,
    blockchain: "sui",
    contractAddress: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  },

  // ───── USDT across major chains ─────
  {
    assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    symbol: "USDT",
    displayName: "USDT (Ethereum)",
    decimals: 6,
    blockchain: "eth",
    contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  },
  {
    assetId: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
    symbol: "USDT",
    displayName: "USDT (Arbitrum / USDT0)",
    decimals: 6,
    blockchain: "arb",
    contractAddress: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
  },
  // Polygon USDT under nep245 (2026-05-08).
  {
    assetId: "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr",
    symbol: "USDT",
    displayName: "USDT (Polygon)",
    decimals: 6,
    blockchain: "pol",
    contractAddress: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
  },
  // OP USDT under nep245 (2026-05-08).
  {
    assetId: "nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo",
    symbol: "USDT",
    displayName: "USDT (Optimism)",
    decimals: 6,
    blockchain: "op",
    contractAddress: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
  },
  // scope:v2x — Avalanche USDT under nep245.
  {
    assetId: "nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp",
    symbol: "USDT",
    displayName: "USDT (Avalanche)",
    decimals: 6,
    blockchain: "avax",
    contractAddress: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7",
  },
  // scope:v2x — BSC USDT. NOTE 18 decimals (not 6).
  {
    assetId: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
    symbol: "USDT",
    displayName: "USDT (BSC)",
    decimals: 18,
    blockchain: "bnb",
    contractAddress: "0x55d398326f99059ff775485246999027b3197955",
  },
  // Solana USDT mint — unchanged contract; asset id from upstream catalog.
  {
    assetId: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
    symbol: "USDT",
    displayName: "USDT (Solana)",
    decimals: 6,
    blockchain: "sol",
    contractAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
  // TRON USDT — asset id changed shape upstream 2026-05-08.
  // Contract address (TRC-20 base58) still the same.
  {
    assetId: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
    symbol: "USDT",
    displayName: "USDT (TRON)",
    decimals: 6,
    blockchain: "tron",
    contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  },

  // ───── DAI on Ethereum (newly bridged 2026-05-08) ─────
  // scope:v2x
  {
    assetId: "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near",
    symbol: "DAI",
    displayName: "DAI (Ethereum)",
    decimals: 18,
    blockchain: "eth",
    contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
  },

  // ───── Other notable: ARB, OP, AAVE, LINK ─────
  {
    assetId: "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
    symbol: "ARB",
    displayName: "ARB",
    decimals: 18,
    blockchain: "arb",
    contractAddress: "0x912ce59144191c1204e64559fe8253a0e49e6548",
  },
  // OP token migrated to nep245 alongside Optimism's other assets.
  {
    assetId: "nep245:v2_1.omni.hot.tg:10_vLAiSt9KfUGKpw5cD3vsSyNYBo7",
    symbol: "OP",
    displayName: "OP",
    decimals: 18,
    blockchain: "op",
    contractAddress: "0x4200000000000000000000000000000000000042",
  },
  {
    assetId: "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",
    symbol: "AAVE",
    displayName: "AAVE",
    decimals: 18,
    blockchain: "eth",
    contractAddress: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
  },
  {
    assetId: "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",
    symbol: "LINK",
    displayName: "LINK",
    decimals: 18,
    blockchain: "eth",
    contractAddress: "0x514910771af9ca656af840dff83e8264ecf986ca",
  },
];

/**
 * NOTE — `SOURCE_CAPABLE_BLOCKCHAINS` used to live here and no longer does.
 *
 * It encodes WALLET capability (which chains we can sign a deposit tx for),
 * which no upstream feed can know, so keeping it in a generated file meant a
 * routine regeneration could silently downgrade it — and on 2026-08-19 one
 * did. It now lives in the hand-owned `./intents-source-capability.ts`.
 * Import it from there.
 */

/**
 * EVM chain ids — used by the source-tx builder when the source asset
 * is an EVM-family token. Keep in sync with `wallets/chain-rpcs.ts`'s
 * RPC fallback lists.
 */
export const EVM_CHAIN_IDS: Partial<Record<IntentsBlockchain, number>> = {
  eth: 1,
  arb: 42161,
  base: 8453,
  op: 10,
  pol: 137,
  avax: 43114,
  bnb: 56,
  monad: 143, // Phase 3 (2026-05-08)
};

/**
 * Map a blockchain id to the user-facing chain name shown in the
 * "On chain: …" sub-selector.
 */
export const BLOCKCHAIN_DISPLAY_NAME: Record<IntentsBlockchain, string> = {
  eth: "Ethereum",
  arb: "Arbitrum",
  base: "Base",
  op: "Optimism",
  pol: "Polygon",
  avax: "Avalanche",
  bnb: "BNB Chain",
  btc: "Bitcoin",
  sol: "Solana",
  near: "NEAR",
  doge: "Dogecoin",
  xrp: "XRP",
  tron: "TRON",
  ton: "TON",
  ltc: "Litecoin",
  bch: "Bitcoin Cash",
  cardano: "Cardano",
  monad: "Monad",
  dash: "Dash",
  stellar: "Stellar",
  sui: "Sui",
};
