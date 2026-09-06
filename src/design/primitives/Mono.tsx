/**
 * <Mono> — inline mono-font text helper.
 */

import type { CSSProperties, ReactNode } from "react";

export function Mono({
  size = 11,
  color = "var(--text)",
  spacing = 0,
  upper = false,
  bold = false,
  children,
  style,
}: {
  size?: number;
  color?: string;
  spacing?: number;
  upper?: boolean;
  bold?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: size,
        color,
        letterSpacing: spacing,
        textTransform: upper ? "uppercase" : "none",
        fontWeight: bold ? 600 : 400,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
