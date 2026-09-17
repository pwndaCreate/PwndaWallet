/**
 * src/features/mining/components/CpuThreadsControl.tsx
 *
 * CPU thread slider, 1..detected logical processors, for both layouts. The
 * value launches as-is: xmrig `--threads=N` (RandomX) or SRBMiner
 * `--cpu-threads N` (XelisHash v3); the far right is "all", which keeps each
 * miner's old MAX behaviour. LOW / MED / MAX are presets that move the slider.
 * Mapping and persistence: `miningTuning.ts`. Replaced `LoadSlider` on the Mine
 * PRO views 2026-09-16.
 */
import type { MiningIntensity } from "../../../types/mining";
import type { CpuMinerBinary } from "../miningLane";
import {
  cpuThreadsForPreset,
  cpuThreadsLowPriority,
  effectiveCpuThreads,
  presetForCpuThreads,
  type CpuThreads,
} from "../miningTuning";
import { TuningSlider, type TuningPreset } from "./TuningSlider";

const PRESETS: readonly { tier: MiningIntensity; label: string; tone: TuningPreset["tone"] }[] = [
  { tier: "low", label: "low", tone: "low" },
  { tier: "medium", label: "med", tone: "med" },
  { tier: "high", label: "max", tone: "high" },
];

/** The exact flag a position sends, for the caption. */
export function cpuThreadsFlagLabel(
  threads: CpuThreads,
  logical: number,
  cpuMiner: CpuMinerBinary,
): string {
  const n = effectiveCpuThreads(threads, logical);
  if (cpuMiner === "SRBMiner-MULTI") {
    return n == null ? "SRBMiner picks the count" : `--cpu-threads ${n}`;
  }
  return threads == null || n === logical
    ? "no thread flag (xmrig uses every thread)"
    : `--threads=${n}`;
}

export function CpuThreadsControl({
  threads,
  logical,
  onChange,
  cpuMiner,
  disabled,
  variant = "full",
  delayBase,
}: {
  threads: CpuThreads;
  /** Detected logical processors; 0 while detection has not answered. */
  logical: number;
  onChange: (next: CpuThreads) => void;
  cpuMiner: CpuMinerBinary;
  /** Locked while the CPU lane mines: the count is a launch argument. */
  disabled?: boolean;
  variant?: "full" | "compact";
  delayBase?: number;
}) {
  const detected = logical > 0;
  const n = effectiveCpuThreads(threads, logical);
  const position = n ?? 1;
  const readout = !detected
    ? threads == null
      ? "all"
      : `${threads}`
    : `${n} / ${logical}`;
  const presets: TuningPreset[] = PRESETS.map((p) => ({
    key: p.tier,
    label: p.label,
    tone: p.tone,
    position: effectiveCpuThreads(cpuThreadsForPreset(p.tier, logical), logical) ?? 1,
  }));
  const active = presetForCpuThreads(threads, logical);
  const background = cpuThreadsLowPriority(threads, logical) ? " · lowered priority" : "";
  const caption = detected
    ? `${cpuThreadsFlagLabel(threads, logical, cpuMiner)}${background} · applies on next start`
    : "detecting processor count…";

  return (
    <TuningSlider
      testId="cpu-threads-control"
      label="cpu threads"
      compactLabel="threads"
      ariaLabel="CPU threads"
      min={1}
      max={detected ? logical : 1}
      position={position}
      onPosition={(pos) => onChange(detected && pos >= logical ? null : pos)}
      readout={readout}
      presets={detected ? presets : []}
      activePreset={detected ? active : null}
      caption={caption}
      disabled={disabled || !detected}
      disabledReason={disabled ? "stop the CPU lane to change this" : undefined}
      variant={variant}
      delayBase={delayBase}
    />
  );
}
