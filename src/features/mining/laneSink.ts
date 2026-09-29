/**
 * Where a hashrate poll's result goes (RAM plan Phase 2M.3, 2026-09-23).
 *
 * ## The cost this removes
 *
 * `useMiner` runs inside `App`, and each lane's 2 s snapshot poll used to end in
 * `setHashrateSamples(...)` + `setSession(...)`. So while mining, EVERY poll
 * re-rendered the app root. Measured in the sandbox (`cpu_gpu_mining_active`,
 * user sitting on the Wallet tab): **0 App renders/min with mining off, ~62/min
 * with a dual-lane session live** — a steady stream of render allocation for
 * data nothing on screen shows. (Nothing outside `features/mining` reads the
 * samples or the session; the 60 s persistence aggregator runs inside
 * `MiningView`.)
 *
 * ## Why not just poll less
 *
 * The poll is deliberately NOT focus-gated: the sample buffer has to stay
 * contiguous so the Tier-2 aggregator can catch up over minutes the user spent
 * elsewhere, and an earlier focus-gated version showed the 24 HR chart as
 * isolated spikes (fixed 2026-05-15 - see `hashrate-history.md` § "Tier-2
 * depends on the unconditional poll"). It also feeds the 1 HR chart's gap
 * bridging, which treats a gap over ~5 expected intervals as real downtime.
 * So the poll and its timestamps must stay exactly as they are.
 *
 * ## What this does instead
 *
 * The poll keeps running every 2 s and keeps producing real, timestamped
 * samples. What changes is only when they are committed to React state:
 *
 * - **Mine view on screen** (`isLive()`): commit immediately - behaviour
 *   identical to before, one sample per commit.
 * - **Otherwise**: park the samples and commit them as ONE batch every
 *   `flushMs`, or the instant the Mine view gets focus. The buffer ends up with
 *   the same samples at the same timestamps; it just arrives in a few large
 *   commits instead of one small commit every 2 s.
 *
 * Pure over an injected clock so the tests need no real time.
 */

export type HashrateSample = { t: number; value: number };

/** Cap kept in step with `MAX_HASHRATE_SAMPLES` in `useMiner.ts` (1800). */
export function appendCapped(
  prev: HashrateSample[],
  batch: HashrateSample[],
  max: number,
): HashrateSample[] {
  const next = prev.concat(batch);
  return next.length > max ? next.slice(-max) : next;
}

export interface LaneSink<S> {
  /** Record one poll result. */
  push(sample: HashrateSample, session: S): void;
  /** Commit whatever is parked, now. No-op when nothing is. */
  flush(): void;
  /** Drop parked samples and cancel the timer - the lane stopped. */
  dispose(): void;
}

export function createLaneSink<S>(opts: {
  /** True while the Mine view is on screen. Read at every push. */
  isLive: () => boolean;
  /** Commit a batch (oldest first) and the newest session to state. */
  apply: (batch: HashrateSample[], session: S) => void;
  /** Longest a parked sample waits when the Mine view is not on screen. */
  flushMs: number;
  clock?: {
    setTimer: (cb: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
  };
}): LaneSink<S> {
  const clock = opts.clock ?? {
    setTimer: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let pending: HashrateSample[] = [];
  let pendingSession: { value: S } | null = null;
  let timer: unknown = null;

  const clearTimer = () => {
    if (timer !== null) {
      clock.clearTimer(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (pending.length === 0 || pendingSession === null) return;
    const batch = pending;
    const session = pendingSession.value;
    pending = [];
    pendingSession = null;
    opts.apply(batch, session);
  };

  return {
    push(sample, session) {
      pending.push(sample);
      pendingSession = { value: session };
      if (opts.isLive()) {
        flush();
      } else if (timer === null) {
        timer = clock.setTimer(flush, opts.flushMs);
      }
    },
    flush,
    dispose() {
      clearTimer();
      pending = [];
      pendingSession = null;
    },
  };
}
