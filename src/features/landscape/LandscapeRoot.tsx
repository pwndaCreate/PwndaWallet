import type { EngineOwnership } from "../../lib/swapSeedFingerprint";
import { getAdapter, type ChainType, type WalletInfo } from "../../wallets";
import type { ZphAssetBalance, ZphAssetType } from "../../wallets/zph-rpc";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import type { XmrTransfer } from "../../wallets/xmr-wallet";
import type { WalletKind } from "../../vault-schema";
import type { View } from "../../types/view";
import { LandscapeShell, type LandscapeTab } from "./LandscapeShell";
import { WalletLandscapeView } from "../wallet/WalletLandscapeView";
import { UnifiedPortfolioView } from "../wallet/UnifiedPortfolioView";
import type { Holding } from "../wallet/portfolio-aggregate";
import { WalletDetailsCard } from "../wallet/WalletDetailsCard";
import { MineLandscapeView } from "../mining/MineLandscapeView";
import type { MiningProjection } from "../../types/mining";
import { MiningSetupWizard } from "../mining/MiningSetupWizard";
import { enableMiningAndOpenSetup, openMinerSetup } from "../mining/minerSetupEntry";
import { ActivityView } from "../activity/ActivityView";
import { EarnConvertBody } from "../swap/EarnConvertBody";
import type { ConvertPipelineState } from "../swap/useConvertPipeline";
import type { ConversionRow } from "../swap/components/earn-ui";
import { ActivityLandscapeView } from "../activity/ActivityLandscapeView";
import { SwapLandscapeView } from "../swap/SwapLandscapeView";
import { MoneroNodesView } from "../monero/MoneroNodesView";
import { ZephyrNodesView } from "../zephyr/ZephyrNodesView";
import { ZanoNodesView } from "../zano/ZanoNodesView";
import { ZanoImportPanel } from "../zano/ZanoImportPanel";
import { ZanoSyncCard } from "../zano/ZanoSyncCard";
import { ZanoAssetsCard } from "../zano/ZanoAssetsCard";
import { ZanoTxHistoryCard } from "../zano/ZanoTxHistoryCard";
import type { ZanoAssetBalance, ZanoTransferEntry } from "../../wallets/zano-rpc";
import type { ZanoSyncState } from "../zano/useZanoSession";
import {
  XelisImportPanel,
  XelisNodesView,
  XelisSyncCard,
  XelisTxHistoryCard,
  type XelisNodesApi,
  type XelisSessionApi,
} from "../xelis";
import { SettingsLandscapeView } from "../settings/SettingsLandscapeView";
import { MinerSetupView } from "../mining/MinerSetupView";
import { ActiveSendModal } from "../send/SendModal";
import { ZephyrSwapModal } from "../zephyr/ZephyrSwapModal";
import { DeskSwapTrackerModal, type DeskTrackerState } from "../swap";
import { SidecarSwapTracker, type SidecarSwapState } from "../swap-sidecar";
import type { LayoutMode } from "./useLayout";
import type { ChainTx } from "../../wallets/types";

type SyncState =
  | "idle"
  | "starting"
  | "syncing"
  | "synced"
  | "connection-lost"
  | "error";

/**
 * Landscape-mode root. Mounts only when `layout === "landscape"` and
 * a wallet is loaded; otherwise App.tsx falls through to the portrait
 * shell. Composes the existing per-tab views (Wallet / Swap / Mine /
 * Activity / Settings + the Settings sub-views), the modals, and the
 * shared `<LandscapeShell>` (titlebar + sidebar).
 *
 * The prop list is intentionally large and explicit — App.tsx hooks
 * already produce all this state, and threading it through context
 * for landscape mode would be the "global state sludge" failure
 * mode the modularization plan calls out. See [[app-tsx-modularization]].
 */
export function LandscapeRoot(props: {
  /** Whose Grove engine is running — the engine is one sidecar bound to one
   *  seed, so after a wallet switch it is still the PREVIOUS wallet's.
   *  Forwarded to `SwapLandscapeView`; only `"foreign"` renders anything. */
  engineOwnership?: EngineOwnership;
  /** In-flight desk swaps, owned by the App shell so the tracker survives
   *  navigation during a 10-60 minute atomic swap. */
  deskTracker?: DeskTrackerState;
  /** In-flight BasicSwap P2P swaps — same lifetime reasoning as
   *  `deskTracker`, owned by App.tsx (`useSidecarSwap`) rather than this
   *  component, since a 30-90 minute swap must outlive `SwapLandscapeView`
   *  unmounting on any tab switch. Added 2026-08-22 alongside the rest of
   *  BasicSwap's landscape parity — see CONTRIBUTING.md's Landscape-First rule. */
  sidecarTracker?: SidecarSwapState;
  /** The shared convert pipeline (EARN tab / portrait CONVERT). */
  convertPipeline?: ConvertPipelineState;
  convertSeed?: {
    from: string;
    to: string;
    amount: string;
    router: "basicswap" | "intents" | "auto";
    nonce: number;
  } | null;
  onSidecarSwapAdopt?: (handle: never) => void;
  earnSourceBalance?: number | null;
  /** Wallet balance of any coin, for the Mine tab's "in wallet" line. */
  walletBalanceFor?: (coin: ChainType) => number | null;
  /**
   * Convert-route projection for the Mine tab's SIMPLE hero.
   *
   * Computed in App (where prices and the EARN target live) and passed
   * through, because `features/mining` may not import `features/swap`.
   */
  miningProjection?: MiningProjection | null;
  onSelectMineDisplayCoin?: (ticker: string) => void;
  /** Assets reachable from mining, for the Mine hero's dropdown. */
  mineReachableTickers?: readonly string[];
  /** Open the Swap tab with an asset pre-selected on AUTO. */
  onOpenSwapForAsset?: (ticker: string) => void;
  earnMiningState?: { active: boolean; hardware?: string | null; hashrate?: string | null };
  earnConversions?: readonly ConversionRow[];
  // ── Identity / layout ──
  view: View;
  setView: (v: View) => void;
  activeChain: ChainType;
  setActiveChain: (c: ChainType) => void;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  /** Only threaded through for `ZanoImportPanel`, which needs it directly
   *  (mirrors the prop it receives from portrait's `DashboardView`). The Zano
   *  wallet-tab content is BUILT here (from the shared Zano components) and
   *  passed to `WalletLandscapeView` via `zanoCenterSlot`, so it renders INLINE
   *  in that view's focal column like the monero/zephyr sections — no longer a
   *  detached footer. `WalletLandscapeView` has no wallet-mutation prop of its
   *  own, which is why the import panel is assembled here. */
  setWalletsByChain: React.Dispatch<
    React.SetStateAction<Partial<Record<ChainType, WalletInfo>>>
  >;
  /** Resolve a payout address for the given chain. Forwarded to the
   *  landscape Mine tab so it doesn't have to reach into the wallet
   *  state directly. */
  addressFor: (coin: ChainType) => string | null;
  wallet: WalletInfo | null;
  landscapeTab: LandscapeTab;
  setLandscapeTab: (t: LandscapeTab) => void;
  layout: LayoutMode;
  setLayout: (l: LayoutMode) => void;

  // ── Balances + USD prices ──
  balancesByChain: Partial<Record<ChainType, string>>;
  balancesLoading: boolean;
  pricesByTicker: Record<string, number>;
  priceHistoryByTicker: Record<string, number[]>;
  refreshAllBalances: () => Promise<void>;
  refreshPrices: () => Promise<void>;
  refreshBalance: () => void;
  refreshZphAssetBalances: () => Promise<void>;

  // ── XMR session ──
  xmrSeedLoaded: string | null;
  xmrSyncState: SyncState;
  xmrSyncPercent: number;
  xmrSyncWalletHeight: number;
  xmrSyncDaemonHeight: number;
  xmrSyncBlocksPerSec: number | null;
  xmrSyncEtaSeconds: number | null;
  xmrSyncError: string;
  xmrDefenderExcluded: boolean | null;
  xmrTxHistory: XmrTransfer[];
  xmrReceiveAddress: string | null;
  xmrShowPrimary: boolean;
  setXmrShowPrimary: (v: boolean) => void;
  refreshXmrReceive: () => Promise<unknown>;
  retryXmrSync: () => void;
  handleXmrAddDefenderExclusion: () => void;

  // ── ZPH session ──
  zphSeedLoaded: string | null;
  zphSyncState: SyncState;
  zphSyncPercent: number;
  zphSyncWalletHeight: number;
  zphSyncDaemonHeight: number;
  zphSyncBlocksPerSec: number | null;
  zphSyncEtaSeconds: number | null;
  zphSyncError: string;
  zphDefenderExcluded: boolean | null;
  zphAssetBalances: ZphAssetBalance[] | null;
  retryZphSync: () => void;
  handleZphAddDefenderExclusion: () => void;
  zphReserveInfo: {
    stats: ZphLiveStats | null;
    loading: boolean;
    error: string | null;
    fetchedAt: number | null;
  };

  // ── ZANO session ── (no percent/height/ETA — see useZanoSession's header
  // for why: no sync-progress RPC pair was verified against the real binary,
  // unlike XMR/ZPH's height-comparison poller)
  zanoSeedLoaded: string | null;
  zanoSyncState: ZanoSyncState;
  zanoSyncError: string;
  zanoBinaryReady: boolean | null;
  zanoDownloading: boolean;
  zanoDownloadProgress: { stage: string; percent: number; message: string } | null;
  zanoAssetBalances: ZanoAssetBalance[] | null;
  zanoTxHistory: ZanoTransferEntry[];
  zanoTxLoading: boolean;
  setZanoSeedLoaded: (v: string | null) => void;
  /** Resolves the saved entry's sidecar wallet file, or null when nothing was
   *  saved — `ZanoImportPanel` opens that file (2026-09-15). */
  saveZanoSeedToVault: (seed: string, passphrase: string) => Promise<string | null>;
  startZanoSync: (
    seed: string,
    masterPassword: string,
    passphrase?: string,
    walletFile?: string
  ) => void;
  retryZanoSync: () => void;
  handleZanoDownloadBinary: () => void;
  refreshZanoAssetBalances: () => Promise<void>;
  zanoNodes: Parameters<typeof ZanoNodesView>[0]["nodes"];
  openZanoNodesView: () => Promise<void>;

  // ── XELIS (2026-09-15): the whole useXelisSession return ──
  xelisSeedLoaded: string | null;
  setXelisSeedLoaded: (v: string | null) => void;
  /** Resolves the saved entry's wallet directory, or null when nothing was saved. */
  saveXelisSeedToVault: (seed: string) => Promise<string | null>;
  xelisSession: XelisSessionApi;
  xelisNodes: XelisNodesApi;
  openXelisNodesView: () => Promise<void>;
  showXelisSeed?: boolean;
  setShowXelisSeed?: (v: boolean) => void;

  // ── Tx history ──
  chainTxByKey: Record<string, ChainTx[]>;
  chainTxLoading: Record<string, boolean>;
  chainTxErrors: Record<string, string | null>;
  ownedChains: ChainType[];
  addressByChain: Record<string, string>;

  // ── Send modal ──
  sendTo: string;
  setSendTo: (v: string) => void;
  sendAmount: string;
  setSendAmount: (v: string) => void;
  sending: boolean;
  showSendModal: boolean;
  /** Optional Zephyr asset selector — sends ZSD/ZRS/ZYS instead of ZEPH. */
  openSendModal: (assetType?: string) => void;
  closeSendModal: () => void;
  /** `feeRate`: the Send modal's selected tier, per-(v)byte, for UTXO chains. */
  handleSend: (feeRate?: number) => Promise<void>;
  /** The Zephyr asset currently being sent (ZSD/ZRS/ZYS) or undefined. Drives
   *  the SendModal's asset label. */
  sendAssetType: string | undefined;

  // ── Zephyr swap modal ──
  showZphSwapModal: boolean;
  setShowZphSwapModal: (v: boolean) => void;
  zphSwapInitialSource: ZphAssetType | undefined;
  setZphSwapInitialSource: (v: ZphAssetType | undefined) => void;

  // ── Wallet-details sub-view ──
  sharedMnemonic: string;
  showMnemonic: boolean;
  setShowMnemonic: (v: boolean) => void;
  showPrivateKey: boolean;
  setShowPrivateKey: (v: boolean) => void;
  showXmrSeed: boolean;
  setShowXmrSeed: (v: boolean) => void;
  showZphSeed: boolean;
  zanoSeedPassphrase?: string | null;
  showZanoSeed?: boolean;
  setShowZanoSeed?: (v: boolean) => void;
  setShowZphSeed: (v: boolean) => void;

  // ── Vault helpers ──
  handleLogout: () => void;
  // ── Multi-wallet CRUD (Phase 2) — Settings ▸ Wallets ──
  addWallet: (
    kind: WalletKind,
    input: string,
    name: string,
    chain?: ChainType
  ) => Promise<boolean>;
  renameWallet: (id: string, name: string) => Promise<void>;
  removeWallet: (id: string) => Promise<void>;
  walletOpBusy: boolean;
  // ── Wallet switching (Phase 3) — rail switcher ──
  switchWallet: (id: string) => Promise<void>;
  // ── Unified portfolio (Phase 4) ──
  unifiedHoldings: Holding[];
  showUnifiedPortfolio: boolean;
  /** Live derivation choice from the unlocked vault — drives the SOL
   *  derivation switcher panel in the Wallet Details view. */
  currentSolanaDerivationChoice?: string;
  /** Save+re-derive callback when the user picks an alternative SOL path. */
  handleChangeSolanaDerivation?: (newChoice: string) => Promise<void>;
  /** Live cardano derivation choice — drives the ADA derivation panel. */
  currentCardanoDerivationChoice?: string;
  /** Save+re-derive callback when the user picks an alternative ADA derivation. */
  handleChangeCardanoDerivation?: (newChoice: string) => Promise<void>;
  /** Live algorand derivation choice — drives the ALGO derivation panel. */
  currentAlgorandDerivationChoice?: string;
  /** Save+re-derive callback when the user picks an alternative ALGO derivation. */
  handleChangeAlgorandDerivation?: (newChoice: string) => Promise<void>;
  /** Live litecoin derivation choice — drives the LTC derivation panel
   *  (Exodus legacy L… vs default ltc1q…). */
  currentLitecoinDerivationChoice?: string;
  /** Save+re-derive callback when the user picks an alternative LTC derivation. */
  handleChangeLitecoinDerivation?: (newChoice: string) => Promise<void>;
  /** Save+re-derive callback for the secp256k1 profile coins (XRP/TRX/RVN/DASH). */
  handleChangeCoinDerivation?: (
    coin: "xrp" | "tron" | "ravencoin" | "dash",
    path: string
  ) => Promise<void>;
  /** Apply a whole derivation profile across every coin at once. */
  handleApplyProfile?: (profile: "standard" | "exodus" | "atomic") => Promise<void>;

  // ── Misc ──
  miner: {
    checkMinerStatus: () => void;
    [k: string]: unknown;
  } & Record<string, unknown>;
  /** Mining opt-in gate. `false` → the Mine rail + miner-setup render the
   *  `MiningSetupWizard` instead of the live mining views (pure-wallet
   *  cutover). See `miningOptIn.ts`. */
  miningOptedIn: boolean;
  /** Persist the mining opt-in flag (called by the wizard). */
  onEnableMining: () => Promise<void>;
  /** Opt-out: stop any live session, clear the flag, return to dormant. */
  onDisableMining: () => Promise<void>;
  xmrNodes: Parameters<typeof MoneroNodesView>[0]["nodes"];
  zphNodes: Parameters<typeof ZephyrNodesView>[0]["nodes"];
  copyToClipboard: (text: string, key?: string) => void;
  /** The app-wide error / success lines (`useSend`'s "Transaction failed: …"
   *  and "Transaction sent! Hash: …", balance-refresh failures, swap toasts).
   *  Portrait renders them under its header; landscape rendered NEITHER until
   *  2026-09-12, so a failed send left the modal open with no message. */
  error?: string;
  success?: string;
  setSuccess?: (msg: string) => void;
  setError: (msg: string) => void;
  openMoneroNodesView: () => Promise<void>;
  openZephyrNodesView: () => Promise<void>;
  handleMinimize: () => void;
  handleClose: () => void;

  /** Session vault password — passed through to `MineLandscapeView`. */
  sessionPassword: string | null;

  /** Seed-import panel for an independent-seed chain (XMR/ZPH) that the user
   *  hasn't set up yet. Built by App.tsx, which already holds the panel's data
   *  props for portrait; forwarded verbatim to `WalletLandscapeView`. */
  importPanelSlot?: React.ReactNode;

  /** Scan-date editor for Monero/Zephyr, built by App. */
  scanDateSlot?: React.ReactNode;
}) {
  const {
    deskTracker,
    sidecarTracker,
    convertPipeline,
    convertSeed,
    onSidecarSwapAdopt,
    earnSourceBalance = null,
    walletBalanceFor,
    miningProjection = null,
    onSelectMineDisplayCoin,
    mineReachableTickers,
  onOpenSwapForAsset,
    earnMiningState = { active: false },
    earnConversions = [],
    view,
    setView,
    activeChain,
    setActiveChain,
    walletsByChain,
    setWalletsByChain,
    addressFor,
    wallet,
    landscapeTab,
    setLandscapeTab,
    layout,
    setLayout,
    balancesByChain,
    balancesLoading,
    pricesByTicker,
    priceHistoryByTicker,
    refreshAllBalances,
    refreshPrices,
    refreshBalance,
    refreshZphAssetBalances,
    xmrSeedLoaded,
    xmrSyncState,
    xmrSyncPercent,
    xmrSyncWalletHeight,
    xmrSyncDaemonHeight,
    xmrSyncBlocksPerSec,
    xmrSyncEtaSeconds,
    xmrSyncError,
    xmrDefenderExcluded,
    xmrTxHistory,
    xmrReceiveAddress,
    xmrShowPrimary,
    setXmrShowPrimary,
    refreshXmrReceive,
    retryXmrSync,
    handleXmrAddDefenderExclusion,
    zphSeedLoaded,
    zphSyncState,
    zphSyncPercent,
    zphSyncWalletHeight,
    zphSyncDaemonHeight,
    zphSyncBlocksPerSec,
    zphSyncEtaSeconds,
    zphSyncError,
    zphDefenderExcluded,
    zphAssetBalances,
    retryZphSync,
    handleZphAddDefenderExclusion,
    zphReserveInfo,
    zanoSeedLoaded,
    zanoSyncState,
    zanoSyncError,
    zanoBinaryReady,
    zanoDownloading,
    zanoDownloadProgress,
    zanoAssetBalances,
    zanoTxHistory,
    zanoTxLoading,
    setZanoSeedLoaded,
    saveZanoSeedToVault,
    startZanoSync,
    retryZanoSync,
    handleZanoDownloadBinary,
    zanoNodes,
    openZanoNodesView,
    xelisSeedLoaded,
    setXelisSeedLoaded,
    saveXelisSeedToVault,
    xelisSession,
    xelisNodes,
    openXelisNodesView,
    showXelisSeed,
    setShowXelisSeed,
    chainTxByKey,
    chainTxLoading,
    chainTxErrors,
    ownedChains,
    addressByChain,
    sendTo,
    setSendTo,
    sendAmount,
    setSendAmount,
    sending,
    showSendModal,
    openSendModal,
    closeSendModal,
    handleSend,
    sendAssetType,
    showZphSwapModal,
    setShowZphSwapModal,
    zphSwapInitialSource,
    setZphSwapInitialSource,
    sharedMnemonic,
    showMnemonic,
    setShowMnemonic,
    showPrivateKey,
    setShowPrivateKey,
    showXmrSeed,
    setShowXmrSeed,
    showZphSeed,
    zanoSeedPassphrase,
    showZanoSeed,
    setShowZanoSeed,
    setShowZphSeed,
    handleLogout,
    addWallet,
    renameWallet,
    removeWallet,
    walletOpBusy,
    switchWallet,
    unifiedHoldings,
    showUnifiedPortfolio,
    currentSolanaDerivationChoice,
    handleChangeSolanaDerivation,
    currentCardanoDerivationChoice,
    handleChangeCardanoDerivation,
    currentAlgorandDerivationChoice,
    handleChangeAlgorandDerivation,
    currentLitecoinDerivationChoice,
    handleChangeLitecoinDerivation,
    handleChangeCoinDerivation,
    handleApplyProfile,
    miner,
    miningOptedIn,
    onEnableMining,
    onDisableMining,
    xmrNodes,
    zphNodes,
    copyToClipboard,
    error = "",
    success = "",
    setSuccess,
    setError,
    openMoneroNodesView,
    openZephyrNodesView,
    handleMinimize,
    handleClose,
    sessionPassword,
    importPanelSlot,
    scanDateSlot,
  } = props;

  // Determine sync state for the titlebar (prefer XMR if loaded)
  const sharedSyncState = xmrSeedLoaded ? xmrSyncState : "idle";
  const sharedSyncPercent = xmrSeedLoaded ? xmrSyncPercent : 0;

  return (
    <LandscapeShell
      tab={landscapeTab}
      setTab={setLandscapeTab}
      syncState={sharedSyncState}
      syncPercent={sharedSyncPercent}
      onLock={handleLogout}
      onSwitchWallet={switchWallet}
      handleMinimize={handleMinimize}
      handleClose={handleClose}
    >
      {landscapeTab === "wallet" && showUnifiedPortfolio && (
        <UnifiedPortfolioView
          holdings={unifiedHoldings}
          pricesByTicker={pricesByTicker}
          onOpenWallet={switchWallet}
        />
      )}
      {landscapeTab === "wallet" && !showUnifiedPortfolio && (
        <WalletLandscapeView
          onOpenSwapForAsset={onOpenSwapForAsset}
          importPanelSlot={importPanelSlot}
          walletsByChain={walletsByChain}
          activeChain={activeChain}
          setActiveChain={setActiveChain}
          balancesByChain={balancesByChain}
          balancesLoading={balancesLoading}
          onRefreshBalances={async () => {
            await Promise.all([refreshAllBalances(), refreshPrices()]);
          }}
          pricesByTicker={pricesByTicker}
          priceHistoryByTicker={priceHistoryByTicker}
          xmrTxHistory={xmrTxHistory}
          xmrSession={
            xmrSeedLoaded
              ? {
                  syncState: xmrSyncState,
                  syncPercent: xmrSyncPercent,
                  walletHeight: xmrSyncWalletHeight,
                  daemonHeight: xmrSyncDaemonHeight,
                  blocksPerSec: xmrSyncBlocksPerSec,
                  etaSeconds: xmrSyncEtaSeconds,
                  syncError: xmrSyncError,
                  defenderExcluded: xmrDefenderExcluded,
                  receiveAddress: xmrReceiveAddress,
                  showPrimary: xmrShowPrimary,
                  setShowPrimary: setXmrShowPrimary,
                  onNewSubaddress: async () => {
                    try {
                      await refreshXmrReceive();
                    } catch (e: any) {
                      setError(
                        "Could not generate new subaddress: " +
                          (e?.message ?? e)
                      );
                    }
                  },
                  onRetry: retryXmrSync,
                  onManageNodes: openMoneroNodesView,
                  onAddDefenderExclusion: handleXmrAddDefenderExclusion,
                }
              : null
          }
          zphSession={
            zphSeedLoaded
              ? {
                  syncState: zphSyncState,
                  syncPercent: zphSyncPercent,
                  walletHeight: zphSyncWalletHeight,
                  daemonHeight: zphSyncDaemonHeight,
                  blocksPerSec: zphSyncBlocksPerSec,
                  etaSeconds: zphSyncEtaSeconds,
                  syncError: zphSyncError,
                  defenderExcluded: zphDefenderExcluded,
                  assetBalances: zphAssetBalances,
                  onOpenSwap: (source) => {
                    setZphSwapInitialSource(source);
                    setShowZphSwapModal(true);
                  },
                  reserveStats: zphReserveInfo.stats,
                  reserveLoading: zphReserveInfo.loading,
                  reserveError: zphReserveInfo.error,
                  reserveFetchedAt: zphReserveInfo.fetchedAt,
                  onRetry: retryZphSync,
                  onManageNodes: openZephyrNodesView,
                  onAddDefenderExclusion: handleZphAddDefenderExclusion,
                }
              : null
          }
          onSend={openSendModal}
          chainTxByKey={chainTxByKey}
          addressByChain={addressByChain}
          sharedMnemonic={sharedMnemonic}
          currentSolanaDerivationChoice={currentSolanaDerivationChoice}
          onChangeSolanaDerivation={handleChangeSolanaDerivation}
          currentCardanoDerivationChoice={currentCardanoDerivationChoice}
          onChangeCardanoDerivation={handleChangeCardanoDerivation}
          currentAlgorandDerivationChoice={currentAlgorandDerivationChoice}
          onChangeAlgorandDerivation={handleChangeAlgorandDerivation}
          currentLitecoinDerivationChoice={currentLitecoinDerivationChoice}
          onChangeLitecoinDerivation={handleChangeLitecoinDerivation}
          onCopy={copyToClipboard}
          zanoCenterSlot={
            !walletsByChain.zano ? (
              <ZanoImportPanel
                sessionPassword={sessionPassword}
                setError={setError}
                setWalletsByChain={setWalletsByChain}
                setZanoSeedLoaded={setZanoSeedLoaded}
                saveZanoSeedToVault={saveZanoSeedToVault}
                startZanoSync={startZanoSync}
              />
            ) : (
              <>
                {zanoSyncState !== "idle" && zanoSyncState !== "ready" && (
                  <ZanoSyncCard
                    syncState={zanoSyncState}
                    syncError={zanoSyncError}
                    binaryReady={zanoBinaryReady}
                    downloading={zanoDownloading}
                    downloadProgress={zanoDownloadProgress}
                    accentColor="#0e0e10"
                    onDownloadBinary={handleZanoDownloadBinary}
                    onRetry={retryZanoSync}
                  />
                )}
                <ZanoAssetsCard assetBalances={zanoAssetBalances} />
                {/* Zano's ONLY history surface in landscape since 2026-09-16
                    (WalletLandscapeView no longer adds the generic "Recent"
                    list for it — `historySurfaceFor`). So it renders whenever
                    a wallet exists, idle included: the card says "will appear
                    once the wallet connects" itself, and an idle gate here
                    would leave an idle wallet with no history surface at all. */}
                <ZanoTxHistoryCard
                  syncState={zanoSyncState}
                  txHistory={zanoTxHistory}
                  txLoading={zanoTxLoading}
                  onCopy={copyToClipboard}
                />
              </>
            )
          }
          // `zanoConnected` removed 2026-09-16: it fed only the Recent block's
          // Zano empty-copy, and that block no longer renders for Zano.
          xelisSynced={xelisSession.syncState === "synced"}
          // Zano's Send gate (2026-09-16); portrait reads the same state.
          zanoReady={zanoSyncState === "ready"}
          // Xelis, built from the shared Xelis components exactly like Zano's
          // slot above: the import panel with no Xelis wallet, sync + history
          // with one. WalletLandscapeView renders it in BOTH branches.
          xelisCenterSlot={
            !walletsByChain.xelis ? (
              <XelisImportPanel
                sessionPassword={sessionPassword}
                setError={setError}
                setWalletsByChain={setWalletsByChain}
                setXelisSeedLoaded={setXelisSeedLoaded}
                saveXelisSeedToVault={saveXelisSeedToVault}
                startXelisSync={xelisSession.start}
              />
            ) : (
              <>
                {xelisSession.syncState !== "idle" && (
                  <XelisSyncCard
                    syncState={xelisSession.syncState}
                    syncError={xelisSession.syncError}
                    syncStatus={xelisSession.syncStatus}
                    syncStatusError={xelisSession.syncStatusError}
                    balance={xelisSession.balance}
                    balanceError={xelisSession.balanceError}
                    binaryReady={xelisSession.binaryReady}
                    downloading={xelisSession.downloading}
                    downloadProgress={xelisSession.downloadProgress}
                    accentColor={getAdapter("xelis").color}
                    onDownloadBinary={() => void xelisSession.downloadBinary()}
                    onRetry={xelisSession.retry}
                  />
                )}
                {/* Every state, as portrait's WalletTxHistorySubview does: the
                    card says "appears once the wallet connects" while the
                    session is down, and with the generic "Recent" list gone
                    for Xelis (2026-09-16) an idle gate here would leave the
                    wallet with no history surface at all. */}
                <XelisTxHistoryCard
                  syncState={xelisSession.syncState}
                  txHistory={xelisSession.txHistory}
                  txLoading={xelisSession.txLoading}
                  txError={xelisSession.txError}
                  onCopy={copyToClipboard}
                />
              </>
            )
          }
        />
      )}

      {landscapeTab === "swap" && (
        <SwapLandscapeView
          engineOwnership={props.engineOwnership}
          onDeskSwapAccepted={deskTracker?.adopt}
          onSidecarSwapAccepted={
            (onSidecarSwapAdopt as never) ?? sidecarTracker?.adopt
          }
          convertSeed={convertSeed}
          sidecarActiveSwaps={sidecarTracker?.swaps ?? []}
          onOpenSidecarTracker={sidecarTracker?.openTracker}
          walletsByChain={walletsByChain}
          balancesByChain={balancesByChain}
          pricesByTicker={pricesByTicker}
          zphAssetBalances={zphAssetBalances}
          onOpenZephyrSwapModal={(initialSource) => {
            setZphSwapInitialSource(initialSource);
            setShowZphSwapModal(true);
          }}
          onSwapToast={(msg) => {
            setError(msg);
            window.setTimeout(() => setError(""), 2400);
          }}
        />
      )}
      {landscapeTab === "mine" && (
        miningOptedIn ? (
          <MineLandscapeView
            miner={miner as any}
            addressFor={addressFor}
            pricesByTicker={pricesByTicker}
            projection={miningProjection}
            onSelectDisplayCoin={onSelectMineDisplayCoin}
            reachableTickers={mineReachableTickers}
            minedAmount={earnSourceBalance}
            walletBalanceFor={walletBalanceFor}
            // Navigates to the EARN tab, carrying nothing: the pipeline
            // already knows its target, and the Mine tab's display coin is
            // the DEFAULT for that target rather than an override of it.
            onOpenEarn={() => setLandscapeTab("earn")}
            conversionRunning={
              convertPipeline?.stage === "hop1-running" ||
              convertPipeline?.stage === "hop2-running"
            }
            // "► Set up miners" on a blocked START. Same shared handler as
            // portrait's; only the navigation is landscape's (Miner Setup is
            // a Settings sub-view here).
            onSetup={() =>
              openMinerSetup({
                checkMinerStatus: miner.checkMinerStatus,
                showMinerSetup: () => {
                  setLandscapeTab("settings");
                  setView("miner-setup");
                },
              })
            }
          />
        ) : (
          <MiningSetupWizard
            // Land on MinerSetupView (download / Defender / device profile)
            // with a fresh miner-status read — the shared handler portrait
            // uses too. In landscape that sub-view lives under the settings tab.
            onSetUp={() =>
              enableMiningAndOpenSetup({
                enableMining: onEnableMining,
                checkMinerStatus: miner.checkMinerStatus,
                showMinerSetup: () => {
                  setLandscapeTab("settings");
                  setView("miner-setup");
                },
              })
            }
            onDismiss={() => setLandscapeTab("wallet")}
          />
        )
      )}
      {/* EARN — the convert pipeline (canvas frame 1d). The body is shared
          with portrait's CONVERT segment; only the arrangement differs. */}
      {landscapeTab === "earn" && convertPipeline && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
          <EarnConvertBody
            variant="landscape"
            pipeline={convertPipeline}
            sourceBalance={earnSourceBalance}
            pricesByTicker={pricesByTicker}
            mining={earnMiningState}
            conversions={earnConversions}
          />
        </div>
      )}
      {landscapeTab === "activity" && (
        <ActivityLandscapeView
          txByChain={chainTxByKey}
          loading={chainTxLoading}
          errors={chainTxErrors}
          chainsOwned={ownedChains}
          addressByChain={addressByChain}
          pricesByTicker={pricesByTicker}
          zphStats={zphReserveInfo.stats}
        />
      )}
      {/* Keep the import live so future paths (e.g. a portrait sheet
          mounted inside landscape) still have access to the legacy
          table view without re-adding the import. */}
      {false && (
        <ActivityView
          txByChain={chainTxByKey}
          loading={chainTxLoading}
          errors={chainTxErrors}
          chainsOwned={ownedChains}
          addressByChain={addressByChain}
        />
      )}
      {landscapeTab === "settings" && view === "monero-nodes" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
          <MoneroNodesView nodes={xmrNodes} onBack={() => setView("dashboard")} />
        </div>
      )}
      {landscapeTab === "settings" && view === "zephyr-nodes" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
          <ZephyrNodesView nodes={zphNodes} onBack={() => setView("dashboard")} />
        </div>
      )}
      {landscapeTab === "settings" && view === "zano-nodes" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
          <ZanoNodesView nodes={zanoNodes} onBack={() => setView("dashboard")} />
        </div>
      )}
      {landscapeTab === "settings" && view === "xelis-nodes" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
          <XelisNodesView nodes={xelisNodes} onBack={() => setView("dashboard")} />
        </div>
      )}
      {landscapeTab === "settings" &&
        view !== "monero-nodes" &&
        view !== "zephyr-nodes" &&
        view !== "zano-nodes" &&
        view !== "xelis-nodes" &&
        view !== "wallet-details" &&
        view !== "miner-setup" && (
          <SettingsLandscapeView
            scanDateSlot={scanDateSlot}
            onLock={handleLogout}
            onOpenP2P={() => setLandscapeTab("swap")}
            layout={layout}
            setLayout={setLayout}
            xmrSeedLoaded={xmrSeedLoaded}
            zphSeedLoaded={zphSeedLoaded}
            zanoSeedLoaded={zanoSeedLoaded}
            xelisSeedLoaded={xelisSeedLoaded}
            onOpenMoneroNodes={openMoneroNodesView}
            onOpenZephyrNodes={openZephyrNodesView}
            onOpenZanoNodes={openZanoNodesView}
            onOpenXelisNodes={openXelisNodesView}
            onOpenMinerSetup={() => {
              (miner as any).checkMinerStatus();
              setView("miner-setup");
            }}
            onOpenWalletDetails={() => setView("wallet-details")}
            onAddWallet={addWallet}
            onRenameWallet={renameWallet}
            onRemoveWallet={removeWallet}
            walletOpBusy={walletOpBusy}
          />
        )}
      {/* Sub-views reachable from the landscape Settings tab — render the
          same components portrait uses. The landscape sync effect routes
          the user back to settings when they navigate away from these. */}
      {landscapeTab === "settings" && view === "miner-setup" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
          {miningOptedIn ? (
            <MinerSetupView
              miner={miner as any}
              // Portrait passes these; without them the device profile's
              // per-coin $/day had no prices in landscape (parity audit,
              // 2026-09-16).
              pricesByTicker={pricesByTicker}
              onBack={() => setView("settings")}
              onDisableMining={onDisableMining}
            />
          ) : (
            <MiningSetupWizard
              onSetUp={() =>
                enableMiningAndOpenSetup({
                  enableMining: onEnableMining,
                  checkMinerStatus: miner.checkMinerStatus,
                  // Already on Settings ▸ Miner Setup; this keeps it there.
                  showMinerSetup: () => setView("miner-setup"),
                })
              }
              onDismiss={() => setView("settings")}
            />
          )}
        </div>
      )}
      {landscapeTab === "settings" && view === "wallet-details" && wallet && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
          <WalletDetailsCard
            wallet={wallet}
            sharedMnemonic={sharedMnemonic}
            showMnemonic={showMnemonic}
            setShowMnemonic={setShowMnemonic}
            showPrivateKey={showPrivateKey}
            setShowPrivateKey={setShowPrivateKey}
            xmrSeedLoaded={xmrSeedLoaded}
            showXmrSeed={showXmrSeed}
            setShowXmrSeed={setShowXmrSeed}
            zphSeedLoaded={zphSeedLoaded}
            showZphSeed={showZphSeed}
            zanoSeedLoaded={zanoSeedLoaded}
            zanoSeedPassphrase={zanoSeedPassphrase}
            showZanoSeed={showZanoSeed}
            setShowZanoSeed={setShowZanoSeed}
            xelisSeedLoaded={xelisSeedLoaded}
            showXelisSeed={showXelisSeed}
            setShowXelisSeed={setShowXelisSeed}
            setShowZphSeed={setShowZphSeed}
            currentSolanaDerivationChoice={currentSolanaDerivationChoice}
            onChangeSolanaDerivation={handleChangeSolanaDerivation}
            currentLitecoinDerivationChoice={currentLitecoinDerivationChoice}
            onChangeLitecoinDerivation={handleChangeLitecoinDerivation}
            onChangeCoinDerivation={handleChangeCoinDerivation}
            onApplyProfile={handleApplyProfile}
            onCopy={copyToClipboard}
            onBack={() => setView("settings")}
          />
        </div>
      )}

      {/* App-wide error / success lines. Fixed and above `.modal-overlay`
          (z-index 2000) because the send that fails does so with its modal
          still open — rendering in flow behind the backdrop would repeat the
          2026-09-12 "Send does nothing" report. */}
      {(error || success) && (
        <div
          data-landscape-alerts
          style={{
            position: "fixed",
            top: 44,
            left: "50%",
            transform: "translateX(-50%)",
            width: "min(640px, calc(100vw - 32px))",
            zIndex: 2100,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {error && (
            <div
              className="alert alert-error"
              role="alert"
              style={{ margin: 0, display: "flex", gap: 10, alignItems: "flex-start" }}
            >
              <span style={{ flex: 1 }}>{error}</span>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setError("")}
                style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", fontFamily: "var(--mono)" }}
              >
                ×
              </button>
            </div>
          )}
          {success && (
            <div
              className="alert alert-success"
              role="status"
              style={{ margin: 0, display: "flex", gap: 10, alignItems: "flex-start" }}
            >
              <span style={{ flex: 1 }}>{success}</span>
              {setSuccess && (
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setSuccess("")}
                  style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", fontFamily: "var(--mono)" }}
                >
                  ×
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Modals still rendered on top */}
      {showSendModal && walletsByChain[activeChain] && (
        // The same wrapper portrait mounts (2026-09-15): the asset label, and
        // the price of a fee charged in a Zephyr ecosystem asset, derive from
        // the send-asset store `useSend` sends with. The `sendAssetType` prop
        // is that same value; the wrapper reads it at the source.
        <ActiveSendModal
          adapter={getAdapter(activeChain)}
          usdPrice={pricesByTicker[getAdapter(activeChain).ticker.toUpperCase()]}
          zphStats={zphReserveInfo.stats}
          fromAddress={walletsByChain[activeChain]?.address}
          sendTo={sendTo}
          setSendTo={setSendTo}
          sendAmount={sendAmount}
          setSendAmount={setSendAmount}
          sending={sending}
          onSend={handleSend}
          onClose={closeSendModal}
        />
      )}

      {showZphSwapModal && walletsByChain.zephyr && activeChain === "zephyr" && (
        <ZephyrSwapModal
          walletAddress={walletsByChain.zephyr.address}
          assetBalances={zphAssetBalances}
          liveStats={zphReserveInfo.stats}
          initialSourceAsset={zphSwapInitialSource}
          onClose={() => {
            setShowZphSwapModal(false);
            setZphSwapInitialSource(undefined);
          }}
          onSuccess={() => {
            refreshBalance();
            void refreshZphAssetBalances();
          }}
        />
      )}

      {/* Desk swap tracker - mounted outside every landscapeTab conditional so
          a 10-60 minute atomic swap survives sidebar navigation. Mirror of the
          ViewRouter hoist; both must stay in lockstep or landscape users lose
          the tracker the moment they change tabs. */}
      {deskTracker?.trackedSwap && (
        <DeskSwapTrackerModal
          open={deskTracker.trackerOpen}
          summary={deskTracker.trackedSwap}
          onClose={deskTracker.closeTracker}
          onTerminal={() => deskTracker.refresh()}
        />
      )}
      {/* Mirror of the desk tracker mount immediately above, same reasoning:
          a 30-90 minute BasicSwap P2P swap survives sidebar navigation.
          `SidecarSwapTracker` self-gates on `state.trackerOpen && state.tracked`
          (see its own signature), so unlike DeskSwapTrackerModal this is a
          single prop, not four. */}
      {sidecarTracker && <SidecarSwapTracker state={sidecarTracker} />}
    </LandscapeShell>
  );
}
