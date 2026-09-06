import { useEffect, useState } from "react";

/**
 * A clock that re-renders its component on an interval.
 *
 * Elapsed-time UI has no state of its own to react to — a swap's `createdAt`
 * never changes, so without a tick the "running 4m 12s" label would freeze at
 * whatever it read when the parent last rendered, which is exactly the "is
 * this thing still alive?" question it exists to answer.
 *
 * `active` is not an optimisation: the interval is installed only while
 * something is actually in flight, so an idle Swap tab does not re-render once
 * a second forever.
 */
export function useNowTick(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Read once on activation so the first frame is not up to `everyMs` stale.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);
  return now;
}
