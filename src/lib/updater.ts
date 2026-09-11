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
 * Every format this project ships can self-update: Windows NSIS, Linux
 * AppImage, `.deb` and `.rpm`. The plugin replaces the AppImage in place and
 * installs the two packages with `pkexec dpkg -i` / `pkexec rpm -U`, which is
 * what apt and dnf run underneath and is recorded in the package database
 * exactly as a normal install is. Package users get a polkit prompt.
 *
 * `isUpdaterSupported()` asks the backend, which asks the BUNDLER: the marker
 * `__TAURI_BUNDLE_TYPE`, stamped into each artifact as it is built. So the
 * answer is "was this produced by a bundler" rather than a guess from the
 * environment, and the only `false` is an unstamped binary — a `cargo run` dev
 * build, or a tarball someone extracted by hand.
 *
 * ### This used to say the opposite
 *
 * Until 2026-09-10 the comment here claimed `.deb`/`.rpm` could not
 * self-update because "overwriting apt-managed files behind apt's back is how
 * you get an unbootable package database", and `isUpdaterSupported()` returned
 * false for them. Both were wrong. What actually kept those two formats from
 * updating was that `release-local.ps1` never uploaded their signatures, so no
 * manifest could list them — a missing glob, not a platform constraint. See
 * `scripts/releaseArtifactParity.test.mjs`.
 *
 * One real caveat survives, and it lives on the build side rather than here:
 * `dpkg -i` does not resolve dependencies, so a release that ADDS one can
 * half-configure on a machine that lacks it. `scripts/check-linux-deps.mjs`
 * refuses such a release before it is built.
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
