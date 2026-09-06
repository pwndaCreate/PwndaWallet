/**
 * Self-update check.
 *
 * Wraps `@tauri-apps/plugin-updater` so the rest of the app can ask "is there
 * a newer PwndaWallet?" without importing Tauri APIs directly (and without
 * exploding in the browser-only dev entries, where `window.__TAURI__` is
 * absent — see `src/lib/tauri.ts` for the same pattern).
 *
 * ## Trust model
 *
 * The updater downloads a replacement binary and runs it. The only thing
 * standing between "we fetched some bytes" and "we execute them" is the
 * minisign signature check, which the Rust plugin performs against the public
 * key compiled in from `tauri.conf.json` → `plugins.updater.pubkey`. That check
 * is not optional and cannot be disabled from here.
 *
 * The practical consequence: whoever controls the private key controls what
 * runs on every user's machine. Treat it like a code-signing key — it does not
 * belong in the repo, in CI logs, or in `.env` files that get shared.
 *
 * ## Platform behaviour
 *
 * Tauri can only replace the running binary for formats that own their own
 * install: Windows (MSI/NSIS) and Linux AppImage. `.deb` and `.rpm` are owned
 * by the system package manager, so the plugin refuses to self-replace there —
 * correctly, since overwriting apt-managed files behind apt's back is how you
 * get an unbootable package database. Those users get told a new version
 * exists and are pointed at the download.
 *
 * `isUpdaterSupported()` encodes that split so the caller can avoid showing a
 * "Restart to update" button that could never work.
 */

import { invoke } from "./tauri";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Release notes from `latest.json`, if the manifest carried any. */
  notes?: string;
  /** RFC 3339 publish date from the manifest, if present. */
  date?: string;
}

/** Narrow shape of the plugin's `Update` object that we actually use. */
type TauriUpdate = {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  downloadAndInstall: (
    onEvent?: (e: { event: string; data?: unknown }) => void
  ) => Promise<void>;
};

let cachedUpdate: TauriUpdate | null = null;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Whether an in-place update can actually be applied on this install.
 *
 * Delegates to the Rust `updater_can_self_install` command, which checks the
 * `APPIMAGE` env var the AppImage runtime exports. That's the only reliable way
 * to tell an AppImage from a `.deb`/`.rpm` from inside the process, and it has
 * to be answered natively — the webview has no view of the process environment.
 *
 * Fails closed: if the command errors we report "not self-updatable", because
 * offering an install that silently no-ops (or worse, overwrites apt-owned
 * files) is a worse outcome than telling the user to run `apt upgrade`.
 */
export async function isUpdaterSupported(): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await invoke<boolean>("updater_can_self_install");
  } catch {
    return false;
  }
}

/**
 * Ask the update server whether a newer version exists.
 *
 * Returns `null` when we're up to date, when running outside Tauri (browser dev
 * entries), or when the check fails. Failure is deliberately non-fatal and
 * silent-ish: a wallet that refuses to start because a release server is down
 * would be a worse bug than a missed update. The error is logged, not thrown.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // Sandbox-only: let the browser sandbox exercise the update UI.
  //
  // The real check needs the Tauri runtime, so `dev:sandbox` can never produce
  // an update and the banner could not be looked at — which is how the app
  // ended up with an updater nobody had ever SEEN fire. Same shape as
  // VITE_MOCK_STATE / VITE_MOCK_DEVICE; set VITE_MOCK_UPDATE=<version> in
  // .env.sandbox.local. `import.meta.env.DEV` is statically false in
  // `vite build`, so this whole branch is dead-code-eliminated from shipped
  // binaries.
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_UPDATE) {
    const version = String(import.meta.env.VITE_MOCK_UPDATE);
    console.log(`[updater] VITE_MOCK_UPDATE active — pretending v${version} is available`);
    return {
      version,
      currentVersion: "0.0.0-sandbox",
      notes: "Synthetic update from VITE_MOCK_UPDATE. Nothing is downloadable.",
    };
  }
  if (!inTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      cachedUpdate = null;
      return null;
    }
    cachedUpdate = update as unknown as TauriUpdate;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body || undefined,
      date: update.date || undefined,
    };
  } catch (e) {
    console.warn("[updater] check failed:", e);
    cachedUpdate = null;
    return null;
  }
}

/**
 * Download and install the update found by the last `checkForUpdate()`.
 *
 * The signature is verified by the Rust plugin before anything is written. On
 * success the caller should relaunch; we do NOT relaunch automatically, because
 * this app may be mid-sync, mid-swap, or holding an unlocked vault — yanking
 * the process out from under that is the caller's decision to make, not ours.
 *
 * `onProgress` receives 0..1, or -1 when the total size is unknown.
 */
export async function installUpdate(
  onProgress?: (fraction: number) => void
): Promise<void> {
  if (!cachedUpdate) {
    throw new Error("No update available — call checkForUpdate() first.");
  }
  let downloaded = 0;
  let total = 0;
  await cachedUpdate.downloadAndInstall((e) => {
    if (e.event === "Started") {
      const d = e.data as { contentLength?: number } | undefined;
      total = d?.contentLength ?? 0;
      onProgress?.(total > 0 ? 0 : -1);
    } else if (e.event === "Progress") {
      const d = e.data as { chunkLength?: number } | undefined;
      downloaded += d?.chunkLength ?? 0;
      onProgress?.(total > 0 ? downloaded / total : -1);
    } else if (e.event === "Finished") {
      onProgress?.(1);
    }
  });
}
