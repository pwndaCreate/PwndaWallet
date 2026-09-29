/**
 * Shared chart-data throttle for the Mine views (RAM plan Phase 2M.2,
 * 2026-09-23).
 *
 * Moved out of `MiningView.tsx` VERBATIM. It used to be private to the
 * PORTRAIT view, so the Round 9 mining-leak fix (below) protected portrait
 * only: `MineLandscapeView` - the primary surface - handed `hashrateSamples`
 * straight to `<HashrateAreaChart>` and repainted it every 2 s. Same
 * landscape-first failure shape CLAUDE.md records for the BasicSwap taker UI:
 * a fix built for one layout, the other left looking wired up. Both views now
 * import this, and `mineChartThrottleParity.test.ts` checks the wiring itself.
 */
import { useEffect, useRef, useState } from "react";

/**
 * 2026-06-01 (leak Round 9) — how often the live 1 HR hashrate chart is
 * allowed to repaint while mining. Samples are collected every 2 s, but
 * the chart's heavy SVG-path rebuild + WebView2 re-raster (the source of
 * the ~1600 MB/h mining leak) only needs to happen at a human-visible
 * cadence. 12 s is ~360 px/12 s ≈ 0.1 px/s motion on a 1-hour window —
 * imperceptible — while cutting the repaint count (and its leak) ~6×.
 */
export const CHART_REPAINT_THROTTLE_MS = 12_000;

/**
 * Return a reference to `value` that only updates at most once per
 * `intervalMs`. Used to decouple a high-frequency source array (hashrate
 * samples, appended every 2 s) from an expensive consumer (the SVG chart)
 * so the consumer re-renders on a slower, human-visible cadence. The
 * latest value is always captured; the throttle only delays *when the
 * consumer sees a new reference*, never drops the final value (a trailing
 * timer flushes the last update). Generic over the value type.
 */
export function useThrottledRef<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState<T>(value);
  const lastEmitRef = useRef<number>(Date.now());
  const latestRef = useRef<T>(value);
  latestRef.current = value;

  useEffect(() => {
    const sinceLast = Date.now() - lastEmitRef.current;
    if (sinceLast >= intervalMs) {
      // Enough time has passed — emit immediately.
      lastEmitRef.current = Date.now();
      setThrottled(latestRef.current);
      return;
    }
    // Otherwise schedule a trailing flush so the final value isn't lost.
    const id = window.setTimeout(() => {
      lastEmitRef.current = Date.now();
      setThrottled(latestRef.current);
    }, intervalMs - sinceLast);
    return () => window.clearTimeout(id);
  }, [value, intervalMs]);

  return throttled;
}
