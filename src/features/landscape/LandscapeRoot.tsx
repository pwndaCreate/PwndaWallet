import type { EngineOwnership } from "../../lib/swapSeedFingerprint";
import { getAdapter, type ChainType, type WalletInfo } from "../../wallets";
import type { ZphAssetBalance, ZphAssetType } from "../../wallets/zph-rpc";
import { ZPH_UI_TICKER } from "../../wallets/zph-rpc";
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
import { SettingsLandscapeView } from "../settings/SettingsLandscapeView";
import { MinerSetupView } from "../mining/MinerSetupView";
import { SendModal } from "../send/SendModal";
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
  saveZanoSeedToVault: (seed: string, passphrase: string) => Promise<void>;
  startZanoSync: (seed: string, masterPassword: string, passphrase?: string) => void;
  retryZanoSync: () => void;
  handleZanoDownloadBinary: () => void;
  refreshZanoAssetBalances: () => Promise<void>;
  zanoNodes: Parameters<typeof ZanoNodesView>[0]["nodes"];
  openZanoNodesView: () => Promise<void>;

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
  handleSend: () => Promise<void>;
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
                {zanoSyncState !== "idle" && (
                  <ZanoTxHistoryCard
                    syncState={zanoSyncState}
                    txHistory={zanoTxHistory}
                    txLoading={zanoTxLoading}
                    onCopy={copyToClipboard}
                  />
                )}
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
            // Navigates to the EARN tab, carrying nothing: the pipeline
            // already knows its target, and the Mine tab's display coin is
            // the DEFAULT for that target rather than an override of it.
            onOpenEarn={() => setLandscapeTab("earn")}
            conversionRunning={
              convertPipeline?.stage === "hop1-running" ||
              convertPipeline?.stage === "hop2-running"
            }
          />
        ) : (
          <MiningSetupWizard
            onSetUp={async () => {
              await onEnableMining();
              // Land on MinerSetupView (download / Defender / device profile).
              // In landscape that sub-view lives under the settings tab.
              (miner as any).checkMinerStatus?.();
              setLandscapeTab("settings");
              setView("miner-setup");
            }}
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
      {landscapeTab === "settings" &&
        view !== "monero-nodes" &&
        view !== "zephyr-nodes" &&
        view !== "zano-nodes" &&
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
            onOpenMoneroNodes={openMoneroNodesView}
            onOpenZephyrNodes={openZephyrNodesView}
            onOpenZanoNodes={openZanoNodesView}
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
              onBack={() => setView("settings")}
              onDisableMining={onDisableMining}
            />
          ) : (
            <MiningSetupWizard
              onSetUp={async () => { await onEnableMining(); (miner as any).checkMinerStatus?.(); }}
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

      {/* Modals still rendered on top */}
      {showSendModal && walletsByChain[activeChain] && (
        <SendModal
          adapter={getAdapter(activeChain)}
          sendTo={sendTo}
          setSendTo={setSendTo}
          sendAmount={sendAmount}
          setSendAmount={setSendAmount}
          sending={sending}
          onSend={handleSend}
          onClose={closeSendModal}
          // Zephyr ecosystem assets reuse the ZEPH adapter; label the modal with
          // the actual asset (ZEPHUSD/ZEPHRSV/ZEPHYRS) so it doesn't say "ZEPH".
          assetLabel={
            sendAssetType
              ? ZPH_UI_TICKER[sendAssetType as ZphAssetType]
              : undefined
          }
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
