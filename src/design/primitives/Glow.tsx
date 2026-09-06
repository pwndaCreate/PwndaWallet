/**
 * <Glow> — white text-shadow halo helper.
 *
 * See src/design/BEHAVIORS.md — "Glow text-shadow" row.
 */

import type { CSSProperties, ReactNode } from "react";

export function Glow({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        textShadow:
          "0 0 5px rgba(242,242,242,0.4), 0 0 10px rgba(242,242,242,0.2)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
