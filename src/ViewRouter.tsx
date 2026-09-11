/* ═══════════════════════════════════════════════════════════
   ViewRouter — portrait-mode view-routing dispatch.

   Extracted verbatim from App.tsx's portrait-mode return (the chain of
   `{view === "..." && <SomeView .../>}` blocks, the window-shell /
   TitleBar / header chrome, the error/success alerts, the Send /
   Zephyr-swap modals, and the BottomNav).

   This is a STRICT, behavior-preserving presentational component: it
   owns NO state, NO effects, NO hooks beyond what JSX needs, and NO
   control flow beyond the `view === "..."` conditionals that already
   existed inline. App.tsx remains the owner of every piece of state,
   every handler, and every hook call; it threads them through the
   props object below and invokes `<ViewRouter ... />`.

   The portrait/landscape layout switch (the early `LandscapeRoot`
   return) and the VITE_SKIP_AUTH dev-bypass effect stay in App.tsx —
   they are not part of the per-view dispatch.
   ═══════════════════════════════════════════════════════════ */

import type { EngineOwnership } from "./lib/swapSeedFingerprint";
import type { WalletKind } from "./vault-schema";
import {
  ST,
  BottomNav,
  type TabId,
} from "./components/Primitives";
import { TitleBar, Card } from "./components/PrimitivesV2";
import { UpdateBanner } from "./components/UpdateBanner";
import { SendModal } from "./features/send/SendModal";
import { ZephyrSwapModal } from "./features/zephyr/ZephyrSwapModal";
import { DeskSwapTrackerModal, type DeskTrackerState } from "./features/swap";
import {
  SidecarSwapTracker,
  type SidecarSwapState,
} from "./features/swap-sidecar";
import { MoneroNodesView } from "./features/monero/MoneroNodesView";
import { ZephyrNodesView } from "./features/zephyr/ZephyrNodesView";
import { ZanoNodesView } from "./features/zano/ZanoNodesView";
import { MiningView } from "./features/mining/MiningView";
import { MinerSetupView } from "./features/mining/MinerSetupView";
import { MiningSetupWizard } from "./features/mining/MiningSetupWizard";
import { SettingsView } from "./features/settings/SettingsView";
import { DashboardView } from "./features/wallet/DashboardView";
import { WalletDetailsCard } from "./features/wallet/WalletDetailsCard";
import { ActivityViewPortrait } from "./features/activity/ActivityViewPortrait";
import type { MiningProjection } from "./types/mining";
import type { ConvertPipelineState } from "./features/swap/useConvertPipeline";
import { SwapView } from "./features/swap/SwapView";

import { useMiner } from "./features/mining/useMiner";
import { useXmrNodes } from "./features/monero/useXmrNodes";
import { useZphNodes } from "./features/zephyr/useZphNodes";
import { useZanoNodes } from "./features/zano/useZanoNodes";
import { useZphReserveInfo } from "./features/zephyr/useZphReserveInfo";
import type { useXmrSession } from "./features/monero/useXmrSession";
import type { useZphSession } from "./features/zephyr/useZphSession";
import type { useZanoSession } from "./features/zano/useZanoSession";
import type { useSend } from "./features/send/useSend";
import type { useTxHistory } from "./features/activity/useTxHistory";
import type { useVault } from "./features/vault/useVault";
import type { useAppState } from "./state/AppStateContext";

import {
  getAdapter,
  type ChainType,
  type WalletInfo,
  type NetworkInfo,
} from "./wallets";
import type { ZphAssetType } from "./wallets/zph-rpc";
import { type View } from "./types/view";
import type { LayoutMode } from "./features/landscape/useLayout";

type Adapter = ReturnType<typeof getAdapter>;

// Derive exact types from the source-of-truth hooks so the props match
// precisely what App.tsx threads through. App destructures these hook
// returns (often with aliases); the indexed-access types below keep the
// prop contract identical to what each child view already received.
type XmrSession = ReturnType<typeof useXmrSession>;
type ZphSession = ReturnType<typeof useZphSession>;
type ZanoSession = ReturnType<typeof useZanoSession>;
type SendFlow = ReturnType<typeof useSend>;
type TxHistory = ReturnType<typeof useTxHistory>;
type Vault = ReturnType<typeof useVault>;
type AppStateShape = ReturnType<typeof useAppState>;

export type ViewRouterProps = {
  /** In-flight desk swaps, owned by the App shell so the tracker survives
   *  navigation during a 10-60 minute atomic swap. */
  deskTracker?: DeskTrackerState;
  /** In-flight BasicSwap sidecar swaps, owned by App above this router. */
  sidecarTracker?: SidecarSwapState;
  convertPipeline?: ConvertPipelineState;
  /** Whose Grove engine is running — forwarded to `SwapView`, which shares
   *  `EngineOwnershipStrip` with the landscape surface. */
  engineOwnership?: EngineOwnership;
  convertSeed?: {
    from: string;
    to: string;
    amount: string;
    router: "basicswap" | "intents" | "auto";
    nonce: number;
  } | null;
  onSidecarSwapAdopt?: (handle: never) => void;
  earnSourceBalance?: number | null;
  /** Convert-route projection for the Mine tab's SIMPLE hero (frame 3a). */
  miningProjection?: MiningProjection | null;
  onSelectMineDisplayCoin?: (ticker: string) => void;
  /** Assets reachable from mining, for the Mine hero's dropdown. */
  mineReachableTickers?: readonly string[];
  /** Open the Swap tab with an asset pre-selected on AUTO. */
  onOpenSwapForAsset?: (ticker: string) => void;
  earnMiningState?: { active: boolean; hardware?: string | null; hashrate?: string | null };
  /** Scan-date editor for Monero/Zephyr, built by App and shared with
   *  the landscape settings so both layouts render one instance. */
  scanDateSlot?: React.ReactNode;
  /** Wallet add/rename/remove, forwarded to `SettingsView`'s `WalletsCard`.
   *  Landscape got this card on 2026-08-21 when the per-chain Forget buttons
   *  were retired in favour of one list; portrait's buttons were removed in
   *  the same change but the card never followed, so portrait had no way to
   *  remove a wallet at all until the 2026-09-03 merge caught it. */
  addWallet?: (
    kind: WalletKind,
    input: string,
    name: string,
    chain?: ChainType
  ) => Promise<boolean>;
  renameWallet?: (id: string, name: string) => Promise<void>;
  removeWallet?: (id: string) => Promise<void>;
  walletOpBusy?: boolean;
  // ── Core view + chain state ────────────────────────────────
  view: View;
  setView: (v: View) => void;
  activeChain: ChainType;
  setActiveChain: (c: ChainType) => void;
  walletsByChain: AppStateShape["walletsByChain"];
  setWalletsByChain: AppStateShape["setWalletsByChain"];
  wallet: WalletInfo | null;
  adapter: Adapter;

  // ── Banners ────────────────────────────────────────────────
  error: string;
  setError: (msg: string) => void;
  success: string;
  setSuccess: (msg: string) => void;

  // ── Balance / network / loading ────────────────────────────
  balance: string;
  balancesByChain: Partial<Record<ChainType, string>>;
  networkInfo: NetworkInfo | null;
  loading: boolean;
  refreshBalance: () => Promise<void>;

  // ── Prices ─────────────────────────────────────────────────
  pricesByTicker: Record<string, number>;
  priceHistoryByTicker: Record<string, number[]>;

  // ── Sensitive-info toggles + copy feedback ─────────────────
  copiedKey: string | null;
  copyToClipboard: (text: string, key?: string) => void;
  showPrivateKey: boolean;
  setShowPrivateKey: (v: boolean) => void;
  showMnemonic: boolean;
  setShowMnemonic: (v: boolean) => void;
  showXmrSeed: boolean;
  setShowXmrSeed: (v: boolean) => void;
  showZphSeed: boolean;
  zanoSeedPassphrase?: string | null;
  showZanoSeed?: boolean;
  setShowZanoSeed?: (v: boolean) => void;
  setShowZphSeed: (v: boolean) => void;
  sharedMnemonic: string;

  // ── Session password + seeds ───────────────────────────────
  sessionPassword: AppStateShape["sessionPassword"];
  xmrSeedLoaded: string | null;
  zphSeedLoaded: string | null;
  setXmrSeedLoaded: (s: string | null) => void;
  setZphSeedLoaded: (s: string | null) => void;
  saveXmrSeedToVault: Vault["saveXmrSeedToVault"];
  saveZphSeedToVault: Vault["saveZphSeedToVault"];

  // ── Layout ─────────────────────────────────────────────────
  layout: LayoutMode;
  setLayout: (l: LayoutMode) => void;

  // ── Window chrome ──────────────────────────────────────────
  handleMinimize: () => void;
  handleClose: () => void;

  // ── XMR session (aliases of useXmrSession's return fields) ─
  xmrSyncState: XmrSession["syncState"];
  xmrSyncPercent: XmrSession["syncPercent"];
  xmrSyncWalletHeight: XmrSession["syncWalletHeight"];
  xmrSyncDaemonHeight: XmrSession["syncDaemonHeight"];
  xmrSyncError: XmrSession["syncError"];
  xmrBinaryReady: XmrSession["binaryReady"];
  xmrDefenderExcluded: XmrSession["defenderExcluded"];
  xmrDownloading: XmrSession["downloading"];
  xmrDownloadProgress: XmrSession["downloadProgress"];
  xmrTxHistory: XmrSession["txHistory"];
  xmrTxLoading: XmrSession["txLoading"];
  xmrReceiveAddress: XmrSession["receiveAddress"];
  xmrShowPrimary: XmrSession["showPrimary"];
  setXmrShowPrimary: XmrSession["setShowPrimary"];
  refreshXmrReceive: XmrSession["refreshReceiveAddress"];
  handleXmrAddDefenderExclusion: XmrSession["addDefender"];
  handleXmrDownloadBinary: XmrSession["downloadBinary"];
  startXmrSync: XmrSession["start"];

  // ── ZPH session (aliases of useZphSession's return fields) ─
  zphSyncState: ZphSession["syncState"];
  zphSyncPercent: ZphSession["syncPercent"];
  zphSyncWalletHeight: ZphSession["syncWalletHeight"];
  zphSyncDaemonHeight: ZphSession["syncDaemonHeight"];
  zphSyncError: ZphSession["syncError"];
  zphBinaryReady: ZphSession["binaryReady"];
  zphDefenderExcluded: ZphSession["defenderExcluded"];
  zphDownloading: ZphSession["downloading"];
  zphDownloadProgress: ZphSession["downloadProgress"];
  zphAssetBalances: ZphSession["assetBalances"];
  refreshZphAssetBalances: ZphSession["refreshAssetBalances"];
  handleZphAddDefenderExclusion: ZphSession["addDefender"];
  handleZphDownloadBinary: ZphSession["downloadBinary"];
  startZphSync: ZphSession["start"];

  // ── Zephyr reserve info ────────────────────────────────────
  zphReserveInfo: ReturnType<typeof useZphReserveInfo>;

  // ── ZANO session (aliases of useZanoSession's return fields) ─
  zanoSeedLoaded: string | null;
  setZanoSeedLoaded: (v: string | null) => void;
  saveZanoSeedToVault: (seed: string, passphrase: string) => Promise<void>;
  zanoSyncState: ZanoSession["syncState"];
  zanoSyncError: ZanoSession["syncError"];
  zanoBinaryReady: ZanoSession["binaryReady"];
  zanoDownloading: ZanoSession["downloading"];
  zanoDownloadProgress: ZanoSession["downloadProgress"];
  zanoAssetBalances: ZanoSession["assetBalances"];
  zanoTxHistory: ZanoSession["txHistory"];
  zanoTxLoading: ZanoSession["txLoading"];
  startZanoSync: ZanoSession["start"];
  retryZanoSync: ZanoSession["retry"];
  handleZanoDownloadBinary: ZanoSession["downloadBinary"];
  refreshZanoAssetBalances: ZanoSession["refreshAssetBalances"];
  zanoNodes: ReturnType<typeof useZanoNodes>;
  openZanoNodesView: () => Promise<void>;

  // ── Tx history (aliases of useTxHistory's return fields) ───
  chainTxByKey: TxHistory["txByChain"];
  chainTxLoading: TxHistory["loading"];
  chainTxErrors: TxHistory["errors"];
  ownedChains: ChainType[];
  addressByChain: Record<string, string>;

  // ── Send flow (useSend return fields) ──────────────────────
  sendTo: SendFlow["sendTo"];
  setSendTo: SendFlow["setSendTo"];
  sendAmount: SendFlow["sendAmount"];
  setSendAmount: SendFlow["setSendAmount"];
  sending: SendFlow["sending"];
  showSendModal: SendFlow["showSendModal"];
  openSendModal: SendFlow["openSendModal"];
  closeSendModal: SendFlow["closeSendModal"];
  handleSend: SendFlow["handleSend"];

  // ── Zephyr swap modal ──────────────────────────────────────
  showZphSwapModal: boolean;
  setShowZphSwapModal: (v: boolean) => void;
  zphSwapInitialSource: ZphAssetType | undefined;
  setZphSwapInitialSource: (s: ZphAssetType | undefined) => void;

  // ── Mining + nodes ─────────────────────────────────────────
  miner: ReturnType<typeof useMiner>;
  /** Mining opt-in gate. `false` → the Mine tab / miner-setup render the
   *  `MiningSetupWizard` instead of the live mining views (pure-wallet
   *  cutover). See `miningOptIn.ts`. */
  miningOptedIn: boolean;
  /** Persist the mining opt-in flag (called by the wizard). */
  onEnableMining: () => Promise<void>;
  /** Opt-out: stop any live session, clear the flag, return to dormant. */
  onDisableMining: () => Promise<void>;
  addressFor: (c: ChainType) => string | null;
  xmrNodes: ReturnType<typeof useXmrNodes>;
  zphNodes: ReturnType<typeof useZphNodes>;

  // ── Auth / vault handlers (useVault return fields) ─────────
  handleCreate: Vault["handleCreate"];
  handleImport: Vault["handleImport"];
  handleConfirmDerivation: Vault["handleConfirmDerivation"];
  handleSetPassword: Vault["handleSetPassword"];
  handleUnlock: Vault["handleUnlock"];
  handleRemoveWallet: Vault["handleRemoveWallet"];
  handleLogout: Vault["handleLogout"];
  pendingBip39: Vault["pendingBip39"];
  pendingXmrSeed: Vault["pendingXmrSeed"];
  pendingZphSeed: Vault["pendingZphSeed"];

  // ── Derivation handlers (useVault return fields) ───────────
  activeDerivationChoice: Vault["activeDerivationChoice"];
  handleChangeSolanaDerivation: Vault["handleChangeSolanaDerivation"];
  handleChangeCardanoDerivation: Vault["handleChangeCardanoDerivation"];
  handleChangeAlgorandDerivation: Vault["handleChangeAlgorandDerivation"];
  handleChangeLitecoinDerivation: Vault["handleChangeLitecoinDerivation"];
  handleChangeCoinDerivation: Vault["handleChangeCoinDerivation"];
  handleApplyProfile: Vault["handleApplyProfile"];

  // ── Chain switch + node-view openers ───────────────────────
  handleChainSwitch: (chain: ChainType) => void;
  openMoneroNodesView: () => Promise<void>;
  openZephyrNodesView: () => Promise<void>;
};

/**
 * Presentational view-routing dispatch. Every value/handler is owned by
 * App.tsx and threaded through props — moving this JSX changed nothing
 * about what each view receives.
 */
export function ViewRouter(props: ViewRouterProps) {
  const {
    deskTracker,
    sidecarTracker,
  convertPipeline,
  engineOwnership,
  convertSeed,
  onSidecarSwapAdopt,
  earnSourceBalance,
  miningProjection = null,
  onSelectMineDisplayCoin,
  mineReachableTickers,
  onOpenSwapForAsset,
  earnMiningState,
    scanDateSlot,
  addWallet,
  renameWallet,
  removeWallet,
  walletOpBusy = false,
    view,
    setView,
    activeChain,
    setActiveChain,
    walletsByChain,
    setWalletsByChain,
    wallet,
    adapter,
    error,
    setError,
    success,
    setSuccess,
    balance,
    balancesByChain,
    networkInfo,
    loading,
    refreshBalance,
    pricesByTicker,
    priceHistoryByTicker,
    copiedKey,
    copyToClipboard,
    showPrivateKey,
    setShowPrivateKey,
    showMnemonic,
    setShowMnemonic,
    showXmrSeed,
    setShowXmrSeed,
    showZphSeed,
    zanoSeedPassphrase,
    showZanoSeed,
    setShowZanoSeed,
    setShowZphSeed,
    sharedMnemonic,
    sessionPassword,
    xmrSeedLoaded,
    zphSeedLoaded,
    setXmrSeedLoaded,
    setZphSeedLoaded,
    saveXmrSeedToVault,
    saveZphSeedToVault,
    layout,
    setLayout,
    handleMinimize,
    handleClose,
    xmrSyncState,
    xmrSyncPercent,
    xmrSyncWalletHeight,
    xmrSyncDaemonHeight,
    xmrSyncError,
    xmrBinaryReady,
    xmrDefenderExcluded,
    xmrDownloading,
    xmrDownloadProgress,
    xmrTxHistory,
    xmrTxLoading,
    xmrReceiveAddress,
    xmrShowPrimary,
    setXmrShowPrimary,
    refreshXmrReceive,
    handleXmrAddDefenderExclusion,
    handleXmrDownloadBinary,
    startXmrSync,
    zphSyncState,
    zphSyncPercent,
    zphSyncWalletHeight,
    zphSyncDaemonHeight,
    zphSyncError,
    zphBinaryReady,
    zphDefenderExcluded,
    zphDownloading,
    zphDownloadProgress,
    zphAssetBalances,
    refreshZphAssetBalances,
    handleZphAddDefenderExclusion,
    handleZphDownloadBinary,
    startZphSync,
    zphReserveInfo,
    zanoSeedLoaded,
    setZanoSeedLoaded,
    saveZanoSeedToVault,
    zanoSyncState,
    zanoSyncError,
    zanoBinaryReady,
    zanoDownloading,
    zanoDownloadProgress,
    zanoAssetBalances,
    zanoTxHistory,
    zanoTxLoading,
    startZanoSync,
    retryZanoSync,
    handleZanoDownloadBinary,
    refreshZanoAssetBalances,
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
    showZphSwapModal,
    setShowZphSwapModal,
    zphSwapInitialSource,
    setZphSwapInitialSource,
    miner,
    miningOptedIn,
    onEnableMining,
    onDisableMining,
    addressFor,
    xmrNodes,
    zphNodes,
    handleCreate,
    handleImport,
    handleConfirmDerivation,
    handleSetPassword,
    handleUnlock,
    handleRemoveWallet,
    handleLogout,
    pendingBip39,
    pendingXmrSeed,
    pendingZphSeed,
    activeDerivationChoice,
    handleChangeSolanaDerivation,
    handleChangeCardanoDerivation,
    handleChangeAlgorandDerivation,
    handleChangeLitecoinDerivation,
    handleChangeCoinDerivation,
    handleApplyProfile,
    handleChainSwitch,
    openMoneroNodesView,
    openZephyrNodesView,
  } = props;

  // Home + Login render the full-screen AuthSplash. Flag those so `.app` becomes
  // a flex column (`.app-auth`) and the splash fills the real available height
  // (below the titlebar + header) instead of overflowing into a scrollbar.
  // home/login now render via AuthRouter (App.tsx), never through this
  // router — so the auth splash styling no longer applies here.
  const isSplashView = false;

  return (
    <div className="window-shell">
      {/* UXS-20260516-118: skip-to-content link — invisible until
          focused, then jumps past the title-bar window-chrome buttons
          (Minimize / Close / Settings / Lock) into the main app
          content. Without this, a P4 keyboard user had to Tab through
          4 chrome buttons every time they entered the wallet. */}
      <a className="skip-to-content" href="#pwnda-main-content">
        Skip to wallet content
      </a>

      {/* Slim v2 titlebar — draggable, spans full window width */}
      <div data-tauri-drag-region>
        <TitleBar
          syncLabel={
            xmrSyncState === "synced" || zphSyncState === "synced" ? "synced" :
            xmrSyncState === "syncing" || zphSyncState === "syncing" ? "syncing" :
            xmrSyncState === "starting" || zphSyncState === "starting" ? "starting" :
            xmrSyncState === "connection-lost" || zphSyncState === "connection-lost" ? "reconnecting" :
            xmrSyncState === "error" || zphSyncState === "error" ? "error" : "idle"
          }
          syncColor={
            xmrSyncState === "synced" || zphSyncState === "synced" ? "green" :
            xmrSyncState === "syncing" || zphSyncState === "syncing" ? "amber" :
            xmrSyncState === "starting" || zphSyncState === "starting" ? "amber" :
            xmrSyncState === "connection-lost" || zphSyncState === "connection-lost" ? "amber" :
            xmrSyncState === "error" || zphSyncState === "error" ? "red" : "gray"
          }
          onMin={handleMinimize}
          onClose={handleClose}
        />
      </div>

      <div className={isSplashView ? "app app-auth" : "app"} id="pwnda-main-content" tabIndex={-1}>
      <header>
        <h1><ST speed={22}>PWNDA WALLET</ST></h1>
        <div className="header-actions">
          {view === "dashboard" && (
            <button
              className="btn-icon btn-small"
              onClick={() => setView("settings")}
              title="Settings"
              aria-label="Settings"
            >
              {"⚙"} Settings
            </button>
          )}
          {Object.keys(walletsByChain).length > 0 && (
            <button className="btn-secondary btn-small" onClick={handleLogout}>
              ► Lock
            </button>
          )}
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}
      {/* Update notice. Shared with LandscapeShell — see UpdateBanner's header
          for why it is one component mounted twice rather than two. */}
      <UpdateBanner onOpenSettings={() => setView("settings")} />

      {/* home / login / backup / setPassword / import / derivation-picker are
          NOT rendered here. They moved to `features/auth/AuthRouter` on
          2026-08-12 and are rendered by App.tsx ahead of the layout branch, so
          portrait and landscape share one implementation. Re-adding them here
          would reintroduce the split that let landscape skip the password step
          entirely — see AuthRouter's header. */}

      {view === "miner-setup" && (
        miningOptedIn ? (
          <MinerSetupView miner={miner} pricesByTicker={pricesByTicker} onBack={() => setView(Object.keys(walletsByChain).length > 0 ? "dashboard" : "home")} onDisableMining={onDisableMining} />
        ) : (
          <MiningSetupWizard
            onSetUp={async () => { await onEnableMining(); setView("miner-setup"); }}
            onDismiss={() => setView(Object.keys(walletsByChain).length > 0 ? "dashboard" : "home")}
          />
        )
      )}


      {view === "mining" && (
        miningOptedIn ? (
          <MiningView
            miner={miner}
            addressFor={addressFor}
            pricesByTicker={pricesByTicker}
            onBack={() => setView("dashboard")}
            onSetup={() => setView("miner-setup")}
            projection={miningProjection}
            onSelectDisplayCoin={onSelectMineDisplayCoin}
            reachableTickers={mineReachableTickers}
            minedAmount={earnSourceBalance}
            // Portrait has no EARN tab (frame 1g: the nav is already full),
            // so the promo routes to the Swap tab's CONVERT segment, which
            // is the same pipeline under a different arrangement.
            onOpenEarn={() => setView("swap")}
            conversionRunning={
              convertPipeline?.stage === "hop1-running" ||
              convertPipeline?.stage === "hop2-running"
            }
          />
        ) : (
          <MiningSetupWizard
            onSetUp={async () => { await onEnableMining(); setView("miner-setup"); }}
            onDismiss={() => setView("dashboard")}
          />
        )
      )}


      {view === "dashboard" && (
        <DashboardView
          onOpenSwapForAsset={onOpenSwapForAsset}
          activeChain={activeChain}
          walletsByChain={walletsByChain}
          setWalletsByChain={setWalletsByChain}
          wallet={wallet}
          adapter={adapter}
          onSelectChain={handleChainSwitch}
          balance={balance}
          balancesByChain={balancesByChain}
          networkInfo={networkInfo}
          loading={loading}
          onRefreshBalance={refreshBalance}
          copiedKey={copiedKey}
          onCopy={copyToClipboard}
          setError={setError}
          sessionPassword={sessionPassword}
          xmrSeedLoaded={xmrSeedLoaded}
          zphSeedLoaded={zphSeedLoaded}
          zanoSeedLoaded={zanoSeedLoaded}
          setXmrSeedLoaded={setXmrSeedLoaded}
          setZphSeedLoaded={setZphSeedLoaded}
          setZanoSeedLoaded={setZanoSeedLoaded}
          saveXmrSeedToVault={saveXmrSeedToVault}
          saveZphSeedToVault={saveZphSeedToVault}
          saveZanoSeedToVault={saveZanoSeedToVault}
          startXmrSync={startXmrSync}
          startZphSync={startZphSync}
          startZanoSync={startZanoSync}
          xmrSession={{
            syncState: xmrSyncState,
            syncPercent: xmrSyncPercent,
            syncWalletHeight: xmrSyncWalletHeight,
            syncDaemonHeight: xmrSyncDaemonHeight,
            syncError: xmrSyncError,
            binaryReady: xmrBinaryReady,
            defenderExcluded: xmrDefenderExcluded,
            downloading: xmrDownloading,
            downloadProgress: xmrDownloadProgress,
            txHistory: xmrTxHistory,
            txLoading: xmrTxLoading,
            receiveAddress: xmrReceiveAddress,
            showPrimary: xmrShowPrimary,
            setShowPrimary: setXmrShowPrimary,
            onRefreshReceiveAddress: refreshXmrReceive,
            onAddDefenderExclusion: handleXmrAddDefenderExclusion,
            onDownloadBinary: handleXmrDownloadBinary,
            onRetry: () => {
              if (xmrSeedLoaded && sessionPassword) {
                startXmrSync(xmrSeedLoaded, sessionPassword);
              }
            },
          }}
          zphSession={{
            syncState: zphSyncState,
            syncPercent: zphSyncPercent,
            syncWalletHeight: zphSyncWalletHeight,
            syncDaemonHeight: zphSyncDaemonHeight,
            syncError: zphSyncError,
            binaryReady: zphBinaryReady,
            defenderExcluded: zphDefenderExcluded,
            downloading: zphDownloading,
            downloadProgress: zphDownloadProgress,
            assetBalances: zphAssetBalances,
            reserveStats: zphReserveInfo.stats,
            reserveLoading: zphReserveInfo.loading,
            reserveError: zphReserveInfo.error,
            reserveFetchedAt: zphReserveInfo.fetchedAt,
            onAddDefenderExclusion: handleZphAddDefenderExclusion,
            onDownloadBinary: handleZphDownloadBinary,
            onRetry: () => {
              if (zphSeedLoaded && sessionPassword) {
                startZphSync(zphSeedLoaded, sessionPassword);
              }
            },
          }}
          zanoSession={{
            syncState: zanoSyncState,
            syncError: zanoSyncError,
            binaryReady: zanoBinaryReady,
            downloading: zanoDownloading,
            downloadProgress: zanoDownloadProgress,
            assetBalances: zanoAssetBalances,
            txHistory: zanoTxHistory,
            txLoading: zanoTxLoading,
            onDownloadBinary: handleZanoDownloadBinary,
            onRetry: retryZanoSync,
          }}
          chainTxByKey={chainTxByKey}
          chainTxLoading={chainTxLoading}
          chainTxErrors={chainTxErrors}
          addressByChain={addressByChain}
          onOpenSendModal={openSendModal}
          onOpenZephyrSwapModal={(source) => {
            setZphSwapInitialSource(source);
            setShowZphSwapModal(true);
          }}
          usdPriceForActive={pricesByTicker[adapter.ticker.toUpperCase()]}
          pricesByTicker={pricesByTicker}
          priceHistoryByTicker={priceHistoryByTicker}
          sharedMnemonic={sharedMnemonic}
          currentSolanaDerivationChoice={activeDerivationChoice.solana}
          onChangeSolanaDerivation={handleChangeSolanaDerivation}
          currentCardanoDerivationChoice={activeDerivationChoice.cardano}
          onChangeCardanoDerivation={handleChangeCardanoDerivation}
          currentAlgorandDerivationChoice={activeDerivationChoice.algorand}
          onChangeAlgorandDerivation={handleChangeAlgorandDerivation}
          currentLitecoinDerivationChoice={activeDerivationChoice.litecoin}
          onChangeLitecoinDerivation={handleChangeLitecoinDerivation}
        />
      )}

      {view === "swap" && (
        <SwapView
          onDeskSwapAccepted={deskTracker?.adopt}
          onSidecarSwapAccepted={
            (onSidecarSwapAdopt as never) ?? sidecarTracker?.adopt
          }
          convertSeed={convertSeed}
          sidecarActiveSwaps={sidecarTracker?.swaps ?? []}
          onOpenSidecarTracker={sidecarTracker?.openTracker}
          convertPipeline={convertPipeline}
          engineOwnership={engineOwnership}
          earnSourceBalance={earnSourceBalance}
          earnMiningState={earnMiningState}
          walletsByChain={walletsByChain}
          balancesByChain={balancesByChain}
          pricesByTicker={pricesByTicker}
          zphAssetBalances={zphAssetBalances}
          onOpenZephyrSwapModal={(initialSource) => {
            setZphSwapInitialSource(initialSource);
            setShowZphSwapModal(true);
          }}
          onSwapToast={(msg) => {
            setSuccess(msg);
            setTimeout(() => setSuccess(""), 2400);
          }}
        />
      )}

      {view === "activity" && (
        <ActivityViewPortrait
          txByChain={chainTxByKey}
          loading={chainTxLoading}
          errors={chainTxErrors}
          chainsOwned={ownedChains}
          addressByChain={addressByChain}
        />
      )}

      {view === "settings" && (
        <>
          <SettingsView
            scanDateSlot={scanDateSlot}
            onAddWallet={addWallet}
            onRenameWallet={renameWallet}
            onRemoveWallet={removeWallet}
            walletOpBusy={walletOpBusy}
            onBack={() => setView("dashboard")}
            onOpenWalletDetails={() => setView("wallet-details")}
            onOpenP2P={() => setView("swap")}
            onOpenMinerSetup={() => {
              miner.checkMinerStatus();
              setView("miner-setup");
            }}
            xmrSeedLoaded={xmrSeedLoaded}
            zphSeedLoaded={zphSeedLoaded}
            zanoSeedLoaded={zanoSeedLoaded}
            onOpenMoneroNodes={openMoneroNodesView}
            onOpenZephyrNodes={openZephyrNodesView}
            onOpenZanoNodes={openZanoNodesView}
          />
          {/* Layout toggle — appended below the existing settings view */}
          <Card title="LAYOUT" style={{ marginTop: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              {(["portrait", "landscape"] as const).map((l) => (
                <button
                  key={l}
                  className={layout === l ? "btn-primary" : "btn-secondary"}
                  style={{ flex: 1, textTransform: "uppercase",
                    fontSize: 11, letterSpacing: 0.8 }}
                  onClick={() => setLayout(l)}
                >
                  {layout === l ? "► " : ""}{l.charAt(0).toUpperCase() + l.slice(1)}
                </button>
              ))}
            </div>
            <p style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)",
              marginTop: 8, letterSpacing: 0.3 }}>
              Landscape mode uses a sidebar nav and multi-column panels.
              Switches immediately when a wallet is loaded.
            </p>
          </Card>
        </>
      )}


      {view === "wallet-details" && layout === "portrait" && wallet && (
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
          currentSolanaDerivationChoice={activeDerivationChoice.solana}
          onChangeSolanaDerivation={handleChangeSolanaDerivation}
          currentLitecoinDerivationChoice={activeDerivationChoice.litecoin}
          onChangeLitecoinDerivation={handleChangeLitecoinDerivation}
          onChangeCoinDerivation={handleChangeCoinDerivation}
          onApplyProfile={handleApplyProfile}
          onCopy={copyToClipboard}
          onBack={() => setView("settings")}
        />
      )}

      {view === "monero-nodes" && (
        <MoneroNodesView nodes={xmrNodes} onBack={() => setView("settings")} />
      )}

      {view === "zephyr-nodes" && (
        <ZephyrNodesView nodes={zphNodes} onBack={() => setView("settings")} />
      )}

      {view === "zano-nodes" && (
        <ZanoNodesView nodes={zanoNodes} onBack={() => setView("settings")} />
      )}

      {showSendModal && wallet && (
        <SendModal
          adapter={adapter}
          fromAddress={wallet.address}
          sendTo={sendTo}
          setSendTo={setSendTo}
          sendAmount={sendAmount}
          setSendAmount={setSendAmount}
          sending={sending}
          onSend={handleSend}
          onClose={closeSendModal}
        />
      )}

      {showZphSwapModal && wallet && activeChain === "zephyr" && (
        <ZephyrSwapModal
          walletAddress={wallet.address}
          assetBalances={zphAssetBalances}
          liveStats={zphReserveInfo.stats}
          initialSourceAsset={zphSwapInitialSource}
          onClose={() => {
            setShowZphSwapModal(false);
            setZphSwapInitialSource(undefined);
          }}
          onSuccess={() => {
            // Trigger a balance refresh after a successful swap. Wallet-rpc
            // takes ~2 min (one block) to reflect the converted asset, but
            // pinging refreshBalance now keeps the source-asset side fresh.
            refreshBalance();
            void refreshZphAssetBalances();
          }}
        />
      )}

      {/* Desk swap tracker. Mounted HERE, outside every view conditional, so a
          10-60 minute atomic swap stays visible across tab navigation - the
          same hoist ZephyrSwapModal already uses. Guard on the summary, not on
          `open`: the modal returns null when closed and all its effects are
          gated on `open`. */}
      {deskTracker?.trackedSwap && (
        <DeskSwapTrackerModal
          open={deskTracker.trackerOpen}
          summary={deskTracker.trackedSwap}
          onClose={deskTracker.closeTracker}
          onTerminal={() => deskTracker.refresh()}
        />
      )}

      {/* BasicSwap sidecar tracker. Mounted alongside the desk tracker and for
          the identical reason: a sidecar swap runs 30-90 minutes, so the view
          it was started from is long gone by the time it settles. The
          component returns null unless a swap is tracked AND the tracker is
          open, so an unmounted-but-present tracker costs nothing. */}
      {sidecarTracker && <SidecarSwapTracker state={sidecarTracker} />}
      </div>
      {/* BottomNav — 4 tabs (BEHAVIORS §3.2). Only shown once a wallet
          exists. Send is triggered from the inline button on the
          dashboard; the bottom nav's Swap tab opens ZephyrSwapModal for
          ZEPH and surfaces a "coming soon" hint on every other chain. */}
      {Object.keys(walletsByChain).length > 0 &&
        (view === "dashboard" ||
          view === "mining" ||
          view === "settings" ||
          view === "activity" ||
          view === "swap") && (
        <BottomNav
          tab={
            view === "mining" ? "mine" :
            view === "settings" ? "settings" :
            view === "activity" ? "activity" :
            view === "swap" ? "swap" : "wallet"
          }
          setTab={(t: TabId) => {
            if (t === "wallet") setView("dashboard");
            else if (t === "swap") setView("swap");
            else if (t === "mine") setView("mining");
            else if (t === "activity") setView("activity");
            else if (t === "settings") setView("settings");
          }}
        />
      )}
    </div>
  );
}
