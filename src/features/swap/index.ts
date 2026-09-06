/**
 * Swap feature public surface.
 *
 * Other features (currently: `activity` for the unified history view)
 * may import from this barrel. The internal modules of `swap/` (form
 * components, quote hooks, executors, confirm modal) remain private
 * to the feature folder per the BOUNDARIES.md contract — re-export
 * only what crosses feature boundaries.
 *
 * Created 2026-05-26 to unblock the unified cross-chain swap history
 * view in `src/features/activity/ActivityView.tsx`. Before this,
 * `swap-history-store` was private to the swap folder and the
 * Activity tab showed "Swap history isn't tracked separately yet".
 */

export {
  loadSwapHistory,
  computeDriftFraction,
  driftTone,
  formatDriftPercent,
  // Exposed for the desk tracker's 8.1 -> history projection. The writers
  // (appendSwapHistory / updateSwapHistoryEntry / upsertSwapHistoryEntry /
  // newSwapId) stay PRIVATE to the swap folder — history is written from here
  // only, never from a consuming feature.
  deskStateToHistoryStatus,
  type SwapHistoryEntry,
  type SwapHistoryStatus,
} from "./swap-history-store";
export { formatActualReceived } from "./swap-actual-received";

// Desk tracker: owns in-flight desk swaps + their history projection. Routed
// through the barrel so the App shell (and, later, the activity feature) can
// read it without a BOUNDARIES.md amendment.
export { useDeskTracker, type DeskTrackerState } from "./useDeskTracker";
export { DeskSwapTrackerModal } from "./DeskSwapTrackerModal";
