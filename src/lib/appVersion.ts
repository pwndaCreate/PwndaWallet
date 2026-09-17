/**
 * The ONE place the UI gets PwndaWallet's version from.
 *
 * Derived at build time from `package.json`. That is the same number the
 * shipped binary reports, because `release-local.ps1` refuses to build unless
 * `package.json` and `src-tauri/tauri.conf.json` agree (and bumps both
 * together), and `appVersion.test.ts` fails the suite if they ever drift.
 * Tauri compiles `tauri.conf.json`'s version into the binary; that is what the
 * updater compares against the latest release's manifest.
 *
 * Why a build-time constant rather than `getVersion()` from
 * `@tauri-apps/api/app`: it renders identically in the browser sandbox (no
 * Tauri runtime there), needs no async state in the title bar, and the test
 * above already pins it to the value `getVersion()` would return.
 *
 * Before 2026-09-16 six surfaces hardcoded "v2.0.1" — a number no PwndaWallet
 * release ever carried — and PwndaLite hardcoded its own copy.
 * `appVersion.test.ts` now fails on any hardcoded `vX.Y.Z` in UI source.
 *
 * Named JSON imports only: Vite tree-shakes them, so the rest of either file
 * (scripts, dependency list, updater config) is not bundled.
 */
import { version as packageVersion } from "../../package.json";
import { version as liteConfVersion } from "../../src-tauri/tauri-lite.conf.json";

/** This build of PwndaWallet, bare ("0.6.3"). */
export const APP_VERSION: string = packageVersion;

/**
 * This build of PwndaLite, bare. Lite is a separate Tauri product with its own
 * `tauri-lite.conf.json`, whose version is what the Lite binary reports.
 */
export const LITE_APP_VERSION: string = liteConfVersion;

/** Display form: "v0.6.3". Accepts a bare or already-prefixed version. */
export function formatAppVersion(version: string = APP_VERSION): string {
  return version.startsWith("v") ? version : `v${version}`;
}
