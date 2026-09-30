/**
 * The app-wide error / success lines — ONE component, mounted by both layout
 * roots (2026-09-29).
 *
 * Fixed and above `.modal-overlay` (z-index 2000), because a send that fails
 * does so with its modal still open: a line rendered in page flow sits behind
 * the backdrop and cannot be read. Landscape got this on 2026-09-12 (the
 * "Send does nothing" report). Portrait kept its in-flow lines, and the
 * 2026-09-29 send-safety audit found a failed portrait send still showing
 * nothing readable: the button flipped back to "Send", and a user who pressed
 * it again could send twice. Same reason `UpdateBanner` is one component
 * mounted twice rather than two.
 *
 * Each line sits on an opaque base (`--bg`) under the alert's own tint: the
 * tint is translucent (`--danger-dim`), and fixed over the page it let the
 * header text behind show through the message.
 */
export function AppAlerts({
  error,
  success,
  setError,
  setSuccess,
  top = 44,
}: {
  error: string;
  success: string;
  setError: (msg: string) => void;
  /** Absent: the success line has no dismiss button. */
  setSuccess?: (msg: string) => void;
  /** Distance from the top of the window, below the layout's own title bar. */
  top?: number;
}) {
  if (!error && !success) return null;
  return (
    <div
      data-app-alerts
      style={{
        position: "fixed",
        top,
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(640px, calc(100vw - 32px))",
        zIndex: 2100,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {error && (
        <div style={{ background: "var(--bg)" }}>
          <div
            className="alert alert-error"
            role="alert"
            style={{ margin: 0, display: "flex", gap: 10, alignItems: "flex-start" }}
          >
            <span style={{ flex: 1, overflowWrap: "anywhere" }}>{error}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setError("")}
              style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", fontFamily: "var(--mono)" }}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {success && (
        <div style={{ background: "var(--bg)" }}>
          <div
            className="alert alert-success"
            role="status"
            style={{ margin: 0, display: "flex", gap: 10, alignItems: "flex-start" }}
          >
            <span style={{ flex: 1, overflowWrap: "anywhere" }}>{success}</span>
            {setSuccess && (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setSuccess("")}
                style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", fontFamily: "var(--mono)" }}
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
