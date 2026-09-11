import { HederaSetupPanel } from "./HederaSetupPanel";
import { isHederaAccountMissing } from "../../wallets/hbar-wallet";
import { groupStablecoins, isStablecoinChain } from "../../wallets/stablecoins";
import { useMemo, useState } from "react";
import { WalletTxHistorySubview } from "./WalletTxHistorySubview";
import {
  ALL_CHAINS,
  getAdapter,
  type ChainAdapter,
  type ChainType,
  type NetworkInfo,
  type WalletInfo,
} from "../../wallets";
import { assetRank } from "../../wallets/coin-metadata";
// ChainTxCard import removed 2026-05-16 — rendering moved into
// WalletTxHistorySubview. Re-add this import if reverting to the
// inline-on-dashboard layout (see DashboardTxHistoryLegacy.tsx).
import { AccountCard } from "./AccountCard";
import { useUtxoReceiveAddress } from "../../lib/utxoAccountRegistry";
import { BtcLegacyPanel } from "./BtcLegacyPanel";
import { AdaLegacyPanel } from "./AdaLegacyPanel";
import { CardanoDerivationPanel } from "./CardanoDerivationPanel";
import { SolanaDerivationPanel } from "./SolanaDerivationPanel";
import { LitecoinDerivationPanel } from "./LitecoinDerivationPanel";
import { AlgorandDerivationPanel } from "./AlgorandDerivationPanel";
import { DerivationInfoCard } from "./DerivationInfoCard";

import { Card, MiniSpark } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { SwapBalanceSubline } from "./SwapBalanceSubline";
import {
  classifyBalance,
  formatMissingLabel,
  isMissingFromTotal,
} from "./balance-status";
import {
  useSidecarBalances,
  useSwapSidecarOptIn,
  type SidecarBalanceRow,
} from "../swap-sidecar";
import { XmrImportPanel } from "../monero/XmrImportPanel";
import { ZphImportPanel } from "../zephyr/ZphImportPanel";
import { XmrSyncCard } from "../monero/XmrSyncCard";
import { DexXmrWalletSection } from "../monero/DexXmrWalletSection";
import { ZphSyncCard } from "../zephyr/ZphSyncCard";
// XmrTxHistoryCard import removed 2026-05-16 — rendering moved into
// WalletTxHistorySubview. Re-add this import if reverting to the
// inline-on-dashboard layout (see DashboardTxHistoryLegacy.tsx).
import { ZephyrAssetsCard } from "../zephyr/ZephyrAssetsCard";
import { ZephyrProtocolStatsCard } from "../zephyr/ZephyrProtocolStatsCard";
import { ZanoImportPanel } from "../zano/ZanoImportPanel";
import { ZanoSyncCard } from "../zano/ZanoSyncCard";
import { ZanoAssetsCard } from "../zano/ZanoAssetsCard";
import { ZanoTxHistoryCard } from "../zano/ZanoTxHistoryCard";
import type { XmrTransfer } from "../../wallets/xmr-wallet";
import type {
  ZphAssetBalance,
  ZphAssetType,
} from "../../wallets/zph-rpc";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import type { ZanoAssetBalance, ZanoTransferEntry } from "../../wallets/zano-rpc";
import type { ChainTx } from "../../wallets/types";
import { UtxoAccountCard } from "./UtxoAccountCard";

/**
 * Chains that mount a richer derivation switcher below `DerivationInfoCard`.
 * Used only to word the card's hint ("use the options below" vs "no switcher
 * for this chain yet") — the card renders for every chain either way.
 */
const CHAINS_WITH_DERIVATION_PANEL = new Set<ChainType>([
  "bitcoin",
  "cardano",
  "solana",
  "algorand",
  "litecoin",
  "xrp",
  "tron",
  "ravencoin",
  "dash",
]);

interface BinaryDownloadProgress {
  stage: string;
  percent: number;
  message: string;
}

type SyncState =
  | "idle"
  | "starting"
  | "syncing"
  | "synced"
  | "connection-lost"
  | "error";

/**
 * Per-chain session bundles consumed by the portrait dashboard.
 * Mirrors the landscape `XmrSessionForLandscape` / `ZphSessionForLandscape`
 * shape but adds the binary-download + tx-history fields the portrait
 * sync / history cards need.
 */
export interface XmrSessionForDashboard {
  syncState: SyncState;
  syncPercent: number;
  syncWalletHeight: number;
  syncDaemonHeight: number;
  syncError: string;
  binaryReady: boolean | null;
  defenderExcluded: boolean | null;
  downloading: boolean;
  downloadProgress: BinaryDownloadProgress | null;
  txHistory: XmrTransfer[];
  txLoading: boolean;
  receiveAddress: string | null;
  showPrimary: boolean;
  setShowPrimary: (v: boolean) => void;
  onRefreshReceiveAddress: () => Promise<unknown>;
  onAddDefenderExclusion: () => void;
  onDownloadBinary: () => void;
  onRetry: () => void;
}

export interface ZphSessionForDashboard {
  syncState: SyncState;
  syncPercent: number;
  syncWalletHeight: number;
  syncDaemonHeight: number;
  syncError: string;
  binaryReady: boolean | null;
  defenderExcluded: boolean | null;
  downloading: boolean;
  downloadProgress: BinaryDownloadProgress | null;
  assetBalances: ZphAssetBalance[] | null;
  reserveStats: ZphLiveStats | null;
  reserveLoading: boolean;
  reserveError: string | null;
  reserveFetchedAt: number | null;
  onAddDefenderExclusion: () => void;
  onDownloadBinary: () => void;
  onRetry: () => void;
}

/**
 * Zano's session bundle, structurally parallel to the two above but
 * missing the fields neither ZPH's binary-download UI nor a verified
 * sync-progress RPC actually needed here — no `syncPercent`/
 * `syncWalletHeight`/`syncDaemonHeight` (see `useZanoSession`'s header:
 * no wallet-height-vs-daemon-height pair was confirmed against the real
 * binary), and no `defenderExcluded` (no Defender interference was
 * observed running `simplewallet.exe` directly, so no exclusion helpers
 * were built — see `ZanoSyncCard`'s header for the full reasoning).
 */
export interface ZanoSessionForDashboard {
  syncState: "idle" | "starting" | "ready" | "error";
  syncError: string;
  binaryReady: boolean | null;
  downloading: boolean;
  downloadProgress: BinaryDownloadProgress | null;
  assetBalances: ZanoAssetBalance[] | null;
  txHistory: ZanoTransferEntry[];
  txLoading: boolean;
  onDownloadBinary: () => void;
  onRetry: () => void;
}

/**
 * Portrait dashboard. Composition: chain picker → either an import
 * panel (XMR / ZPH when no seed loaded), the active chain's wallet
 * content (account card, optional Zephyr stats/assets, sync card,
 * tx history, send/swap button), or a "no wallet" placeholder.
 *
 * Most prop wiring is App.tsx-owned state; the two `*Session`
 * bundles encapsulate the per-chain useXmrSession / useZphSession
 * surface area the dashboard reads.
 */
export function DashboardView(props: {
  // Identity
  activeChain: ChainType;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  setWalletsByChain: React.Dispatch<
    React.SetStateAction<Partial<Record<ChainType, WalletInfo>>>
  >;
  wallet: WalletInfo | null;
  adapter: ChainAdapter;

  // Identity for chain switch
  onSelectChain: (chain: ChainType) => void;

  // Account-card display
  balance: string;
  balancesByChain: Partial<Record<ChainType, string>>;
  networkInfo: NetworkInfo | null;
  loading: boolean;
  onRefreshBalance: () => void;
  copiedKey: string | null;
  onCopy: (text: string, key?: string) => void;
  setError: (msg: string) => void;

  // Vault + sync lifecycle for the import panels
  sessionPassword: string | null;
  xmrSeedLoaded: string | null;
  zphSeedLoaded: string | null;
  zanoSeedLoaded: string | null;
  setXmrSeedLoaded: (v: string | null) => void;
  setZphSeedLoaded: (v: string | null) => void;
  setZanoSeedLoaded: (v: string | null) => void;
  saveXmrSeedToVault: (
    seed: string,
    restoreHeight: number | null
  ) => Promise<void>;
  saveZphSeedToVault: (
    seed: string,
    restoreHeight: number | null
  ) => Promise<void>;
  saveZanoSeedToVault: (seed: string, passphrase: string) => Promise<void>;
  startXmrSync: (
    seed: string,
    masterPassword: string,
    restoreHeight?: number
  ) => void;
  startZphSync: (
    seed: string,
    masterPassword: string,
    restoreHeight?: number
  ) => void;
  startZanoSync: (
    seed: string,
    masterPassword: string,
    passphrase?: string
  ) => void;

  // Per-chain sync sessions (XMR + ZPH + Zano)
  xmrSession: XmrSessionForDashboard;
  zphSession: ZphSessionForDashboard;
  zanoSession: ZanoSessionForDashboard;

  // Generic per-chain tx history (every chain except Monero)
  chainTxByKey: Record<string, ChainTx[]>;
  chainTxLoading: Record<string, boolean>;
  chainTxErrors: Record<string, string | null>;
  addressByChain: Record<string, string>;

  // Bottom action button (send / swap)
  onOpenSendModal: () => void;
  onOpenZephyrSwapModal: (source?: ZphAssetType) => void;
  /** Open the Swap tab with this asset pre-selected on AUTO. */
  onOpenSwapForAsset?: (ticker: string) => void;

  // USD price for the active chain's ticker (optional — undefined while loading)
  usdPriceForActive?: number;
  // Full per-ticker USD price map (uppercase ticker → USD). Powers the
  // portfolio total and the per-row USD value in the assets list.
  pricesByTicker: Record<string, number>;
  // 24h-history series per uppercase ticker (downsampled to ~24 points
  // by `fetchUsdPriceHistory`). Drives the portfolio sparkline at the
  // top of the dashboard and the per-asset sparkline on the active
  // chain's account card. Optional — when undefined or empty, both
  // sparks fall back to a flat-zero placeholder.
  priceHistoryByTicker?: Record<string, number[]>;

  // Legacy / multi-path discovery panels. Mounted inline below the
  // account card on the matching chain's dashboard tab so users with
  // funds at non-standard derivations see them without digging into
  // settings. Each prop is optional — when missing, the panel just
  // doesn't render. See PwndaWalletVault/wiki/concepts/derivation-paths.md
  // for the full rationale.
  sharedMnemonic?: string | null;
  currentSolanaDerivationChoice?: string;
  onChangeSolanaDerivation?: (newChoice: string) => Promise<void>;
  currentCardanoDerivationChoice?: string;
  onChangeCardanoDerivation?: (newChoice: string) => Promise<void>;
  currentAlgorandDerivationChoice?: string;
  onChangeAlgorandDerivation?: (newChoice: string) => Promise<void>;
  currentLitecoinDerivationChoice?: string;
  onChangeLitecoinDerivation?: (newChoice: string) => Promise<void>;
}) {
  const {
    activeChain,
    walletsByChain,
    setWalletsByChain,
    wallet,
    adapter,
    onSelectChain,
    balance,
    balancesByChain,
    networkInfo,
    loading,
    onRefreshBalance,
    copiedKey,
    onCopy,
    setError,
    sessionPassword,
    setXmrSeedLoaded,
    setZphSeedLoaded,
    setZanoSeedLoaded,
    saveXmrSeedToVault,
    saveZphSeedToVault,
    saveZanoSeedToVault,
    startXmrSync,
    startZphSync,
    startZanoSync,
    xmrSession,
    zphSession,
    zanoSession,
    chainTxByKey,
    chainTxLoading,
    chainTxErrors,
    addressByChain,
    onOpenSendModal,
    onOpenZephyrSwapModal,
    onOpenSwapForAsset,
    usdPriceForActive,
    pricesByTicker,
    priceHistoryByTicker,
    sharedMnemonic,
    currentSolanaDerivationChoice,
    onChangeSolanaDerivation,
    currentCardanoDerivationChoice,
    onChangeCardanoDerivation,
    currentAlgorandDerivationChoice,
    onChangeAlgorandDerivation,
    currentLitecoinDerivationChoice,
    onChangeLitecoinDerivation,
  } = props;

  // Internal sub-view state — the Wallet bottom-nav tab can host
  // sub-pages without leaving the tab. Currently the only sub-page
  // is per-asset transaction history (2026-05-16). Future per-asset
  // sub-views (analytics, send-flow, etc.) can extend this union.
  // Resets to "dashboard" whenever the active chain changes so the
  // user doesn't get stranded on a tx-history page for a chain they
  // just navigated away from.
  /**
   * UTXO receive-address rotation — the "Multiple Addresses" behaviour.
   *
   * Default is the FRESH address (showPrimary=false), because address reuse is
   * the harm and it should not be opt-in. The toggle exists because the primary
   * is still what a user needs when reconciling against an explorer or another
   * wallet that shows index 0.
   *
   * Deliberately display-only: `wallet.address` continues to back Send's change
   * output, the balance-cache fingerprint and what the swap engine watches.
   */
  const [utxoShowPrimary, setUtxoShowPrimary] = useState(false);
  const utxoReceiveAddress = useUtxoReceiveAddress(activeChain, wallet?.mnemonic);

  const [walletSubview, setWalletSubview] = useState<
    "dashboard" | "tx-history"
  >("dashboard");

  // C6 — swap-node wallets, for the DEX Monero card on the Monero panel.
  // Same fresh-install rule as every other sidecar surface: `optedIn === null`
  // (read in flight) is NOT enabled, so a user who never turned swaps on
  // issues no `swap_sidecar_*` invoke and sees an unchanged dashboard.
  const { optedIn: dexSidecarOptedIn } = useSwapSidecarOptIn();
  const { rows: dexSwapRows } = useSidecarBalances({
    enabled: dexSidecarOptedIn === true,
  });

  // Portfolio total = Σ (balance * price) over every chain we have a
  // wallet AND a price for. Chains with a wallet but no price land in
  // assetsCount and the per-row list, but contribute 0 to the total.
  //
  // `missingCount` = held chains whose VALUE is unknown and therefore absent
  // from the total: a balance that failed to load ("—") or a non-zero balance
  // we couldn't price. A genuine 0 balance is "known empty", not missing. The
  // header surfaces this so the total never silently understates.
  const { portfolioUsd, assetsCount, missingNames } = useMemo(() => {
    let usd = 0;
    let n = 0;
    const missing: string[] = [];
    for (const chain of ALL_CHAINS) {
      if (!walletsByChain[chain]) continue;
      n += 1;
      const a = getAdapter(chain);
      const bal = balancesByChain[chain];
      const price = pricesByTicker[a.ticker.toUpperCase()];
      // Shared classifier — see balance-status.ts. `absent` (Hedera's "no
      // account exists yet") and `pending` (an XMR/ZPH sidecar still syncing)
      // are NOT failures and must not be reported as "not loaded".
      const status = classifyBalance(bal);
      const hasPrice = price != null && Number.isFinite(price);
      if (isMissingFromTotal(status, hasPrice)) {
        missing.push(a.displayName);
        continue;
      }
      if (status.kind === "value" && hasPrice) usd += status.amount * price;
    }
    return { portfolioUsd: usd, assetsCount: n, missingNames: missing };
  }, [walletsByChain, balancesByChain, pricesByTicker]);

  // ── Sub-view: per-asset transaction history ──────────────────────
  // Render the dedicated tx-history page instead of the dashboard
  // when the user clicks "▶ Transaction history" below. BottomNav
  // remains on Wallet — this is internal to the wallet tab.
  if (walletSubview === "tx-history") {
    return (
      <WalletTxHistorySubview
        activeChain={activeChain}
        xmrSession={xmrSession}
        zanoSession={zanoSession}
        chainTxByKey={chainTxByKey}
        chainTxLoading={chainTxLoading}
        chainTxErrors={chainTxErrors}
        addressByChain={addressByChain}
        onCopy={(text) => onCopy(text)}
        onBack={() => setWalletSubview("dashboard")}
      />
    );
  }

  return (
    <div className="dashboard">
      {/* Portfolio hero — total USD across every loaded chain, with a
          tiny "N ASSETS" eyebrow. Replaces the bracketed [ LABEL ]
          chrome and the chain-picker grid. */}
      <PortfolioHeader
        portfolioUsd={portfolioUsd}
        assetsCount={assetsCount}
        missingNames={missingNames}
        walletsByChain={walletsByChain}
        balancesByChain={balancesByChain}
        priceHistoryByTicker={priceHistoryByTicker}
      />

      {/* v2 action row: 3-up Send / Receive / Swap. Sits above the focal
          asset card per the design reference. Receive copies the focal
          address; Swap is enabled only on Zephyr. */}
      {wallet && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          margin: "0 0 14px",
        }}>
          <button
            className="qbtn"
            // Called with NO arguments on purpose. `onClick={onOpenSendModal}`
            // hands React's SyntheticEvent to the first parameter, which is
            // `assetType` — see the 2026-08-25 entry in the vault log.
            onClick={() => onOpenSendModal()}
            disabled={activeChain === "monero" && xmrSession.syncState !== "synced"}
          >
            <span style={{ marginRight: 6 }}>▲</span>
            <span>Send</span>
          </button>
          <button
            className="qbtn"
            onClick={() => wallet && onCopy(wallet.address, "address")}
          >
            <span style={{ marginRight: 6 }}>▼</span>
            <span>Receive</span>
          </button>
          {/* Every asset, not just Zephyr. Portrait had the same
              `disabled={activeChain !== "zephyr"}` gate as landscape, and the
              same consequence: a dead control on every other coin. Both now
              open the Swap tab with this asset pre-selected on AUTO. */}
          <button
            className="qbtn accent"
            onClick={() => onOpenSwapForAsset?.(getAdapter(activeChain).ticker)}
            disabled={!onOpenSwapForAsset}
            title={`Swap ${getAdapter(activeChain).ticker} in the Swap tab`}
          >
            <span style={{ marginRight: 6 }}>⇄</span>
            <span>Swap</span>
          </button>
        </div>
      )}

      {/* XMR import panel: shown when Monero is active but no seed is loaded */}
      {activeChain === "monero" && !walletsByChain.monero ? (
        <XmrImportPanel
          sessionPassword={sessionPassword}
          setError={setError}
          setWalletsByChain={setWalletsByChain}
          setXmrSeedLoaded={setXmrSeedLoaded}
          saveXmrSeedToVault={saveXmrSeedToVault}
          startXmrSync={startXmrSync}
        />
      ) : activeChain === "zephyr" && !walletsByChain.zephyr ? (
        <ZphImportPanel
          sessionPassword={sessionPassword}
          setError={setError}
          setWalletsByChain={setWalletsByChain}
          setZphSeedLoaded={setZphSeedLoaded}
          saveZphSeedToVault={saveZphSeedToVault}
          startZphSync={startZphSync}
        />
      ) : activeChain === "zano" && !walletsByChain.zano ? (
        <ZanoImportPanel
          sessionPassword={sessionPassword}
          setError={setError}
          setWalletsByChain={setWalletsByChain}
          setZanoSeedLoaded={setZanoSeedLoaded}
          saveZanoSeedToVault={saveZanoSeedToVault}
          startZanoSync={startZanoSync}
        />
      ) : wallet ? (
        <>
          {/* Same panel landscape mounts — Hedera's "no account yet" is a
              protocol rule, and a bare balance string reads as a fault. */}
          {activeChain === "hedera" && isHederaAccountMissing(balance) && (
            <HederaSetupPanel publicKeyHex={wallet.address} onCopy={onCopy} compact />
          )}
          <AccountCard
            wallet={wallet}
            adapter={adapter}
            activeChain={activeChain}
            balance={balance}
            networkInfo={networkInfo}
            loading={loading}
            onRefresh={onRefreshBalance}
            copiedKey={copiedKey}
            onCopy={onCopy}
            utxoReceiveAddress={utxoReceiveAddress}
            utxoShowPrimary={utxoShowPrimary}
            setUtxoShowPrimary={setUtxoShowPrimary}
            xmrReceiveAddress={xmrSession.receiveAddress}
            xmrShowPrimary={xmrSession.showPrimary}
            setXmrShowPrimary={xmrSession.setShowPrimary}
            onNewXmrSubaddress={async () => {
              try {
                await xmrSession.onRefreshReceiveAddress();
              } catch (e: any) {
                setError(
                  "Could not generate new subaddress: " + (e?.message ?? e)
                );
              }
            }}
            usdPrice={usdPriceForActive}
            priceHistory={
              priceHistoryByTicker?.[adapter.ticker.toUpperCase()]
            }
          />

          {/* Derivation, for EVERY chain. Driven by the adapter's required
              `derivation` declaration, so a chain added later gets this with
              no wiring — which is the gap the per-chain panels below left:
              they each had to be hand-mounted, so most chains had no
              derivation surface and a user whose funds sat on a different
              path had nowhere to look. The richer switchers still render
              underneath for the chains that have them. */}
          <DerivationInfoCard
            chain={activeChain}
            hasDedicatedPanel={CHAINS_WITH_DERIVATION_PANEL.has(activeChain)}
            mnemonic={sharedMnemonic}
            onCopy={onCopy}
          />

          {/* Legacy / alternative-derivation panels mounted on the
              dashboard tab so users with funds at non-standard derivations
              see them without digging into Settings → Wallet Details. Each
              panel self-hides when the legacy address has no balance. */}
          {activeChain === "bitcoin" && sharedMnemonic && (
            <BtcLegacyPanel
              mnemonic={sharedMnemonic}
              standardAddress={wallet.address}
              onCopy={onCopy}
            />
          )}
          {activeChain === "cardano" && sharedMnemonic && (
            <AdaLegacyPanel mnemonic={sharedMnemonic} onCopy={onCopy} />
          )}
          {activeChain === "cardano" &&
            sharedMnemonic &&
            currentCardanoDerivationChoice &&
            onChangeCardanoDerivation && (
              <CardanoDerivationPanel
                mnemonic={sharedMnemonic}
                currentChoice={currentCardanoDerivationChoice}
                onChooseDerivation={onChangeCardanoDerivation}
                onCopy={onCopy}
              />
            )}
          {activeChain === "solana" &&
            sharedMnemonic &&
            currentSolanaDerivationChoice &&
            onChangeSolanaDerivation && (
              <SolanaDerivationPanel
                mnemonic={sharedMnemonic}
                currentChoice={currentSolanaDerivationChoice}
                onChooseDerivation={onChangeSolanaDerivation}
                onCopy={onCopy}
              />
            )}
          {activeChain === "algorand" &&
            sharedMnemonic &&
            currentAlgorandDerivationChoice &&
            onChangeAlgorandDerivation && (
              <AlgorandDerivationPanel
                mnemonic={sharedMnemonic}
                currentChoice={currentAlgorandDerivationChoice}
                onChooseDerivation={onChangeAlgorandDerivation}
                onCopy={onCopy}
              />
            )}
          {activeChain === "litecoin" &&
            sharedMnemonic &&
            currentLitecoinDerivationChoice &&
            onChangeLitecoinDerivation && (
              <LitecoinDerivationPanel
                mnemonic={sharedMnemonic}
                currentChoice={currentLitecoinDerivationChoice}
                onChooseDerivation={onChangeLitecoinDerivation}
                onCopy={onCopy}
              />
            )}

          {/* Account-wide address list + restore-safety warning for the UTXO
              chains. Generic across BTC/LTC/DOGE/DASH/BCH: the single-address
              model breaks the same way on all of them once anything spends
              with real BIP-32 change behaviour. See UtxoAccountCard. */}
          {getAdapter(activeChain).utxoAccounts &&
            sharedMnemonic &&
            wallet &&
            onCopy && (
              <UtxoAccountCard
                chain={activeChain}
                mnemonic={sharedMnemonic}
                address={wallet.address}
                onCopy={onCopy}
              />
            )}

          {/* Live Zephyr protocol stats — reserve ratio (with band warning),
              asset USD prices, ZYS yield APY. Source: scanner API. */}
          {activeChain === "zephyr" && (
            <ZephyrProtocolStatsCard
              stats={zphSession.reserveStats}
              loading={zphSession.reserveLoading}
              error={zphSession.reserveError}
              fetchedAt={zphSession.reserveFetchedAt}
            />
          )}

          {/* Multi-asset balance card for Zephyr (ZSD/ZRS/ZYS). Hidden
              when balances haven't been fetched yet OR when all three
              non-ZPH balances are zero. */}
          {activeChain === "zephyr" && (
            <ZephyrAssetsCard
              assetBalances={zphSession.assetBalances}
              liveStats={zphSession.reserveStats}
              onOpenSwap={onOpenZephyrSwapModal}
            />
          )}

          {/* Confidential-assets display for Zano — display-only, no
              swap handler (see ZanoAssetsCard's header for why: the
              whitelist is open-ended, unlike Zephyr's fixed four). */}
          {activeChain === "zano" && (
            <ZanoAssetsCard assetBalances={zanoSession.assetBalances} />
          )}

          {/* XMR sync progress — only shown on the Monero panel while
              the sidecar is starting / scanning. Once synced we hide
              this card and the balance becomes trustworthy. */}
          {activeChain === "monero" &&
            xmrSession.syncState !== "idle" &&
            xmrSession.syncState !== "synced" && (
              <XmrSyncCard
                syncState={xmrSession.syncState}
                syncPercent={xmrSession.syncPercent}
                syncWalletHeight={xmrSession.syncWalletHeight}
                syncDaemonHeight={xmrSession.syncDaemonHeight}
                syncError={xmrSession.syncError}
                defenderExcluded={xmrSession.defenderExcluded}
                binaryReady={xmrSession.binaryReady}
                downloading={xmrSession.downloading}
                downloadProgress={xmrSession.downloadProgress}
                accentColor={adapter.color}
                onAddDefenderExclusion={xmrSession.onAddDefenderExclusion}
                onDownloadBinary={xmrSession.onDownloadBinary}
                onRetry={xmrSession.onRetry}
              />
            )}

          {/* C6 — the swap node's own Monero wallet. Portrait inherits the
              landscape block (see WalletLandscapeView): same component, same
              Monero-panel-only gate, same "not your vault's XMR" framing.

              Reads the SAME `dexSwapRows` this component already fetches
              above, same as <AssetsList>'s `swapRows` prop now does —
              deliberately not a second `useSidecarBalances` instance. Two
              instances mounted together fire their poll in lockstep every
              ~20s, and against the engine's own ~25s Electrum lock-hold that
              was a real, measured contributor to the BTC/LTC reconnect
              churn documented 2026-08-21 (see log.md). One poll, shared. */}
          {activeChain === "monero" && (
            <DexXmrWalletSection
              optedIn={dexSidecarOptedIn}
              row={dexSwapRows.XMR}
            />
          )}

          {/* ZPH sync progress — structural mirror of MONERO SYNC. */}
          {activeChain === "zephyr" &&
            zphSession.syncState !== "idle" &&
            zphSession.syncState !== "synced" && (
              <ZphSyncCard
                syncState={zphSession.syncState}
                syncPercent={zphSession.syncPercent}
                syncWalletHeight={zphSession.syncWalletHeight}
                syncDaemonHeight={zphSession.syncDaemonHeight}
                syncError={zphSession.syncError}
                defenderExcluded={zphSession.defenderExcluded}
                binaryReady={zphSession.binaryReady}
                downloading={zphSession.downloading}
                downloadProgress={zphSession.downloadProgress}
                accentColor={adapter.color}
                onAddDefenderExclusion={zphSession.onAddDefenderExclusion}
                onDownloadBinary={zphSession.onDownloadBinary}
                onRetry={zphSession.onRetry}
              />
            )}

          {/* Zano sync/connection status — binary idle/starting/ready/error,
              no percent/height (see ZanoSyncCard's header for why). */}
          {activeChain === "zano" &&
            zanoSession.syncState !== "idle" &&
            zanoSession.syncState !== "ready" && (
              <ZanoSyncCard
                syncState={zanoSession.syncState}
                syncError={zanoSession.syncError}
                binaryReady={zanoSession.binaryReady}
                downloading={zanoSession.downloading}
                downloadProgress={zanoSession.downloadProgress}
                accentColor={adapter.color}
                onDownloadBinary={zanoSession.onDownloadBinary}
                onRetry={zanoSession.onRetry}
              />
            )}

          {/* "View transaction history" button — replaces the inline
              tx-history cards (2026-05-16). Opens a per-asset sub-
              view inside the Wallet tab (BottomNav stays on Wallet).
              See `WalletTxHistorySubview.tsx`. To revert to the inline
              cards: see the note at the top of
              `./DashboardTxHistoryLegacy.tsx`. */}
          {walletsByChain[activeChain] && (
            <button
              type="button"
              className="qbtn"
              onClick={() => setWalletSubview("tx-history")}
              style={{
                width: "100%",
                marginTop: 14,
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                letterSpacing: 0.6,
                textAlign: "left",
              }}
              title={`View ${adapter.displayName} transaction history`}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: "var(--text)",
                }}
              >
                <span style={{ color: "var(--text-dim)" }}>≡</span>
                Transaction history
              </span>
              <span
                style={{
                  color: "var(--text-dim)",
                  fontSize: 11,
                }}
              >
                {adapter.ticker} ▸
              </span>
            </button>
          )}

        </>
      ) : (
        <Card>
          <p className="no-wallet-msg">
            No {adapter.displayName} wallet imported. Import a mnemonic phrase
            to derive addresses for all chains.
          </p>
        </Card>
      )}

      {/* Sortable per-chain assets list — replaces the chain-picker
          tile grid. Click a row to make that chain active.
          v2 card-style design landed 2026-05-16. To revert to the
          single-row legacy layout: import { AssetsList } from
          "./AssetsListLegacy" and remove the inline AssetsList
          definition below in this file. */}
      <AssetsList
        activeChain={activeChain}
        walletsByChain={walletsByChain}
        balancesByChain={balancesByChain}
        pricesByTicker={pricesByTicker}
        priceHistoryByTicker={priceHistoryByTicker}
        onSelect={onSelectChain}
        swapRows={dexSwapRows}
      />

    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   PortfolioHeader — total USD across every loaded chain, asset count
   eyebrow, and a 24h-delta + sparkline strip on the right.

   The sparkline is the *real* historical portfolio total: for each
   timestamp in the 24h window, Σ over chains of (current_balance ×
   price_at_t). It mirrors the landscape WalletLandscapeView formula
   so portrait + landscape produce visually-identical sparks. The
   delta is the first-vs-last percentage move of the same series.

   Falls back to a flat-zero placeholder when `priceHistoryByTicker`
   is missing or empty (initial load, price-fetch failure, all-zero
   balances) so the visible chart never lies about market movement.
   ────────────────────────────────────────────────────────────────── */

/** Parse a balance string into a number, tolerating commas, "—", and
 *  the sentinel "Not initialized". Returns `null` when the value is
 *  not a finite positive number — caller treats null as "skip this
 *  chain in the portfolio computation". */
function parsePortfolioBalance(raw: string | undefined): number | null {
  if (!raw || raw === "—" || raw === "Not initialized") return null;
  const cleaned = raw.replace(/,/g, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Flat-zero placeholder series. MiniSpark normalises by min/max so a
 *  truly flat series renders as a single baseline line — visually
 *  honest about "no data yet" without faking an upward trend. */
const FLAT_PLACEHOLDER_SPARK = new Array(12).fill(0);

function PortfolioHeader({
  portfolioUsd,
  assetsCount,
  missingNames,
  walletsByChain,
  balancesByChain,
  priceHistoryByTicker,
}: {
  portfolioUsd: number;
  assetsCount: number;
  /** Display names of held chains whose value couldn't be loaded (failed
   *  balance or missing price). Non-empty ⇒ the total is understated; the
   *  header names them so the user knows which. */
  missingNames: string[];
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  balancesByChain: Partial<Record<ChainType, string>>;
  priceHistoryByTicker?: Record<string, number[]>;
}) {
  // Always show cents — the total is a computed sum, so 2 decimals read as
  // "approximate figure" without needing an "≈" glyph in front of it.
  const fmt = (n: number) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  // Name the missing chains when few; fall back to a count when many so the
  // eyebrow doesn't overflow.
  const missingLabel = formatMissingLabel(missingNames);


  // Build the per-timestamp portfolio-value series. Algorithm mirrors
  // WalletLandscapeView's `portfolioSpark` exactly so portrait + landscape
  // graphs render identically. Right-aligned across heterogenous-length
  // chain histories — chains with partial history contribute only to
  // the recent tail of the series.
  const portfolioSpark = useMemo<number[]>(() => {
    const history = priceHistoryByTicker ?? {};
    let maxLen = 0;
    for (const chain of ALL_CHAINS) {
      if (!walletsByChain[chain]) continue;
      const ticker = getAdapter(chain).ticker.toUpperCase();
      const h = history[ticker];
      if (h && h.length > maxLen) maxLen = h.length;
    }
    if (maxLen === 0) return FLAT_PLACEHOLDER_SPARK;
    const series = new Array<number>(maxLen).fill(0);
    let contributed = false;
    for (const chain of ALL_CHAINS) {
      if (!walletsByChain[chain]) continue;
      const a = getAdapter(chain);
      const h = history[a.ticker.toUpperCase()];
      if (!h || h.length === 0) continue;
      const bal = parsePortfolioBalance(balancesByChain[chain]);
      if (bal == null) continue;
      const offset = maxLen - h.length;
      for (let i = 0; i < h.length; i++) {
        series[offset + i] += bal * h[i];
      }
      contributed = true;
    }
    return contributed ? series : FLAT_PLACEHOLDER_SPARK;
  }, [walletsByChain, balancesByChain, priceHistoryByTicker]);

  // 24h delta — first vs last point of the real series. `null` while
  // we're rendering the placeholder so we don't fake a green +0% pill.
  const delta24h: { pct: number; positive: boolean } | null = useMemo(() => {
    if (portfolioSpark === FLAT_PLACEHOLDER_SPARK) return null;
    const first = portfolioSpark[0];
    const last = portfolioSpark[portfolioSpark.length - 1];
    if (!first || !last || first <= 0) return null;
    const pct = ((last - first) / first) * 100;
    return { pct, positive: pct >= 0 };
  }, [portfolioSpark]);

  const sparkColor = delta24h
    ? delta24h.positive
      ? "var(--accent)"
      : "var(--warn, #ffae42)"
    : "var(--text-dim)";

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        padding: "14px 16px",
        marginBottom: 14,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--text-dim)",
        }}
      >
        Portfolio · {assetsCount} {assetsCount === 1 ? "Asset" : "Assets"}
        {missingLabel && (
          <span
            title={`These held chains couldn't be valued (balance or price failed to load) and are excluded from the total, so it's understated: ${missingNames.join(
              ", "
            )}.`}
            style={{ color: "var(--warn, #ffae42)", marginLeft: 6 }}
          >
            · {missingLabel}
          </span>
        )}
      </div>
      <div
        className="hero-num tnum"
        style={{ fontSize: 32, lineHeight: 1.1, marginTop: 4 }}
      >
        ${fmt(portfolioUsd)}
        <span
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginLeft: 8,
            fontWeight: 400,
          }}
        >
          USD
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <span
          className="tnum"
          style={{
            color: delta24h
              ? delta24h.positive
                ? "var(--accent)"
                : "var(--warn, #ffae42)"
              : "var(--text-dim)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          }}
          title={
            delta24h
              ? "Change in portfolio total over the last ~24h, computed from your current balances priced against the historical USD series for each chain."
              : "24h delta — fetching price history."
          }
        >
          {delta24h
            ? `${delta24h.positive ? "+" : ""}${delta24h.pct.toFixed(2)}%`
            : "—"}
        </span>
        <span
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          24h
        </span>
        {/* minRangeFrac floors the vertical span to ~8% so a small daily move
            renders small instead of filling the height (the auto-scale was
            making a <2% move look like a dramatic swing). Harmless on the
            flat placeholder (midpoint 0 → no floor). */}
        <MiniSpark
          values={portfolioSpark}
          w={120}
          h={16}
          color={sparkColor}
          minRangeFrac={0.08}
        />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   AssetsList — vertical list of every chain the user has a wallet
   for, plus the two independent-seed chains (Monero, Zephyr) which
   show even before they are imported so the user can navigate to
   their import panel. Sorted by USD value desc; the active chain is
   highlighted with the chain's accent color.
   ────────────────────────────────────────────────────────────────── */
/**
 * AssetsList v2 (2026-05-16) — per-asset card-style rows.
 *
 * Each row is a self-contained card with:
 *   - LEFT  : the chain's `CoinIcon` framed in a square outline box
 *   - MID   : chain display name (white, bold) above the human-formatted
 *             balance + ticker (dim, smaller)
 *   - RIGHT : USD value (white, bold) above the 24h delta (green up /
 *             warn down / dim em-dash while history is loading)
 *
 * Sort order: USD-desc (same as legacy). Active chain row gets an
 * accent-tinted border + soft background tint so the active state is
 * preserved without recoloring the chain glyph (user constraint —
 * "Don't modify or change the current icons").
 *
 * Reverting: see the import-swap note at the call site above. The
 * legacy single-row implementation lives at
 * `./AssetsListLegacy.tsx`.
 */
function AssetsList({
  activeChain,
  walletsByChain,
  balancesByChain,
  pricesByTicker,
  priceHistoryByTicker,
  onSelect,
  swapRows,
}: {
  activeChain: ChainType;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  balancesByChain: Partial<Record<ChainType, string>>;
  pricesByTicker: Record<string, number>;
  priceHistoryByTicker?: Record<string, number[]>;
  onSelect: (chain: ChainType) => void;
  /** C0.1 swap-node balances — lifted from the parent (2026-08-21) so the
   *  whole Dashboard shares ONE `useSidecarBalances` poll instead of two
   *  firing in lockstep every mount; see the parent's `dexSwapRows`. */
  swapRows: Record<string, SidecarBalanceRow>;
}) {
  // T3.4 — default to meaningful chains only (positive balance, or the
  // currently-active chain, or one of the canonical defaults). Keeps the
  // ASSETS card scannable on a fresh vault. localStorage-persisted.
  const [showAll, setShowAll] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pwnda-wallet-chains-show-all") === "true";
    } catch {
      return false;
    }
  });
  // C0.1 — swap-node balances (see the `swapRows` prop doc above for why
  // this no longer calls useSidecarBalances directly). Portrait inherits
  // the landscape treatment (see WalletLandscapeView): a subordinate
  // sub-line under the wallet amount, and nothing at all when the sidecar
  // is off or the coin's balance is zero.
  const toggleShowAll = () => {
    setShowAll((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(
          "pwnda-wallet-chains-show-all",
          next ? "true" : "false"
        );
      } catch {
        /* localStorage unavailable — non-fatal */
      }
      return next;
    });
  };
  const allRows = useMemo(() => {
    const list = ALL_CHAINS.map((chain) => {
      const a = getAdapter(chain);
      const hasWallet = !!walletsByChain[chain];
      const independent = !!a.usesIndependentSeed;
      const selectable = hasWallet || independent;
      const bal = balancesByChain[chain];
      const numeric =
        bal && bal !== "—" && bal !== "Not initialized"
          ? parseFloat(bal.replace(/,/g, ""))
          : NaN;
      const tickerUpper = a.ticker.toUpperCase();
      const price = pricesByTicker[tickerUpper];
      const usd =
        Number.isFinite(numeric) && price && Number.isFinite(price)
          ? numeric * price
          : 0;
      // 24h delta % from first-vs-last of the per-ticker price
      // history. `null` when we don't have at least two points yet.
      const history = priceHistoryByTicker?.[tickerUpper];
      let delta24hPct: number | null = null;
      if (history && history.length >= 2) {
        const first = history[0];
        const last = history[history.length - 1];
        if (first > 0 && last > 0) {
          delta24hPct = ((last - first) / first) * 100;
        }
      }
      const positiveBalance = Number.isFinite(numeric) && numeric > 0;
      return { chain, adapter: a, selectable, bal, usd, delta24hPct, positiveBalance };
    }).filter((r) => r.selectable && !isStablecoinChain(r.chain));

    // Stablecoins are STACKED here too, from the same `groupStablecoins` the
    // landscape rail uses — one row per symbol rather than seven "USDC (Base)"
    // style rows that read as seven unrelated coins.
    //
    // Portrait's column is too narrow for landscape's expandable network
    // breakdown, so a family row selects its LARGEST leg instead: the user
    // lands on the network holding the most, with Send/Receive/Swap working
    // normally because that leg is a real chain. The breakdown itself lives in
    // landscape, which has the width for it.
    for (const g of groupStablecoins(balancesByChain)) {
      const best = [...g.rows].sort((x, y) => (y.amount ?? -1) - (x.amount ?? -1))[0];
      if (!best) continue;
      const held = (g.total ?? 0) > 0;
      const isActiveFamily = g.rows.some((r) => r.chain === activeChain);
      if (!held && !isActiveFamily) continue;
      const target = isActiveFamily
        ? g.rows.find((r) => r.chain === activeChain)!.chain
        : best.chain;
      const a = getAdapter(target);
      const price = pricesByTicker[g.symbol.toUpperCase()];
      list.push({
        chain: target,
        adapter: { ...a, displayName: g.displayName, ticker: g.symbol },
        selectable: true,
        bal: g.total == null ? undefined : String(g.total),
        usd:
          g.total != null && price && Number.isFinite(price)
            ? g.total * price
            : 0,
        delta24hPct: null,
        positiveBalance: held,
      });
    }
    // "Smart" order: holdings value descending, then the canonical
    // market-cap rank for zero / unpriced rows, then name — consistent
    // with the landscape wallet + the swap pickers.
    list.sort((a, b) => {
      const va = a.usd > 0 ? a.usd : -1;
      const vb = b.usd > 0 ? b.usd : -1;
      if (va !== vb) return vb - va;
      const ra = assetRank(a.adapter.ticker);
      const rb = assetRank(b.adapter.ticker);
      if (ra !== rb) return ra - rb;
      return a.adapter.displayName.localeCompare(b.adapter.displayName);
    });
    return list;
  }, [walletsByChain, balancesByChain, pricesByTicker, priceHistoryByTicker]);

  // T3.4 — canonical defaults always render even at zero balance so a
  // fresh wallet shows a non-empty list. Tickers are intentionally a
  // small set; everything else is collapsed behind "show all".
  // Chains always shown, even at zero balance. The independent-seed chains
  // (XMR / ZEPH / ZANO) MUST be here: their import panel is gated on
  // `activeChain === <chain>`, and this list is the only way to make that
  // chain active — so a missing entry doesn't just hide a row, it makes the
  // whole chain unreachable behind "show all N chains".
  //
  // 2026-08-28: ZANO was missing. Monero and Zephyr seeds are generated
  // during onboarding, so those chains are in `walletsByChain` from creation
  // and would have shown anyway; Zano is import-only, so it had zero balance,
  // was never the active chain, and was filtered out of its own entry point.
  // The Zano feature had been complete and shipped for a day and was
  // invisible in the UI. See PwndaWalletVault/log.md 2026-08-28.
  const CANONICAL_DEFAULTS = new Set<string>([
    "BTC",
    "ETH",
    "SOL",
    "ADA",
    "XMR",
    "ZEPH",
    "ZANO",
  ]);
  const meaningfulRows = useMemo(
    () =>
      allRows.filter(
        (r) =>
          r.positiveBalance ||
          r.chain === activeChain ||
          CANONICAL_DEFAULTS.has(r.adapter.ticker.toUpperCase())
      ),
    [allRows, activeChain]
  );
  const rows = showAll ? allRows : meaningfulRows;
  const hiddenCount = allRows.length - meaningfulRows.length;

  if (allRows.length === 0) return null;

  const formatBalanceForRow = (raw: string | undefined, ticker: string): string => {
    if (!raw || raw === "—" || raw === "Not initialized") return `— ${ticker}`;
    // Trim trailing zeros beyond 6dp for visual density — matches the
    // reference design ("2.481900 XMR", "0.182300 ETH"). If the raw
    // string already has fewer decimals we leave it alone.
    const n = parseFloat(raw.replace(/,/g, ""));
    if (!Number.isFinite(n)) return `${raw} ${ticker}`;
    // Pick a decimal-place count that mirrors the reference: high-
    // precision for sub-1 amounts (more decimals), fewer for >1.
    const dp = n >= 100 ? 2 : n >= 1 ? 4 : 6;
    return `${n.toFixed(dp)} ${ticker}`;
  };

  const formatUsd = (usd: number): string => {
    if (usd === 0) return "—";
    if (usd >= 100) return `$${usd.toFixed(2)}`;
    if (usd >= 1) return `$${usd.toFixed(2)}`;
    if (usd >= 0.01) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(4)}`;
  };

  return (
    <Card title="ASSETS">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: -2,
        }}
      >
        {rows.map(({ chain, adapter, bal, usd, delta24hPct }) => {
          const active = chain === activeChain;
          const positive = delta24hPct !== null && delta24hPct >= 0;
          const deltaColor =
            delta24hPct === null
              ? "var(--text-dim)"
              : positive
                ? "var(--accent)"
                : "var(--warn, #ff6b6b)";
          const deltaText =
            delta24hPct === null
              ? "—"
              : `${positive ? "+" : ""}${delta24hPct.toFixed(1)}%`;
          return (
            <button
              key={chain}
              onClick={() => onSelect(chain)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                // Focus is the coin's OWN colour glowing, not a generic accent
                // border — the icon is coloured at rest now, so selection has
                // to be signalled by something other than gaining colour.
                background: active
                  ? `${adapter.color}12`
                  : "rgba(255,255,255,0.02)",
                border: active
                  ? `1px solid ${adapter.color}`
                  : "1px solid var(--border)",
                boxShadow: active ? `0 0 14px -4px ${adapter.color}` : "none",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "var(--font-mono)",
                color: "var(--text)",
                transition:
                  "background .12s ease, border-color .12s ease, box-shadow .12s ease",
                width: "100%",
              }}
            >
              {/* Icon framed in a square outline — preserves the
                  user's "don't modify the icons" constraint while
                  matching the reference design's framed glyphs. */}
              <div
                style={{
                  flex: "0 0 auto",
                  width: 36,
                  height: 36,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: active
                    ? `1px solid ${adapter.color}`
                    : "1px solid var(--border-soft, rgba(255,255,255,0.18))",
                  background: "rgba(0,0,0,0.25)",
                  transition: "border-color .12s ease",
                }}
              >
                <CoinIcon
                  sym={adapter.ticker}
                  size={20}
                  color={adapter.color}
                  glow={active ? "accent" : false}
                />
              </div>

              {/* Name + amount column */}
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  minWidth: 0,
                  gap: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--text)",
                    letterSpacing: 0.2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {adapter.displayName}
                </span>
                <span
                  className="tnum"
                  style={{
                    fontSize: 10.5,
                    color: "var(--text-dim)",
                    letterSpacing: 0.2,
                  }}
                >
                  {formatBalanceForRow(bal, adapter.ticker)}
                </span>
                {/* Swap-node holding, when there is one. Below the wallet
                    amount and smaller than it, in the name column rather than
                    the USD column — see SwapBalanceSubline for why it must
                    never merge into the wallet's own figures. */}
                <SwapBalanceSubline
                  raw={swapRows[adapter.ticker.toUpperCase()]?.balance}
                  ticker={adapter.ticker}
                  size={9.5}
                />
              </div>

              {/* USD value + 24h delta column (right-aligned) */}
              <div
                style={{
                  flex: "0 0 auto",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: 2,
                  minWidth: 72,
                }}
              >
                <span
                  className="tnum"
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: usd > 0 ? "var(--text)" : "var(--text-dim)",
                    letterSpacing: 0.2,
                  }}
                >
                  {formatUsd(usd)}
                </span>
                <span
                  className="tnum"
                  style={{
                    fontSize: 10.5,
                    color: deltaColor,
                    letterSpacing: 0.2,
                  }}
                  title={
                    delta24hPct === null
                      ? "24h delta — fetching price history."
                      : "24h price change for this asset."
                  }
                >
                  {deltaText}
                </span>
              </div>
            </button>
          );
        })}
        {/* T3.4 — show-all toggle. Only render when there are hidden
            chains to surface (or when already showing all and we have
            extras to collapse). */}
        {(hiddenCount > 0 || showAll) && (
          <div style={{ marginTop: 4, textAlign: "center" }}>
            <button
              type="button"
              className="btn-link"
              onClick={toggleShowAll}
              style={{ fontSize: 10, letterSpacing: 0.5 }}
            >
              {showAll
                ? `▴ collapse to active chains`
                : `▸ show all ${allRows.length} chains (${hiddenCount} hidden)`}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
