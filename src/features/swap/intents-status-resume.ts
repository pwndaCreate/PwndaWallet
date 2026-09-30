/**
 * Follow NEAR Intents swaps that are still pending in history
 * (2026-09-29 send-safety audit, F5).
 *
 * # Why
 *
 * Until now only the OPEN confirm modal polled 1Click's status, and it gave
 * up after 30 minutes. A swap outlived that easily: a BTC deposit alone was
 * estimated at 812 s, and a short deposit is refunded only BY the quote's
 * deadline. Close the app, or wait past 30 minutes, and the history row said
 * "pending" forever — the one row the user most needed to be right, because
 * it is where they learn whether their money came back.
 *
 * History rows now carry the deposit address (and the deadline), and this
 * module picks up every pending one and polls it to a terminal status.
 *
 * # When it runs
 *
 * Once per session, as soon as a wallet is open: `App.tsx` calls
 * `resumePendingIntentsSwapsOnce()` when `walletsByChain` fills (2026-09-30).
 * The first mount of `SwapForm` still calls it too; the `Once` makes the
 * second call a no-op. Before that App wiring, a pending swap resumed only
 * when the Swap screen was first opened, so after a restart a finished swap
 * read "pending" in Activity until then.
 */
import {
  intentsStatusToHistory,
  isIntentsPollActive,
  pollIntentsToTerminal,
} from "./swap-execute";
import { extractActualReceivedFromIntents } from "./swap-actual-received";
import {
  loadSwapHistory,
  updateSwapHistoryEntry,
  type SwapHistoryEntry,
} from "./swap-history-store";
import type { IntentsStatusResponse } from "../../lib/proxy-types";

/** Rows older than this are not resumed: 1Click has long since decided them,
 *  and a stale row is better left for the user than polled forever. */
const RESUME_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

export interface ResumeDeps {
  load: () => Promise<SwapHistoryEntry[]>;
  update: (id: string, patch: Partial<SwapHistoryEntry>) => Promise<void>;
  poll: (args: {
    depositAddress: string;
    /** Set for a memo deposit (Stellar, 2026-09-30). */
    depositMemo?: string;
    deadline?: string;
    intervalMs?: number;
  }) => Promise<IntentsStatusResponse>;
  /** Is a poller already watching this deposit? Address plus memo: two XLM
   *  swaps share an address (2026-09-30). */
  isActive: (depositAddress: string, depositMemo?: string) => boolean;
  now: () => number;
}

const defaultDeps: ResumeDeps = {
  load: loadSwapHistory,
  update: updateSwapHistoryEntry,
  poll: pollIntentsToTerminal,
  isActive: isIntentsPollActive,
  now: () => Date.now(),
};

/** The pending Intents rows worth resuming. Pure, for tests. */
export function rowsToResume(
  rows: SwapHistoryEntry[],
  nowMs: number,
  isActive: (depositAddress: string, depositMemo?: string) => boolean,
): SwapHistoryEntry[] {
  return rows.filter((r) => {
    if (r.status !== "pending" || !r.depositAddress) return false;
    // With the memo (2026-09-30): a poller for one XLM swap at the shared
    // address is not a poller for the next.
    if (isActive(r.depositAddress, r.depositMemo)) return false;
    const created = Date.parse(r.createdAt);
    return !Number.isFinite(created) || nowMs - created <= RESUME_MAX_AGE_MS;
  });
}

/**
 * Poll every resumable row to a terminal status and record it. Resolves when
 * all polls settle; returns how many rows were resumed. Never throws.
 */
export async function resumePendingIntentsSwaps(
  deps: ResumeDeps = defaultDeps,
): Promise<number> {
  let rows: SwapHistoryEntry[];
  try {
    rows = await deps.load();
  } catch {
    return 0;
  }
  const todo = rowsToResume(rows, deps.now(), deps.isActive);
  await Promise.all(
    todo.map(async (row) => {
      try {
        const terminal = await deps.poll({
          depositAddress: row.depositAddress!,
          // A memo deposit's status is asked with its memo (2026-09-30);
          // rows without one poll exactly as before.
          ...(row.depositMemo ? { depositMemo: row.depositMemo } : {}),
          deadline: row.depositDeadline,
          intervalMs: 30_000,
        });
        const status = intentsStatusToHistory(
          typeof terminal.status === "string" ? terminal.status : undefined,
        );
        const actualReceived =
          status === "success" ? extractActualReceivedFromIntents(terminal) : undefined;
        await deps.update(row.id, {
          status,
          outcomeUnknown: false,
          completedAt: new Date(deps.now()).toISOString(),
          ...(actualReceived
            ? { actualReceived, actualReceivedAt: new Date(deps.now()).toISOString() }
            : {}),
        });
      } catch {
        // Timed out or unreachable: the row stays pending, which is the truth.
      }
    }),
  );
  return todo.length;
}

let started = false;

/** Start `resumePendingIntentsSwaps` once per session (idempotent). */
export function resumePendingIntentsSwapsOnce(): void {
  if (started) return;
  started = true;
  void resumePendingIntentsSwaps().catch(() => undefined);
}
