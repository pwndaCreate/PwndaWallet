/**
 * "Take me to the DEX coin editor" — a one-line channel between the swap-node
 * card's coin tiles and the `DEX COINS` section that actually owns the toggles.
 *
 * # Why a channel instead of props
 *
 * The tiles are read-only **on purpose**: `swap_sidecar_set_coin`, the
 * pending-coins reconcile and the restart it sometimes needs are one apply
 * cycle, and `DexCoinsSection` owns it. A second writer in the status card
 * would be two controls over one piece of node state — the exact shape that
 * produced the 2026-08-20 "prop threaded to the panel but not the section"
 * defect. That decision stands; this does not add a writer.
 *
 * What it fixes is the affordance. The tiles look like toggles (bordered,
 * filled-or-hollow, one per coin) and sit exactly where a user reaches to turn
 * a coin on, and clicking one did nothing at all. The only pointer to the real
 * control was an 8px dim caption. Reported 2026-09-04: *"I am unable to click
 * the other coins for the swap node while its running to enable them."* The
 * user was clicking the right thing; it just was not wired to anything.
 *
 * Props would mean threading a callback and an expand-signal from Settings
 * through the portrait view AND the landscape view into two separately-mounted
 * components. That is precisely the drift this repo keeps paying for — a
 * feature wired in one surface and not the other. One channel, subscribed by
 * the section itself, is wired once and works in both by construction.
 *
 * # Semantics
 *
 * `requestDexCoinsFocus()` is a request, not a command: if no section is
 * mounted, nothing happens and nothing throws. Listeners are responsible for
 * expanding and scrolling themselves — this module deliberately knows nothing
 * about the DOM.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Ask whatever DEX-coins editor is mounted to open itself and scroll into view.
 * Safe to call when none is mounted.
 */
export function requestDexCoinsFocus(): void {
  // Copy before iterating: a listener that unsubscribes itself while handling
  // must not perturb this iteration.
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // One misbehaving listener must not stop the others, and a failed
      // scroll is never worth an error boundary.
    }
  }
}

/** Subscribe. Returns the unsubscribe function. */
export function onDexCoinsFocus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop every listener. */
export function __resetDexCoinsFocus(): void {
  listeners.clear();
}
