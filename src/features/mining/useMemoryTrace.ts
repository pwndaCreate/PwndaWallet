/**
 * Memory-trace hook — polls `performance.memory` every 60 seconds and
 * appends to a rolling buffer persisted in localStorage so the trace
 * survives the typical "wallet ate gigabytes overnight" report cycle
 * even after the user restarts the app.
 *
 * Background: the 2026-05-27 and 2026-05-28 memory-leak fix rounds
 * dropped per-render hot-path allocations from ~75 KB to ~3 KB, but
 * users were still reporting WebView2 process memory growing to 7+ GB
 * after long mining sessions. The remaining leak isn't in any
 * accumulator we've audited so far — to find it we need a time-series
 * of V8 heap growth alongside mining events.
 *
 * This hook produces that time-series. The `<MemoryTraceCard>` consumer
 * surfaces a sparkline + current/peak/growth-rate stats and the user
 * can copy the raw data for post-mortem analysis.
 *
 * ## What `performance.memory` reports
 *
 * Chromium / V8 specific (the only WebView2 has). All values in bytes:
 *
 *   - `usedJSHeapSize`  — bytes of actual JS objects retained after GC
 *   - `totalJSHeapSize` — V8's current heap reservation
 *   - `jsHeapSizeLimit` — max heap V8 will grow to
 *
 * These DO NOT include:
 *   - WebView2 native memory (DOM, CSSOM, image buffers, GPU textures,
 *     compiled code cache, IPC message buffers)
 *   - Tauri event queue / native sidechannel
 *
 * If WebView2 process memory in Task Manager is 7 GB but this hook
 * shows `usedJSHeapSize` at 200 MB, the leak is in the WebView2 native
 * layer (not JS). That's a different debugging path: GPU canvas buffers,
 * image cache, or Tauri's event delivery system.
 *
 * If `usedJSHeapSize` itself is growing toward GB scale, the leak is in
 * JS — an accumulating object graph somewhere in the React tree. Take
 * a heap snapshot via DevTools (knowing DevTools itself adds memory
 * pressure) and look for the biggest retainer.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";

/** Poll interval. Once per minute is enough to spot leak slopes;
 *  more frequent polls would add their own measurable per-tick
 *  allocation noise to the very metric they're trying to measure. */
export const MEMORY_TRACE_INTERVAL_MS = 60_000;

/** Cap on persisted samples. 1440 = 24 hours @ 1 sample/min. Anything
 *  older falls off the rolling buffer. */
export const MEMORY_TRACE_MAX_SAMPLES = 1440;

const STORAGE_KEY = "pwnda.memoryTrace.v1";

/** One memory sample. Sizes in MB for human readability. `t` is Unix
 *  ms. `view` is the active app view at sample time — helps correlate
 *  growth with which panel was on screen. */
export interface MemorySample {
  t: number;
  usedMb: number;
  totalMb: number;
  limitMb: number;
  view: string;
  /**
   * 2026-05-30 (leak Round 5) — total live DOM element count
   * (`document.getElementsByTagName("*").length`) and the SVG-subset
   * count at sample time. The JS heap (`usedMb`) stays flat while the
   * WebView2 *native* renderer grows to multi-GB during mining, so the
   * leak is in DOM / compositing / GPU-texture memory that
   * `performance.memory` can't see. These two counters disambiguate the
   * native growth: if `domNodes` climbs in lockstep with the
   * `mem-native` `webviewMb` curve, it's DOM-node accumulation (a
   * concrete, fixable React leak); if `domNodes` stays flat while
   * `webviewMb` climbs, it's compositing-layer / GPU-texture growth from
   * sustained SVG-filter re-rasterization or perpetual CSS animation
   * (no JS object to find — fix the render, not an accumulator).
   * Optional so old persisted traces still parse.
   */
  domNodes?: number;
  svgNodes?: number;
}

/** Stored shape; `version` lets future schema changes migrate cleanly. */
interface MemoryTraceFile {
  version: 1;
  samples: MemorySample[];
}

/** Subset of `Performance` that exposes `memory` (Chromium / V8 only).
 *  Typescript's lib.d.ts doesn't include this since it's non-standard. */
interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

function loadFile(): MemoryTraceFile {
  if (typeof window === "undefined") return { version: 1, samples: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, samples: [] };
    const parsed = JSON.parse(raw) as Partial<MemoryTraceFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.samples)) {
      return { version: 1, samples: [] };
    }
    return { version: 1, samples: parsed.samples };
  } catch {
    return { version: 1, samples: [] };
  }
}

function saveFile(file: MemoryTraceFile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    /* quota exceeded or storage disabled — non-fatal */
  }
}

/** Count live DOM nodes + the SVG subset. Cheap (a single tag-name
 *  collection length read); returns `undefined` outside a browser. The
 *  SVG subset is broken out because the hashrate chart is pure SVG and is
 *  the prime suspect for the 2026-05-30 native-renderer leak. */
function readDomCounts(): { domNodes?: number; svgNodes?: number } {
  if (typeof document === "undefined") return {};
  try {
    const domNodes = document.getElementsByTagName("*").length;
    // `getElementsByTagName("*")` doesn't reach into the SVG namespace by
    // tag wildcard on every engine; querySelectorAll("svg *") does and is
    // the count that matters for the chart-rerasterization hypothesis.
    const svgNodes = document.querySelectorAll("svg, svg *").length;
    return { domNodes, svgNodes };
  } catch {
    return {};
  }
}

function readSample(view: string): MemorySample | null {
  const perf = window.performance as PerformanceWithMemory;
  const mem = perf?.memory;
  if (!mem) return null;
  const { domNodes, svgNodes } = readDomCounts();
  return {
    t: Date.now(),
    usedMb: mem.usedJSHeapSize / 1024 / 1024,
    totalMb: mem.totalJSHeapSize / 1024 / 1024,
    limitMb: mem.jsHeapSizeLimit / 1024 / 1024,
    view,
    domNodes,
    svgNodes,
  };
}

/** How often to force a renderer GC while the app is IDLE. The idle
 *  WebView2 native leak accumulates ~70-75 MB/h independent of our JS
 *  (proven: same rate with the Tauri-emit firehose gated to 0). Microsoft's
 *  WebView2 team (WebView2Feedback #3678) recommends calling `window.gc()`
 *  to reclaim renderer memory — available on RELEASE builds when the runtime
 *  is launched with `--js-flags=--expose-gc` (set in every tauri*.conf.json
 *  window's `additionalBrowserArgs`). 4 min keeps the idle sawtooth low at
 *  negligible CPU cost. */
export const GC_INTERVAL_IDLE_MS = 4 * 60_000;

/** How often to force a renderer GC while MINING. The live hashrate chart
 *  repaints every 2 s during a session (new sample appended), and WebView2
 *  leaks renderer-native memory per repaint — the *mining* leak measured at
 *  ~1600 MB/h (22× the idle rate; session mem-native-20260601T234106Z hit
 *  7.7 GB in 4.6 h). The idle 4-min cadence is far too slow to hold that
 *  back, so we collect much more aggressively while mining — every 45 s
 *  reclaims ~1.2 GB/cycle of accumulated repaint textures, keeping the
 *  ceiling bounded. Still cheap: a forced GC on the (flat ~50 MB) JS heap
 *  is a few ms, dwarfed by the miner's own CPU use. */
export const GC_INTERVAL_MINING_MS = 45_000;

/** Back-compat alias — the idle cadence is the default. */
export const GC_INTERVAL_MS = GC_INTERVAL_IDLE_MS;

/** Window augmented with the V8 `gc()` hook exposed by `--expose-gc`.
 *  Non-standard, so it isn't in lib.dom. Undefined when the flag is
 *  absent (e.g. a plain `vite dev` browser, or an old build) — the hook
 *  no-ops cleanly in that case. */
interface WindowWithGc extends Window {
  gc?: () => void;
}

/**
 * Periodically force a V8/renderer garbage collection to reclaim the
 * WebView2 native-memory creep.
 *
 * Mount EXACTLY ONCE per app instance, in the top-level shell, alongside
 * [`useMemoryTracker`]. This is the application-level half of the
 * Microsoft-recommended mitigation for the WebView2 renderer idle leak
 * (#3678); the other half is the `--expose-gc` flag in
 * `additionalBrowserArgs`. Without that flag `window.gc` is `undefined`
 * and this hook is an inexpensive no-op (it still schedules the timer but
 * each tick early-returns).
 *
 * The cadence is MINING-AWARE: every 45 s while `mining` is true (the
 * chart-repaint leak runs ~22× faster then), every 4 min while idle. Pass
 * the live mining flag from the shell. A forced collection on the (small,
 * flat) JS heap is a few ms, so even the 45 s cadence is negligible next to
 * the miner's own CPU use. We also trigger one opportunistically when the
 * window regains visibility, since the user is most likely to *look* at
 * memory right after refocusing.
 *
 * See `wiki/concepts/webview2-memory-management.md` § Round 8 + 9.
 */
export function usePeriodicGc(mining: boolean = false): void {
  useEffect(() => {
    const runGc = () => {
      const w = window as WindowWithGc;
      if (typeof w.gc === "function") {
        try {
          w.gc();
        } catch {
          /* gc() can throw if called re-entrantly; never fatal */
        }
      }
    };
    const intervalMs = mining ? GC_INTERVAL_MINING_MS : GC_INTERVAL_IDLE_MS;
    const id = window.setInterval(runGc, intervalMs);
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        runGc();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      window.clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
    // Re-arm the interval when mining starts/stops so the cadence switches
    // between the idle (4 min) and mining (45 s) rates.
  }, [mining]);
}

/**
 * Polling-mode hook. Mount EXACTLY ONCE per app instance — typically in
 * the top-level shell (`App.tsx` / `LiteApp.tsx`) so memory is sampled
 * continuously regardless of which panel is on screen. Two instances
 * would double-sample, wasting localStorage writes and producing
 * duplicated samples in the persisted trace.
 *
 * Pass the current `view` string so each sample is labeled with what
 * was rendered — lets the post-mortem reader correlate growth slope
 * inflections with which panel was active.
 */
export function useMemoryTracker({ view }: { view: string }): void {
  // Track the latest view in a ref so the polling closure can read it
  // without re-subscribing the interval every time the view changes.
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const collect = () => {
      const s = readSample(viewRef.current);
      if (!s) return;
      const current = loadFile().samples;
      const next = [...current, s];
      // Cap rolling buffer.
      if (next.length > MEMORY_TRACE_MAX_SAMPLES) {
        next.splice(0, next.length - MEMORY_TRACE_MAX_SAMPLES);
      }
      saveFile({ version: 1, samples: next });
      // Mirror the sample to a backend JSONL (`mem-frontend-*.jsonl`) so a
      // post-mortem can overlay the JS-heap / DOM-node / SVG-node curve
      // against the native renderer RSS (`mem-native-*.jsonl`) and localize a
      // leak by `view`. Dev-gated on the backend (no-op in release); ~1
      // invoke/min, so it can't reopen the IPC firehose. Fire-and-forget.
      void invoke("mem_frontend_log", { sample: s }).catch(() => {});
    };
    // Fire one immediately so the trace has at least one data point on
    // first mount; subsequent samples at the interval cadence.
    collect();
    const id = window.setInterval(collect, MEMORY_TRACE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
}

/**
 * Reader-mode hook. Mount in the `<MemoryTraceCard>` (or anywhere else
 * that wants to display the trace). Just reads from localStorage at a
 * lower cadence than the tracker writes — doesn't poll `performance.memory`
 * itself. Safe to mount/unmount as the consumer tab opens/closes.
 *
 * Refresh cadence is 10s — enough to reflect a fresh tracker sample
 * within the user's typical attention span without churning React state
 * on every IDE keystroke.
 */
export interface UseMemoryTraceDataResult {
  samples: MemorySample[];
  currentUsedMb: number | null;
  growthMbPerHour: number | null;
  peakUsedMb: number | null;
  reset: () => void;
}

export function useMemoryTraceData(): UseMemoryTraceDataResult {
  const [samples, setSamples] = useState<MemorySample[]>(() => loadFile().samples);

  useEffect(() => {
    const refresh = () => setSamples(loadFile().samples);
    // Refresh quickly on mount so the card shows the latest tracker
    // state immediately, then poll at a relaxed cadence afterward.
    refresh();
    const id = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(id);
  }, []);

  // Derived stats.
  const currentUsedMb =
    samples.length > 0 ? samples[samples.length - 1].usedMb : null;
  const peakUsedMb =
    samples.length > 0
      ? samples.reduce((m, s) => (s.usedMb > m ? s.usedMb : m), 0)
      : null;

  let growthMbPerHour: number | null = null;
  if (samples.length >= 2) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60_000;
    const win = samples.filter((s) => s.t >= oneHourAgo);
    if (win.length >= 2) {
      const first = win[0];
      const last = win[win.length - 1];
      const hours = (last.t - first.t) / 3_600_000;
      if (hours > 0) {
        growthMbPerHour = (last.usedMb - first.usedMb) / hours;
      }
    }
  }

  const reset = () => {
    setSamples([]);
    saveFile({ version: 1, samples: [] });
  };

  return {
    samples,
    currentUsedMb,
    growthMbPerHour,
    peakUsedMb,
    reset,
  };
}
