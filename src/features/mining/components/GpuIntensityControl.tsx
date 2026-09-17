/**
 * src/features/mining/components/GpuIntensityControl.tsx
 *
 * SRBMiner's GPU intensity as a slider, for both layouts: AUTO (far left, no
 * `--gpu-intensity` flag — SRBMiner self-tunes) then 1..31, SRBMiner-MULTI
 * 3.6.2's documented range ("gpu intensity, 0-31 or if > 31 it's treated as
 * raw intensity"). AUTO / LOW / MED / MAX are presets (none / 16 / 22 / 28).
 *
 * History: portrait PRO had four hand-written buttons and landscape PRO had
 * nothing (parity audit, 2026-09-16); both then shared a four-button version
 * of this component; the same day it became this slider.
 *
 * lolMiner (Octopus / CFX) has no intensity flag. Pass `unsupportedReason`
 * and the slider renders locked with that reason rather than disappearing,
 * so the lane still says why there is nothing to tune.
 */
import type { GpuIntensity } from "../../../types/mining";
import {
  GPU_INTENSITY_MAX,
  GPU_INTENSITY_MIN,
  clampGpuIntensity,
  gpuIntensityForPreset,
  presetForGpuIntensity,
  type GpuIntensitySetting,
} from "../miningTuning";
import { TuningSlider, type TuningPreset } from "./TuningSlider";

/** Slider position 0 is AUTO; 1..31 are the flag's values. */
const AUTO_POSITION = GPU_INTENSITY_MIN - 1;

const HINT: Record<GpuIntensity, string> = {
  auto: "SRBMiner self-tunes intensity (default)",
  low: "conservative; lower VRAM / power",
  medium: "balanced",
  high: "high kernel work-size; may OOM on <8 GB cards",
};

/** The exact flag a value sends, for tooltips and captions. */
export function gpuIntensityFlagText(v: GpuIntensitySetting): string {
  const c = clampGpuIntensity(v);
  return c == null ? "no --gpu-intensity flag (SRBMiner self-tunes)" : `--gpu-intensity ${c}`;
}

const PRESETS: readonly { tier: GpuIntensity; label: string; tone: TuningPreset["tone"] }[] = [
  { tier: "auto", label: "auto", tone: "low" },
  { tier: "low", label: "low", tone: "low" },
  { tier: "medium", label: "med", tone: "med" },
  { tier: "high", label: "max", tone: "high" },
];

export function GpuIntensityControl({
  value,
  onChange,
  disabled,
  unsupportedReason,
  variant = "full",
  delayBase = 420,
}: {
  /** 1..31, or `null` for AUTO. */
  value: GpuIntensitySetting;
  onChange: (next: GpuIntensitySetting) => void;
  /** Changing intensity applies at the next start, so lock it while the GPU lane mines. */
  disabled?: boolean;
  /** Set when the lane's miner has no intensity flag (lolMiner). */
  unsupportedReason?: string | null;
  variant?: "full" | "compact";
  delayBase?: number;
}) {
  const c = clampGpuIntensity(value);
  const active = presetForGpuIntensity(c);
  const presets: TuningPreset[] = PRESETS.map((p) => {
    const v = gpuIntensityForPreset(p.tier);
    return {
      key: p.tier,
      label: p.label,
      tone: p.tone,
      position: v ?? AUTO_POSITION,
      title: `${gpuIntensityFlagText(v)} (${HINT[p.tier]})`,
    };
  });
  const locked = !!unsupportedReason;
  const caption = locked
    ? unsupportedReason!
    : `${gpuIntensityFlagText(c)}${active && active !== "auto" ? ` · ${HINT[active]}` : ""} · applies on next start`;

  return (
    <TuningSlider
      testId="gpu-intensity-control"
      label="gpu intensity"
      compactLabel="intensity"
      ariaLabel="GPU intensity"
      min={AUTO_POSITION}
      max={GPU_INTENSITY_MAX}
      position={c ?? AUTO_POSITION}
      onPosition={(pos) => onChange(pos <= AUTO_POSITION ? null : pos)}
      readout={locked ? "n/a" : c == null ? "auto" : `${c} / ${GPU_INTENSITY_MAX}`}
      presets={presets}
      activePreset={locked ? null : active}
      caption={caption}
      disabled={disabled || locked}
      disabledReason={
        locked ? unsupportedReason! : disabled ? "stop the GPU lane to change this" : undefined
      }
      variant={variant}
      delayBase={delayBase}
    />
  );
}
