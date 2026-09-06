/**
 * Three-button load picker for mining intensity. Extracted from
 * MineLandscapeView per ease-of-use-improvement-plan T2.1.
 *
 * `variant="full"` is the landscape vertical card: `LOAD` label + %
 * readout on top, three buttons in a row, `idle / balanced / max`
 * captions underneath. Used by `MineLandscapeView`.
 *
 * `variant="compact"` is the portrait inline-row form: just three
 * buttons. Used by `MiningView` inside `mine-config-row`.
 *
 * Both variants share the `low | medium | high` semantics and the
 * intensity→percent mapping (`25 / 75 / 100`).
 */

import { ST } from "../../../components/Primitives";

export type LoadLevel = "low" | "medium" | "high";

const PCT: Record<LoadLevel, number> = { low: 25, medium: 75, high: 100 };
const LABEL: Record<LoadLevel, string> = { low: "low", medium: "med", high: "max" };

interface LoadSliderProps {
  value: LoadLevel;
  onChange: (next: LoadLevel) => void;
  disabled?: boolean;
  variant?: "full" | "compact";
  /** Stagger base delay for scramble-on-mount. Optional. */
  delayBase?: number;
}

export function LoadSlider({
  value,
  onChange,
  disabled,
  variant = "full",
  delayBase = 420,
}: LoadSliderProps) {
  if (variant === "compact") {
    return (
      <div className="mine-intensity">
        {(["low", "medium", "high"] as const).map((lvl, i) => {
          const active = value === lvl;
          const cls =
            active && lvl === "low"
              ? "active low"
              : active && lvl === "medium"
                ? "active med"
                : active && lvl === "high"
                  ? "active high"
                  : "";
          return (
            <button
              key={lvl}
              className={`mine-int-btn ${cls}`}
              onClick={() => onChange(lvl)}
              disabled={disabled}
            >
              <ST delay={delayBase + i * 55} speed={22}>
                {LABEL[lvl].toUpperCase()}
              </ST>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--text-muted)",
          letterSpacing: 1,
          textTransform: "uppercase",
          marginBottom: 6,
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>load</span>
        <span className="tnum" style={{ color: "var(--accent)" }}>
          {PCT[value]}%
        </span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {(["low", "medium", "high"] as const).map((lvl) => {
          const a = lvl === value;
          return (
            <button
              key={lvl}
              className={`qbtn${a ? " accent" : ""}`}
              onClick={() => onChange(lvl)}
              disabled={disabled}
              style={{
                flex: 1,
                padding: "8px 0",
                fontSize: 10,
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              {LABEL[lvl]}
            </button>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 0.5,
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>idle</span>
        <span>balanced</span>
        <span>max</span>
      </div>
    </div>
  );
}

export function intensityPercent(level: LoadLevel): number {
  return PCT[level];
}
