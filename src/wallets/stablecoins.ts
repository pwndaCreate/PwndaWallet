/**
 * Stablecoin registry — USDC / USDT / USDT0 across every chain this wallet
 * can already sign for: the EVM chains, Solana, TRON, and since 2026-10-06
 * NEAR and Aptos.
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
 * # Not only EVM (2026-09-02, 2026-10-06)
 *
 * `contract` is whatever the chain calls the token: an ERC-20 address, an SPL
 * mint, a TRC-20 address, a NEP-141 contract ACCOUNT on NEAR
 * (`usdt.tether-token.near`), or the fungible-asset METADATA OBJECT on Aptos
 * (`0x357b…dc2b`). The NEAR and Aptos rows were added 2026-10-06 (operator
 * request, 2026-10-01) and checked the same way: NEAR's `ft_metadata` view and
 * Aptos's `0x1::fungible_asset::Metadata` resource, read live, each against
 * the asset 1Click lists for that chain.
 *
 * # USD₮0 is shown as USDT (operator request, 2026-10-01)
 *
 * The USD₮0 family stays its own family HERE, because that is what the
 * contracts are (they answer `symbol() = "USD₮0"` / `"USDT0"`). Everywhere the
 * wallet SHOWS a leg it files under USDT and reads "USDT", with "USD₮0" as a
 * small note beside it — `stablecoinLegLabel`. On Arbitrum, Polygon and Monad
 * it is the only USDT there is; on Optimism it sits beside the older bridged
 * USDT, and the note is what tells the two apart.
 *
 * # Adding a network
 *
 * Verify first. `scripts/verify-stablecoins.mjs` reads symbol/name/decimals
 * from the chain and refuses anything that disagrees with the row.
 */
import type { ChainType, WalletInfo } from "./types";

/** The three stablecoin families this wallet carries. */
export type StablecoinSymbol = "USDC" | "USDT" | "USDT0";

export interface StablecoinNetwork {
  /** The dedicated `ChainType` for this (symbol, network) pair. */
  chain: ChainType;
  /** The chain the token lives on — its native-gas parent. */
  parent: ChainType;
  /** Short label for the network row ("Ethereum", "BNB Smart Chain"). */
  network: string;
  /**
   * The token, as its chain names it: ERC-20 / TRC-20 address, SPL mint,
   * NEP-141 contract account, or Aptos fungible-asset metadata object.
   * Verified on-chain — see the header.
   */
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
      // Monad (2026-09-29), verified on chain: symbol() "USDC", decimals 6.
      { chain: "usdc-monad", parent: "monad",   network: "Monad",           contract: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6, nearIntents: true },
      // NEAR (2026-10-06): Circle's native USDC, a NEP-141 contract whose
      // account id is this hex string. `ft_metadata` read live: name "USDC",
      // symbol "USDC", decimals 6. 1Click: `nep141:<this id>`.
      { chain: "usdc-near",  parent: "near",    network: "NEAR",            contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, nearIntents: true },
      // Aptos (2026-10-06): Circle's native USDC, a fungible asset; this is its
      // metadata object. `0x1::fungible_asset::Metadata` read live: name
      // "USDC", symbol "USDC", decimals 6, project_uri circle.com/usdc. 1Click
      // lists it as `nep141:aptos-34ee497f…omft.near` with this contract.
      { chain: "usdc-aptos", parent: "aptos",   network: "Aptos",           contract: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b", decimals: 6, nearIntents: true },
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
      // at all before 2026-09-02. Flipped to `nearIntents: true` on
      // 2026-09-09: `tron` is now in `intents-source-capability.ts`, so the
      // route the flag was withholding is one the wallet can actually execute
      // (`trc20-wallet.ts` builds and signs the `transfer(address,uint256)`
      // call, the same path the Send button uses).
      { chain: "usdt-tron", parent: "tron",      network: "Tron",            contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, nearIntents: true },
      // NEAR (2026-10-06): Tether's own NEP-141 contract. `ft_metadata` read
      // live: name "Tether USD", symbol "USDt", decimals 6. 1Click:
      // `nep141:usdt.tether-token.near`.
      { chain: "usdt-near",  parent: "near",     network: "NEAR",            contract: "usdt.tether-token.near", decimals: 6, nearIntents: true },
      // Aptos (2026-10-06): Tether's native USDt fungible asset (metadata
      // object). Read live: name "Tether USD", symbol "USDt", decimals 6,
      // project_uri tether.to. 1Click: `nep141:aptos-88cb7619…omft.near`.
      { chain: "usdt-aptos", parent: "aptos",    network: "Aptos",           contract: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b", decimals: 6, nearIntents: true },
    ],
  },
  {
    symbol: "USDT0",
    displayName: "USD₮0",
    color: "#26a17b",
    networks: [
      // Arbitrum's USDT migrated to this contract; `symbol()` = "USD₮0".
      { chain: "usdt0-arb", parent: "arbitrum", network: "Arbitrum", contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, nearIntents: true },
      // Same migration on Polygon — verified `symbol()` = "USDT0". Flipped to
      // `nearIntents: true` on 2026-09-29: 1Click lists this contract (as
      // "USDT" on pol) and `ASSET_CAPABILITIES["USDT0-POL"]` already routed it,
      // so the wallet row alone was withholding its "swappable via NEAR" mark.
      { chain: "usdt0-pol", parent: "polygon",  network: "Polygon",  contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, nearIntents: true },
      // Monad (2026-09-29), verified on chain: symbol() "USDT0", decimals 6.
      { chain: "usdt0-monad", parent: "monad", network: "Monad",    contract: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d", decimals: 6, nearIntents: true },
      // Optimism (2026-10-06). NOT the `usdt-op` row: Optimism's bridged USDT
      // (0x94b0…8e58, symbol "USDT", name "Tether USD") was never upgraded in
      // place, and USD₮0 launched beside it as a separate contract. Read live
      // via mainnet.optimism.io: symbol() "USD₮0", name() "USD₮0", decimals 6.
      // 1Click lists it as `nep245:v2_1.omni.hot.tg:10_2R1RXDBxCyJTeMEsdXydh7xsHmz`.
      { chain: "usdt0-op",   parent: "optimism", network: "Optimism", contract: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", decimals: 6, nearIntents: true },
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

/**
 * Families that FILE under another in the wallet, as they already do in the
 * swap picker (`picker-rows.ts`): USD₮0 is the OFT that Arbitrum's and
 * Polygon's USDT migrated to, so somebody looking for USDT on Arbitrum opens
 * USDT and finds it there, still labelled USD₮0.
 */
const FILES_UNDER: Partial<Record<StablecoinSymbol, StablecoinSymbol>> = {
  USDT0: "USDT",
};

/** How the wallet names one leg: the symbol it reads as, its network, and a note. */
export interface StablecoinLegLabel {
  /** The symbol the row READS as: "USDT" for a USD₮0 leg too. */
  symbol: string;
  /** The network, alone: "Arbitrum", never "Arbitrum · USD₮0". */
  network: string;
  /**
   * The token's own name when it differs from {@link symbol} — "USD₮0" on
   * the USD₮0 legs — drawn small beside the row, never as its name.
   * Undefined for every other leg.
   */
  note?: string;
}

/**
 * How every surface names a stablecoin leg (operator request, 2026-10-01:
 * "the row reads USDT, with USD₮0 as a small note").
 *
 * Until 2026-10-06 a USD₮0 leg's network read "Arbitrum · USD₮0" in the rail
 * and the tokens strip, its ticker "USDT0" in the coin panel, the Send title
 * and Activity, and its name "USD₮0 (Arbitrum)". One function now answers for
 * all of them, so the two Optimism rows — bridged USDT and USD₮0 — can only be
 * told apart the same way everywhere: by the note.
 */
export function stablecoinLegLabel(chain: ChainType): StablecoinLegLabel | undefined {
  const leg = stablecoinNetworkFor(chain);
  if (!leg) return undefined;
  const filedUnder = FILES_UNDER[leg.symbol];
  if (!filedUnder) return { symbol: leg.symbol, network: leg.network };
  return { symbol: filedUnder, network: leg.network, note: familyFor(leg.symbol)?.displayName };
}

/**
 * A leg's name as plain text — "USDT (Arbitrum · USD₮0)" — for the places
 * that print a chain's name as a string (the adapters' `displayName`, the
 * Activity status line). The note goes AFTER the network, inside the
 * parentheses, so the text reads "USDT" first. Exported for the tests that
 * keep `coin-metadata.ts` and the adapters on this one wording.
 */
export function stablecoinLegName(chain: ChainType): string | undefined {
  const l = stablecoinLegLabel(chain);
  if (!l) return undefined;
  return `${l.symbol} (${l.network}${l.note ? ` · ${l.note}` : ""})`;
}

/**
 * The `CoinIcon` symbol for a chain's mark. A USD₮0 leg reads "USDT" but keeps
 * the USD₮0 glyph — the ₮ with a "0" badge, which is the icon's form of the
 * small note (2026-10-06). Every other chain: `ticker` unchanged.
 */
export function coinMarkFor(chain: ChainType, ticker: string): string {
  return stablecoinNetworkFor(chain)?.symbol ?? ticker;
}

/**
 * The stablecoin rows the wallet lists — ONE rule for both layouts
 * (portrait `DashboardView`, landscape `WalletLandscapeView`):
 *  - every family, held or not, at 0 when nothing is held;
 *  - USD₮0's networks inside USDT, each row naming its network ("Arbitrum")
 *    with "USD₮0" as its `note` (2026-10-06; it read "Arbitrum · USD₮0").
 *
 * Both layouts used to list a family only once something was held ("a fresh
 * wallet should not grow permanent $0.00 rows"). A wallet that had never held
 * a stablecoin then had no row to receive one into — reported 2026-09-29 as
 * "I don't see USDT or USDC anywhere, I don't see any UI for it". USDC and USDT
 * were made always-listed that day; the operator then asked the same of every
 * asset hidden until held ("show even if it has a 0 balance"), so no family is
 * held back any more.
 */
export function stablecoinRailGroups(
  balancesByChain: Partial<Record<ChainType, string>>,
): StablecoinGroup[] {
  const groups = new Map(groupStablecoins(balancesByChain).map((g) => [g.symbol, g]));
  for (const [from, to] of Object.entries(FILES_UNDER) as Array<[StablecoinSymbol, StablecoinSymbol]>) {
    const src = groups.get(from);
    const dst = groups.get(to);
    if (!src || !dst) continue;
    // The note, not the network, carries "USD₮0" (operator request,
    // 2026-10-01): the row reads as the network it is on, and the views draw
    // the note small beside it.
    dst.rows = [...dst.rows, ...src.rows.map((r) => ({ ...r, note: src.displayName }))];
    if (src.total != null) dst.total = (dst.total ?? 0) + src.total;
    groups.delete(from);
  }
  return [...groups.values()];
}

/**
 * The wallet entries of every token leg held by `parent`'s account, pointed
 * at that same account (2026-09-29).
 *
 * A token balance lives ON its owner's account: USDT on TRON is a TRC-20
 * balance of the TRON address. Each leg's adapter derives by delegating to
 * its parent adapter's DEFAULT derivation, which agrees with the parent only
 * while the parent sits on its default path. When a derivation choice moves
 * the parent (an Exodus/Atomic import puts TRX on `m/44'/195'/…`), the leg
 * stayed behind: the dashboard showed USDT under one TRON address and TRX —
 * the energy that pays for sending USDT — under another, and a swap paying
 * out USDT landed on the account the user was not looking at.
 *
 * Callers apply this wherever they re-derive the parent from a choice. On the
 * default path it returns entries identical to the adapters' own.
 */
export function tokenLegsHeldBy(
  parent: ChainType,
  parentInfo: WalletInfo | undefined,
): Partial<Record<ChainType, WalletInfo>> {
  const legs: Partial<Record<ChainType, WalletInfo>> = {};
  if (!parentInfo) return legs;
  for (const n of STABLECOIN_NETWORKS) {
    if (n.parent === parent) legs[n.chain] = { ...parentInfo, chain: n.chain };
  }
  return legs;
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
    /** "USD₮0" on a USD₮0 leg filed under USDT (`stablecoinRailGroups`);
     *  absent otherwise. Drawn small, never as the row's name. */
    note?: string;
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
