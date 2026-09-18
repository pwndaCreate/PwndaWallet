/**
 * src/features/mining/components/LaneTuningControls.tsx
 *
 * The DISPLAYED lane's tuning block, mounted by landscape PRO
 * (`MineLandscapeView`, variant `full`) and portrait PRO (`MiningView`,
 * variant `compact`) — one component so the two layouts cannot drift
 * (landscape-first rule; parity audit 2026-09-16):
 *
 *   - CPU lane → `CpuThreadsControl` (xmrig `--threads` / SRBMiner `--cpu-threads`);
 *   - GPU lane → `GpuDevicePicker`, then `GpuIntensityControl`, which is
 *     locked with a reason when the lane's miner is lolMiner (no flag);
 *   - XelisHash GPU lane → `GpuVramLimitControl` in the intensity slot
 *     (AUTO by default; an optional per-card VRAM budget, 2026-09-17).
 *
 * Every control is locked while its lane mines; changes apply on next start.
 */
import type { GpuAlgorithm, MiningHardware } from "../../../types/mining";
import type { GpuSelection } from "../gpuSelection";
import {
  LOLMINER_NO_INTENSITY,
  gpuIntensityUnsupportedReason,
  type CpuMinerBinary,
} from "../miningLane";
import type {
  CpuThreads,
  GpuIntensitySetting,
  GpuLike,
  GpuVramLimitSetting,
} from "../miningTuning";
import { CpuThreadsControl } from "./CpuThreadsControl";
import { GpuDevicePicker } from "./GpuDevicePicker";
import { GpuIntensityControl } from "./GpuIntensityControl";
import { GpuVramLimitControl } from "./GpuVramLimitControl";

// Re-exported: it moved to `miningLane` on 2026-09-17, when the reasons became
// per-algorithm, and callers still import it from here.
export { LOLMINER_NO_INTENSITY };

export function LaneTuningControls({
  hardware,
  gpuAlgorithm,
  cpuMiner,
  laneMining,
  cpuThreads,
  cpuThreadCount,
  setCpuThreads,
  gpuIntensityLevel,
  setGpuIntensityLevel,
  gpuVramLimit,
  setGpuVramLimit,
  gpus,
  gpuSelection,
  setGpuSelection,
  variant = "full",
  delayBase,
}: {
  hardware: MiningHardware;
  gpuAlgorithm: GpuAlgorithm;
  cpuMiner: CpuMinerBinary;
  /** Whether the DISPLAYED lane is mining (locks its controls). */
  laneMining: boolean;
  cpuThreads: CpuThreads;
  cpuThreadCount: number;
  setCpuThreads: (next: CpuThreads) => void;
  gpuIntensityLevel: GpuIntensitySetting;
  setGpuIntensityLevel: (next: GpuIntensitySetting) => void;
  /** XelisHash lane only: GB per card, `null` = AUTO. */
  gpuVramLimit: GpuVramLimitSetting;
  setGpuVramLimit: (next: GpuVramLimitSetting) => void;
  gpus: readonly GpuLike[];
  gpuSelection: GpuSelection;
  setGpuSelection: (next: GpuSelection) => void;
  variant?: "full" | "compact";
  delayBase?: number;
}) {
  if (hardware === "cpu") {
    return (
      <CpuThreadsControl
        threads={cpuThreads}
        logical={cpuThreadCount}
        onChange={setCpuThreads}
        cpuMiner={cpuMiner}
        disabled={laneMining}
        variant={variant}
        delayBase={delayBase}
      />
    );
  }
  const intensityLocked = gpuIntensityUnsupportedReason(gpuAlgorithm);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: variant === "full" ? 16 : 10,
      }}
    >
      <GpuDevicePicker
        gpus={gpus}
        selection={gpuSelection}
        onChange={setGpuSelection}
        disabled={laneMining}
        variant={variant}
      />
      {gpuAlgorithm === "xelishashv3" ? (
        // Per-thread scratchpad: a memory budget instead of an intensity.
        <GpuVramLimitControl
          value={gpuVramLimit}
          onChange={setGpuVramLimit}
          gpus={gpus}
          disabled={laneMining}
          variant={variant}
          delayBase={delayBase}
        />
      ) : (
        <GpuIntensityControl
          value={gpuIntensityLevel}
          onChange={setGpuIntensityLevel}
          disabled={laneMining}
          unsupportedReason={intensityLocked}
          variant={variant}
          delayBase={delayBase}
        />
      )}
    </div>
  );
}
