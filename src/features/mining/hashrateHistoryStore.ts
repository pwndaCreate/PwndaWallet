/**
 * Persistent hashrate-history store — disk-backed time series for the
 * mining hero panel's [24 HR] view.
 *
 * Tier-2 of the two-tier hashrate-history design (see
 * `wiki/concepts/hashrate-history.md`):
 *
 *   - **Tier 1** lives in `useMiner.ts::hashrateSamples` — 2-second raw
 *     samples capped at 300 (= 10 min). Drives the [1 HR] view.
 *   - **Tier 2** lives in this file + `usePersistentHashrate.ts` — one
 *     bucket per minute, ≤1,440 buckets per (chain, algo) series
 *     (= 24 hr), persisted via `tauri-plugin-store`. Drives the [24 HR]
 *     view. Survives app restarts, crashes, and long idle periods.
 *
 * Storage backend: `tauri-plugin-store` file `hashrate-history.dat`
 * (separate from the wallet vault; never encrypted, never holds keys).
 * Atomic JSON writes — a crash mid-write can lose at most the
 * currently-pending bucket, not the whole series.
 *
 * Schema is versioned. Future changes bump `SCHEMA_VERSION` and add a
 * migrator below; readers tolerate `version` mismatches by resetting
 * to an empty store (history loss is acceptable, divergent reads are not).
 */

import { Store } from "@tauri-apps/plugin-store";
import type { ChainType } from "../../wallets";
import type { CpuAlgorithm, GpuAlgorithm } from "../../types/mining";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;
const STORE_FILE = "hashrate-history.dat";
const STORE_KEY = "history";

/** Maximum buckets we keep per series (= 24 hr × 60 min). */
export const MAX_BUCKETS_PER_SERIES = 1440;

/** Bucket aggregation window in milliseconds (1 minute). */
export const BUCKET_WINDOW_MS = 60_000;

/**
 * One minute of hashrate data, down-sampled from the Tier-1 raw buffer.
 * `t` is the bucket START in Unix milliseconds (UTC). The bucket covers
 * `[t, t + BUCKET_WINDOW_MS)`.
 */
export interface HashrateBucket {
  /** Bucket-start timestamp (Unix ms, UTC). Always aligned to a wall-clock minute. */
  t: number;
  /** Average raw-sample hashrate within the bucket window. H/s for RandomX, H/s for KawPow, etc. */
  avg: number;
  /** Smallest sample in the window. */
  min: number;
  /** Largest sample in the window. */
  max: number;
  /** Number of raw samples that landed in this bucket. */
  n: number;
}

/**
 * Stable key for the per-series map. Pairing chain + algorithm because
 * the same algorithm hashrates differently across chains — XMR-RandomX
 * and ZEPH-RandomX are visually distinct on the same CPU because the
 * scratchpad / dataset sizes differ. KawPow only goes through RVN; the
 * pairing is symmetric and future-proof.
 *
 * `randomx` for CPU; `kawpow`/`octopus`/`autolykos` for GPU. We don't
 * key by hardware kind because the chain implies it.
 */
export type SeriesKey = `${ChainType}/${CpuAlgorithm | GpuAlgorithm}`;

export function makeSeriesKey(
  chain: ChainType,
  algorithm: CpuAlgorithm | GpuAlgorithm,
): SeriesKey {
  return `${chain}/${algorithm}` as SeriesKey;
}

export interface HashrateHistoryFile {
  version: number;
  /** Per-(chain, algorithm) bucket arrays, capped at MAX_BUCKETS_PER_SERIES each. */
  series: Partial<Record<SeriesKey, HashrateBucket[]>>;
}

function emptyFile(): HashrateHistoryFile {
  return { version: SCHEMA_VERSION, series: {} };
}

// ---------------------------------------------------------------------------
// Singleton store accessor
// ---------------------------------------------------------------------------

let _storePromise: Promise<Store> | null = null;
async function getStore(): Promise<Store> {
  if (!_storePromise) {
    _storePromise = Store.load(STORE_FILE);
  }
  return _storePromise;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Load the entire history file from disk. Returns an empty file on any
 * failure (missing key, JSON corruption, version mismatch) — UI never
 * blocks on history retrieval, and a fresh-install / corrupted-cache
 * scenario is indistinguishable from "no data yet".
 */
export async function loadHistory(): Promise<HashrateHistoryFile> {
  try {
    const store = await getStore();
    const raw = await store.get<unknown>(STORE_KEY);
    if (!raw || typeof raw !== "object") return emptyFile();
    const parsed = raw as Partial<HashrateHistoryFile>;
    if (parsed.version !== SCHEMA_VERSION || !parsed.series) {
      // Future schema changes plug their migrators here. For now: reset.
      return emptyFile();
    }
    return { version: SCHEMA_VERSION, series: parsed.series };
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.warn("[hashrate-history] load failed; starting fresh:", e);
    return emptyFile();
  }
}

/**
 * Persist the history file. Fire-and-forget — caller doesn't block on
 * disk; cache write failure is non-fatal (UI keeps working from the
 * in-memory copy, next write attempt may succeed).
 */
export async function saveHistory(file: HashrateHistoryFile): Promise<void> {
  try {
    const store = await getStore();
    await store.set(STORE_KEY, file);
    await store.save();
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.warn("[hashrate-history] save failed:", e);
  }
}

/**
 * Append a single bucket to a series and trim to the rolling cap.
 * Mutates the file in place + returns it for chaining; caller is
 * responsible for calling `saveHistory` after (typically debounced).
 *
 * Enforces a monotonic-timestamp invariant: a bucket whose `t` is
 * less-than-or-equal to the previous bucket's `t` is dropped (defends
 * against NTP backward-jumps + double-aggregation races).
 */
export function appendBucket(
  file: HashrateHistoryFile,
  key: SeriesKey,
  bucket: HashrateBucket,
): HashrateHistoryFile {
  const existing = file.series[key] ?? [];
  if (existing.length > 0 && bucket.t <= existing[existing.length - 1].t) {
    // Non-monotonic — skip. (Clock skew, double-fire, etc.)
    return file;
  }
  const next = [...existing, bucket];
  if (next.length > MAX_BUCKETS_PER_SERIES) {
    next.splice(0, next.length - MAX_BUCKETS_PER_SERIES);
  }
  file.series[key] = next;
  return file;
}

/**
 * Drop buckets older than `nowMs - 24 hr` across every series. Called
 * lazily before reads so a long-idle wallet still gets a clean 24h
 * window the moment the user opens the chart.
 */
export function pruneOldBuckets(
  file: HashrateHistoryFile,
  nowMs: number,
): HashrateHistoryFile {
  const cutoff = nowMs - MAX_BUCKETS_PER_SERIES * BUCKET_WINDOW_MS;
  let mutated = false;
  for (const [k, buckets] of Object.entries(file.series)) {
    if (!buckets || buckets.length === 0) continue;
    const trimmed = buckets.filter((b) => b.t >= cutoff);
    if (trimmed.length !== buckets.length) {
      file.series[k as SeriesKey] = trimmed;
      mutated = true;
    }
  }
  void mutated; // surfaced via series-length comparison if a caller cares
  return file;
}

/**
 * Read-only series accessor used by the chart + sessions list.
 * Returns a defensive copy so consumers can't mutate the cached file.
 */
export function getSeries(
  file: HashrateHistoryFile,
  key: SeriesKey,
): HashrateBucket[] {
  return [...(file.series[key] ?? [])];
}

// ---------------------------------------------------------------------------
// Aggregator helpers (pure functions used by the hook)
// ---------------------------------------------------------------------------

/**
 * Compute a bucket from a set of raw samples that all fell within the
 * same 60-second window. Returns null when the input is empty so the
 * caller can skip non-mining minutes cleanly.
 */
export function reduceSamplesToBucket(
  samples: { t: number; value: number }[],
  bucketStartMs: number,
): HashrateBucket | null {
  if (samples.length === 0) return null;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    sum += s.value;
    if (s.value < min) min = s.value;
    if (s.value > max) max = s.value;
  }
  return {
    t: bucketStartMs,
    avg: sum / samples.length,
    min,
    max,
    n: samples.length,
  };
}

/** Floor a timestamp down to the nearest minute boundary. */
export function floorToBucket(ms: number): number {
  return Math.floor(ms / BUCKET_WINDOW_MS) * BUCKET_WINDOW_MS;
}
