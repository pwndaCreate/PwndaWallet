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
 * ## Shared across BOTH layouts, on purpose
 *
 * Mounted by `ViewRouter` (portrait) and `LandscapeShell` (landscape) — one
 * component, two call sites, per the landscape-first rule in CLAUDE.md. A
 * portrait-only notifier would mean landscape users silently never hear about
 * updates, which is the exact failure mode that rule was written for.
 *
 * Only one shell is mounted at a time, but toggling the layout remounts this,
 * so the network check is memoised at MODULE level rather than per-mount —
 * see `checkOnce`. Flipping the layout switch should not re-poll GitHub.
 *
 * ## Deliberately quiet
 *
 * - It never blocks startup: the check is fired after a short delay and its
 *   failure is silent (`checkForUpdate` already returns `null` on error — a
 *   wallet must not present an error because a release server is down).
 * - Dismissal is remembered PER VERSION. Dismissing 0.6.1 hides 0.6.1 forever,
 *   and says nothing about 0.6.2. A banner that returns every launch trains
 *   people to dismiss without reading.
 * - It does not install anything. The actual download/install lives in the
 *   Settings card, which is also the only place that can tell the user their
 *   install type cannot self-update (`.deb`/`.rpm`). Offering a one-click
 *   install here would have to duplicate that logic or lie to those users.
 */
import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, type UpdateInfo } from "../lib/updater";

/** Per-version dismissal. Value is the version the user dismissed. */
const DISMISS_KEY = "pwnda-update-dismissed";

/**
 * How long after mount to ask. Startup is already contending for the network
 * (balances, prices, node health); an update check is the least urgent thing
 * happening and should not be in that queue.
 */
const CHECK_DELAY_MS = 4000;

/**
 * The check, memoised for the lifetime of the process.
 *
 * `checkForUpdate()` is not free — it is an HTTPS round-trip to the release
 * endpoint — and this component can mount more than once per launch (layout
 * toggle). A module-level promise makes "once per launch" a property of the
 * module rather than a discipline every call site has to remember.
 */
let checkOnce: Promise<UpdateInfo | null> | null = null;
function updateCheck(): Promise<UpdateInfo | null> {
  if (!checkOnce) checkOnce = checkForUpdate();
  return checkOnce;
}

/** Exported for tests only — lets a case start from a clean process. */
export function __resetUpdateCheckForTests(): void {
  checkOnce = null;
}

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
  /** Route the user to Settings, where the install button lives. */
  onOpenSettings: () => void;
}) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      void updateCheck().then((found) => {
        if (!alive || !found) return;
        if (readDismissed() === found.version) return;
        setInfo(found);
      });
    }, CHECK_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  const dismiss = useCallback(() => {
    setHidden(true);
    try {
      if (info) localStorage.setItem(DISMISS_KEY, info.version);
    } catch {
      // Non-fatal: the banner still closes for this session, it just comes
      // back next launch. Losing a preference is better than a crash here.
    }
  }, [info]);

  if (!info || hidden) return null;

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
      </span>
      <button
        type="button"
        className="btn-link"
        style={{ fontSize: 11, whiteSpace: "nowrap" }}
        onClick={onOpenSettings}
      >
        View
      </button>
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
    </div>
  );
}
