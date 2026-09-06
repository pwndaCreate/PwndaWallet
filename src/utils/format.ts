/**
 * Cross-feature pure formatters.
 *
 * These were copy-pasted byte-for-byte across the wallet and activity
 * view files (DashboardView / WalletLandscapeView / AccountCard and
 * ActivityViewPortrait / ActivityLandscapeView / ActivityView). Hoisting
 * them here means a future formatting fix lands once instead of being
 * re-applied per call site.
 *
 * Keep this file PURE — no React, no component state, no Tauri runtime.
 * The Tauri-opener wrapper lives in `./openExternal.ts` because it has a
 * runtime dependency on the invoke shim.
 */

/**
 * Human-readable "time ago" label from a Unix-seconds timestamp.
 * Returns "—" when the timestamp is missing/zero.
 *
 * Extracted 2026-06-16 from the byte-identical copies in
 * `WalletLandscapeView.tsx`, `ActivityLandscapeView.tsx`, and
 * `ActivityViewPortrait.tsx` (the last named its param `timestamp`;
 * the body was otherwise identical — callers pass positionally so the
 * rename is invisible).
 */
export function fmtRelative(ts?: number): string {
  if (!ts) return "—";
  const ms = Date.now() - ts * 1000;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 604_800_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return `${Math.round(ms / 604_800_000)}w ago`;
}
