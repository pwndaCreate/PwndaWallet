import type { HTMLAttributes, KeyboardEvent, MouseEvent } from "react";

/**
 * Props that make a history row open its transaction's details (operator
 * request, 2026-10-01: "click on each given recent transaction … and a mini
 * window or panel appears with the transaction details"). The row is a button
 * to the keyboard and to screen readers as well as to the mouse, as
 * Activity's rows already are.
 *
 * `open` undefined leaves the row as it was: a surface that opens nothing gets
 * no button role, no focus stop and no hover.
 *
 * A control inside the row (the hash, which opens the explorer or copies)
 * stops its own click, so pressing it does not also open the details.
 */
export function openableRowProps(
  open: (() => void) | undefined,
  title = "Show transaction details",
): HTMLAttributes<HTMLDivElement> {
  if (!open) return {};
  return {
    role: "button",
    tabIndex: 0,
    title,
    onClick: open,
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      // The row's own keys only: Enter on a control inside it is that
      // control's.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    },
    onMouseEnter: (e: MouseEvent<HTMLDivElement>) => {
      e.currentTarget.style.background = "rgba(255,255,255,0.03)";
    },
    onMouseLeave: (e: MouseEvent<HTMLDivElement>) => {
      e.currentTarget.style.background = "transparent";
    },
  };
}
