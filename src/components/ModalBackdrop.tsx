/**
 * The dimmed backdrop behind a modal or a bottom sheet: closes on a real
 * click on the backdrop, and never because the window was moved.
 *
 * Moved here from `src/features/swap/modal-parts.tsx` on 2026-09-30, when the
 * Activity transaction sheet (`activity/TxDetails.tsx`) needed the same
 * behaviour and could not import a swap internal. The swap modals still get it
 * as `Backdrop` from `modal-parts`, which re-exports this file.
 *
 * # Moving the window must not close a modal
 *
 * The operator's report, 2026-09-30: "When I try to move the app the swap
 * screen unfocuses and disappears." Worked out from the code; not reproduced
 * live:
 *
 *  - The window has no OS title bar (`decorations: false`). It is dragged by
 *    the app's own title bar, a `data-tauri-drag-region` 34 px (portrait) or
 *    36 px (landscape) tall at the top of the window.
 *  - A backdrop was `position: fixed; inset: 0; z-index: 60` inside `.app`,
 *    and in portrait it covered that title bar, which has no layer of its
 *    own (see `MODAL_BACKDROP_Z` below for the order now). Tauri's drag
 *    script (tauri 2.11.5,
 *    `src/window/scripts/drag.js`) starts a drag only when the pressed element
 *    itself carries the attribute. A press on the title bar landed on the
 *    backdrop instead: the window did not move, and the release was a `click`
 *    on the backdrop, which closed the modal.
 *  - A drag that starts in the card and ends outside it closed it too (a text
 *    selection of a hash, say): a click whose press and release land on
 *    different elements goes to their common ancestor, the backdrop.
 *
 * So the backdrop closes only on a click whose press AND release are both on
 * the backdrop itself, with the pointer still where it was pressed; and its top
 * strip is a drag region, so pressing where the title bar shows through moves
 * the window, as the user expected. The strip sits at `z-index: -1`, above the
 * backdrop's own background and below the card, so it can never cover a
 * control on the card.
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export const BACKDROP_TITLEBAR_STRIP_PX = 36;
/**
 * The backdrop's layer at the page root (2026-09-30). Above the page (`.app`,
 * 1) and the portrait bottom nav (`BottomNav`, 10); below the landscape title
 * bar (`LandscapeShell`, 20), whose window buttons stay usable. The portrait
 * title bar (`design/shell/TitleBar`) has no layer of its own, so a modal
 * covers it there, as it always has: the top strip above is what moves the
 * window then. `modalBackdrop.test.ts` pins the order against those files.
 */
export const MODAL_BACKDROP_Z = 15;
/** How far the pointer may travel between press and release and still be a
 *  click rather than a drag. */
export const BACKDROP_DRAG_SLOP_PX = 4;

interface BackdropPointerEvent {
  target: unknown;
  currentTarget: unknown;
  button?: number;
  clientX: number;
  clientY: number;
}

/** Where the pending press on each backdrop began. Keyed by the backdrop
 *  element, so the component needs no hook and its handlers can be driven
 *  directly by a test. */
const backdropPresses = new WeakMap<object, { x: number; y: number }>();

function backdropNode(e: BackdropPointerEvent): object | null {
  return e.currentTarget && typeof e.currentTarget === "object" ? e.currentTarget : null;
}

/** mousedown: remember the press only if it is on the backdrop itself. */
export function noteBackdropPress(e: BackdropPointerEvent): void {
  const node = backdropNode(e);
  if (!node) return;
  if (e.target === e.currentTarget && (e.button ?? 0) === 0) {
    backdropPresses.set(node, { x: e.clientX, y: e.clientY });
  } else {
    backdropPresses.delete(node);
  }
}

/** click: true only when press and release were both on the backdrop itself
 *  and the pointer did not travel. Consumes the recorded press either way. */
export function backdropClickCloses(e: BackdropPointerEvent): boolean {
  const node = backdropNode(e);
  if (!node) return false;
  const press = backdropPresses.get(node);
  backdropPresses.delete(node);
  if (!press || e.target !== e.currentTarget) return false;
  return (
    Math.abs(e.clientX - press.x) <= BACKDROP_DRAG_SLOP_PX &&
    Math.abs(e.clientY - press.y) <= BACKDROP_DRAG_SLOP_PX
  );
}

/**
 * Rendered into `document.body` (2026-09-30). Inside `.app` — a stacking
 * context of its own at z-index 1 — no z-index could lift a modal over the
 * portrait bottom nav, which sits outside `.app` at 10: the nav painted over
 * the Activity sheet's buttons and stayed clickable behind every modal, so a
 * tab switch could unmount one mid-flow. Without a DOM (the unit tests) it
 * renders in place.
 */
export function ModalBackdrop({
  children,
  onClick,
  align = "center",
}: {
  children: ReactNode;
  onClick?: () => void;
  /** `center` for a modal card, `end` for a bottom sheet. */
  align?: "center" | "end";
}) {
  const backdrop = (
    <div
      data-modal-backdrop
      onMouseDown={noteBackdropPress}
      onClick={(e) => {
        if (backdropClickCloses(e) && onClick) onClick();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: align === "end" ? "flex-end" : "center",
        justifyContent: "center",
        zIndex: MODAL_BACKDROP_Z,
        animation: "fade-in .15s ease",
      }}
    >
      <div
        data-tauri-drag-region
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: BACKDROP_TITLEBAR_STRIP_PX,
          zIndex: -1,
        }}
      />
      {children}
    </div>
  );
  return typeof document === "undefined" ? backdrop : createPortal(backdrop, document.body);
}
