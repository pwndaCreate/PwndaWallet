/**
 * src/features/mining/components/TuningSlider.tsx
 *
 * The one slider layout behind `CpuThreadsControl` and `GpuIntensityControl`:
 * a label with a live readout, a range input, preset buttons that move the
 * range, and a caption. Two variants, the same split `LoadSlider` used:
 *
 *   - `full`    — landscape's card (label + readout over the range);
 *   - `compact` — portrait's `mine-config-row` (label column on the left).
 *
 * Presets are buttons, not a second source of truth: each one sets a slider
 * position, and a preset reads as active only while the slider sits exactly on
 * it. `disabledReason` replaces the caption when the control is locked.
 */
import { ST } from "../../../components/Primitives";

export interface TuningPreset {
  key: string;
  label: string;
  /** The slider position this preset sets. */
  position: number;
  title?: string;
  /** Accent for the compact variant's active state (legacy `.mine-int-btn`). */
  tone?: "low" | "med" | "high";
}

export interface TuningSliderProps {
  label: string;
  /** Shorter label for the compact variant's 72px label column. */
  compactLabel?: string;
  ariaLabel: string;
  min: number;
  max: number;
  position: number;
  onPosition: (position: number) => void;
  /** Big readout next to the label, e.g. `12 / 32` or `auto`. */
  readout: string;
  presets: readonly TuningPreset[];
  /** Which preset (by key) the slider sits exactly on, if any. */
  activePreset: string | null;
  caption: string;
  disabled?: boolean;
  disabledReason?: string;
  variant?: "full" | "compact";
  delayBase?: number;
  /** Stable hook for tests / Playwright. */
  testId?: string;
}

const MONO = "var(--font-mono)";

export function TuningSlider({
  label,
  compactLabel,
  ariaLabel,
  min,
  max,
  position,
  onPosition,
  readout,
  presets,
  activePreset,
  caption,
  disabled,
  disabledReason,
  variant = "full",
  delayBase = 420,
  testId,
}: TuningSliderProps) {
  const range = (
    <input
      type="range"
      aria-label={ariaLabel}
      aria-valuetext={readout}
      min={min}
      max={max}
      step={1}
      value={Math.min(max, Math.max(min, position))}
      disabled={disabled || max <= min}
      onChange={(e) => onPosition(Number(e.target.value))}
      style={{
        flex: 1,
        minWidth: 0,
        width: "100%",
        accentColor: "var(--accent)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        margin: 0,
      }}
    />
  );
  const captionText = disabled && disabledReason ? disabledReason : caption;
  const captionEl = (
    <div
      style={{
        fontSize: 9,
        color: "var(--text-dim)",
        letterSpacing: 0.5,
        fontFamily: MONO,
        lineHeight: 1.4,
      }}
    >
      {captionText}
    </div>
  );

  if (variant === "compact") {
    return (
      <div className="mine-config-row" style={{ alignItems: "flex-start" }} data-testid={testId}>
        <span className="mine-label" style={{ paddingTop: 7 }}>
          <ST delay={delayBase - 40} speed={22}>{(compactLabel ?? label).toUpperCase()}</ST>
        </span>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="mine-intensity">
            {presets.map((p, i) => {
              const active = p.key === activePreset;
              return (
                <button
                  key={p.key}
                  type="button"
                  className={`mine-int-btn ${active ? `active ${p.tone ?? "low"}` : ""}`}
                  onClick={() => onPosition(p.position)}
                  disabled={disabled}
                  aria-pressed={active}
                  title={p.title}
                >
                  <ST delay={delayBase + i * 55} speed={22}>
                    {p.label.toUpperCase()}
                  </ST>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {range}
            <span
              className="tnum"
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: "var(--accent)",
                minWidth: 44,
                textAlign: "right",
                whiteSpace: "nowrap",
              }}
            >
              {readout}
            </span>
          </div>
          {captionEl}
        </div>
      </div>
    );
  }

  return (
    <div data-testid={testId}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--text-muted)",
          letterSpacing: 1,
          textTransform: "uppercase",
          marginBottom: 6,
          fontFamily: MONO,
        }}
      >
        <span>{label}</span>
        <span className="tnum" style={{ color: "var(--accent)" }}>
          {readout}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>{range}</div>
      <div style={{ display: "flex", gap: 6 }}>
        {presets.map((p) => {
          const a = p.key === activePreset;
          return (
            <button
              key={p.key}
              type="button"
              className={`qbtn${a ? " accent" : ""}`}
              onClick={() => onPosition(p.position)}
              disabled={disabled}
              aria-pressed={a}
              title={p.title}
              style={{
                flex: 1,
                padding: "8px 0",
                fontSize: 10,
                letterSpacing: 1,
                textTransform: "uppercase",
                opacity: disabled ? 0.5 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 6 }}>{captionEl}</div>
    </div>
  );
}
