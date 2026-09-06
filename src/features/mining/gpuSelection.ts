/**
 * src/features/mining/gpuSelection.ts
 *
 * Which physical GPU(s) to mine on, remembered across sessions. Reported
 * request: a 2-GPU rig should be able to pick GPU 1, GPU 2, or both, using
 * SRBMiner-MULTI's `--gpu-id` / lolMiner's `--devices` (both verified against
 * the exact pinned miner versions — see [[srbminer-flags]]).
 *
 * # `null` is "every GPU", not "no GPUs"
 *
 * `null` means the flag is omitted entirely at the Rust layer, which is every
 * existing install's behaviour today — a user who never opens this control
 * must see byte-identical argv to before this feature existed. An EMPTY
 * array is deliberately not a distinct state: nothing in the UI can produce
 * one (the picker always offers "ALL" as a real button, never lets every
 * button be toggled off), so `readGpuSelection` folds `[]` back to `null`
 * rather than letting a corrupted/hand-edited storage value select zero
 * devices — the SRBMiner/lolMiner failure mode for a genuinely empty index
 * list is worse than falling back to the safe default.
 *
 * # localStorage, not the plugin store
 *
 * Same reasoning as `mineViewMode.ts`: a layout/hardware preference read on
 * first paint must not flash the wrong state while an async store loads.
 * Never holds anything secret.
 *
 * # Why indices, not a richer device identity
 *
 * The index is a position into the SAME `Vec<GpuInfo>` `get_gpu_info`
 * returns and `useDeviceProfile` already renders. There is no verified
 * mapping from that OS-level enumeration to either miner's OWN internal
 * device numbering (their CUDA/OpenCL/HIP runtimes may order devices
 * differently) — this is a KNOWN, ACCEPTED gap, not an oversight: the
 * existing GPU benchmark path (`run_gpu_miner_benchmark`) already makes the
 * identical assumption and ships. See `build_gpu_miner_args`'s doc comment
 * in miners.rs for the full accounting.
 */

export type GpuSelection = number[] | null;

const KEY = "pwnda.mine.gpuSelection";

/**
 * `null` unless the user has narrowed it, AND the stored value still names
 * at least one real index for `gpuCount` GPUs. A selection surviving a
 * hardware change (an eGPU unplugged, a card removed) that referenced a now
 * -absent index would either mine on the wrong remaining card or hand the
 * miner an out-of-range `--gpu-id`/`--devices` value it will refuse to start
 * on — falling back to "every GPU" is the same safe default `null` already
 * is everywhere else in this module.
 */
export function readGpuSelection(gpuCount: number): GpuSelection {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const indices = parsed.filter(
      (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < gpuCount
    );
    return indices.length > 0 ? indices : null;
  } catch {
    return null;
  }
}

export function writeGpuSelection(selection: GpuSelection): void {
  try {
    if (selection == null || selection.length === 0) {
      window.localStorage.removeItem(KEY);
    } else {
      window.localStorage.setItem(KEY, JSON.stringify(selection));
    }
  } catch {
    /* the choice just does not persist this session */
  }
}
