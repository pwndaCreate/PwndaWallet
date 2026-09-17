/**
 * The update actions every update surface shares: install, progress, restart.
 *
 * Used by `UpdateBanner` (both layouts and the lock screen) and by
 * `AppUpdateRow` (both layouts' Settings). State lives in `lib/appUpdate.ts`,
 * so an install started in one place shows in the other.
 */
import type { ReactNode } from "react";
import { formatAppVersion } from "../lib/appVersion";
import {
  checkAppUpdate,
  installAppUpdate,
  restartIntoUpdate,
  useAppUpdate,
} from "../lib/appUpdate";

const small = { fontSize: 10 } as const;

/**
 * What can be done with the release already found. Renders nothing before a
 * release is found, so callers decide how the "no update" states look.
 */
export function AppUpdateActions({ fontSize = 10 }: { fontSize?: number }) {
  const u = useAppUpdate();
  const style = { fontSize, whiteSpace: "nowrap" as const };
  if (!u.info) return null;

  if (u.phase === "found" || u.phase === "error") {
    if (!u.canSelfInstall) {
      return (
        <span style={{ ...style, whiteSpace: "normal", color: "var(--text-dim)" }}>
          This build can't update itself. Install v{u.info.version} from the release page.
        </span>
      );
    }
    return (
      <button
        type="button"
        className="btn-link"
        style={style}
        onClick={() => void installAppUpdate()}
        data-testid="update-install"
      >
        {u.phase === "error" ? "retry install" : `install v${u.info.version}`}
      </button>
    );
  }
  if (u.phase === "installing") {
    return (
      <span className="tnum" style={style} data-testid="update-progress">
        {u.progress < 0 ? "downloading…" : `installing ${Math.round(u.progress * 100)}%`}
      </span>
    );
  }
  if (u.phase === "done") {
    return (
      <button
        type="button"
        className="btn-link"
        style={{ ...style, color: "var(--accent)" }}
        onClick={() => void restartIntoUpdate()}
        data-testid="update-restart"
      >
        restart now
      </button>
    );
  }
  if (u.phase === "restarting") {
    return <span style={style}>restarting…</span>;
  }
  return null;
}

/**
 * The "Updates" row in Settings ► About, in both layouts. `label` lets a
 * layout render the row's label in its own style (landscape's `InfoRow`).
 */
export function AppUpdateRow({ label }: { label?: ReactNode }) {
  const u = useAppUpdate();
  const canCheck = ["idle", "current", "found", "error"].includes(u.phase);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="update-row">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        {label ?? <span style={{ color: "var(--text-dim)" }}>Updates</span>}
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {u.phase === "checking" && <span style={small}>checking…</span>}
          {u.phase === "current" && (
            <span style={{ ...small, color: "var(--text-dim)" }}>up to date</span>
          )}
          {u.info && u.phase !== "current" && (
            <span style={{ ...small, color: "var(--accent)" }}>
              v{u.info.version} available · this build{" "}
              {formatAppVersion(u.info.currentVersion || undefined)}
            </span>
          )}
          {canCheck && (
            <button
              type="button"
              className="btn-link"
              style={small}
              onClick={() => void checkAppUpdate(true)}
            >
              check now
            </button>
          )}
        </span>
      </div>
      {u.info && (
        <div style={small}>
          <AppUpdateActions />
        </div>
      )}
      {u.phase === "done" && (
        <div style={{ ...small, color: "var(--text-dim)" }}>
          Installed. Restart closes the app the same way the close button does, then opens the new version.
        </div>
      )}
      {u.error && <div style={{ ...small, color: "var(--danger)" }}>{u.error}</div>}
    </div>
  );
}
