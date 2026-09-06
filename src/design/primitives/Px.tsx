/**
 * <Px> — inline pixel-font text helper.
 */

import type { CSSProperties, ReactNode } from "react";

export function Px({
  size = 12,
  color = "var(--white)",
  spacing = 1,
  children,
  style,
}: {
  size?: number;
  color?: string;
  spacing?: number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: "var(--pixel)",
        fontSize: size,
        color,
        letterSpacing: spacing,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
