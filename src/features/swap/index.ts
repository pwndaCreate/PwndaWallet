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
  // So Activity's swap list follows background writes too (2026-10-01): a
  // P2P swap's status is written by the tracker's poll, not by anything the
  // user does on the Activity tab.
  onSwapHistoryChange,
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
// How a row's status reads in a list: "not sent" for a deposit that never
// reached its chain (2026-10-01).
export { swapStatusLabel } from "./swap-details";

// The swap details modal and the row props that open it (2026-09-30). The
// Activity SWAPS lists open the same modal as the Swap tab's RECENT SWAPS: one
// component for all four lists, never an Activity copy of it.
export {
  SwapDetailsModal,
  SWAP_ROW_OPEN_STYLE,
  swapRowOpenProps,
} from "./SwapDetailsModal";
// Unfinished NEAR Intents swaps are re-tracked at app start (2026-09-30),
// not only once the Swap tab mounts.
export { resumePendingIntentsSwapsOnce } from "./intents-status-resume";

// Desk tracker: owns in-flight desk swaps + their history projection. Routed
// through the barrel so the App shell (and, later, the activity feature) can
// read it without a BOUNDARIES.md amendment.
export { useDeskTracker, type DeskTrackerState } from "./useDeskTracker";
export { DeskSwapTrackerModal } from "./DeskSwapTrackerModal";

// Peer-to-peer (BasicSwap) swaps in history (operator request, 2026-10-01).
// `p2pSwapHistory` is the sink App.tsx hands to `useSidecarSwap`: the tracker
// reports, and the writing happens here, in the swap folder, like the desk's.
// The status mapping sits beside `deskStateToHistoryStatus` in spirit.
export {
  p2pSwapHistory,
  p2pBidStateToHistoryStatus,
  P2P_HISTORY_PROVIDER,
} from "./p2p-history";

// The swap registry, read-only, so the wallet can tell whether ANY router
// carries a ticker before it enables a Swap button (`wallet/wallet-surface.ts`,
// `hasSwapVenue`, 2026-09-16). Exported here rather than imported from
// `asset-capabilities.ts` directly, because that file is private to this
// folder. Consumers read it; only this folder may change what it says.
export { ASSET_CAPABILITIES } from "./asset-capabilities";
