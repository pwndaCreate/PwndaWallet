/**
 * Thin variant-shorthand wrappers over <Btn>.
 *
 * Prefer <Btn variant="primary"/> directly in new code. These remain
 * for back-compat with existing call sites.
 */

import type { CSSProperties, ReactNode } from "react";
import { Btn } from "../design/primitives";

export function BtnPrimary({
  children,
  onClick,
  disabled,
  full,
  style,
  caret = true,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  full?: boolean;
  style?: CSSProperties;
  caret?: boolean;
}) {
  return (
    <Btn
      variant="primary"
      onClick={onClick}
      disabled={disabled}
      full={full}
      style={style}
      caret={caret}
    >
      {children}
    </Btn>
  );
}

export function BtnGhost({
  children,
  onClick,
  style,
  caret = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
  caret?: boolean;
}) {
  return (
    <Btn variant="ghost" onClick={onClick} style={style} caret={caret}>
      {children}
    </Btn>
  );
}
