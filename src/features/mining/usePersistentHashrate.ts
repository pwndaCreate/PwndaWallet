/**
 * Persistent hashrate history hook — Tier 2 of the two-tier hashrate
 * history design (see [[hashrate-history]]).
 *
 * Subscribes to the active mining session's raw 2-s hashrate samples
 * (Tier 1, owned by `useMiner.ts`) and rolls them up into 1-minute
 * buckets persisted to disk via `hashrateHistoryStore.ts`. Designed to
 * be cheap on the hot path: aggregation runs at most once per 60 s,
 * disk writes are debounced to once per 5 min (≈12 writes/hr per active
 * series), and the in-memory copy is the source of truth for renders.
 *
 * Lifecycle:
 *   - Hydrate from disk on mount (one-shot).
 *   - Every BUCKET_WINDOW_MS while mining: roll up new samples for the
 *     active (chain, algorithm) series, append a bucket, schedule a
 *     debounced disk write.
 *   - On stop / coin / algo change: force-flush the partial bucket so
 *     the user sees their last few mining seconds reflected immediately.
 *   - On window-close (Tauri "destroyed" event): force-flush.
 *
 * Returns:
 *   - `loaded` — true once the disk hydrate has resolved
 *   - `getSeriesFor(chain, algorithm)` — read accessor for renders
 *   - `activeSeries` — buckets for the currently-active mining target
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChainType } from "../../wallets";
import type {
  CpuAlgorithm,
  GpuAlgorithm,
  MiningHardware,
} from "../../types/mining";
import {
  appendBucket,
  BUCKET_WINDOW_MS,
  floorToBucket,
  type HashrateBucket,
  type HashrateHistoryFile,
  loadHistory,
  makeSeriesKey,
  pruneOldBuckets,
  reduceSamplesToBucket,
  saveHistory,
  type SeriesKey,
} from "./hashrateHistoryStore";

/** How often we flush the in-memory store to disk while mining (ms). */
const DEBOUNCED_WRITE_MS = 5 * 60_000; // 5 min

/** Inputs the hook needs to compute + persist buckets. */
export interface UsePersistentHashrateInput {
  /** True while the *displayed* hardware (CPU or GPU) is actively mining. */
  mining: boolean;
  /** Active mining coin — keys the series. */
  miningCoin: ChainType;
  /** Hardware kind picks which algorithm key to use. */
  miningHardware: MiningHardware;
  /** Active CPU algorithm (only consulted when `miningHardware === "cpu"`). */
  cpuAlgorithm: CpuAlgorithm;
  /** Active GPU algorithm (only consulted when `miningHardware === "gpu"`). */
  gpuAlgorithm: GpuAlgorithm;
  /**
   * Tier-1 raw sample buffer from `useMiner.ts`. Each sample is `{ t,
   * value }` with `t` in Unix ms and `value` in H/s. We don't mutate
   * this array; we just window-slice it.
   */
  hashrateSamples: { t: number; value: number }[];
}

export interface UsePersistentHashrateResult {
  /** Disk hydrate finished (or fast-failed). Renderers can wait on this to avoid a flicker. */
  loaded: boolean;
  /** Read any series, e.g. for cross-coin overlays in a future feature. */
  getSeriesFor: (
    chain: ChainType,
    algo: CpuAlgorithm | GpuAlgorithm,
  ) => HashrateBucket[];
  /** Convenience accessor for the currently-active series. */
  activeSeries: HashrateBucket[];
  /** Force-flush partial bucket + disk write. Called by Stop. */
  flush: () => Promise<void>;
}

function currentAlgoFor(
  hw: MiningHardware,
  cpu: CpuAlgorithm,
  gpu: GpuAlgorithm,
): CpuAlgorithm | GpuAlgorithm {
  return hw === "cpu" ? cpu : gpu;
}

export function usePersistentHashrate(
  input: UsePersistentHashrateInput,
): UsePersistentHashrateResult {
  const {
    mining,
    miningCoin,
    miningHardware,
    cpuAlgorithm,
    gpuAlgorithm,
    hashrateSamples,
  } = input;

  const algorithm = currentAlgoFor(miningHardware, cpuAlgorithm, gpuAlgorithm);
  const activeKey: SeriesKey = makeSeriesKey(miningCoin, algorithm);

  // The hook's source of truth. Mirrors the on-disk file; renderers read from here.
  const [fileState, setFileState] = useState<HashrateHistoryFile | null>(null);
  const fileRef = useRef<HashrateHistoryFile | null>(null);

  // Bucket-start timestamp the aggregator most recently closed. Used to
  // detect when a new minute boundary has been crossed.
  const lastBucketStartRef = useRef<number>(0);
  // Debounced-write scheduler — tracks the next-scheduled flush.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Dirty bit so an immediate flush() avoids a no-op disk write.
  const dirtyRef = useRef<boolean>(false);

  // ── Disk hydrate (one-shot) ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const f = await loadHistory();
      const pruned = pruneOldBuckets(f, Date.now());
      if (cancelled) return;
      fileRef.current = pruned;
      setFileState(pruned);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Persist helper ──────────────────────────────────────────────
  const persistNow = useCallback(async (): Promise<void> => {
    if (!fileRef.current || !dirtyRef.current) return;
    dirtyRef.current = false;
    if (writeTimerRef.current) {
      clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    await saveHistory(fileRef.current);
  }, []);

  const schedulePersist = useCallback((): void => {
    dirtyRef.current = true;
    if (writeTimerRef.current) return;
    writeTimerRef.current = setTimeout(() => {
      writeTimerRef.current = null;
      void persistNow();
    }, DEBOUNCED_WRITE_MS);
  }, [persistNow]);

  // ── Bucket aggregator ───────────────────────────────────────────
  //
  // Fired both as a reaction to `hashrateSamples` change AND on a
  // self-managed 60-second tick. Sample-driven firing handles the
  // common case (a new sample tipped us past a minute boundary);
  // the timer is a safety net for the case where polling is paused
  // (tab hidden, miner stalled) so we don't lose minutes' worth of
  // bucket boundaries.
  useEffect(() => {
    if (!fileRef.current) return; // wait for hydrate
    if (!mining) return; // nothing to aggregate when idle

    const tryAggregate = () => {
      const file = fileRef.current;
      if (!file) return;
      const nowFloor = floorToBucket(Date.now());
      // First aggregation in this session: seed the watermark to the
      // EARLIER of `nowFloor - 1` and the timestamp of the oldest still-
      // unbucketed sample. Prevents the first bucket from ever extending
      // backwards more than one minute.
      if (lastBucketStartRef.current === 0) {
        lastBucketStartRef.current = nowFloor - BUCKET_WINDOW_MS;
      }
      // Close every fully-complete bucket between the last watermark
      // and the current minute. Usually this is one iteration; bumps
      // to two only when the poll loop slipped.
      while (lastBucketStartRef.current + BUCKET_WINDOW_MS < nowFloor) {
        const bucketStart = lastBucketStartRef.current + BUCKET_WINDOW_MS;
        const bucketEnd = bucketStart + BUCKET_WINDOW_MS;
        const samplesInWindow = hashrateSamples.filter(
          (s) => s.t >= bucketStart && s.t < bucketEnd && s.value > 0,
        );
        const bucket = reduceSamplesToBucket(samplesInWindow, bucketStart);
        if (bucket) {
          const updated = appendBucket(file, activeKey, bucket);
          fileRef.current = updated;
          setFileState({ ...updated, series: { ...updated.series } });
          schedulePersist();
        }
        lastBucketStartRef.current = bucketStart;
      }
    };

    tryAggregate();
    const id = window.setInterval(tryAggregate, BUCKET_WINDOW_MS);
    return () => window.clearInterval(id);
  }, [
    mining,
    hashrateSamples,
    activeKey,
    schedulePersist,
  ]);

  // ── Watermark reset on session boundary ─────────────────────────
  // When the user stops mining, force-flush the *partial* current
  // minute (so the last <60s of mining survives even if the user closes
  // the app right after) and reset the watermark. The aggregator skips
  // partial buckets in normal operation; this is the one place we
  // explicitly handle them.
  useEffect(() => {
    if (mining) return;
    const file = fileRef.current;
    if (!file) return;
    if (lastBucketStartRef.current === 0) return; // session never started

    const partialStart = lastBucketStartRef.current + BUCKET_WINDOW_MS;
    const partialEnd = Date.now();
    if (partialEnd > partialStart) {
      const samplesInWindow = hashrateSamples.filter(
        (s) => s.t >= partialStart && s.t < partialEnd && s.value > 0,
      );
      const bucket = reduceSamplesToBucket(samplesInWindow, partialStart);
      if (bucket) {
        const updated = appendBucket(file, activeKey, bucket);
        fileRef.current = updated;
        setFileState({ ...updated, series: { ...updated.series } });
      }
    }
    lastBucketStartRef.current = 0;
    void persistNow();
  }, [mining, activeKey, hashrateSamples, persistNow]);

  // ── Cleanup: flush on unmount (app close / tab destroy) ─────────
  useEffect(() => {
    return () => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      // Best-effort sync flush on teardown. saveHistory is async; we
      // don't await (we can't in cleanup) but the underlying tauri-
      // plugin-store enqueues the write atomically.
      void persistNow();
    };
  }, [persistNow]);

  // ── Read API ─────────────────────────────────────────────────────
  const getSeriesFor = useCallback(
    (chain: ChainType, algo: CpuAlgorithm | GpuAlgorithm): HashrateBucket[] => {
      const f = fileState;
      if (!f) return [];
      const key = makeSeriesKey(chain, algo);
      return [...(f.series[key] ?? [])];
    },
    [fileState],
  );

  const activeSeries = fileState
    ? [...(fileState.series[activeKey] ?? [])]
    : [];

  return {
    loaded: fileState !== null,
    getSeriesFor,
    activeSeries,
    flush: persistNow,
  };
}
