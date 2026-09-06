/**
 * The last account-key share pass, so the Settings card can show what the
 * AUTOMATIC pass concluded — not only the manual button's pass.
 *
 * ## Why a store and not a prop
 *
 * `useSwapAutoSetup` already computed `sharedErrors`, and its own doc says
 * "surfaced rather than swallowed because the two things that land here are
 * both actionable and both silent otherwise". They were swallowed: nothing
 * rendered the field. The automatic pass runs from `App.tsx`, the card lives
 * three layers down behind a view switch that takes no props from it, and the
 * refusal only ever reached `console.error`.
 *
 * That is how BCH's real error — *"the swap node's current balance for this
 * coin could not be read, so its wallet was not replaced"* — stayed invisible
 * through two days of debugging a `NaN` in a different window. A refused push
 * leaves the engine unable to build that coin's wallet at all, which presents
 * as an empty balance, never as an error.
 *
 * Module-level rather than context because it is write-once-per-pass
 * diagnostics with no ordering requirements, and because the card must be
 * able to render a pass that finished before it mounted.
 */
export interface SharePassRecord {
  /** Epoch ms — the card renders relative age, and a stale record is worth
   *  distinguishing from a fresh one. */
  at: number;
  /** Tickers the engine VERIFIED as sharing (derived the same address). */
  shared: string[];
  /** Per-coin refusals, verbatim from the backend. */
  errors: string[];
}

let last: SharePassRecord | null = null;
const subscribers = new Set<(r: SharePassRecord) => void>();

/** Called by the pass itself, automatic or manual. */
export function recordSharePass(result: {
  shared: string[];
  errors: string[];
}): SharePassRecord {
  last = { at: Date.now(), shared: [...result.shared], errors: [...result.errors] };
  for (const fn of subscribers) {
    try {
      fn(last);
    } catch {
      // A broken subscriber must not break the pass that is reporting to it.
    }
  }
  return last;
}

/** The most recent pass, or null when none has finished this session. */
export function lastSharePass(): SharePassRecord | null {
  return last;
}

/** Subscribe; returns the unsubscribe. */
export function subscribeSharePass(fn: (r: SharePassRecord) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Tests only — module state outlives a test file otherwise. */
export function resetSharePassLog(): void {
  last = null;
  subscribers.clear();
}
