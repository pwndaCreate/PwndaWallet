/**
 * <Btn> — unified hover-scramble button. Hot-path primitive.
 *
 * Single API replacing the old ScrambleBtn + PixelScrambleBtn split.
 *
 *   <Btn variant="primary|ghost|accent|danger" size="sm|md|lg" full caret>
 *
 * Defaults: variant="ghost", size="md", caret=false.
 *
 * SIGNATURE behaviors. See src/design/BEHAVIORS.md —
 *   "Scramble-on-hover" / "Hover scramble cancel-on-leave" /
 *   "Hover state transitions" / "Disabled opacity".
 */

import { CSSProperties, ReactNode, useState } from "react";
import { useScramble } from "./ST";

export type BtnVariant = "primary" | "ghost" | "accent" | "danger";
export type BtnSize = "sm" | "md" | "lg";

const VARIANTS: Record<BtnVariant, { fg: string; bg: string; bd: string; hbg: string }> = {
  primary: {
    fg: "#050505",
    bg: "var(--white)",
    bd: "var(--white)",
    hbg: "rgba(242,242,242,0.82)",
  },
  ghost: {
    fg: "var(--text)",
    bg: "transparent",
    bd: "var(--border)",
    hbg: "rgba(255,255,255,0.06)",
  },
  accent: {
    fg: "var(--accent)",
    bg: "var(--accent-soft)",
    bd: "var(--accent-mid)",
    hbg: "rgba(0,255,102,0.18)",
  },
  danger: {
    fg: "var(--danger)",
    bg: "rgba(255,59,59,0.06)",
    bd: "rgba(255,59,59,0.4)",
    hbg: "rgba(255,59,59,0.18)",
  },
};

const SIZES: Record<BtnSize, { p: string; fs: number }> = {
  sm: { p: "5px 10px", fs: 10 },
  md: { p: "9px 16px", fs: 12 },
  lg: { p: "12px 22px", fs: 13 },
};

export function Btn({
  children,
  onClick,
  variant = "ghost",
  size = "md",
  full = false,
  disabled = false,
  caret = false,
  type = "button",
  style,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: BtnVariant;
  size?: BtnSize;
  full?: boolean;
  disabled?: boolean;
  caret?: boolean;
  type?: "button" | "submit" | "reset";
  style?: CSSProperties;
  title?: string;
}) {
  const raw = String(children ?? "");
  const stripped = raw.replace(/^[►▶↑↓•◇◆]\s*/, "");
  const { display, scramble, reset } = useScramble(stripped);
  const [h, setH] = useState(false);
  const v = VARIANTS[variant];
  const s = SIZES[size];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => {
        if (!disabled) {
          setH(true);
          scramble();
        }
      }}
      onMouseLeave={() => {
        setH(false);
        reset();
      }}
      style={{
        fontFamily: "var(--mono)",
        fontSize: s.fs,
        fontWeight: 500,
        letterSpacing: 0.3,
        padding: s.p,
        border: `1px solid ${v.bd}`,
        color: v.fg,
        background: h && !disabled ? v.hbg : v.bg,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? "var(--disabled-opacity, 0.4)" : 1,
        width: full ? "100%" : "auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        transition: "all var(--motion-hover-duration, 120ms) var(--motion-hover-easing, ease)",
        ...style,
      }}
    >
      {caret && <span style={{ opacity: 0.7 }}>►</span>}
      <span>{display}</span>
    </button>
  );
}
