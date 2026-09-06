import type { GpuIntensity, MiningIntensity } from "../../../types/mining";

/**
 * Pure device-power / intensity / thread calculations extracted from
 * `useMiner`. These are deterministic functions of their inputs — no
 * React state, no side effects — so they live as standalone helpers and
 * `useMiner` wraps them in `useCallback` with the right closure deps.
 *
 * Behaviour is byte-identical to the inline versions that previously
 * lived in `useMiner.ts` (extracted 2026-06-16 as part of the
 * size-reduction refactor). See [[mining-process-management]].
 */

/**
 * CPU thread-selection args for a single xmrig launch, keyed by mining-
 * intensity tier. Mirrors `CpuThreadArgs` in `src-tauri/src/miners.rs`.
 * At most one of `threads`/`cpuMaxThreadsHint` is ever set per tier.
 */
export interface CpuThreadArgs {
  threads: number | null;
  cpuMaxThreadsHint: number | null;
  cpuPriority: number | null;
}

/**
 * Map a CPU mining-intensity tier to xmrig launch args.
 *
 *   - low    → literal `threads: 2` (unchanged small, agnostic footprint)
 *              + `cpuPriority: 1` (Windows BelowNormal). 2 threads was
 *              never the cause of reported sluggishness at Low — OS
 *              scheduling priority was, since xmrig ran at default
 *              priority regardless of intensity.
 *   - medium → `cpuMaxThreadsHint: 50` (percentage; xmrig's own
 *              cache/topology-aware autoconfig resolves the actual
 *              thread count and core placement) + `cpuPriority: 2`.
 *              Replaces the old raw `floor(logicalThreads / 2)`
 *              `--threads=N`, which was blind to L2/L3 cache-per-thread
 *              budget and CPU topology (SMT siblings, P-core/E-core) —
 *              hardcoding that math in the wallet doesn't generalize
 *              across arbitrary user hardware, whereas xmrig's own hint
 *              mechanism already does the topology-aware selection.
 *   - high   → everything null — "give it everything", unchanged.
 *              Empirically confirmed (real i9-13900K, offline
 *              `--bench` mode) that omitting all three flags still
 *              resolves to true 100% (auto/all) thread usage.
 *
 * `cpuThreadCount` is unused today — Low and Medium are deliberately
 * agnostic of the actual logical core count, which is the whole point
 * (xmrig's own hint mechanism is topology-aware so the wallet doesn't
 * hardcode per-CPU behavior for hardware it's never seen). Kept as a
 * parameter for signature stability against a future tier/override.
 */
export function cpuThreadArgsForIntensity(
  intensity: MiningIntensity,
  _cpuThreadCount: number
): CpuThreadArgs {
  switch (intensity) {
    case "low":
      return { threads: 2, cpuMaxThreadsHint: null, cpuPriority: 1 };
    case "medium":
      return { threads: null, cpuMaxThreadsHint: 50, cpuPriority: 2 };
    case "high":
      return { threads: null, cpuMaxThreadsHint: null, cpuPriority: null };
  }
}

/**
 * Pre-launch (not-yet-mining) CPU thread-count label for the hero panel.
 * Purely cosmetic text — never feeds back into launch args. Once mining
 * is actually running, callers should prefer the real resolved count
 * from `MinerSession.threadsActive` (sourced from xmrig's own
 * `/1/summary` poll); this is only the best-effort estimate shown
 * before that data exists.
 */
export function cpuThreadsPreLaunchLabel(
  intensity: MiningIntensity,
  cpuThreadCount: number
): string {
  switch (intensity) {
    case "low":
      return "2 threads";
    case "medium":
      return cpuThreadCount > 0
        ? `~${Math.round(cpuThreadCount * 0.5)} threads (auto)`
        : "~50% (auto)";
    case "high":
      return cpuThreadCount > 0 ? `${cpuThreadCount} threads` : "all threads";
  }
}

/**
 * Convert a GPU intensity tier to the numeric `--gpu-intensity` value
 * passed to SRBMiner. Returns `null` for `"auto"` which causes the
 * caller (and Rust `build_gpu_miner_args`) to omit the flag entirely
 * — SRBMiner then self-tunes (its default behaviour).
 *
 * Values picked to land safely on the consumer-GPU side of the 0-31
 * range:
 *   - Low (16): conservative, lower power / VRAM pressure
 *   - Medium (22): balanced, the typical sweet spot for modern AMD / NVIDIA
 *   - Max (28): high-end kernel work-size; may OOM on <8 GB cards
 *
 * Same mapping is used for both KawPow (RVN) and Autolykos2 (ERG) —
 * SRBMiner's `--gpu-intensity` is algorithm-agnostic, so we don't
 * need per-algo tables. See `wiki/concepts/srbminer-flags.md`.
 */
export function gpuIntensityValue(level: GpuIntensity): number | null {
  switch (level) {
    case "auto":
      return null;
    case "low":
      return 16;
    case "medium":
      return 22;
    case "high":
      return 28;
  }
}
