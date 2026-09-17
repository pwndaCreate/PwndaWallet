/**
 * "A new version is available" bar.
 *
 * ## Why this exists
 *
 * The updater has worked for a while, but nothing ever ASKED it a question:
 * `checkForUpdate()` had exactly one caller in the whole app — a button in
 * Settings ► About. A user who never opened that card was never told an update
 * existed, so in practice the app had an updater and no update path. This
 * component is the missing half: it checks on launch and says so.
 *
 * ## Mounted in three places, one component
 *
 * `ViewRouter` (portrait), `LandscapeShell` (landscape), and — since
 * 2026-09-17 — the lock screen in `App.tsx`, which renders ahead of both
 * shells. Before that, a user who launched the app and stayed on the unlock
 * screen was never told anything. The lock screen passes no `onOpenSettings`,
 * because Settings is not reachable before unlock; the banner's own install
 * button is enough there.
 *
 * The check is memoised in `lib/appUpdate.ts`, so mounting in several places
 * (and remounting on a layout toggle) asks the release endpoint once.
 *
 * ## It installs, it does not restart
 *
 * Until 2026-09-17 the banner only notified, on the reasoning that `.deb`/`.rpm`
 * could not self-update and only Settings could say so. That stopped being true
 * on 2026-09-10 (see `lib/updater.ts`), and landscape Settings never had an
 * install button at all, so in the default layout "View" led nowhere. The
 * banner now carries the shared install/restart actions. Restarting is still a
 * separate click: the app may be mid-swap or mid-sync.
 *
 * ## Deliberately quiet
 *
 * - It never blocks startup: the check is fired after a short delay and its
 *   failure is silent (`checkForUpdate` returns `null` on error — a wallet must
 *   not present an error because a release server is down).
 * - Dismissal is remembered PER VERSION. Dismissing 0.6.1 hides 0.6.1 forever,
 *   and says nothing about 0.6.2. A banner that returns every launch trains
 *   people to dismiss without reading. An install in progress cannot be
 *   dismissed out of sight.
 */
import { useCallback, useEffect, useState } from "react";
import { checkAppUpdate, useAppUpdate } from "../lib/appUpdate";
import { AppUpdateActions } from "./AppUpdateControls";

/** Per-version dismissal. Value is the version the user dismissed. */
const DISMISS_KEY = "pwnda-update-dismissed";

/**
 * How long after mount to ask. Startup is already contending for the network
 * (balances, prices, node health); an update check is the least urgent thing
 * happening and should not be in that queue.
 */
const CHECK_DELAY_MS = 4000;

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    // Private windows / blocked site data throw on ACCESS, not just on write.
    return null;
  }
}

export function UpdateBanner({
  onOpenSettings,
}: {
  /** Route the user to Settings. Omitted on the lock screen. */
  onOpenSettings?: () => void;
}) {
  const u = useAppUpdate();
  const info = u.info;
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

  useEffect(() => {
    const t = setTimeout(() => void checkAppUpdate(), CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const busy = u.phase === "installing" || u.phase === "done" || u.phase === "restarting";

  const dismiss = useCallback(() => {
    if (!info) return;
    setDismissed(info.version);
    try {
      localStorage.setItem(DISMISS_KEY, info.version);
    } catch {
      // Non-fatal: the banner still closes for this session, it just comes
      // back next launch. Losing a preference is better than a crash here.
    }
  }, [info]);

  if (!info || (dismissed === info.version && !busy)) return null;

  return (
    <div
      className="alert alert-success"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        marginBottom: 0,
        wordBreak: "normal",
      }}
      data-testid="update-banner"
    >
      <span style={{ flex: 1 }}>
        Update available — <strong>v{info.version}</strong>{" "}
        <span style={{ opacity: 0.7 }}>(you have v{info.currentVersion})</span>
        {u.error && (
          <span style={{ display: "block", fontSize: 11, color: "var(--danger)" }}>{u.error}</span>
        )}
      </span>
      <AppUpdateActions fontSize={11} />
      {onOpenSettings && !busy && (
        <button
          type="button"
          className="btn-link"
          style={{ fontSize: 11, whiteSpace: "nowrap" }}
          onClick={onOpenSettings}
        >
          View
        </button>
      )}
      {!busy && (
        <button
          type="button"
          className="btn-link"
          aria-label="Dismiss update notice"
          title="Dismiss — you will be told again at the next version"
          style={{ fontSize: 11, opacity: 0.7 }}
          onClick={dismiss}
        >
          ✕
        </button>
      )}
    </div>
  );
}
