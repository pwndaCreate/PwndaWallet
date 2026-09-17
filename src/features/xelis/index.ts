/**
 * Public surface of the Xelis wallet feature. Cross-feature imports go through
 * this file (BOUNDARIES.md). Consumers: App.tsx, ViewRouter.tsx,
 * LandscapeRoot.tsx, DashboardView.tsx, WalletLandscapeView.tsx (types only),
 * WalletTxHistorySubview.tsx and useVault.ts.
 */
export {
  useXelisSession,
  XELIS_SYNC_POLL_MS,
  XELIS_READY_POLL_MS,
  type XelisSyncState,
  type XelisDownloadProgressPayload,
  type XelisSessionApi,
} from "./useXelisSession";
export { useXelisNodes, type XelisNodesApi } from "./useXelisNodes";
export { XelisNodesView } from "./XelisNodesView";
export { XelisImportPanel } from "./XelisImportPanel";
export { XelisSyncCard } from "./XelisSyncCard";
export { XelisTxHistoryCard } from "./XelisTxHistoryCard";
export {
  checkXelisSeed,
  describeXelisSeedProblem,
  xelisOfflineAddress,
  xelisWalletInfo,
  XELIS_SEED_CHECK_UNAVAILABLE,
  type XelisSeedVerdict,
  type XelisSeedProblem,
} from "./xelisSeed";
export {
  describeXelisSync,
  xelisTransferRow,
  type XelisSyncView,
  type XelisTransferRow,
} from "./xelisDisplay";
