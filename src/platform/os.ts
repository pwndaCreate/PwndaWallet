// Frontend OS detection for surfacing / hiding OS-specific UI affordances.
//
// Uses `@tauri-apps/plugin-os` for accurate detection inside the Tauri
// runtime, with a `navigator.userAgent` fallback for the design catalog +
// web-build dev surfaces (where the Tauri plugin isn't registered).
//
// The plugin's `type()` is sync (after initialization) and returns
// "windows" | "linux" | "macos" | "android" | "ios". We cache the result so
// downstream callers can stay synchronous — the cache is populated on the
// first `await initOsDetection()`, which happens from App.tsx mount.
//
// Consumers:
// - Mining settings UI: hide "Add Defender exclusion" on non-Windows.
// - Mining UI: show "MSR setup" doc link on Linux instead of silent elevation.
// - Wallet RPC panels: skip Windows-only options on Linux.

type OsType = "windows" | "linux" | "macos" | "android" | "ios" | "unknown";

let cached: OsType | null = null;

/** Populate the OS-type cache from the Tauri plugin. Safe to call multiple
 *  times — second+ calls are no-ops. Safe to call outside Tauri (browser /
 *  catalog) — falls back to UA-based detection.
 *
 *  App.tsx should `await initOsDetection()` once on mount so the sync
 *  accessors below never return "unknown" inside the wallet app. */
export async function initOsDetection(): Promise<OsType> {
  if (cached !== null) return cached;
  try {
    // Dynamic import so the plugin module isn't loaded outside Tauri
    // (browser dev surfaces would otherwise fail at module load).
    const { type } = await import("@tauri-apps/plugin-os");
    cached = type() as OsType;
  } catch {
    cached = detectFromUserAgent();
  }
  return cached;
}

function detectFromUserAgent(): OsType {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Android/i.test(ua)) return "android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

/** Sync OS-type accessor. Returns the cached value from `initOsDetection`;
 *  falls back to UA-based detection if init was never called. */
function getOs(): OsType {
  if (cached !== null) return cached;
  // Fallback path — keeps the sync API working even when init wasn't
  // awaited. The fallback is UA-based which is accurate for our targets.
  cached = detectFromUserAgent();
  return cached;
}

export const isWindows = (): boolean => getOs() === "windows";
export const isLinux = (): boolean => getOs() === "linux";
export const isMac = (): boolean => getOs() === "macos";

// Windows Defender is the only AV stack we know how to add exclusions for.
export const supportsDefenderExclusion = (): boolean => isWindows();

// XMRig RandomX MSR optimization is available on Windows (WinRing0 driver)
// and Linux (read /dev/cpu/N/msr after `modprobe msr` + root). Not on macOS.
export const supportsElevatedMSR = (): boolean => isWindows() || isLinux();

// The wallet currently elevates miner spawns on Windows via UAC. On Linux
// we run unprivileged and surface a perf-hint instead.
export const usesUacElevation = (): boolean => isWindows();

// Linux needs the user to set up MSR + hugepages manually. Use this to
// decide whether to show the "performance setup" hint card.
export const needsLinuxPerfSetup = (): boolean => isLinux();
