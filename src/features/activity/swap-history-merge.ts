/**
 * Shared helpers for merging cross-chain `SwapHistoryEntry[]` into the
 * unified Activity timeline. Consumed by both `ActivityViewPortrait`
 * and `ActivityLandscapeView`.
 *
 * Pre-2026-05-26, the Activity tab showed "Swap history isn't tracked
 * separately yet." when the user clicked the SWAPS filter — the data
 * was being captured in `swap-history-store.ts` but no view layer was
 * loading it. This module is the bridge: both Activity views call
 * `useSwapHistory()` to load + auto-refresh, and `swapHashSet()` to
 * build the dedup set for the `all` filter.
 *
 * Why a shared module instead of a hook in each view: the dedup logic
 * needs to live in exactly one place so a future change (e.g. case-
 * sensitivity tweak, hash-prefix normalization for chains with
 * variable prefixes) doesn't have to be applied twice.
 */
import { useEffect, useState } from "react";
import type { ChainTx } from "../../wallets/types";
import { loadSwapHistory, type SwapHistoryEntry } from "../swap";

/**
 * Load swap history once on mount + provide a manual reload. The
 * swap store is small (capped at 200 entries) so a single read is
 * cheap; we don't pre-emptively poll because mutations only happen
 * in the swap confirm modal, which closes before the user navigates
 * back to Activity.
 *
 * Returns `[entries, reload]` so a future caller can refresh after
 * an in-tab broadcast.
 */
export function useSwapHistory(): [SwapHistoryEntry[], () => void] {
  const [entries, setEntries] = useState<SwapHistoryEntry[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancel = false;
    loadSwapHistory()
      .then((rows) => {
        if (!cancel) setEntries(rows);
      })
      .catch(() => {
        /* swap history is best-effort here — the Activity tab still
           renders per-chain txs if the store is unreachable. */
      });
    return () => {
      cancel = true;
    };
  }, [tick]);
  return [entries, () => setTick((n) => n + 1)];
}

/**
 * Build the dedup hash set from a swap-history array. Every chain-tx
 * whose `hash` matches an entry in this set should be suppressed from
 * the unified timeline — the swap row is the canonical representation
 * of that hash in this view. Per-chain dashboards are NOT touched by
 * this dedup; they continue to show the source/dest tx rows
 * independently.
 *
 * Hashes are normalized to lowercase so the dedup is case-insensitive
 * (EIP-55 mixed-case Ethereum hex round-trips sometimes; some indexers
 * serve hashes in mixed case).
 */
export function swapHashSet(entries: SwapHistoryEntry[]): Set<string> {
  const set = new Set<string>();
  for (const s of entries) {
    if (s.sourceTxHash) set.add(s.sourceTxHash.toLowerCase());
    if (s.destTxHash) set.add(s.destTxHash.toLowerCase());
  }
  return set;
}

/** Convenience: filter a `ChainTx[]` to drop entries whose hash is in
 *  the swap-hash set. */
export function dedupChainTxsAgainstSwaps(
  txs: ChainTx[],
  swapHashes: Set<string>
): ChainTx[] {
  if (swapHashes.size === 0) return txs;
  return txs.filter((tx) => !swapHashes.has(tx.hash.toLowerCase()));
}

/**
 * Compute the sort timestamp for a swap history entry in Unix-seconds
 * (consistent with `ChainTx.timestamp`). Prefers `completedAt`; falls
 * back to `createdAt` for in-flight swaps; returns 0 when both ISO
 * strings are unparseable (sorts to the bottom).
 */
export function swapEntryTimestamp(s: SwapHistoryEntry): number {
  const iso = s.completedAt ?? s.createdAt;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}
