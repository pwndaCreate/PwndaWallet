/**
 * `<SelectMenu>` — a dropdown the design system actually controls.
 *
 * # Why not a native `<select>`
 *
 * The Mine hero's asset picker was a native `<select>`. Its options are drawn
 * by the OS, not the page: small, plain white, system font, on a system
 * background. Reported 2026-08-29 — *"the text is small and its just plain
 * white"* — and it is not a CSS bug to be fixed, because `<option>` styling is
 * substantially ignored across browsers and the popup itself is outside the
 * document. Any terminal-aesthetic app that wants a styled option list has to
 * render the list itself.
 *
 * So this is a button plus an absolutely-positioned panel of real elements:
 * mono font, accent selection, per-item hint text, and enough size to read.
 *
 * # What is deliberately preserved from the native control
 *
 * A custom dropdown is easy to make less accessible than the thing it
 * replaced, so:
 *
 *   - the trigger is a real `<button>` with `aria-haspopup="listbox"` and
 *     `aria-expanded`, and the panel is a `role="listbox"` of
 *     `role="option"`s carrying `aria-selected`;
 *   - Escape closes, Enter/Space opens, arrows move, Home/End jump;
 *   - focus returns to the trigger on close, so keyboard users are not
 *     stranded;
 *   - clicking outside closes, via a listener bound only while open.
 *
 * Tests drive the previous native `<select>` by setting `.value` and firing
 * `change`; that no longer exists, so anything asserting on it must move to
 * clicking the trigger and an option. That is a real cost of this change and
 * is why the native control was worth keeping until the styling actually
 * mattered.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export interface SelectMenuItem<T extends string = string> {
  value: T;
  /** Main label. Rendered in mono at the menu's own size. */
  label: string;
  /** Right-aligned secondary text — a balance, a leg count, a route note. */
  hint?: string | null;
  /** Small mark before the label (a coin icon, a status square). */
  glyph?: ReactNode;
  disabled?: boolean;
  /** Why it is disabled, or any extra context. Becomes the `title`. */
  title?: string;
}

const mono = { fontFamily: "var(--font-mono)" } as const;

export function SelectMenu<T extends string = string>({
  value,
  items,
  onChange,
  ariaLabel,
  placeholder = "select",
  disabled = false,
  align = "left",
  minWidth = 150,
  style,
}: {
  value: T;
  items: ReadonlyArray<SelectMenuItem<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  /** Which edge the panel hangs from. `right` for triggers near a boundary. */
  align?: "left" | "right";
  minWidth?: number;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  const selected = items.find((i) => i.value === value) ?? null;
  const enabledIndexes = items
    .map((it, i) => (it.disabled ? -1 : i))
    .filter((i) => i >= 0);

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Outside-click and Escape are bound only while open — a permanently
  // attached document listener per dropdown is a leak with a long tail.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const i = items.findIndex((it) => it.value === value);
    setActive(i >= 0 ? i : (enabledIndexes[0] ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const move = (dir: 1 | -1) => {
    if (enabledIndexes.length === 0) return;
    const pos = enabledIndexes.indexOf(active);
    const next =
      pos === -1
        ? enabledIndexes[0]
        : enabledIndexes[
            (pos + dir + enabledIndexes.length) % enabledIndexes.length
          ];
    setActive(next);
  };

  const commit = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    onChange(it.value);
    close(true);
  };

  return (
    <div ref={rootRef} style={{ position: "relative", ...style }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) setOpen(true);
            else move(e.key === "ArrowDown" ? 1 : -1);
          }
        }}
        style={{
          ...mono,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          minWidth,
          border: `1px solid ${open ? "var(--accent)" : "var(--border-hi)"}`,
          background: open ? "var(--accent-soft)" : "var(--surface)",
          color: open ? "var(--accent)" : "var(--text)",
          padding: "6px 9px",
          fontSize: 11,
          letterSpacing: 0.5,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          textAlign: "left",
        }}
      >
        {selected?.glyph}
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selected?.label ?? placeholder}
        </span>
        <span
          aria-hidden
          style={{
            fontSize: 9,
            color: open ? "var(--accent)" : "var(--text-dim)",
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 120ms",
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Home") {
              e.preventDefault();
              setActive(enabledIndexes[0] ?? 0);
            } else if (e.key === "End") {
              e.preventDefault();
              setActive(enabledIndexes[enabledIndexes.length - 1] ?? 0);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              commit(active);
            }
          }}
          style={{
            ...mono,
            position: "absolute",
            top: "calc(100% + 3px)",
            [align]: 0,
            zIndex: 40,
            minWidth: Math.max(minWidth, 172),
            maxHeight: 268,
            overflowY: "auto",
            border: "1px solid var(--accent-mid)",
            background: "var(--bg-surface-2, #111111)",
            // Lifts the panel off whatever it covers. The rest of this design
            // system is shadow-free by rule; a floating layer is the one place
            // depth carries meaning rather than decoration.
            boxShadow: "0 6px 20px rgba(0,0,0,0.75)",
            padding: 3,
          }}
        >
          {items.map((it, i) => {
            const isSelected = it.value === value;
            const isActive = i === active;
            return (
              <div
                key={it.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={it.disabled || undefined}
                title={it.title}
                onMouseEnter={() => !it.disabled && setActive(i)}
                onClick={() => commit(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 9px",
                  fontSize: 11,
                  letterSpacing: 0.5,
                  cursor: it.disabled ? "not-allowed" : "pointer",
                  color: it.disabled
                    ? "var(--text-dim)"
                    : isSelected
                      ? "var(--accent)"
                      : "var(--text)",
                  background: it.disabled
                    ? "transparent"
                    : isActive
                      ? "var(--accent-soft)"
                      : "transparent",
                  borderLeft: `2px solid ${
                    isSelected ? "var(--accent)" : "transparent"
                  }`,
                  opacity: it.disabled ? 0.55 : 1,
                }}
              >
                {it.glyph}
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.label}
                </span>
                {it.hint && (
                  <span
                    className="tnum"
                    style={{
                      fontSize: 9,
                      color: it.disabled
                        ? "var(--text-dim)"
                        : isSelected
                          ? "var(--accent)"
                          : "var(--text-muted)",
                    }}
                  >
                    {it.hint}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
