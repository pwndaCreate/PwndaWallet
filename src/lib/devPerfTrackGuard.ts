/**
 * Dev-only: keep React 19.2's development "Performance Tracks" from piling up
 * in the browser's Performance timeline (RAM plan Phase 4, 2026-09-27).
 *
 * ## What happened
 *
 * React 19.2's DEVELOPMENT build logs every component render to the
 * Performance timeline. When a component re-renders with changed props it
 * first DIFFS the old and new props (`addObjectDiffToProperties`, recursing
 * into arrays and objects) and records the diff as the `detail` of a
 * `performance.measure(...)`. The browser structured-clones that detail and
 * keeps every entry until someone calls `performance.clearMeasures()` —
 * nothing does.
 *
 * While mining, the hashrate buffer (1,800 samples = 1 h at 2 s) reaches
 * components as props. For the first hour each poll APPENDS, so old and new
 * arrays share their elements and the diff is one row. From then on each poll
 * SLIDES the window: every index holds a different object, and the diff is
 * ~1,000+ rows per component per poll. Measured on the operator's instance:
 * renderer commit grew 2–5 MB/min for the first hour of a GPU session, then
 * 20–47 MB/min from the minute the buffer filled (04:09, exactly 1 h after
 * the 03:08 start) — 13.2 GB by morning. Reproduced in the Tauri sandbox by
 * filling the buffer: +45 MB/min, all in `partition_alloc/partitions/buffer`;
 * 17,107 retained measures averaging 1,085 diff rows; `clearMeasures()` took
 * the renderer from 911 to 238 MB. Production React has no such logging.
 *
 * ## What this does
 *
 * Wraps `performance.measure` so a call carrying React's DevTools payload
 * (`detail.devtools`) is not recorded. Every other measure passes through
 * untouched (the app itself records none today). The diff is still computed
 * — it is React's own dev-only CPU cost — but nothing is retained.
 *
 * Opt out for a React profiling session in DevTools:
 * `localStorage["pwnda-dev-react-perf-tracks"] = "1"`, then reload.
 */

/** React's DevTools-extension track payload: `{ detail: { devtools: {...} } }`. */
export function isReactDevtoolsMeasure(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  const detail = (options as { detail?: unknown }).detail;
  if (!detail || typeof detail !== "object") return false;
  const devtools = (detail as { devtools?: unknown }).devtools;
  return !!devtools && typeof devtools === "object";
}

const INSTALLED = Symbol.for("pwnda.devPerfTrackGuard");

type MeasureFn = Performance["measure"];

/**
 * Install once. Returns an uninstall function (tests; never needed at
 * runtime). A second install is a no-op that returns a no-op.
 */
export function installDevPerfTrackGuard(perf: Performance | undefined = globalThis.performance): () => void {
  if (!perf || typeof perf.measure !== "function") return () => {};
  const tagged = perf as Performance & { [INSTALLED]?: true };
  if (tagged[INSTALLED]) return () => {};
  const original: MeasureFn = perf.measure;
  const guarded = function (this: Performance, ...args: Parameters<MeasureFn>) {
    if (isReactDevtoolsMeasure(args[1])) return undefined as unknown as PerformanceMeasure;
    return original.apply(this, args);
  } as MeasureFn;
  perf.measure = guarded;
  tagged[INSTALLED] = true;
  return () => {
    if (perf.measure === guarded) perf.measure = original;
    delete tagged[INSTALLED];
  };
}

/** Whether the operator opted out for a profiling session. */
export function reactPerfTracksWanted(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem("pwnda-dev-react-perf-tracks") === "1";
  } catch {
    return false;
  }
}
