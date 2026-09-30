/**
 * Pure scheduling + merge rules for `useTxHistory` (RAM plan 3.6 / 3.7,
 * 2026-09-25).
 *
 * ## Why these exist
 *
 * The 2026-09-25 trace ([[ram-optimization-execution-plan]] § "cause trace")
 * found `useTxHistory` re-fetching the latest 50 transactions of every one of
 * ~99 (chain, address) pairs every 60 s on EVERY view - ~660 requests a
 * minute on an idle Mine tab, half of them failing - and landing each result
 * as its own `App`-root state update. React's development build retains
 * native memory per `App` commit, so that stream drove the WebView2 renderer
 * to 7.4 GB committed on the operator's dev instance; production retained
 * ~10x less but still paid the network, CPU and GC churn.
 *
 * The rules here:
 *  - poll at `activeMs` only while a history-showing view is on screen, at
 *    `backgroundMs` otherwise;
 *  - back off a pair that keeps failing instead of retrying every minute;
 *  - after the first full page, poll a SMALL page and merge it into what is
 *    already held, falling back to a full page when the small one does not
 *    overlap (so a burst of new transactions cannot leave a gap);
 *  - an unchanged result is not an update.
 */
import type { ChainTx } from "../../wallets/types";
import { normalizeTxHash, txRowKey } from "../../wallets/tx-row-key";

/** Longest a failing pair is left alone, whatever its failure count. */
export const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * How long after its last attempt a pair is due again. Doubles per
 * consecutive failure (capped at 2^5 and at {@link MAX_BACKOFF_MS}); a success
 * resets `failures` to 0.
 */
export function pollIntervalMs(args: {
  active: boolean;
  failures: number;
  activeMs: number;
  backgroundMs: number;
}): number {
  const base = args.active ? args.activeMs : args.backgroundMs;
  const f = Math.max(0, Math.min(args.failures, 5));
  return Math.min(base * 2 ** f, Math.max(base, MAX_BACKOFF_MS));
}

/** Is a pair due, given when it was last attempted (0 = never)? */
export function isDue(now: number, lastAttemptAt: number, intervalMs: number): boolean {
  return lastAttemptAt === 0 || now - lastAttemptAt >= intervalMs;
}

/**
 * Does a small poll page connect to what we already hold? `false` means every
 * row in a FULL small page is new - there may be more new rows beyond it than
 * the page could carry, so the caller must fetch a full page instead of
 * merging (otherwise the list would silently skip transactions).
 */
export function pollPageOverlaps(prev: ChainTx[] | undefined, page: ChainTx[], pollLimit: number): boolean {
  if (!prev || prev.length === 0) return false;
  if (page.length < pollLimit) return true; // the page reached the end of history
  const held = new Set(prev.map((t) => normalizeTxHash(t.hash)));
  return page.some((t) => held.has(normalizeTxHash(t.hash)));
}

/**
 * Merge a newer page into the held list: a row in `page` replaces the held row
 * with the same identity (confirmations, status and amounts move), held rows
 * not in the page are kept, newest first (a row with no timestamp - mempool -
 * sorts to the top), capped at `cap`.
 *
 * Identity is `txRowKey`, not the bare hash (2026-09-30): keyed by hash, the
 * two legs of one transaction (a Zephyr conversion's `out` and `in`, two
 * ERC-20 transfers in one transaction) replaced each other on every poll, and
 * a hash spelled in another case was a second row.
 */
export function mergeHistoryPage(prev: ChainTx[] | undefined, page: ChainTx[], cap: number): ChainTx[] {
  const byKey = new Map<string, ChainTx>();
  for (const t of prev ?? []) byKey.set(txRowKey(t), t);
  for (const t of page) byKey.set(txRowKey(t), t);
  const ts = (t: ChainTx) => (t.timestamp === undefined ? Number.POSITIVE_INFINITY : t.timestamp);
  return [...byKey.values()].sort((a, b) => ts(b) - ts(a)).slice(0, cap);
}

/** Exact equality of two held lists, so an unchanged poll commits nothing. */
export function sameHistory(a: ChainTx[] | undefined, b: ChainTx[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Error strings from multi-endpoint adapters list every endpoint's failure and
 * vary on every attempt (timeouts, 429s in a different order). Only the first
 * line is compared, so a still-failing pair does not re-render the app each
 * time it fails the same way.
 */
export function sameError(a: string | null | undefined, b: string | null | undefined): boolean {
  const head = (s: string | null | undefined) => (s ? s.split("\n", 1)[0] : null);
  return head(a) === head(b);
}
