import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

/**
 * Resizable left/right rails for the landscape 3-column layout.
 *
 * The center column stays fluid (`1fr`); the user drags two vertical splitters
 * to resize the left and right rails. Widths persist to localStorage so the
 * chosen layout survives reloads. This keeps the landscape *format* (still three
 * columns, sidebar untouched) while letting the user change panel sizes —
 * everything inside each rail reflows because the columns were already flex.
 *
 * Usage (in a landscape view that owns a `300px 1fr 300px`-style grid):
 *
 *   const rails = useResizableRails("pwnda-landscape-rails-wallet");
 *   <div style={{ ...grid, position: "relative",
 *                 gridTemplateColumns: rails.gridTemplateColumns }}>
 *     {rails.handles}
 *     {left}{center}{right}
 *   </div>
 *
 * The handles are absolutely positioned over the column boundaries, so they do
 * NOT occupy grid cells — the three existing children stay as the three columns.
 */

const MIN = 220;
const MAX = 480;
// The fluid center column is never allowed to shrink below this — a rail can't
// grow so wide that the focal content gets squeezed into uselessness.
const CENTER_MIN = 260;
const clamp = (v: number) => Math.max(MIN, Math.min(MAX, v));

export function useResizableRails(
  storageKey: string,
  defaults: { left: number; right: number } = { left: 300, right: 300 },
): { left: number; right: number; gridTemplateColumns: string; handles: ReactElement } {
  const load = (k: "left" | "right", d: number): number => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const p = JSON.parse(raw) as Record<string, unknown>;
        if (typeof p[k] === "number") return clamp(p[k] as number);
      }
    } catch {
      /* ignore malformed persisted value */
    }
    return d;
  };

  const [left, setLeft] = useState(() => load("left", defaults.left));
  const [right, setRight] = useState(() => load("right", defaults.right));

  // Persist on change (a handful of writes per drag is fine).
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ left, right }));
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [storageKey, left, right]);

  // Drag state lives in a ref so the window listeners can stay mounted once.
  // `containerW`/`otherW` are captured at drag start to cap the dragged rail
  // against the live container width (keeps the center ≥ CENTER_MIN).
  const drag = useRef<{
    side: "left" | "right";
    startX: number;
    startW: number;
    containerW: number;
    otherW: number;
  } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      // Cap so left + right + CENTER_MIN never exceeds the container width.
      const cap = d.containerW > 0 ? Math.min(MAX, Math.max(MIN, d.containerW - d.otherW - CENTER_MIN)) : MAX;
      const next = (w: number) => Math.max(MIN, Math.min(cap, w));
      if (d.side === "left") setLeft(next(d.startW + dx));
      else setRight(next(d.startW - dx)); // right rail grows as the pointer moves left
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const begin = useCallback(
    (side: "left" | "right") => (e: ReactPointerEvent) => {
      const grid = (e.currentTarget as HTMLElement).parentElement;
      drag.current = {
        side,
        startX: e.clientX,
        startW: side === "left" ? left : right,
        containerW: grid ? grid.clientWidth : 0,
        otherW: side === "left" ? right : left,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    },
    [left, right],
  );

  const handles = (
    <>
      <RailHandle posStyle={{ left: left - 3 }} onPointerDown={begin("left")} label="Resize left rail" />
      <RailHandle posStyle={{ right: right - 3 }} onPointerDown={begin("right")} label="Resize right rail" />
    </>
  );

  return { left, right, gridTemplateColumns: `${left}px minmax(0, 1fr) ${right}px`, handles };
}

function RailHandle({
  posStyle,
  onPointerDown,
  label,
}: {
  posStyle: CSSProperties;
  onPointerDown: (e: ReactPointerEvent) => void;
  label: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        width: 6,
        cursor: "col-resize",
        zIndex: 6,
        background: hover ? "var(--accent)" : "transparent",
        transition: "background .12s",
        ...posStyle,
      }}
    />
  );
}
