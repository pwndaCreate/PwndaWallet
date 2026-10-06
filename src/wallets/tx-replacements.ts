/**
 * Transactions this wallet REPLACED (operator request, 2026-10-01: "Speed
 * up" re-sends an unconfirmed BTC transaction with a higher fee, BIP125).
 *
 * # Why the history needs to be told
 *
 * After a speed-up the original and its replacement spend the same coins, so
 * at most one of them can ever confirm, and the network drops the original.
 * The history does not notice on its own: a routine poll MERGES a small page
 * into the rows it holds and keeps held rows the page does not list
 * (`mergeHistoryPage`, txHistorySchedule.ts), so the original's mempool row
 * would stay beside the replacement's — two pending sends for one payment —
 * until the next full read (a restart, or a refresh the user asks for).
 *
 * `useTxHistory` subscribes here: when a replacement is recorded it drops the
 * original's row and re-reads that chain, and every page it reads afterwards
 * passes through {@link withoutReplacedRows}. Only an UNCONFIRMED row is ever
 * dropped: if the original is mined after all (the replacement lost the
 * race), its confirmed row is the truth and is shown.
 *
 * In memory, for the session. A restart's first read of each address is a
 * full page, which no longer lists a transaction the network dropped, so
 * nothing needs to outlive the session. The swap history, which DOES persist
 * a deposit's hash, follows a replacement through `onTxReplacement` too
 * (`swap-source-replacement.ts`) and writes the new hash down.
 */
import type { ChainTx, ChainType } from "./types";

export interface TxReplacement {
  chain: ChainType;
  /** The transaction that was replaced. */
  replaced: string;
  /** The replacement. */
  by: string;
  /** ms epoch. */
  at: number;
}

const MAX_ENTRIES = 200;
const byKey = new Map<string, TxReplacement>();
const listeners = new Set<(r: TxReplacement) => void>();

function norm(hash: string): string {
  return String(hash ?? "").trim().replace(/^0x/i, "").toLowerCase();
}

function keyOf(chain: ChainType, hash: string): string {
  return `${chain}|${norm(hash)}`;
}

/** Record that `replaced` was replaced by `by` on `chain`, and tell every listener. */
export function recordTxReplacement(r: {
  chain: ChainType;
  replaced: string;
  by: string;
  at?: number;
}): void {
  const replaced = norm(r.replaced);
  const by = norm(r.by);
  if (!replaced || !by || replaced === by) return;
  const entry: TxReplacement = { chain: r.chain, replaced, by, at: r.at ?? Date.now() };
  byKey.set(keyOf(r.chain, replaced), entry);
  while (byKey.size > MAX_ENTRIES) {
    const oldest = byKey.keys().next().value;
    if (oldest === undefined) break;
    byKey.delete(oldest);
  }
  for (const l of [...listeners]) {
    try {
      l(entry);
    } catch {
      /* one listener's failure is its own */
    }
  }
}

/** The replacement recorded for `hash`, if any (one step, not followed). */
export function txReplacementOf(chain: ChainType, hash: string): TxReplacement | undefined {
  return byKey.get(keyOf(chain, hash));
}

/**
 * The transaction that finally stands for `hash`: replaced by B, B by C → C.
 * `hash` itself (normalised) when nothing replaced it.
 */
export function latestReplacementOf(chain: ChainType, hash: string): string {
  let current = norm(hash);
  const seen = new Set<string>();
  for (let r = byKey.get(keyOf(chain, current)); r && !seen.has(r.by); r = byKey.get(keyOf(chain, current))) {
    seen.add(current);
    current = r.by;
  }
  return current;
}

/** Subscribe to recorded replacements. Returns the unsubscribe. */
export function onTxReplacement(listener: (r: TxReplacement) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Not yet in a block: no confirmations, or a pending row with no height. */
export function isUnconfirmedRow(tx: ChainTx): boolean {
  if (tx.height) return false;
  return tx.confirmations === 0 || tx.direction === "pending";
}

/**
 * `rows` without the unconfirmed rows of transactions that were replaced.
 * The SAME array when nothing is dropped, so a caller comparing identities
 * sees no change.
 */
export function withoutReplacedRows<T extends ChainTx>(chain: ChainType, rows: T[]): T[] {
  if (byKey.size === 0 || rows.length === 0) return rows;
  let dropped = false;
  const kept = rows.filter((tx) => {
    const drop = isUnconfirmedRow(tx) && byKey.has(keyOf(chain, tx.hash));
    if (drop) dropped = true;
    return !drop;
  });
  return dropped ? kept : rows;
}

/** Test seam: forget every replacement and listener. */
export function _clearTxReplacementsForTests(): void {
  byKey.clear();
  listeners.clear();
}
