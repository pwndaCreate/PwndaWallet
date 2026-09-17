/**
 * src/features/mining/components/GpuDevicePicker.tsx
 *
 * Which dedicated GPU(s) the GPU lane mines on, for every Mine surface
 * (landscape PRO, portrait PRO, SIMPLE in both layouts).
 *
 *   - no dedicated GPU  → a one-line "none detected" note;
 *   - exactly one       → that card, shown as fixed (nothing to choose; the
 *                         miner gets no device flag, as before);
 *   - two or more       → one button per card ("GPU 0 · RTX 4080", …) plus
 *                         "BOTH" (two cards) / "ALL" (three or more).
 *
 * "Dedicated" is `miningTuning.ts::isDedicatedGpu`. Button labels use the
 * card's index into `get_gpu_info`'s list. That is NOT the id the miners use:
 * `start_gpu_miner` translates it per miner from `--list-devices`
 * (miners.rs::map_gpu_indices_to_miner, 2026-09-16 — SRBMiner numbers AMD
 * before NVIDIA, lolMiner the other way round).
 * "BOTH"/"ALL" stores `null`, which sends no device flag at all.
 */
import type { GpuSelection } from "../gpuSelection";
import { dedicatedGpus, type GpuLike } from "../miningTuning";

const MONO = "var(--font-mono)";

/** Shorten "NVIDIA GeForce RTX 4080" → "RTX 4080" for a button. */
export function shortGpuName(name: string): string {
  return name
    .replace(/\((R|TM)\)/gi, "")
    .replace(/^(NVIDIA\s+)?GeForce\s+/i, "")
    .replace(/^NVIDIA\s+/i, "")
    .replace(/^AMD\s+Radeon\s+/i, "")
    .replace(/^Intel\s+/i, "")
    .replace(/\s+Graphics$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function GpuDevicePicker({
  gpus,
  selection,
  onChange,
  disabled,
  variant = "full",
}: {
  gpus: readonly GpuLike[];
  selection: GpuSelection;
  onChange: (next: GpuSelection) => void;
  /** Locked while the GPU lane mines: the device list is a launch argument. */
  disabled?: boolean;
  variant?: "full" | "compact" | "simple";
}) {
  const dedicated = dedicatedGpus(gpus);
  const compact = variant !== "full";
  const label = (
    <span
      className={variant === "compact" ? "mine-label" : undefined}
      style={
        variant === "compact"
          ? { paddingTop: dedicated.length >= 2 ? 7 : 0 }
          : {
              fontSize: variant === "simple" ? 8 : 10,
              color: "var(--text-muted)",
              letterSpacing: 1,
              textTransform: "uppercase",
              fontFamily: MONO,
            }
      }
    >
      {variant === "compact" ? "DEVICE" : "gpu device"}
    </span>
  );

  const note = (text: string) => (
    <span
      style={{
        fontSize: compact ? 9 : 10,
        color: "var(--text-dim)",
        fontFamily: MONO,
        letterSpacing: 0.5,
      }}
    >
      {text}
    </span>
  );

  let body;
  if (dedicated.length === 0) {
    body = note(
      gpus.length === 0
        ? "no GPU detected"
        : "no dedicated GPU detected — the miner uses what it finds",
    );
  } else if (dedicated.length === 1) {
    const only = dedicated[0];
    body = (
      <span
        title={`${only.name} — the only dedicated GPU, so there is nothing to choose`}
        style={{
          fontSize: compact ? 9 : 10,
          color: "var(--text-muted)",
          fontFamily: MONO,
          letterSpacing: 0.5,
        }}
      >
        GPU {only.index} · {shortGpuName(only.name)}{" "}
        <span style={{ color: "var(--text-dim)" }}>(only dedicated GPU)</span>
      </span>
    );
  } else {
    const allLabel = dedicated.length === 2 ? "both" : "all";
    const options: { key: string; label: string; title: string; value: GpuSelection }[] = [
      ...dedicated.map((d) => ({
        key: String(d.index),
        label: `GPU ${d.index} · ${shortGpuName(d.name)}`,
        title: `Mine on ${d.name} only`,
        value: [d.index],
      })),
      {
        key: "all",
        label: allLabel,
        title: `Mine on every dedicated GPU (${dedicated.length})`,
        value: null,
      },
    ];
    const activeKey = selection == null ? "all" : selection.length === 1 ? String(selection[0]) : null;
    body = (
      <div
        role="radiogroup"
        aria-label="GPU device"
        style={{ display: "flex", flexWrap: "wrap", gap: compact ? 4 : 6, flex: 1, minWidth: 0 }}
      >
        {options.map((o) => {
          const active = o.key === activeKey;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={active}
              title={o.title}
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={variant === "full" ? `qbtn${active ? " accent" : ""}` : undefined}
              style={{
                flex: "1 1 auto",
                minWidth: 0,
                padding: variant === "full" ? "8px 10px" : "4px 8px",
                fontFamily: MONO,
                fontSize: variant === "simple" ? 8 : 10,
                letterSpacing: 1,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
                ...(variant === "full"
                  ? {}
                  : {
                      background: active ? "var(--accent-soft)" : "var(--bg-2)",
                      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                      color: active ? "var(--accent)" : "var(--text-muted)",
                    }),
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  const caption =
    dedicated.length >= 2
      ? disabled
        ? "stop the GPU lane to change this"
        : "applies on next start"
      : null;

  if (variant === "compact") {
    return (
      <div className="mine-config-row" style={{ alignItems: "flex-start" }} data-testid="gpu-device-picker">
        {label}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {body}
          {caption && note(caption)}
        </div>
      </div>
    );
  }
  return (
    <div data-testid="gpu-device-picker" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label}
      {body}
      {caption && note(caption)}
    </div>
  );
}
