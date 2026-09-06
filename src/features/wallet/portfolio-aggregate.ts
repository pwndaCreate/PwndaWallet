import type { ChainType } from "../../wallets";

/**
 * Unified-portfolio aggregation (Phase 4) — PURE, no I/O.
 *
 * Given every wallet's per-chain holdings, produce the grand total, the flat
 * row list (one per unique holding), and per-wallet subtotals for the "All
 * Wallets" view. Deduped by `(chain, address)` so the same address derived by
 * two wallets can never double-count the grand total.
 *
 * USD conversion is injected (`usdFor`) so this module stays free of the price
 * oracle + adapter registry and is trivially unit-testable.
 */

export interface Holding {
  walletId: string;
  walletName: string;
  chain: ChainType;
  address: string;
  /** Raw balance string in chain-native units (as held in balancesByChain), or undefined if unknown. */
  balance: string | undefined;
}

export interface PortfolioRow extends Holding {
  /** USD value, or null when price or balance is unavailable ("—" in the UI). */
  usd: number | null;
}

export interface WalletSubtotal {
  walletId: string;
  walletName: string;
  usd: number;
}

export interface AggregatedPortfolio {
  grandTotalUsd: number;
  rows: PortfolioRow[];
  perWallet: WalletSubtotal[];
  /** Chains held by >1 wallet — the UI shows a wallet chip on these rows. */
  multiWalletChains: Set<ChainType>;
}

export function aggregatePortfolio(
  holdings: Holding[],
  usdFor: (chain: ChainType, balance: string | undefined) => number | null
): AggregatedPortfolio {
  const seen = new Set<string>(); // `${chain}:${address}` — dedupe grand total
  const rows: PortfolioRow[] = [];
  const subtotals = new Map<string, WalletSubtotal>();
  const chainWallets = new Map<ChainType, Set<string>>();
  let grand = 0;

  for (const h of holdings) {
    // Track which wallets touch each chain (chip decision) — over ALL
    // holdings, so two wallets on the same chain both count.
    const cw = chainWallets.get(h.chain) ?? new Set<string>();
    cw.add(h.walletId);
    chainWallets.set(h.chain, cw);

    // Ensure every wallet appears in perWallet even with a $0/unknown total.
    if (!subtotals.has(h.walletId)) {
      subtotals.set(h.walletId, {
        walletId: h.walletId,
        walletName: h.walletName,
        usd: 0,
      });
    }

    const key = `${h.chain}:${h.address}`;
    if (seen.has(key)) continue; // same (chain,address) counted once
    seen.add(key);

    const usd = usdFor(h.chain, h.balance);
    rows.push({ ...h, usd });
    if (usd != null) {
      grand += usd;
      subtotals.get(h.walletId)!.usd += usd;
    }
  }

  const multiWalletChains = new Set<ChainType>();
  for (const [chain, wallets] of chainWallets) {
    if (wallets.size > 1) multiWalletChains.add(chain);
  }

  return {
    grandTotalUsd: grand,
    rows,
    perWallet: [...subtotals.values()],
    multiWalletChains,
  };
}
