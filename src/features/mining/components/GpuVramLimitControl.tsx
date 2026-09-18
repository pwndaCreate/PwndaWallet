/**
 * src/features/mining/components/GpuVramLimitControl.tsx
 *
 * The XelisHash GPU lane's one tuning knob, for both layouts: AUTO (far left,
 * the default) then a per-card VRAM budget in whole GB, up to the biggest
 * dedicated card.
 *
 * AUTO is decided in Rust (`miners/xelis_gpu_profile.rs`, 2026-09-17): each
 * card's cores and architecture, read from SRBMiner's device list at start,
 * give a thread count (~112 per CU/SM); a card the table cannot place falls
 * back to SRBMiner's own tune, which fills most of the VRAM.
 *
 * It replaces the intensity slider on that lane (2026-09-17). XelisHash gives
 * every GPU thread its own 531 KiB scratchpad, so a thread count IS a memory
 * bill, and SRBMiner's 0-31 intensity has no published mapping to one: a two-
 * card run at 20 filled both cards and froze the machine. A budget in GB is a
 * number the user can reason about; Rust (`srb_vram_limit_arg`) turns it into
 * SRBMiner's raw thread count per card and never asks for more than 90% of a
 * card, whatever is picked here.
 */
import {
  GPU_VRAM_LIMIT_MIN_GB,
  clampGpuVramLimit,
  gpuVramLimitMaxGb,
  type GpuLike,
  type GpuVramLimitSetting,
} from "../miningTuning";
import { TuningSlider, type TuningPreset } from "./TuningSlider";

/** Slider position 0 is AUTO; 1..max are GB. */
const AUTO_POSITION = GPU_VRAM_LIMIT_MIN_GB - 1;

/** XelisHash v3 scratchpad, bytes per GPU thread (`xelis-hash/src/v3.rs`). */
const SCRATCHPAD_BYTES = 531 * 128 * 8;

/** Approximate thread count a budget buys, for the caption. */
export function threadsForVramGb(gb: number): number {
  return Math.floor(((gb * 1024 ** 3) / SCRATCHPAD_BYTES) / 256) * 256;
}

export function GpuVramLimitControl({
  value,
  onChange,
  gpus,
  disabled,
  variant = "full",
  delayBase = 420,
}: {
  /** GB per card, or `null` for AUTO. */
  value: GpuVramLimitSetting;
  onChange: (next: GpuVramLimitSetting) => void;
  /** Detected GPUs, to size the slider to the biggest card. */
  gpus: readonly GpuLike[];
  /** Applies at the next start, so locked while the GPU lane mines. */
  disabled?: boolean;
  variant?: "full" | "compact";
  delayBase?: number;
}) {
  const max = gpuVramLimitMaxGb(gpus);
  const c = clampGpuVramLimit(value);
  const shown = c == null ? null : Math.min(c, max);
  const half = Math.max(GPU_VRAM_LIMIT_MIN_GB, Math.floor(max / 2));
  const presetDefs: { key: string; label: string; gb: number | null; tone: TuningPreset["tone"] }[] = [
    { key: "auto", label: "auto", gb: null, tone: "low" },
    { key: "low", label: `${Math.min(2, max)} gb`, gb: Math.min(2, max), tone: "low" },
    { key: "half", label: `${half} gb`, gb: half, tone: "med" },
  ];
  // Drop presets that collapse onto the same position on a small card.
  const seen = new Set<number>();
  const presets: TuningPreset[] = presetDefs
    .filter((p) => {
      const pos = p.gb ?? AUTO_POSITION;
      if (seen.has(pos)) return false;
      seen.add(pos);
      return true;
    })
    .map((p) => ({
      key: p.key,
      label: p.label,
      tone: p.tone,
      position: p.gb ?? AUTO_POSITION,
      title:
        p.gb == null
          ? "sized from each card's cores at start (default); unrecognised cards use SRBMiner's own tune"
          : `up to ${p.gb} GB of VRAM per card (~${threadsForVramGb(p.gb).toLocaleString()} threads)`,
    }));
  const active = presets.find((p) => p.position === (shown ?? AUTO_POSITION))?.key ?? null;
  const caption =
    shown == null
      ? "auto: sized from each card's cores (~112 threads per CU/SM, far below full VRAM) · applies on next start"
      : `up to ${shown} GB per card (~${threadsForVramGb(shown).toLocaleString()} threads), never over 90% of a card · applies on next start`;

  return (
    <TuningSlider
      testId="gpu-vram-limit-control"
      label="vram limit"
      compactLabel="vram"
      ariaLabel="GPU VRAM limit per card"
      min={AUTO_POSITION}
      max={max}
      position={shown ?? AUTO_POSITION}
      onPosition={(pos) => onChange(pos <= AUTO_POSITION ? null : pos)}
      readout={shown == null ? "auto" : `${shown} gb`}
      presets={presets}
      activePreset={active}
      caption={caption}
      disabled={disabled}
      disabledReason={disabled ? "stop the GPU lane to change this" : undefined}
      variant={variant}
      delayBase={delayBase}
    />
  );
}
