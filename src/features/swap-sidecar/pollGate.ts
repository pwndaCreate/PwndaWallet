/**
 * Two small gates for the swap tracker's poll (RAM plan Phase 2.2, 2026-09-23).
 *
 * ## Why these exist
 *
 * `useSidecarSwap` treats every frame on the node's event WebSocket as a
 * doorbell: `socket.onmessage = () => void pollAll()`. The node broadcasts a
 * frame for EVERY offer any peer posts to the network and for periodic
 * balance events (`basicswap.py` `ws_server.send_message_to_all`), none of
 * which concern this user's own bids — and each frame started a full
 * sequential fetch of every live swap plus a `setSwaps` re-render per swap,
 * with no in-flight guard. On a busy order book that is a steady stream of
 * overlapping fetch loops.
 *
 * It is also the one poller a hidden window does NOT slow down: WebView2
 * throttles `setInterval` when the page is minimised, but a WebSocket frame is
 * an event, not a timer. (Pausing this hook while hidden is not an option
 * either — it exists precisely so an unanswered bid is noticed while the
 * window is minimised; see the comment above the re-bid effect.)
 *
 * ## What they do
 *
 * - {@link singleFlight}: at most one run at a time. A call that arrives
 *   mid-run does not start a second overlapping run and is not queued N deep —
 *   it sets one "run again" flag, so a burst collapses to one trailing run.
 * - {@link throttleLeadingTrailing}: the first call runs at once, calls inside
 *   the window collapse into ONE call when the window ends. Bounds a frame
 *   flood to one poll per window while still reacting to the first frame
 *   immediately.
 *
 * Both are pure over injected clocks so the tests need no real time.
 */

/** Wrap `fn` so it never overlaps itself; a call during a run schedules one re-run. */
export function singleFlight(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await fn();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

export interface Throttled {
  (): void;
  /** Drop a pending trailing call. Call from the effect cleanup. */
  cancel: () => void;
}

/**
 * Run `fn` on the first call, then at most once per `windowMs`: calls that land
 * inside the window collapse into a single trailing call at its end.
 */
export function throttleLeadingTrailing(
  fn: () => void,
  windowMs: number,
  clock: {
    now: () => number;
    setTimer: (cb: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
  } = {
    now: () => Date.now(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): Throttled {
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  const call = (() => {
    const wait = last + windowMs - clock.now();
    if (wait <= 0) {
      last = clock.now();
      fn();
    } else if (timer === null) {
      timer = clock.setTimer(() => {
        timer = null;
        last = clock.now();
        fn();
      }, wait);
    }
  }) as Throttled;
  call.cancel = () => {
    if (timer !== null) {
      clock.clearTimer(timer);
      timer = null;
    }
  };
  return call;
}
