/**
 * The ONE place that says which wallet entry feeds which swap-engine account
 * key (C8).
 *
 * ## Why this file exists
 *
 * `swapAccountKey.ts` knows the derivations. `makeAccountKeyDeriver` turns a
 * per-ticker `{ mnemonic, address }` map into pushable keys. The map itself
 * was written out THREE times — `App.tsx` (the automatic pass),
 * `SettingsView.tsx` and `SettingsLandscapeView.tsx` (the manual Unlock
 * button) — and each copy listed BTC and LTC only.
 *
 * That cost two days. BCH was taught to `swapAccountKey.ts` on 2026-09-04 and
 * still could not be pushed, because the caller never handed it a BCH entry;
 * `App.tsx` was fixed on 2026-09-05 and the two Settings copies were still
 * wrong, so the manual button could not have recovered it either. A table
 * duplicated per call site is a coin silently skipped per call site.
 *
 * So: one map, one hook, and `useAccountKeyDeriver.test.ts` fails the build if
 * a ticker in `ADOPTABLE_ACCOUNTS` has no chain here — which is exactly the
 * mistake that could not be seen from any one of the three files.
 *
 * @see src/lib/swapAccountKey.ts
 * @see PwndaWalletVault/wiki/entities/Bitcoin-Cash.md
 */
import { useMemo } from "react";
import type { ChainType, WalletInfo } from "../wallets/types";
import {
  ADOPTABLE_ACCOUNTS,
  makeAccountKeyDeriver,
  type DerivedAccountKeys,
} from "../lib/swapAccountKey";
import { useAppState } from "./AppStateContext";

/**
 * Ticker → the wallet entry its account key is derived from.
 *
 * Every key of `ADOPTABLE_ACCOUNTS` must appear here. The test enforces it in
 * both directions: a coin the deriver knows but this map does not is a coin
 * that silently never gets a key.
 */
export const ACCOUNT_KEY_CHAINS: Readonly<Record<string, ChainType>> = {
  BTC: "bitcoin",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
};

/** The `{ mnemonic, address }` input map, from whatever is loaded. */
export function accountKeyInputsFrom(
  walletsByChain: Partial<Record<ChainType, WalletInfo>>,
): Record<string, { mnemonic: string | null; address: string | null }> {
  const inputs: Record<
    string,
    { mnemonic: string | null; address: string | null }
  > = {};
  for (const [ticker, chain] of Object.entries(ACCOUNT_KEY_CHAINS)) {
    const w = walletsByChain[chain] ?? null;
    inputs[ticker] = {
      // A watch-only entry has no seed; deriving on it would run against an
      // empty string rather than fail, so it is dropped here.
      mnemonic: w?.watchOnly ? null : (w?.mnemonic ?? null),
      address: w?.address ?? null,
    };
  }
  return inputs;
}

/** True once at least one adoptable chain is loaded — nothing to derive from
 *  otherwise, which is a not-yet rather than a refusal. */
export function hasAnyAccountKeyWallet(
  walletsByChain: Partial<Record<ChainType, WalletInfo>>,
): boolean {
  return Object.values(ACCOUNT_KEY_CHAINS).some((c) => Boolean(walletsByChain[c]));
}

/**
 * The deriver, or `null` while the vault is locked / no adoptable chain is
 * loaded. Same construction for the automatic pass and the manual button —
 * the two roads diverging is how the operator's coins ended up wallet-less
 * (2026-08-21), and how BCH stayed that way (2026-09-05).
 */
export function useAccountKeyDeriver(): (() => Promise<DerivedAccountKeys>) | null {
  const { walletsByChain } = useAppState();
  return useMemo(() => {
    if (!hasAnyAccountKeyWallet(walletsByChain)) return null;
    return makeAccountKeyDeriver(accountKeyInputsFrom(walletsByChain));
  }, [walletsByChain]);
}

/** Tickers this app can derive an account key for — for messages and tests. */
export const ACCOUNT_KEY_TICKERS = Object.keys(ADOPTABLE_ACCOUNTS);
