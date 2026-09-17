/**
 * The lock screen's note about swaps the node has in progress (2026-09-15).
 *
 * Locking the app no longer takes the host wallets away from the swap node, so
 * swaps keep running while the app is locked. A node that STARTS while the
 * vault is locked is different: its own wallets are encrypted with a key
 * derived from the vault, so its swaps wait for the unlock. The lock screen is
 * the one place the user can act on that.
 *
 * The count is the node's last reading (`swap_sidecar.rs::SwapsLastSeen`), not
 * a live one, because a locked engine answers nothing. The copy says when it
 * was taken.
 */
export interface SwapsWaiting {
  /** Bids in an active state, both roles, at the node's last reading. */
  inProgress: number;
  /** Unix seconds of that reading. */
  at: number;
}

/** The lines to show, or `null` when there is nothing to say. */
export function swapsWaitingLines(
  waiting: SwapsWaiting | null | undefined,
  now: Date = new Date(),
): string[] | null {
  if (!waiting || !Number.isFinite(waiting.inProgress) || waiting.inProgress < 1) {
    return null;
  }
  const n = Math.floor(waiting.inProgress);
  const when = new Date(waiting.at * 1000);
  const stamp =
    when.toDateString() === now.toDateString()
      ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : when.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  return [
    `→ ${n} swap${n === 1 ? "" : "s"} in progress when the swap node last checked (${stamp}).`,
    `→ The swap node needs this wallet unlocked to continue ${n === 1 ? "it" : "them"}.`,
  ];
}
