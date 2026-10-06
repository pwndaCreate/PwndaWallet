/**
 * A swap's deposit hash follows its replacement (operator request,
 * 2026-10-01: "Speed up" for a BTC deposit stuck in the mempool).
 *
 * A speed-up replaces the deposit transaction: same coins, same deposit
 * address, same amount, a new txid. The original is then dropped by the
 * network and can never confirm. A swap history row still naming the old hash
 * would link its "source tx" to a transaction that no longer exists, and read
 * the wrong leg's parties. So whenever the wallet records a replacement
 * (`wallets/tx-replacements.ts`) — from the swap details or from the
 * transaction details in Activity, wherever the speed-up was pressed — every
 * row whose source transaction it was takes the replacement's hash and
 * explorer link. Written to the stored history, so it outlives the session
 * (the replacement record itself does not need to).
 *
 * NEAR Intents finds a deposit by its ADDRESS, which a replacement keeps, so
 * the swap's live status is unaffected. 1Click is not re-notified of the new
 * hash: the deposit/submit call is a best-effort speed-up of its own scanner
 * (`swap-execute.ts`), what it does with a second hash for one deposit is not
 * documented, and the scanner finds the deposit without it.
 */
import { onTxReplacement, type TxReplacement } from "../../wallets/tx-replacements";
import { explorerTxUrl } from "../../wallets/explorers";
import { modifySwapHistory, type SwapHistoryEntry } from "./swap-history-store";
import { swapLegChain } from "./swap-details";
import { ASSET_CAPABILITIES } from "./asset-capabilities";

/** The patch a replacement makes to one row, or null when it is not that row's deposit. Pure. */
export function sourceReplacementPatch(
  row: SwapHistoryEntry,
  r: TxReplacement,
): Pick<SwapHistoryEntry, "sourceTxHash" | "sourceExplorerUrl"> | null {
  const hash = String(row.sourceTxHash ?? "").trim().replace(/^0x/i, "").toLowerCase();
  if (!hash || hash !== r.replaced) return null;
  if (swapLegChain(row.fromAsset) !== r.chain) return null;
  const cap = ASSET_CAPABILITIES[row.fromAsset.toUpperCase()];
  return {
    sourceTxHash: r.by,
    sourceExplorerUrl: cap?.explorerTxUrl(r.by) ?? explorerTxUrl(r.chain, r.by) ?? "",
  };
}

/** Every row a replacement concerns, patched; null when none is (nothing to write). Pure. */
export function rowsAfterReplacement(
  rows: SwapHistoryEntry[],
  r: TxReplacement,
): SwapHistoryEntry[] | null {
  let changed = false;
  const next = rows.map((row) => {
    const patch = sourceReplacementPatch(row, r);
    if (!patch) return row;
    changed = true;
    return { ...row, ...patch };
  });
  return changed ? next : null;
}

/** Write one replacement into the stored history. Never throws. */
export async function followSourceReplacement(
  r: TxReplacement,
  modify: typeof modifySwapHistory = modifySwapHistory,
): Promise<void> {
  try {
    await modify((rows) => rowsAfterReplacement(rows, r));
  } catch {
    /* the history keeps the old hash; the next replacement record tries again */
  }
}

let unsubscribe: (() => void) | null = null;

/**
 * Follow every replacement the wallet records, for the rest of the session.
 * Idempotent. Started with the swap resume pass (`resumePendingIntentsSwapsOnce`),
 * which App.tsx runs as soon as a wallet is open.
 */
export function followSourceReplacementsOnce(): void {
  if (unsubscribe) return;
  unsubscribe = onTxReplacement((r) => {
    void followSourceReplacement(r);
  });
}

/** Test seam: stop following, so the next call subscribes again. */
export function _stopFollowingSourceReplacementsForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
}
