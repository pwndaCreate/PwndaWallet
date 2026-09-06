/**
 * src/design/env.ts
 *
 * Env detection helpers used by primitives + shell components to
 * conditionally enable Tauri-specific behavior (drag region, OS
 * controls, sidecar invokes).
 *
 * Three runtime modes:
 *   - Full wallet in Tauri:       isTauri() === true
 *   - Full wallet in browser:     isTauri() === false, isLite() === false
 *   - Lite app in Tauri:          isTauri() === true, isLite() === true
 *   - Catalog standalone:         catalog mounts unconditionally; views
 *                                 that hit isTauri() will read false
 */

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);

export const isWeb = (): boolean => !isTauri();

export const isLite = (): boolean =>
  (import.meta as { env?: { VITE_BUILD_VARIANT?: string } }).env?.VITE_BUILD_VARIANT === "lite";

export const isCatalog = (): boolean =>
  (import.meta as { env?: { VITE_ENTRY?: string } }).env?.VITE_ENTRY === "catalog";

/** Useful for guarding sidecar invokes that would throw in browser. */
export function ifTauri<T>(run: () => T, fallback?: T): T | undefined {
  if (isTauri()) return run();
  return fallback;
}
