/**
 * src/features/mining/miningTuning.ts
 *
 * The CPU thread slider, the GPU intensity slider, and which GPUs count as
 * "dedicated" for the device picker. Pure functions plus two localStorage
 * keys, so the mapping from a slider position to a miner flag is testable
 * without React (see `miningTuning.test.ts`).
 *
 * # Flags (checked against the pinned binaries' own `--help`, 2026-09-16)
 *
 *   xmrig 6.26.0            `-t, --threads=N`        number of CPU threads
 *                           `--cpu-priority=N`       0 idle, 2 normal … 5 highest
 *   SRBMiner-MULTI 3.6.2    `--cpu-threads`          number of cpu threads
 *                           `--cpu-threads-priority` 1-5, default 2
 *                           `--gpu-intensity value`  0-31, >31 = raw intensity
 *                           `--gpu-id value`         ids, comma-separated
 *   lolMiner 1.98a          no intensity flag at all
 *
 * The Rust side clamps again (`miners.rs::clamp_cpu_thread_count`,
 * `srb_gpu_intensity_arg`): these functions decide what the UI means, Rust
 * decides what reaches a process.
 *
 * # `null` means "the miner's own default"
 *
 * `cpuThreads === null` is ALL logical processors (xmrig: no thread flag,
 * which xmrig's autoconfig resolves to every thread — measured on an
 * i9-13900K; SRBMiner: `--cpu-threads <logical>`, the old MAX tier).
 * `gpuIntensity === null` is AUTO (no `--gpu-intensity` flag). Both defaults
 * are exactly what an install that never touched these controls launched
 * before the sliders existed.
 *
 * # When a change applies
 *
 * On the next start. The controls are disabled while their lane mines — the
 * miners take these values as launch arguments and have no live API for them.
 */
import type { GpuIntensity, MiningIntensity } from "../../types/mining";
import type { CpuThreadArgs } from "./utils/devicePower";

// ── CPU threads ───────────────────────────────────────────────────────────

export type CpuThreads = number | null;

/**
 * Normalise a thread count for a machine with `logical` processors.
 * Returns `null` (all) for "every thread or more" and for garbage; otherwise
 * an integer in `1..logical-1`. With `logical === 0` (not detected yet) a
 * positive count is kept as-is — Rust clamps it against its own detection.
 */
export function clampCpuThreads(threads: CpuThreads, logical: number): CpuThreads {
  if (threads == null || !Number.isFinite(threads)) return null;
  const n = Math.max(1, Math.round(threads));
  if (logical > 0 && n >= logical) return null;
  return n;
}

/** The thread count a slider position stands for (for display). */
export function effectiveCpuThreads(threads: CpuThreads, logical: number): number | null {
  const t = clampCpuThreads(threads, logical);
  if (t != null) return t;
  return logical > 0 ? logical : null;
}

/**
 * The LOW / MED / MAX buttons are presets that move the slider:
 * LOW = 2 threads (the old tier), MED = half, MAX = all.
 */
export function cpuThreadsForPreset(tier: MiningIntensity, logical: number): CpuThreads {
  switch (tier) {
    case "low":
      return clampCpuThreads(logical > 0 ? Math.min(2, logical) : 2, logical);
    case "medium":
      return logical > 1 ? clampCpuThreads(Math.floor(logical / 2), logical) : null;
    case "high":
      return null;
  }
}

/** Which preset the slider sits exactly on, or `null` for a custom count. */
export function presetForCpuThreads(threads: CpuThreads, logical: number): MiningIntensity | null {
  const t = clampCpuThreads(threads, logical);
  for (const tier of ["low", "medium", "high"] as const) {
    if (cpuThreadsForPreset(tier, logical) === t) return tier;
  }
  return null;
}

/** Mirror of `miners.rs::cpu_threads_low_priority`. */
export function cpuThreadsLowPriority(threads: CpuThreads, logical: number): boolean {
  const t = clampCpuThreads(threads, logical);
  if (t == null) return false;
  const belowAll = logical === 0 || t < logical;
  return belowAll && t <= Math.max(2, Math.floor(logical / 4));
}

/**
 * Coarse tier for labels ("Low" / "Medium" / "Max") and for the Rust tier
 * fallback: all threads is MAX, a background footprint is LOW, anything
 * between is MEDIUM.
 */
export function cpuTierForThreads(threads: CpuThreads, logical: number): MiningIntensity {
  const t = clampCpuThreads(threads, logical);
  if (t == null) return "high";
  return cpuThreadsLowPriority(t, logical) ? "low" : "medium";
}

/**
 * xmrig launch args for a slider position. Exactly one thread flag or none:
 * `null` omits every flag (xmrig autoconfig = all threads, the old MAX); a
 * count sends `--threads=N`, plus `--cpu-priority=1` for a background
 * footprint (the old LOW sent 2 threads at priority 1).
 */
export function xmrigThreadArgs(threads: CpuThreads, logical: number): CpuThreadArgs {
  const t = clampCpuThreads(threads, logical);
  if (t == null) return { threads: null, cpuMaxThreadsHint: null, cpuPriority: null };
  return {
    threads: t,
    cpuMaxThreadsHint: null,
    cpuPriority: cpuThreadsLowPriority(t, logical) ? 1 : null,
  };
}

// ── GPU intensity ─────────────────────────────────────────────────────────

/** SRBMiner 3.6.2: "gpu intensity, 0-31". 0 is undocumented, so 1 is the floor. */
export const GPU_INTENSITY_MIN = 1;
export const GPU_INTENSITY_MAX = 31;

export type GpuIntensitySetting = number | null;

export const GPU_INTENSITY_PRESETS: Record<Exclude<GpuIntensity, "auto">, number> = {
  low: 16,
  medium: 22,
  high: 28,
};

export function clampGpuIntensity(v: GpuIntensitySetting): GpuIntensitySetting {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.min(GPU_INTENSITY_MAX, Math.max(GPU_INTENSITY_MIN, Math.round(v)));
}

export function gpuIntensityForPreset(tier: GpuIntensity): GpuIntensitySetting {
  return tier === "auto" ? null : GPU_INTENSITY_PRESETS[tier];
}

/** Which preset the slider sits exactly on, or `null` for a custom value. */
export function presetForGpuIntensity(v: GpuIntensitySetting): GpuIntensity | null {
  const c = clampGpuIntensity(v);
  if (c == null) return "auto";
  for (const tier of ["low", "medium", "high"] as const) {
    if (GPU_INTENSITY_PRESETS[tier] === c) return tier;
  }
  return null;
}

/** Nearest tier, for labels: split at the midpoints between presets (19, 25). */
export function gpuTierForIntensity(v: GpuIntensitySetting): GpuIntensity {
  const c = clampGpuIntensity(v);
  if (c == null) return "auto";
  if (c <= 19) return "low";
  if (c <= 25) return "medium";
  return "high";
}

// ── Dedicated GPUs ────────────────────────────────────────────────────────

/** The fields of `get_gpu_info`'s `GpuInfo` this module reads. */
export interface GpuLike {
  name: string;
  vendor: string;
  vram_bytes: number;
}

export interface DedicatedGpu {
  /** Position in `get_gpu_info`'s list — the index `--gpu-id`/`--devices` get. */
  index: number;
  name: string;
}

const ONE_GIB = 1024 ** 3;

/**
 * Whether a detected adapter is a dedicated (discrete) GPU.
 *
 * `get_gpu_info` already drops virtual/remote displays and Intel UHD/HD/Iris
 * iGPUs (`device_info.rs`, `drop_patterns`). This repeats those checks (the
 * Linux path matches differently) and adds what it lets through:
 *
 *   - basic display / render drivers (defence in depth);
 *   - AMD APU graphics: an AMD name ending in "Graphics" with no RX / Pro
 *     model — "AMD Radeon(TM) Graphics", "AMD Radeon 780M Graphics",
 *     "Radeon(TM) Vega 8 Graphics";
 *   - any adapter reporting under 1 GiB of VRAM (shared-memory iGPUs report
 *     a small aperture). 0 means "unknown" and does NOT exclude.
 *
 * Intel Arc stays: it is discrete.
 */
export function isDedicatedGpu(g: GpuLike): boolean {
  const name = (g.name ?? "").trim();
  const lower = name.toLowerCase();
  if (!name) return false;
  if (/microsoft basic (display|render)/.test(lower)) return false;
  if (/\b(uhd|hd) graphics\b|\biris\b/.test(lower)) return false;
  const vendor = (g.vendor ?? "").toLowerCase();
  const isAmd = vendor === "amd" || /\b(amd|radeon)\b/.test(lower);
  if (isAmd && /graphics\s*$/.test(lower) && !/\brx\b|\bpro\b/.test(lower)) return false;
  if (g.vram_bytes > 0 && g.vram_bytes < ONE_GIB) return false;
  return true;
}

/** The dedicated GPUs, keeping each one's index into the FULL detected list. */
export function dedicatedGpus(gpus: readonly GpuLike[]): DedicatedGpu[] {
  return gpus.flatMap((g, index) => (isDedicatedGpu(g) ? [{ index, name: g.name }] : []));
}

/**
 * A stored selection, reconciled against today's hardware. Keeps only
 * indices that are still dedicated GPUs; collapses to `null` (every GPU)
 * when fewer than two dedicated GPUs exist, when nothing valid is left, or
 * when every dedicated GPU is selected.
 */
export function reconcileGpuSelection(
  selection: readonly number[] | null,
  gpus: readonly GpuLike[],
): number[] | null {
  if (selection == null) return null;
  const dedicated = dedicatedGpus(gpus).map((d) => d.index);
  if (dedicated.length < 2) return null;
  const kept = selection.filter((i, at) => dedicated.includes(i) && selection.indexOf(i) === at);
  if (kept.length === 0 || kept.length >= dedicated.length) return null;
  return kept;
}

// ── Persistence (localStorage, like gpuSelection.ts) ──────────────────────

const CPU_THREADS_KEY = "pwnda.mine.cpuThreads";
const GPU_INTENSITY_KEY = "pwnda.mine.gpuIntensity";

function readPositiveInt(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeNullable(key: string, v: number | null): void {
  try {
    if (v == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(v));
  } catch {
    /* the choice just does not persist this session */
  }
}

export function readCpuThreads(): CpuThreads {
  return readPositiveInt(CPU_THREADS_KEY);
}

export function writeCpuThreads(v: CpuThreads): void {
  writeNullable(CPU_THREADS_KEY, v);
}

export function readGpuIntensitySetting(): GpuIntensitySetting {
  return clampGpuIntensity(readPositiveInt(GPU_INTENSITY_KEY));
}

export function writeGpuIntensitySetting(v: GpuIntensitySetting): void {
  writeNullable(GPU_INTENSITY_KEY, clampGpuIntensity(v));
}
