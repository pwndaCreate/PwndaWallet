import { getAdapter } from "../wallets";
import { firstUnusedReceiveAddress, utxoAccountSpecFor } from "../wallets/utxo-account";
/**
 * Where the UTXO account-scan results live between the sweep and the views.
 *
 * `AppStateContext` is documented as deliberately narrow — "every
 * feature-specific field stays in the feature hook that owns it" — and this is
 * feature-specific, so it does not belong there. It is also read by more than
 * one feature (the wallet dashboard, the derivation panel, the recovery card),
 * so it does not belong to any single hook either. A tiny external store, read
 * through `useSyncExternalStore`, satisfies both without a context rerender
 * cascade across 27 chains.
 *
 * Written by `App.tsx`'s balance sweep; read by anything that needs to say
 * more than a bare number — how many addresses were scanned, whether the scan
 * completed, and whether any funds sit past a standard restore's gap limit.
 */
import { useSyncExternalStore, useMemo} from "react";
import type { ChainType } from "../wallets/types";
import type { UtxoAccountSummary } from "../wallets/utxo-account-balance";

export type UtxoAccountSummaries = Partial<Record<ChainType, UtxoAccountSummary>>;

let summaries: UtxoAccountSummaries = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current snapshot. Identity is stable until something actually changes, so
 *  `useSyncExternalStore` will not loop. */
export function getUtxoAccountSummaries(): UtxoAccountSummaries {
  return summaries;
}

export function setUtxoAccountSummary(
  chain: ChainType,
  summary: UtxoAccountSummary,
): void {
  summaries = { ...summaries, [chain]: summary };
  emit();
}

/**
 * Drop one chain's summary — when the wallet displayed on that chain has no
 * account to scan (2026-09-29 send-safety audit: a path outside the
 * receive/change model, read as a single address). A summary left behind by a
 * previous wallet there would otherwise list another account's addresses as
 * this wallet's, and feed their history into Activity. No-op when absent.
 */
export function clearUtxoAccountSummary(chain: ChainType): void {
  if (!(chain in summaries)) return;
  const next = { ...summaries };
  delete next[chain];
  summaries = next;
  emit();
}

/** Drop everything — call on logout/wallet switch so one wallet's scan can
 *  never describe another's. */
export function clearUtxoAccountSummaries(): void {
  if (Object.keys(summaries).length === 0) return;
  summaries = {};
  emit();
}

export function useUtxoAccountSummaries(): UtxoAccountSummaries {
  return useSyncExternalStore(subscribe, getUtxoAccountSummaries, getUtxoAccountSummaries);
}

export function useUtxoAccountSummary(
  chain: ChainType | null | undefined,
): UtxoAccountSummary | undefined {
  const all = useUtxoAccountSummaries();
  return chain ? all[chain] : undefined;
}

/** Total funds, across every scanned chain, that a stock gap-limit-20 seed
 *  restore would fail to find. Drives the recovery warning. */
export function totalStrandedSat(all: UtxoAccountSummaries): number {
  return Object.values(all).reduce((n, s) => n + (s?.strandedSat ?? 0), 0);
}

/**
 * A fresh, never-used receive address for the active UTXO chain — or `null`.
 *
 * ONE implementation, imported by both the portrait `DashboardView` and the
 * landscape `WalletLandscapeView`. Deliberately a shared hook rather than the
 * same nine lines twice: a receive address that rotates in one layout and
 * silently reuses index 0 in the other is precisely the portrait/landscape
 * drift this repo has paid for repeatedly (see CLAUDE.md's landscape-first
 * rule), and it would be invisible — both screens show *an* address, and only
 * one of them is safe to hand out twice.
 *
 * Returns `null` for non-UTXO chains, before a scan has run, and after an
 * incomplete one; every caller then falls back to the primary address with its
 * own honest label.
 *
 * `displayedAddress` picks the account (2026-09-29 send-safety audit): the
 * fresh address comes from the account whose first receive address is the one
 * on screen. This used `utxoAccounts[0]`, so a BIP-49 or BIP-44 Bitcoin wallet
 * (or a legacy LTC one) was handed a BIP-84 address — a deposit to it lands in
 * an account the dashboard, now scanning the displayed one, does not add up.
 */
export function useUtxoReceiveAddress(
  chain: ChainType,
  mnemonic: string | undefined | null,
  displayedAddress: string | undefined | null,
): string | null {
  const summary = useUtxoAccountSummary(chain);
  return useMemo(
    () => utxoReceiveAddressFor(chain, mnemonic, displayedAddress, summary),
    [chain, mnemonic, displayedAddress, summary],
  );
}

/**
 * The pure half of {@link useUtxoReceiveAddress}, exported for tests.
 *
 * Fail CLOSED, and never throw.
 *
 * This is a display-only privacy nicety. It renders inside the wallet's main
 * view on both layouts, so anything it throws unmounts the entire tree and the
 * user gets a blank window with no message -- the wallet becomes unusable to
 * protect an address from being reused. That trade is never worth making, so
 * every failure here degrades to "show the primary address" instead.
 *
 * Concrete ways it could throw, all cheap to rule out:
 *   - `getAdapter` returns `adapters[chain]` and does NOT throw on an unmapped
 *     chain -- it returns `undefined`, so `.utxoAccounts` on it is a TypeError.
 *     The type says ChainAdapter; the runtime disagrees.
 *   - `utxoAccountSpecFor` and `firstUnusedReceiveAddress` run
 *     `mnemonicToSeedSync`, which throws on a malformed phrase. Chains with
 *     their own seed (XMR/ZEPH/ZANO) carry a NON-bip39 phrase in
 *     `wallet.mnemonic`; they are excluded by the `utxoAccounts` check today,
 *     and this catch is what keeps that from being load-bearing.
 *
 * No account derives the displayed address (a single-address path): `null`,
 * because there is no account to rotate through.
 */
export function utxoReceiveAddressFor(
  chain: ChainType,
  mnemonic: string | undefined | null,
  displayedAddress: string | undefined | null,
  summary: UtxoAccountSummary | undefined,
): string | null {
  try {
    const specs = getAdapter(chain)?.utxoAccounts;
    if (!specs || !mnemonic || !displayedAddress) return null;
    const spec = utxoAccountSpecFor(mnemonic, specs, displayedAddress);
    if (!spec) return null;
    return firstUnusedReceiveAddress(mnemonic, spec, summary)?.address ?? null;
  } catch (e) {
    console.warn("[utxo-receive] falling back to the primary address:", e);
    return null;
  }
}
