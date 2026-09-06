import { decimalToAtomic } from "./wallets/decimal-amount";
import {
  openSendSession,
  executeStellarTransfer,
  executeSuiTransfer,
} from "./features/swap/session-send";
import { executeNearNativeTransfer } from "./features/swap/swap-sources";
import { getNearAddress } from "./api/swap-rust";
import { NEAR_RPCS } from "./wallets/chain-rpcs";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initOsDetection } from "./platform/os";
import {
  getAdapter,
  type ChainType,
  type WalletInfo,
  type NetworkInfo,
} from "./wallets";
import { hasSavedWallet, saveVaultV3, getStore, type WalletEntry } from "./store";
import type { EncryptedData } from "./crypto";
import { DEFAULT_DERIVATION_CHOICE } from "./features/onboarding/derivation-detector";
import type { Holding } from "./features/wallet/portfolio-aggregate";
import { shouldShowSwitcher } from "./vault-schema";
import { setActiveXmrSeed } from "./wallets/xmr-wallet";
import type { ZphAssetType } from "./wallets/zph-rpc";
import { fetchUsdPrices, fetchUsdPriceHistory } from "./wallets/usd-prices";
import {
  BALANCE_CONCURRENCY,
  BALANCE_DEADLINE_MS,
  hydrateBalances,
  keepLastGood,
  orderChains,
  readBalanceCache,
  runLimited,
  withTimeout,
  writeBalanceCache,
} from "./wallets/balance-cache";

/* ═══════════════════════════════════════════════════════════
   DESIGN SYSTEM — primitives imported from src/components/.
   See handoff/BEHAVIORS.md and handoff/Primitives.tsx.
   ═══════════════════════════════════════════════════════════ */

import { useSend } from "./features/send/useSend";
import { useZphReserveInfo } from "./features/zephyr/useZphReserveInfo";
import { useXmrSession } from "./features/monero/useXmrSession";
import { useZphSession } from "./features/zephyr/useZphSession";
import { useXmrNodes } from "./features/monero/useXmrNodes";
import { useZphNodes } from "./features/zephyr/useZphNodes";
import { useZanoSession } from "./features/zano/useZanoSession";
import { useZanoNodes } from "./features/zano/useZanoNodes";
import { useMiner } from "./features/mining/useMiner";
import { useMiningOptIn } from "./features/mining/miningOptIn";
import { useMemoryTracker, usePeriodicGc } from "./features/mining/useMemoryTrace";
import { useDeskTracker } from "./features/swap";
import {
  applySharedCoinBalances,
  fetchSharedCoinOverrides,
  isSharedCoinChain,
  useSidecarSwap,
  useSwapAutoSetup,
  useSwapSidecarOptIn,
} from "./features/swap-sidecar";
import {
  swapSidecarSharedCoinWithdraw,
  swapSidecarStatus,
  swapSidecarXmrSharedInUse,
  swapSidecarCnSharedInUse,
} from "./api/basicswap";
import { deriveSwapWalletMaterial } from "./lib/swapWalletKey";
import {
  engineBelongsToWallet,
  engineOwnership,
  type EngineOwnership,
  swapSeedFingerprint,
} from "./lib/swapSeedFingerprint";
import { useAccountKeyDeriver } from "./state/useAccountKeyDeriver";
import { useVault } from "./features/vault/useVault";
import { useAppState } from "./state/AppStateContext";
import { useLayout } from "./features/landscape/useLayout";
import { toMiningFocus } from "./features/mining/featureFocus";
import { LandscapeRoot } from "./features/landscape/LandscapeRoot";
import { useConvertPipeline } from "./features/swap/useConvertPipeline";
import { deriveWalletAddresses, addressForAssetId } from "./features/swap/asset-address-resolver";
import { getDropdownTickers } from "./features/swap/swap-data";
import {
  useMiningProjection,
  readMineDisplayCoin,
  writeMineDisplayCoin,
} from "./features/swap/useMiningProjection";
import { useTxHistory } from "./features/activity/useTxHistory";
import { XmrImportPanel } from "./features/monero/XmrImportPanel";
import { ZphImportPanel } from "./features/zephyr/ZphImportPanel";
import { AuthRouter, AUTH_VIEWS } from "./features/auth/AuthRouter";
import { ScanDateCard } from "./features/settings/ScanDateCard";
import { TitleBar } from "./components/PrimitivesV2";
import { ViewRouter } from "./ViewRouter";

/* ═══════════════════════════════════════════════════════════ */

import { type View } from "./types/view";
import {
  type MiningHardware,
  type CpuAlgorithm,
  type GpuAlgorithm,
  type MiningIntensity,
  type MinerStatus,
  type DownloadProgress,
  CHAIN_MINING_PREFIX,
} from "./types/mining";
import {
  dateStringToMoneroHeight,
  dateStringToZephyrHeight,
} from "./utils/heightFromDate";
import {
  resolveUtxoAccountBalance,
} from "./wallets/utxo-account-balance";
import {
  setUtxoAccountSummary,
  clearUtxoAccountSummaries,
  useUtxoAccountSummaries,
} from "./lib/utxoAccountRegistry";

function App() {
  const {
    view,
    setView,
    activeChain,
    setActiveChain,
    walletsByChain,
    setWalletsByChain,
    walletEntries,
    setWalletEntries,
    activeWalletId,
    setActiveWalletId,
    error,
    setError,
    success,
    setSuccess,
    sessionPassword,
    setSessionPassword,
  } = useAppState();
  const [balance, setBalance] = useState<string>("--");
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [loading, setLoading] = useState(false);

  // Per-chain balance cache used by the landscape assets list.
  // Keyed by ChainType; value is the human-readable balance string from adapter.getBalance,
  // or "—" while pending.
  const [balancesByChain, setBalancesByChain] = useState<Partial<Record<ChainType, string>>>({});
  const [balancesLoading, setBalancesLoading] = useState(false);

  // USD price cache keyed by uppercase ticker. Populated by CoinGecko via
  // fetchUsdPrices() — used to compute portfolio total and per-asset USD
  // values in the landscape wallet view.
  const [pricesByTicker, setPricesByTicker] = useState<Record<string, number>>({});

  // 24h price history per ticker (downsampled to ~24 points). Populated
  // alongside `pricesByTicker` via `fetchUsdPriceHistory`. Drives every
  // sparkline + 24h-delta surface — portfolio total spark (sum of
  // per-asset value series), focal-asset position spark, and the right
  // column's market-price spark.
  const [priceHistoryByTicker, setPriceHistoryByTicker] = useState<
    Record<string, number[]>
  >({});

  // Send-flow state — modal visibility, form fields, in-flight flag,
  // and the actual send action — owned by `useSend` (M12).

  // Show/hide sensitive info
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [showMnemonic, setShowMnemonic] = useState(false);
  // Per-target copy feedback — button flips to ✓ green for 1.4s
  // (BEHAVIORS §2.2). The key is an opaque label passed by the caller.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // hasSaved — set true after first vault save, false on remove. Drives the
  // mount-time view routing (login vs home) and the post-logout destination.
  const [hasSaved, setHasSaved] = useState(false);

  // Pending seeds (held between create/import and setPassword) — owned by
  // `useVault` as of M9. Read via `vault.pendingBip39 / pendingXmrSeed /
  // pendingZphSeed` from the BackupView mount below.

  // Session-level XMR seed (decrypted at login, needed for getBalance/sendTransaction)
  const [xmrSeedLoaded, setXmrSeedLoaded] = useState<string | null>(null);
  const [zphSeedLoaded, setZphSeedLoaded] = useState<string | null>(null);
  // Zano: no vault-persistence wiring yet (see zano-integration-plan.md
  // Phase 5 status — pending confirmation on the WalletKind/VaultPayload
  // schema change). Seed lives in-session only; survives chain switches
  // and navigation within a run, not an app restart.
  const [zanoSeedLoaded, setZanoSeedLoaded] = useState<string | null>(null);
  /** The Secured-Seed passphrase this Zano seed needs, mirrored out of the
   *  vault so Wallet Details can show it. Null for ordinary seeds. */
  const [zanoSeedPassphrase, setZanoSeedPassphrase] = useState<string | null>(null);

  // XMR-specific UI state
  const [xmrImportValue, setXmrImportValue] = useState("");
  const [xmrImporting, setXmrImporting] = useState(false);

  // ZEPH-specific UI state — 25-word only (Zephyr doesn't support polyseed).
  const [zphImportValue, setZphImportValue] = useState("");
  const [zphImporting, setZphImporting] = useState(false);
  const [zphImportCreationDate, setZphImportCreationDate] = useState<string>("");
  // Swap modal — Phase 1 of zephyr-ecosystem-swap-plan: edit→quote→confirm→success
  // flow, single-leg only (ZPH↔ZSD, ZPH↔ZRS, ZSD↔ZYS). Pre-selecting an
  // initial asset lets the multi-asset balance card open the modal with that
  // asset pre-filled.
  const [showZphSwapModal, setShowZphSwapModal] = useState(false);
  const [zphSwapInitialSource, setZphSwapInitialSource] =
    useState<ZphAssetType | undefined>(undefined);

  /**
   * Creation-date input for legacy 25-word imports only. Polyseed already
   * carries a birthday, so we hide the picker for 16-word imports.
   * Format: "YYYY-MM-DD" from the <input type=date>.
   */
  const [xmrImportCreationDate, setXmrImportCreationDate] = useState<string>("");

  // XMR Monero seed display toggle in wallet-details
  const [showXmrSeed, setShowXmrSeed] = useState(false);
  // ZEPH Zephyr seed display toggle in wallet-details
  const [showZphSeed, setShowZphSeed] = useState(false);
  const [showZanoSeed, setShowZanoSeed] = useState(false);

  const wallet = walletsByChain[activeChain] ?? null;
  const adapter = getAdapter(activeChain);

  // Layout-mode orchestration — owns layout state, landscapeTab, the
  // window-resize side effect, the mount-time resync, and the two
  // view↔landscapeTab sync effects. Derives `featureFocus` from
  // (layout, view, landscapeTab); feature hooks consume that rather
  // than `view` directly so landscape mode triggers them correctly.
  // See [[layout-parity-plan]] and [[feature-parity-matrix]].
  const { layout, setLayout, landscapeTab, setLandscapeTab, featureFocus } =
    useLayout({ view, setView });

  // Single source of truth for "what mining address should we use for
  // chain X". The full wallet derives from the decrypted vault; Pwnda
  // Lite reads from a user-typed paste field. Same callback shape — the
  // mining feature folder never reaches into either app's state.
  const addressFor = useCallback(
    (c: ChainType) => {
      // Never resolve a watch-only (view-only) wallet — mining payouts must
      // land in a wallet the user actually controls.
      const w = walletsByChain[c];
      return w && !w.watchOnly ? w.address : null;
    },
    [walletsByChain]
  );

  // ── Swap node: hand it the wallet key the moment the vault is open ──
  //
  // Mounted at the ROOT deliberately. Autostart runs before any unlock, so a
  // keyless swap node comes up with its wallets LOCKED and any newly enabled
  // coin deferred — and the fixes for both used to live behind buttons in
  // Settings, which a user has no reason to visit. The vault becoming
  // unlocked is the event that unblocks them, and it happens here.
  //
  // `null` while the vault is locked, so the hook stays inert on the login
  // and onboarding routes (P1: a wallet with no swap opt-in fires nothing —
  // the hook's own `optedIn !== true` guard is what enforces that).
  const { optedIn: swapOptedIn } = useSwapSidecarOptIn();
  const swapVaultMnemonic =
    Object.values(walletsByChain).find((w) => w && !w.watchOnly && w.mnemonic)
      ?.mnemonic ?? null;
  const deriveSwapMaterial = useMemo(
    () =>
      swapVaultMnemonic
        ? () => deriveSwapWalletMaterial(swapVaultMnemonic)
        : null,
    [swapVaultMnemonic]
  );
  // Does the swap engine's datadir belong to the wallet currently on screen?
  //
  // Reported 2026-08-29: after switching wallets the LTC and BTC ADDRESSES
  // changed but their BALANCES did not — both wallets showed the same
  // `4.0573 LTC` under a `SWAP NODE` badge. Cause: the engine keeps reporting
  // BTC/LTC as `adoption: "accountkey"` after a vault switch, because from its
  // side nothing changed, so `applySharedCoinBalances` kept overriding the
  // displayed balance with ONE engine wallet's figure for EVERY vault wallet.
  //
  // The engine cannot answer "am I yours?" from its coin status, and comparing
  // its `deposit_address` does not work either (it hands out a fresh address
  // from the account, so it differs from the wallet's index-0 address even when
  // they match). What identifies the binding is the seed the datadir was
  // prepared with — recorded Rust-side at first prepare and compared here.
  //
  // Unknown is NOT a match: an install prepared before the binding existed
  // reports nothing, and the safe answer is "show this wallet's own adapter".
  const [engineIsThisWallets, setEngineIsThisWallets] = useState(false);
  // The same question, three-valued, for the USER-FACING half. The boolean
  // above deliberately folds "no engine" into `false` so a foreign engine can
  // never speak for this wallet; that is right for the balance override and
  // useless for telling the user anything, because a user with no swap node
  // must not be warned that their engine belongs to someone else.
  const [engineOwnershipState, setEngineOwnershipState] =
    useState<EngineOwnership>("unknown");
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!deriveSwapMaterial) {
        if (alive) {
          setEngineIsThisWallets(false);
          setEngineOwnershipState("unknown");
        }
        return;
      }
      try {
        const [status, material] = await Promise.all([
          swapSidecarStatus(),
          deriveSwapMaterial(),
        ]);
        const mine = await swapSeedFingerprint(material.mnemonic);
        if (alive) {
          setEngineIsThisWallets(
            engineBelongsToWallet(status.swapSeedFingerprint, mine)
          );
          setEngineOwnershipState(
            engineOwnership(status.swapSeedFingerprint, mine)
          );
        }
      } catch {
        // No node, no opt-in, or an unreadable status — all mean "do not let
        // the engine speak for this wallet". Fails safe by construction.
        if (alive) {
          setEngineIsThisWallets(false);
          setEngineOwnershipState("unknown");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [deriveSwapMaterial, activeWalletId]);

  // C8 — the account nodes that make a LEAN swap coin's wallet the user's own
  // wallet. Derived here, in the app layer, for the same reason
  // `deriveSwapMaterial` is: the vault mnemonic stays inside this closure and
  // `src/features/swap-sidecar` never imports crypto (BOUNDARIES.md).
  //
  // `expectedAddress` comes from the wallet's OWN adapter output, not from a
  // second derivation in here. That is what makes the backend's comparison
  // meaningful: it checks the engine against the address this wallet actually
  // shows the user, so a divergence anywhere in either derivation is caught
  // rather than reproduced on both sides.
  // Per-chain inputs, from EACH chain's own wallet entry — mnemonic included,
  // because a multi-wallet vault can carry different mnemonics per chain and
  // "any chain's mnemonic" was a wrong-wallet hazard. The deriver resolves
  // each chain's actual derivation (picker choices included) from its own
  // displayed address; see makeAccountKeyDeriver's header for the incident.
  // ONE table, in `src/state/useAccountKeyDeriver.ts`. This was written out
  // here and twice more in Settings, and all three copies listed BTC and LTC
  // only — which is why BCH could not be adopted even after the derivation
  // module learned the coin (2026-09-05). See that file's header.
  const deriveAccountKeys = useAccountKeyDeriver();
  // `.shared` names tickers this SESSION's auto-setup pass verified as
  // sharing the wallet's own account (see the hook's own header) — the
  // reactive flag `sendOverride` below reads to decide whether a BTC/LTC send
  // should route through the swap engine instead of this wallet's adapter.
  // Known gap: a coin turned on mid-session from Settings does not appear
  // here until the node restarts and a fresh auto-setup pass runs — the same
  // once-per-session latch this hook already applies to unlocking and adding
  // coins, not a new limitation introduced here.
  const swapAutoSetup = useSwapAutoSetup(
    swapOptedIn,
    deriveSwapMaterial,
    deriveAccountKeys,
  );

  // The supervisor restarting the node to add a parked coin is a visible,
  // minute-long event; announcing it is the difference between "the wallet is
  // adding Zano" and "why did the swap node stop on its own" (2026-09-05).
  // Uses the ordinary success banner: it is informational, not a fault.
  useEffect(() => {
    if (swapAutoSetup.unparkNotice) setSuccess(swapAutoSetup.unparkNotice);
  }, [swapAutoSetup.unparkNotice, setSuccess]);
  // Mining opt-in gate (pure-wallet cutover). A fresh/dormant full wallet
  // fires ZERO mining invokes: when not opted-in we force the mining hook's
  // focus to "other" (idles every focus-gated poller) AND pass
  // `enabled:false` (suppresses the one non-focus-gated effect, session
  // rehydration). The Mine tab renders `MiningSetupWizard` instead of
  // `MiningView`. The gate lives here in the app layer — `useMiner`'s
  // `{ addressFor }` contract is unchanged, so PwndaLite (always-on mining,
  // never sets this flag) is unaffected. See `miningOptIn.ts`.
  const { optedIn: miningOptedInRaw, enable: enableMining, disable: disableMiningFlag } =
    useMiningOptIn();
  const miningEnabled = miningOptedInRaw === true;
  // Narrow the wallet-side `FeatureFocus` into the mining-local subset
  // so the hook stays decoupled from the wider union.
  const miningFocus = toMiningFocus(featureFocus);
  const effectiveMiningFocus = miningEnabled ? miningFocus : "other";
  const miner = useMiner({
    focus: effectiveMiningFocus,
    addressFor,
    enabled: miningEnabled,
  });
  // Opt-out: stop any live session FIRST (so flipping the gate can't orphan a
  // running miner), clear the opt-in flag, then return to the wallet. The Mine
  // tab reverts to the setup wizard and the wallet is dormant again.
  const handleDisableMining = useCallback(async () => {
    await miner.stopAllMining();
    await disableMiningFlag();
    setView("dashboard");
  }, [miner, disableMiningFlag, setView]);

  // 2026-05-28 — Memory tracker. Polls `performance.memory` once per
  // minute and persists samples to localStorage so the user can leave
  // the app running through a long mining session and inspect the V8
  // heap growth curve afterward via `<MemoryTraceCard>` in Settings.
  // Mounted at the shell level so it runs regardless of which view is
  // on screen; the `view` arg labels each sample for post-mortem
  // correlation. Hook is a no-op outside Chromium / WebView2.
  useMemoryTracker({ view: `full-${view}` });
  // Periodic forced GC to reclaim the WebView2 renderer native-memory creep
  // (MS WebView2Feedback #3678). Paired with `--expose-gc` in the window's
  // additionalBrowserArgs; no-ops if the flag is absent. Mining-aware: the
  // chart-repaint leak runs ~22× faster while mining, so GC fires every 45 s
  // then vs 4 min idle. See useMemoryTrace.ts::usePeriodicGc +
  // webview2-memory-management.md § Round 8/9.
  usePeriodicGc(miner.isAnyMining);
  const {
    minerStatuses,
    minersReady,
    downloadingMiners,
    downloadProgress,
    defenderExcluded,
    checkingMiners,
    minerError,
    setupNeedsAttention,
    downloadMiners: handleDownloadMiners,
    reinstallMiners: handleReinstallMiners,
    addDefenderExclusions: handleAddDefenderExclusions,
  } = miner;

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleClose = () => getCurrentWindow().close();

  // Live-mirror of `error` so the auto-dismiss timeout in
  // `refreshBalance` can compare against the freshest value rather
  // than its closure-captured one.
  const errorRef = useRef(error);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  // Request-id token for `refreshBalance` / `refreshAllBalances`.
  // Without this, a previous chain's `getBalance` promise can resolve
  // AFTER a newer chain switch and overwrite `balance` with the old
  // value (reported 2026-05-16: ETH balance `0.003469820028131` leaked
  // onto the Solana panel with the SOL ticker because the ETH refresh
  // was still in flight when the user switched derivations on SOL).
  // We bump the counter on every fresh refresh and on every wallet /
  // chain transition, then ignore any resolution whose id is stale.
  const balanceReqRef = useRef(0);
  // Per-chain version so `refreshAllBalances` can ignore stale writes
  // for individual chains while a re-derivation is in flight.
  const chainReqRef = useRef<Partial<Record<ChainType, number>>>({});
  // Read inside refreshAllBalances WITHOUT being one of its dependencies: the
  // sweep's identity must not change on every chain switch, or the effects
  // keyed on it would re-sweep all ~27 chains each time a row is clicked.
  const activeChainRef = useRef<ChainType | null>(null);
  // Which address each balancesByChain value was fetched for, so switching
  // wallet cannot carry the previous wallet's number across (see
  // `hydrateBalances`).
  const balanceAddrRef = useRef<Partial<Record<ChainType, string>>>({});

  // Per-chain transaction history. The hook owns polling + caching; we only
  // pass it the set of (chain, address) pairs the user has unlocked. XMR
  // and ZPH adapters delegate to their wallet-rpc sidecar's get_transfers,
  // so the same hook drives every chain.
  //
  // A UTXO chain's displayed address is only ONE address the wallet
  // controls — the account-scan registry (utxoAccountRegistry.ts) may know
  // about additional used/funded addresses (change addresses a gap walk
  // found past the standard limit). Include those too, or a payout that
  // lands on one of them is counted in the balance total but never asked
  // for its own history, so it silently never appears in "Recent" (see
  // useTxHistory.ts's mergeChainTx doc, 2026-08-23).
  const utxoAccountSummaries = useUtxoAccountSummaries();
  const txPairs = useMemo(() => {
    const pairs: { chain: ChainType; address: string }[] = [];
    const seen = new Set<string>();
    const add = (chain: ChainType, address: string) => {
      const k = `${chain}:${address}`;
      if (seen.has(k)) return;
      seen.add(k);
      pairs.push({ chain, address });
    };
    for (const [chain, w] of Object.entries(walletsByChain) as [
      ChainType,
      WalletInfo
    ][]) {
      if (!w?.address) continue;
      add(chain, w.address);
      for (const entry of utxoAccountSummaries[chain]?.entries ?? []) {
        add(chain, entry.address);
      }
    }
    return pairs;
  }, [walletsByChain, utxoAccountSummaries]);
  const {
    txByChain: chainTxByKey,
    loading: chainTxLoading,
    errors: chainTxErrors,
    refresh: refreshTxHistory,
  } = useTxHistory(txPairs, { pollMs: 60_000, limit: 50 });
  const ownedChains = useMemo(
    () => txPairs.map((p) => p.chain),
    [txPairs]
  );
  const addressByChain = useMemo(() => {
    const o: Record<string, string> = {};
    for (const p of txPairs) o[p.chain] = p.address;
    return o;
  }, [txPairs]);

  /* ── Unified portfolio (Phase 4) ──────────────────────────────────────
   * The "All Wallets" view aggregates every wallet's holdings. We derive
   * each BIP39 wallet's addresses (cheap, pure) and track balances per
   * wallet id. The active wallet's live `balancesByChain` is attributed to
   * its own id; other wallets show whatever has been captured while visiting
   * them (cross-session persistence via the vault balanceCache is a later
   * polish). */
  const [balancesByWallet, setBalancesByWallet] = useState<
    Record<string, Partial<Record<ChainType, string>>>
  >({});

  // Attribute the active wallet's live balances to its wallet id so the
  // unified view can show them. Under "all" the active context is the primary
  // group, so its balances belong to the primary bip39 wallet.
  // Which wallet the numbers currently in `balancesByChain` were fetched for.
  // `activeWalletId` flips the instant the user picks a wallet, but the
  // balances are still the PREVIOUS wallet's until the sweep re-runs — so
  // attributing on that render filed one wallet's holdings under another
  // wallet's id, permanently, in the "All Wallets" total. Skip the pass where
  // the id changed; the next `balancesByChain` update attributes correctly.
  const attributedWalletRef = useRef<string | null>(null);
  useEffect(() => {
    const idChanged = attributedWalletRef.current !== activeWalletId;
    attributedWalletRef.current = activeWalletId;
    if (idChanged) return;
    if (Object.keys(balancesByChain).length === 0) return;
    const targetId =
      activeWalletId === "all"
        ? walletEntries.find((e) => e.kind === "bip39")?.id
        : activeWalletId;
    if (!targetId) return;
    setBalancesByWallet((prev) => ({
      ...prev,
      [targetId]: { ...prev[targetId], ...balancesByChain },
    }));
  }, [balancesByChain, activeWalletId, walletEntries]);

  // Check for saved wallet on mount
  // DEV-ONLY: the bypass only fires when BOTH flags are set:
  //   - `VITE_SKIP_AUTH=true` (the explicit opt-in)
  //   - `VITE_DEV_INSTANCE === "sandbox"` (the sandbox-instance marker)
  //
  // Requiring BOTH means a stray `.env.development.local` that re-enables
  // `VITE_SKIP_AUTH` on the main `npm run tauri dev` instance is harmless:
  // without `VITE_DEV_INSTANCE=sandbox`, the bypass stays off and the
  // user's vault unlock screen renders normally. Without this second
  // gate, the bypass loaded the public BIP39 test mnemonic into
  // walletsByChain — which has REAL on-chain balances ($3k+ across 26
  // chains, accumulated from random funders of the well-known test
  // address) and would mask the user's actual wallet behind those
  // numbers. Reported 2026-05-16.
  const isSandboxBypass =
    import.meta.env.DEV &&
    import.meta.env.VITE_SKIP_AUTH === "true" &&
    import.meta.env.VITE_DEV_INSTANCE === "sandbox";

  useEffect(() => {
    if (isSandboxBypass) return;
    hasSavedWallet().then((exists) => {
      setHasSaved(exists);
      if (exists) setView("login");
    });
  }, []);

  // Populate the OS-type cache so platform/os.ts sync accessors return the
  // accurate Tauri-plugin value (not the UA fallback). Fire-and-forget —
  // the sync accessors fall back to UA detection until this resolves, which
  // is correct for both Tauri and non-Tauri (catalog / web) surfaces.
  useEffect(() => {
    void initOsDetection();
  }, []);

  // DEV-ONLY: Visual-iteration auth bypass. When `VITE_SKIP_AUTH=true`
  // AND `VITE_DEV_INSTANCE=sandbox` are BOTH set in `.env.sandbox.local`,
  // populate `walletsByChain` from the standard BIP39 test mnemonic and
  // route straight to the dashboard — no password, no vault decrypt.
  // Used by the Playwright MCP screenshot workflow (see CONTRIBUTING.md
  // § Visual Iteration Workflow).
  //
  // Production safety: `import.meta.env.DEV` is replaced with `false`
  // at build time, so the whole branch is dead-code-eliminated from
  // `vite build` / `tauri build` output. The XMR and ZEPH wallets use
  // independent seeds; this bypass does not populate them (they
  // require sidecar-RPC unlock with a password). Visual iteration on
  // those panels still works — the sync-state UI just renders its
  // empty / "not loaded" branch.
  useEffect(() => {
    if (!isSandboxBypass) return;
    if (Object.keys(walletsByChain).length > 0) return;
    const TEST_MNEMONIC =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const wallets = deriveAllChains(TEST_MNEMONIC);
    setWalletsByChain(wallets);
    // Seed the multi-wallet spine so Settings ▸ Wallets renders a realistic
    // list under the bypass (the real spine is populated at unlock, which the
    // bypass skips). Demo entries only — never persisted, DCE'd from prod.
    // A "Main" group (bip39 + xmr + zph) plus two standalone wallets show the
    // primary-vs-secondary distinction (primary has no Remove control).
    // Trading uses the 2nd BIP39 test vector (valid checksum, different key
    // material) so switching to it derives visibly different addresses.
    const TRADING_MNEMONIC =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const demoEntries: WalletEntry[] = [
      { id: "demo-main-bip39", name: "Main", kind: "bip39", seed: TEST_MNEMONIC, createdAt: 1, groupId: "demo-main" },
      { id: "demo-main-xmr", name: "Main · Monero", kind: "xmr", seed: "demo", createdAt: 1, groupId: "demo-main", xmrSeedFormat: "polyseed", restoreHeight: null, sidecarFile: "pwnda-active" },
      { id: "demo-main-zph", name: "Main · Zephyr", kind: "zph", seed: "demo", createdAt: 1, groupId: "demo-main", restoreHeight: null, sidecarFile: "pwnda-zph-active" },
      { id: "demo-trading", name: "Trading", kind: "bip39", seed: TRADING_MNEMONIC, createdAt: 2, groupId: "demo-trading" },
      { id: "demo-cold-xmr", name: "Cold Storage", kind: "xmr", seed: "demo", createdAt: 3, groupId: "demo-cold", xmrSeedFormat: "legacy", restoreHeight: null, sidecarFile: "pwnda-xmr-demo-cold-xmr" },
      { id: "demo-pk", name: "Solana Hot", kind: "privateKey", seed: "demo-private-key-material", createdAt: 4, groupId: "demo-pk", chain: "solana", address: "HAgk14JpMQLg8auGCVn4qXt4WMPuT3DKpqk" },
      { id: "demo-watch", name: "vitalik.eth", kind: "watch", seed: "", createdAt: 5, groupId: "demo-watch", chain: "ethereum", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    ];
    setWalletEntries(demoEntries);
    setActiveWalletId("all");
    // Seed per-wallet balances so the unified "All Wallets" view shows a
    // combined portfolio immediately (Main also gets live balances attributed
    // as they load; Trading stays seeded since it isn't the active context).
    setBalancesByWallet({
      "demo-main-bip39": { ethereum: "0.42", bitcoin: "0.015" },
      "demo-trading": { ethereum: "3.25", bitcoin: "0.08", solana: "48", polygon: "1500" },
      "demo-pk": { solana: "12.5" },
      "demo-watch": { ethereum: "8.2" },
    });
    // Seed demo prices so the unified view shows a real combined USD total
    // (the price oracle is CORS-blocked under the browser-only sandbox).
    setPricesByTicker((prev) => ({
      ETH: 2400, BTC: 62000, SOL: 150, POL: 0.45, MATIC: 0.45, BNB: 580,
      AVAX: 28, ADA: 0.45, DOGE: 0.12, LTC: 75, XRP: 0.6, TRX: 0.15,
      ...prev,
    }));
    // Seed an encrypted v3 vault + a session password so the multi-wallet
    // CRUD + switcher actually round-trip against the (stateful) mock store —
    // switchWallet loads/saves the vault, which the plain bypass lacks.
    void (async () => {
      try {
        await saveVaultV3(
          { v: 3, wallets: demoEntries, lastActiveWalletId: "all" },
          "sandbox"
        );
        setSessionPassword("sandbox");
      } catch (e) {
        console.warn("[dev-bypass] demo vault seed failed:", e);
      }
    })();
    // VITE_FORCE_VIEW (sandbox/dev only) lets the agent screenshot a specific
    // pre-vault / onboarding screen the bypass would otherwise skip. See the
    // PwndaWalletVault sandbox-demo-mode-improvements plan, Fix 4a.
    const forcedView = String(import.meta.env.VITE_FORCE_VIEW || "").trim();
    setView((forcedView || "dashboard") as Parameters<typeof setView>[0]);
    // eslint-disable-next-line no-console
    console.warn(
      "[dev-bypass] VITE_SKIP_AUTH + VITE_DEV_INSTANCE=sandbox active — auth gate skipped, BIP39 test wallet loaded. " +
        "Only fires in the dev sandbox; your main `npm run tauri dev` instance always shows the real unlock screen."
    );
    // Run-once on mount; deps intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Configure the swap-relay URL on the Rust side so cross-chain swap
  // commands have somewhere to call. After configuration the Rust core
  // also has the per-install ed25519 X-Client-Sig keypair loaded, so we
  // auto-enroll on first launch (idempotent — re-enrollment is cheap and
  // server-side de-duplicates by pubkey).
  //
  // Failure is non-fatal: the swap UX surfaces a clear error when the
  // user tries to quote. ENROLL_RATE_LIMIT triggers a one-time toast and
  // we silently retry on the next launch.
  useEffect(() => {
    void import("./api/proxy").then(async ({ configureProxy, getProxyStatus, enrollWithProxy }) => {
      try {
        await configureProxy();
        const status = await getProxyStatus();
        if (!status.enrolled) {
          const result = await enrollWithProxy();
          if (result.enrolled) {
            setSuccess("Wallet registered with proxy.");
          } else if (result.status === 429) {
            setSuccess("Proxy busy — will retry next launch.");
          } else {
            // Non-fatal: the swap UX will retry on the user's next quote.
            console.warn("[proxy] enroll non-200:", result.status, result.body);
          }
        }
      } catch (e) {
        console.warn("[proxy] init failed:", e);
      }
    });
  }, [setSuccess]);

  const refreshBalance = useCallback(async () => {
    if (!wallet) return;
    // Snapshot the request id, the address, the chain, and the
    // ticker we're refreshing for. If any of them change before the
    // promise resolves (chain switch, derivation switch, second user
    // click), the resolution is stale and must NOT call setBalance —
    // otherwise the old chain's value overwrites the new one and we
    // get "ETH balance shown on SOL panel" style bugs.
    const reqId = ++balanceReqRef.current;
    const reqChain = activeChain;
    const reqAddress = wallet.address;
    const reqTicker = adapter.ticker;
    try {
      setLoading(true);
      // Prime the XMR module-level seed before fetching balance
      if (activeChain === "monero" && xmrSeedLoaded) {
        setActiveXmrSeed(xmrSeedLoaded);
      }
      // Account-wide for UTXO chains, exactly as the sweep does — if these two
      // paths disagreed, the hero number and the asset row would show different
      // balances for the same coin. An incomplete scan throws into the catch
      // below rather than reporting a lower bound as a balance.
      const [bal, info] = await Promise.all([
        adapter.utxoAccounts && wallet.mnemonic
          ? resolveUtxoAccountBalance(
              reqChain,
              adapter.utxoAccounts,
              wallet.mnemonic,
              wallet.address,
            ).then((s) => {
              setUtxoAccountSummary(reqChain, s);
              if (!s.complete) {
                throw new Error(
                  `${reqChain} account scan incomplete (${s.scanned} probed)`,
                );
              }
              return s.balance;
            })
          : adapter.getBalance(wallet.address),
        adapter.getNetworkInfo(),
      ]);
      // Stale-guard: if a newer refresh has fired since this one
      // started, drop this resolution entirely.
      if (reqId !== balanceReqRef.current) return;
      setBalance(bal);
      setNetworkInfo(info);
      setBalancesByChain((prev) => ({ ...prev, [reqChain]: bal }));
      balanceAddrRef.current[reqChain] = reqAddress;
      void writeBalanceCache(reqChain, reqAddress, bal);

      // C8 authority switch: for a VERIFIED-shared BTC/LTC, this adapter's own
      // reading is a single-address subset of what the engine actually holds
      // once it has spent — see sharedCoinBalance.ts's header. Gated to the
      // two coins that can ever be shared so every other chain's refresh is
      // byte-identical to before this existed; fetchSharedCoinOverrides
      // itself no-ops instantly (no network call) when nothing is shared, so
      // this costs nothing for the overwhelming majority of refreshes.
      // ...and only when the engine is THIS wallet's (see engineIsThisWallets).
      if (isSharedCoinChain(reqChain) && engineIsThisWallets) {
        void fetchSharedCoinOverrides().then((overrides) => {
          if (reqId !== balanceReqRef.current || overrides.length === 0) return;
          setBalancesByChain((prev) => applySharedCoinBalances(prev, overrides));
          // The focal number follows the SAME gated merge the map uses (an
          // engine row that is locked / not yet on the user's seed / still
          // scanning must not replace the adapter's reading — see
          // `applySharedCoinBalances`), so the two can never disagree.
          const merged = applySharedCoinBalances({ [reqChain]: bal }, overrides);
          const mine = merged[reqChain];
          if (mine != null) setBalance(mine);
        });
      }
    } catch (e: any) {
      // Same stale-guard for the error path: don't surface a SOL RPC
      // error after the user has already switched away from SOL.
      if (reqId !== balanceReqRef.current) return;
      // ethers v6 wraps every RPC failure with a verbose "could not
      // coalesce error" payload that includes the entire jsonrpc body.
      // Surface a short, user-friendly message instead and leave the
      // full thing in the console for debugging.
      console.warn("[refreshBalance] failed", e);
      const raw = e?.message ?? String(e);
      let short = raw;
      if (raw.includes("could not coalesce error") || raw.includes("free tier") || raw.includes("timeout")) {
        short = `${reqTicker} RPC timed out. Try again in a moment.`;
      } else if (raw.length > 140) {
        short = raw.slice(0, 140) + "…";
      }
      const msg = `Couldn't refresh ${reqTicker} balance — ${short}`;
      setError(msg);
      // Auto-dismiss balance errors after 6s. They're transient by
      // nature (RPC tier timeouts, momentary network blips) and the
      // big red banner blocks the focal balance underneath. We snapshot
      // the message; if the user (or another flow) replaced it in the
      // meantime, we leave the new error alone.
      window.setTimeout(() => {
        if (errorRef.current === msg) setError("");
      }, 6000);
    } finally {
      if (reqId === balanceReqRef.current) {
        setLoading(false);
      }
    }
    // `reqAddress` is intentionally captured but unused — it's part
    // of the snapshot so future readers can see what address the
    // request was for when debugging.
    void reqAddress;
  }, [wallet, adapter, activeChain, xmrSeedLoaded, setError]);

  // Fetch balances for every loaded chain — used by the landscape assets panel
  // so the multi-chain list shows real numbers instead of placeholders.
  // XMR is skipped unless its session is ready (RPC session is required and
  // spinning it up here would race with the XMR sync hook).
  const refreshAllBalances = useCallback(async () => {
    const entries = Object.entries(walletsByChain) as [ChainType, WalletInfo][];
    if (entries.length === 0) return;
    setBalancesLoading(true);
    try {
      if (xmrSeedLoaded) setActiveXmrSeed(xmrSeedLoaded);
      // 2026-08-22: bounded, prioritised, deadlined, and last-good-preserving.
      // Was `Promise.all` over every chain at once with no timeout and a
      // failure branch that wrote "—" over a value that was right a minute
      // ago — see `src/wallets/balance-cache.ts`'s header for the four
      // defects this replaces. Results still land per chain as they arrive,
      // so the list fills progressively instead of waiting for the slowest.
      const ordered = orderChains(entries, activeChainRef.current);
      await runLimited(
        ordered.map(([chain, w]) => async () => {
          // Per-chain request id — if the wallet at this chain
          // changes (e.g. user switches Solana derivation) before our
          // getBalance resolves, the stale resolution must NOT write
          // to balancesByChain[chain] or it'll display the wrong
          // address's balance in the asset list.
          const myReqId =
            (chainReqRef.current[chain] = (chainReqRef.current[chain] ?? 0) + 1);
          const reqAddress = w.address;
          try {
            const a = getAdapter(chain);
            if (chain === "monero" && !xmrSeedLoaded) {
              if (myReqId === chainReqRef.current[chain]) {
                setBalancesByChain((prev) => ({ ...prev, [chain]: "—" }));
              }
              return;
            }
            // UTXO chains answer for the ACCOUNT, not one address (2026-08-22).
            // `getBalance(w.address)` reports a single derived address, which
            // stops being the wallet the moment anything spends with proper
            // BIP-32 change behaviour — the swap engine does, and 4.02888049
            // LTC sat invisible at m/84'/2'/0'/1/20 as a result. The resolver
            // costs one probe for an untouched account and only escalates to a
            // gap walk when there is history to explain. See
            // `wallets/utxo-account-balance.ts`.
            const bal = await withTimeout(
              a.utxoAccounts && w.mnemonic
                ? resolveUtxoAccountBalance(
                    chain,
                    a.utxoAccounts,
                    w.mnemonic,
                    w.address,
                  ).then((s) => {
                    setUtxoAccountSummary(chain, s);
                    // An incomplete scan is a lower bound, not a balance.
                    // Falling back to the single-address read here would be
                    // the old lie with extra steps, so keep the last-known
                    // value instead by failing this chain honestly.
                    if (!s.complete) {
                      throw new Error(
                        `${chain} account scan incomplete (${s.scanned} probed)`,
                      );
                    }
                    return s.balance;
                  })
                : a.getBalance(w.address),
              BALANCE_DEADLINE_MS,
              `${chain} balance`,
            );
            if (myReqId !== chainReqRef.current[chain]) return;
            setBalancesByChain((prev) => ({ ...prev, [chain]: bal }));
            balanceAddrRef.current[chain] = reqAddress;
            void writeBalanceCache(chain, reqAddress, bal);
          } catch (e) {
            if (myReqId !== chainReqRef.current[chain]) return;
            // Named, not swallowed: the sweep's failures used to be silent,
            // so a chain stuck on "—" had no trail. One line per chain.
            console.warn(
              `[refreshAllBalances] ${chain} failed — keeping last-known value:`,
              e instanceof Error ? e.message : String(e),
            );
            // The retained value is only "stale" if it was fetched for the
            // address we just failed on. After a wallet switch it is the
            // PREVIOUS wallet's balance, and keeping it shows another
            // wallet's money under this one's name.
            setBalancesByChain((prev) =>
              keepLastGood(prev, chain, {
                recordedAddress: balanceAddrRef.current[chain],
                currentAddress: reqAddress,
              }),
            );
          }
        }),
        BALANCE_CONCURRENCY,
      );

      // C8 authority switch — one pass after the batch, not per-chain: the
      // override is independent of any single adapter's fetch and only ever
      // touches bitcoin/litecoin. See the sibling comment in `refreshBalance`
      // and `sharedCoinBalance.ts`'s header for why the adapter's own number
      // can be a stale subset once a coin is verified shared.
      if (engineIsThisWallets && entries.some(([chain]) => isSharedCoinChain(chain))) {
        const overrides = await fetchSharedCoinOverrides();
        if (overrides.length > 0) {
          setBalancesByChain((prev) => applySharedCoinBalances(prev, overrides));
        }
      }
    } finally {
      setBalancesLoading(false);
    }
  }, [walletsByChain, xmrSeedLoaded]);

  useEffect(() => {
    activeChainRef.current = activeChain;
  }, [activeChain]);

  // A scan describes ONE wallet's accounts. On logout (or any transition that
  // empties the wallet set) the summaries must go with it, or the next wallet
  // would inherit the previous one's derivation paths and stranded-funds
  // warning. Mirrors what `hydrateBalances` does for cached balances.
  //
  // CORRECTED 2026-08-29: this only fired when the map went EMPTY (logout), so a
  // wallet SWITCH — which replaces the map with a non-empty one — left the
  // previous wallet's scanned account summaries on screen, and worse, leaked its
  // addresses into `txPairs` so Activity queried the old wallet. Keying the
  // effect on `activeWalletId` clears them on the transition that actually
  // matters. Logout still clears via the empty-map branch.
  useEffect(() => {
    clearUtxoAccountSummaries();
  }, [activeWalletId]);

  useEffect(() => {
    if (Object.keys(walletsByChain).length === 0) clearUtxoAccountSummaries();
  }, [walletsByChain]);

  // Cached last-known balances land BEFORE the network does (2026-08-22).
  // Keyed by chain:address, so a wallet switch shows that wallet's last
  // readings, never the previous wallet's. Values already in state for the
  // same address win over the cache; the sweep then refreshes everything.
  useEffect(() => {
    const entries = Object.entries(walletsByChain) as [ChainType, WalletInfo][];
    if (entries.length === 0) return;
    let cancelled = false;
    void readBalanceCache().then((cached) => {
      if (cancelled) return;
      // `balanceAddrRef` is SNAPSHOTTED here, and written once after the
      // update — never from inside the updater. React may invoke a state
      // updater more than once for a single update (StrictMode does so in
      // dev; a replayed/interrupted render can in production), and updaters
      // are required to be pure. The old version assigned the ref inside the
      // updater, so a second invocation read back the addresses the first
      // had just written, concluded "same address, keep the value", and
      // restored the PREVIOUS wallet's balance it had correctly dropped a
      // moment earlier — indistinguishable afterwards from a real reading
      // for the new wallet. `addrs` derives only from `entries`, so hoisting
      // the write out changes nothing else.
      const prevAddrs = balanceAddrRef.current;
      let nextAddrs: Partial<Record<ChainType, string>> = prevAddrs;
      setBalancesByChain((prev) => {
        const { balances, addrs } = hydrateBalances(
          prev,
          prevAddrs,
          entries,
          cached,
        );
        nextAddrs = addrs;
        return balances;
      });
      balanceAddrRef.current = nextAddrs;
    });
    return () => {
      cancelled = true;
    };
  }, [walletsByChain]);

  // Keep the landscape assets list in sync: refresh on entry to the wallet tab,
  // when the wallet set changes, and whenever the XMR session becomes ready
  // (so its balance lights up once sync primes the RPC).
  // Batch-refresh USD prices alongside balances. Uses the CoinGecko
  // /simple/price endpoint with a 60s in-module cache so repeated calls
  // (tab switches, re-renders) are cheap.
  const refreshPrices = useCallback(async () => {
    // XMR + ZEPH use independent seeds and are NEVER in walletsByChain (the
    // derive loop skips independent-seed chains), so without these two they
    // were never priced — Monero/Zephyr showed a balance but "—" for USD
    // value AND no 24h history (2026-06-14). They're in both id maps.
    const tickers = Array.from(
      new Set([
        ...(Object.keys(walletsByChain) as ChainType[]).map(
          (c) => getAdapter(c).ticker
        ),
        "XMR",
        "ZEPH",
      ])
    );
    if (tickers.length === 0) return;
    const next = await fetchUsdPrices(tickers);
    // Don't blank the portfolio on a transient empty/blocked price fetch —
    // keep the last-known prices instead of dropping to "—"/$0.
    if (Object.keys(next).length > 0) setPricesByTicker(next);
    // History fetch is independent + slower (one API call per ticker
    // staggered ~200ms); fire and forget so the spot prices land first
    // and the sparklines fill in as the calls complete.
    void fetchUsdPriceHistory(tickers).then((hist) => {
      setPriceHistoryByTicker((prev) => ({ ...prev, ...hist }));
    });
  }, [walletsByChain]);

  useEffect(() => {
    if (layout !== "landscape") return;
    if (landscapeTab !== "wallet") return;
    void refreshAllBalances();
    void refreshPrices();
  }, [layout, landscapeTab, walletsByChain, xmrSeedLoaded, refreshAllBalances, refreshPrices]);

  // Same refresh in portrait mode — the v2 dashboard surfaces a
  // portfolio total + a per-asset list, so it needs the same per-chain
  // balance and price data the landscape wallet tab does.
  useEffect(() => {
    if (layout !== "portrait") return;
    if (view !== "dashboard") return;
    void refreshAllBalances();
    void refreshPrices();
  }, [layout, view, walletsByChain, xmrSeedLoaded, refreshAllBalances, refreshPrices]);

  /**
   * Keep balances fresh while the wallet surface is on screen.
   *
   * Until 2026-08-13 balances refreshed ONLY on the two effects above —
   * entering the wallet tab/dashboard, or `walletsByChain` changing. There was
   * no interval anywhere in this file. A per-chain fetch that failed (an RPC
   * blip, a rate limit, a laptop resuming from sleep) wrote "—" and then stayed
   * "—" indefinitely, because nothing ever retried it. The user reads that as
   * "the balance never loads"; it actually loaded once, failed, and was never
   * asked again.
   *
   * 60s: comfortably inside the 60s spot-price cache and the wallet-rpc poll
   * cadence, and cheap — one request per chain, fired concurrently, against
   * endpoints that answer in ~130ms.
   *
   * Gated on the wallet surface being visible so a backgrounded Mine/Settings
   * tab isn't polling chain RPCs for a list nobody is looking at.
   */
  const walletSurfaceVisible =
    (layout === "landscape" && landscapeTab === "wallet") ||
    (layout === "portrait" && view === "dashboard");

  useEffect(() => {
    if (!walletSurfaceVisible) return;
    if (Object.keys(walletsByChain).length === 0) return;
    const id = window.setInterval(() => {
      void refreshAllBalances();
      void refreshPrices();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [walletSurfaceVisible, walletsByChain, refreshAllBalances, refreshPrices]);

  // Per-chain session hooks (sync state machine, polling, receive address,
  // binary + Defender, auto-store tick). Destructured with aliases to
  // preserve the existing `xmrSyncState` / `zphSyncState` / etc. names
  // used throughout the JSX.
  const {
    syncState: xmrSyncState,
    syncPercent: xmrSyncPercent,
    syncWalletHeight: xmrSyncWalletHeight,
    syncDaemonHeight: xmrSyncDaemonHeight,
    syncError: xmrSyncError,
    syncBlocksPerSec: xmrSyncBlocksPerSec,
    syncEtaSeconds: xmrSyncEtaSeconds,
    setSyncState: setXmrSyncState,
    setSyncError: setXmrSyncError,
    txHistory: xmrTxHistory,
    txLoading: xmrTxLoading,
    receiveAddress: xmrReceiveAddress,
    showPrimary: xmrShowPrimary,
    setShowPrimary: setXmrShowPrimary,
    binaryReady: xmrBinaryReady,
    defenderExcluded: xmrDefenderExcluded,
    downloading: xmrDownloading,
    downloadProgress: xmrDownloadProgress,
    start: startXmrSync,
    retry: retryXmrSync,
    downloadBinary: handleXmrDownloadBinary,
    addDefender: handleXmrAddDefenderExclusion,
    refreshReceiveAddress: refreshXmrReceive,
    lock: lockXmrSession,
    forget: forgetXmrSession,
  } = useXmrSession({
    activeChain,
    focus: featureFocus,
    seedLoaded: xmrSeedLoaded,
    sessionPassword,
    refreshBalance,
  });

  const {
    syncState: zphSyncState,
    syncPercent: zphSyncPercent,
    syncWalletHeight: zphSyncWalletHeight,
    syncDaemonHeight: zphSyncDaemonHeight,
    syncError: zphSyncError,
    syncBlocksPerSec: zphSyncBlocksPerSec,
    syncEtaSeconds: zphSyncEtaSeconds,
    setSyncState: setZphSyncState,
    setSyncError: setZphSyncError,
    binaryReady: zphBinaryReady,
    defenderExcluded: zphDefenderExcluded,
    downloading: zphDownloading,
    downloadProgress: zphDownloadProgress,
    assetBalances: zphAssetBalances,
    refreshAssetBalances: refreshZphAssetBalances,
    start: startZphSync,
    retry: retryZphSync,
    downloadBinary: handleZphDownloadBinary,
    addDefender: handleZphAddDefenderExclusion,
    forget: forgetZphSession,
  } = useZphSession({
    activeChain,
    focus: featureFocus,
    seedLoaded: zphSeedLoaded,
    sessionPassword,
    refreshBalance,
  });
  void setXmrSyncError;
  void setZphSyncError;

  const {
    syncState: zanoSyncState,
    syncError: zanoSyncError,
    binaryReady: zanoBinaryReady,
    downloading: zanoDownloading,
    downloadProgress: zanoDownloadProgress,
    assetBalances: zanoAssetBalances,
    txHistory: zanoTxHistory,
    txLoading: zanoTxLoading,
    start: startZanoSync,
    retry: retryZanoSync,
    forget: forgetZanoSession,
    downloadBinary: handleZanoDownloadBinary,
    refreshAssetBalances: refreshZanoAssetBalances,
  } = useZanoSession({
    activeChain,
    focus: featureFocus,
    seedLoaded: zanoSeedLoaded,
    seedPassphrase: zanoSeedPassphrase,
    sessionPassword,
    refreshBalance,
  });

  const xmrNodes = useXmrNodes({ focus: featureFocus, onError: setError, onSuccess: setSuccess });
  const zphNodes = useZphNodes({ focus: featureFocus, onError: setError, onSuccess: setSuccess });
  const zanoNodes = useZanoNodes({ focus: featureFocus, onError: setError, onSuccess: setSuccess });

  // Live Zephyr protocol stats (reserve ratio, asset prices, APY) from
  // the scanner API. Only polled while the user is actually viewing the
  // Zephyr dashboard — see useZphReserveInfo for the lifecycle gate.
  const zphReserveInfo = useZphReserveInfo({ activeChain, focus: featureFocus });

  useEffect(() => {
    if (wallet && view === "dashboard") {
      setBalance("--");
      setNetworkInfo(null);
      refreshBalance();
    }
  }, [wallet, view, activeChain]);

  // When Zephyr sync finishes, refresh ALL chain balances — not just the
  // active one. Otherwise a "Syncing…" / stale balance cached for Zephyr
  // while the user was on a different chain never gets replaced. Same
  // pattern handles XMR sync completion.
  useEffect(() => {
    if (zphSyncState === "synced") {
      void refreshAllBalances();
    }
  }, [zphSyncState, refreshAllBalances]);
  useEffect(() => {
    if (xmrSyncState === "synced") {
      void refreshAllBalances();
    }
  }, [xmrSyncState, refreshAllBalances]);

  // C8 authority switch — the send half. A BTC/LTC wallet this session's
  // auto-setup pass VERIFIED as sharing the wallet's own account routes
  // through the swap engine instead of this wallet's single-address adapter,
  // because the engine holds the coin's complete account and can see (and
  // spend) UTXOs the adapter cannot — see `sharedCoinBalance.ts`'s header.
  // `undefined` for every other chain, and for a shared chain not (yet)
  // reflected in `swapAutoSetup.shared` — those keep sending exactly as
  // before, unchanged.
  const sharedCoinSendOverride = useMemo(():
    | ((to: string, amount: string) => Promise<{ hash: string }>)
    | undefined => {
    const ticker =
      activeChain === "bitcoin" ? "BTC" : activeChain === "litecoin" ? "LTC" : null;
    if (!ticker || !swapAutoSetup.shared.includes(ticker)) return undefined;
    return async (to, amount) => ({
      hash: await swapSidecarSharedCoinWithdraw(activeChain, to, amount),
    });
  }, [activeChain, swapAutoSetup.shared]);

  /**
   * Dashboard Send for STELLAR / NEAR / SUI.
   *
   * These three were receive-only, and not because the crypto was missing:
   * `swap_sign_stellar_tx` / `swap_sign_near_tx` / `swap_sign_sui_tx` have
   * existed in Rust for months. They were unreachable because the signers are
   * SESSION-GATED — the vault mnemonic stays inside Rust and callers get a
   * short-lived id — and a wallet adapter cannot open a session without
   * importing the vault + swap layers, which `BOUNDARIES.md` forbids in that
   * direction. So `sendTransaction` threw with a comment pointing at a helper
   * that, for Stellar and Sui, did not exist yet.
   *
   * The override lives HERE, in the app layer, for the same reason
   * `deriveSwapMaterial` does: this is the one place that legitimately holds
   * both the vault and the swap feature. Opens a session per send (Rust
   * auto-relocks on TTL) using the session password already in memory, so the
   * user is not prompted again mid-flow.
   */
  const sessionSignedSendOverride = useMemo(():
    | ((to: string, amount: string) => Promise<{ hash: string }>)
    | undefined => {
    if (activeChain !== "stellar" && activeChain !== "near" && activeChain !== "sui") {
      return undefined;
    }
    const from = walletsByChain[activeChain]?.address;
    if (!from || !sessionPassword) return undefined;
    return async (to, amount) => {
      const store = await getStore();
      const encrypted = await store.get<EncryptedData>("wallet");
      if (!encrypted) throw new Error("No saved vault found.");
      const sessionId = await openSendSession(encrypted, sessionPassword);
      if (activeChain === "stellar") {
        const r = await executeStellarTransfer({ sessionId, fromAddress: from, to, amount });
        return { hash: r.txHash };
      }
      if (activeChain === "sui") {
        const r = await executeSuiTransfer({ sessionId, fromAddress: from, to, amount });
        return { hash: r.txHash };
      }
      // NEAR needs the ed25519 public key alongside the account id, and only
      // Rust can produce it from the session — the TS adapter derives the
      // implicit account but not the `ed25519:<base58>` form the tx requires.
      const near = await getNearAddress(sessionId);
      const yocto = decimalToAtomic(amount, 24, "NEAR amount");
      const r = await executeNearNativeTransfer({
        sessionId,
        fromAccountId: near.accountId,
        fromPublicKey: near.publicKey,
        depositAddress: to,
        amountAtomic: yocto.toString(),
        rpcUrl: NEAR_RPCS()[0],
      });
      return { hash: r.txHash };
    };
  }, [activeChain, walletsByChain, sessionPassword]);

  // Send-flow hook — paired with `<SendModal>`. Owns sendTo/sendAmount/
  // sending/showSendModal + the actual `handleSend` action. See M12.
  const {
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
  } = useSend({
    wallet,
    adapter,
    activeChain,
    xmrSeedLoaded,
    refreshBalance,
    refreshTxHistory,
    setError,
    setSuccess,
    sendOverride: sharedCoinSendOverride ?? sessionSignedSendOverride,
  });

  // Vault orchestration — owns pending seeds, the six auth-flow handlers
  // (create / import / setPassword / unlock / removeWallet / logout), and
  // the four save/forget helpers. See `src/features/vault/useVault.ts`.
  const {
    pendingBip39,
    pendingXmrSeed,
    pendingZphSeed,
    handleCreate,
    handleImport,
    handleConfirmDerivation,
    handleSetPassword,
    handleUnlock,
    handleRemoveWallet,
    handleLogout,
    saveXmrSeedToVault,
    saveZphSeedToVault,
    saveZanoSeedToVault,
    addWallet,
    renameWallet,
    removeWallet,
    walletOpBusy,
    switchWallet,
    handleChangeSolanaDerivation,
    handleChangeCardanoDerivation,
    handleChangeAlgorandDerivation,
    handleChangeLitecoinDerivation,
    handleChangeCoinDerivation,
    handleApplyProfile,
    activeDerivationChoice,
    deriveAllChains,
  } = useVault({
    sessionPassword,
    setSessionPassword,
    setError,
    setSuccess,
    setView,
    setWalletsByChain,
    setWalletEntries,
    setActiveWalletId,
    // The VALUE, not just the setter: every post-unlock vault mutator needs to
    // know which wallet context it is writing to.
    activeWalletId,
    setActiveChain,
    setXmrSeedLoaded,
    setZphSeedLoaded,
    setZanoSeedLoaded,
    setZanoSeedPassphrase,
    startXmrSync,
    startZphSync,
    startZanoSync,
    lockXmrSession,
    forgetXmrSession,
    forgetZphSession,
    forgetZanoSession,
    hasSaved,
    setHasSaved,
    setBalance,
    setNetworkInfo,
    setShowPrivateKey,
    setShowMnemonic,
    setShowXmrSeed,
    setShowZphSeed,
    setXmrImportValue,
    // C9 safety gate. Currently a no-op for every user (nothing sets the
    // consent flag this checks yet — see swapSidecarXmrSharedInUse's own
    // doc comment) — passed unconditionally rather than gated on
    // `swapOptedIn` because the check itself is a cheap local read that
    // resolves to false immediately when the sidecar was never opted into.
    checkXmrHostWalletInUse: swapSidecarXmrSharedInUse,
    // The ZEPH/ZANO twin (2026-09-04) — now that the consent toggle is
    // wired, a shared ZEPH/ZANO wallet can genuinely be mid-swap.
    checkCnHostWalletInUse: swapSidecarCnSharedInUse,
  });

  /* ── Unified portfolio derivation (Phase 4) — needs `deriveAllChains`
   * from useVault above, so it lives here rather than with the balance
   * state up top. Derives each BIP39 wallet's addresses (memoized) and
   * builds the flat holdings list the "All Wallets" view aggregates. */
  const addressesByWallet = useMemo(() => {
    const out: Record<string, Partial<Record<ChainType, string>>> = {};
    for (const e of walletEntries) {
      if (e.kind !== "bip39") continue;
      const derived = deriveAllChains(e.seed, {
        ...DEFAULT_DERIVATION_CHOICE,
        ...e.derivationChoice,
      });
      const addrs: Partial<Record<ChainType, string>> = {};
      for (const [chain, info] of Object.entries(derived)) {
        if (info?.address) addrs[chain as ChainType] = info.address;
      }
      out[e.id] = addrs;
    }
    return out;
  }, [walletEntries, deriveAllChains]);

  const unifiedHoldings = useMemo<Holding[]>(() => {
    const out: Holding[] = [];
    for (const e of walletEntries) {
      const bals = balancesByWallet[e.id] ?? {};
      if (e.kind === "bip39") {
        const addrs = addressesByWallet[e.id] ?? {};
        for (const [chain, address] of Object.entries(addrs)) {
          out.push({
            walletId: e.id,
            walletName: e.name,
            chain: chain as ChainType,
            address,
            balance: bals[chain as ChainType],
          });
        }
      } else if ((e.kind === "privateKey" || e.kind === "watch") && e.chain && e.address) {
        // Single-chain accounts: one holding on their stored address.
        out.push({
          walletId: e.id,
          walletName: e.name,
          chain: e.chain,
          address: e.address,
          balance: bals[e.chain],
        });
      }
      // xmr/zph seeds surface in their own panels, not the bip39-chain aggregate.
    }
    return out;
  }, [walletEntries, addressesByWallet, balancesByWallet]);

  // Show the unified aggregate only under "All Wallets" AND when ≥2 wallet
  // contexts exist (single-wallet installs keep today's view — no new chrome).
  const showUnifiedPortfolio =
    activeWalletId === "all" &&
    shouldShowSwitcher({ v: 3, wallets: walletEntries });

  // Watch-only wallets can't sign — intercept Send with a clear message.
  // (The WalletInfo has no key, so the flow is already safe; this makes the
  // failure friendly instead of a cryptic adapter error.)
  const openSendModalGuarded = useCallback(
    (assetType?: string) => {
      if (wallet?.watchOnly) {
        setError("This is a watch-only wallet — you can't send from it.");
        return;
      }
      openSendModal(assetType);
    },
    [wallet, openSendModal, setError]
  );

  const openMoneroNodesView = useCallback(async () => {
    setError("");
    setSuccess("");
    // In landscape mode the Nodes sub-views render under the Settings tab.
    // Without this switch, the cleanup effect (App.tsx ~441) would bounce
    // view back to "dashboard" the moment we set it to "monero-nodes",
    // making the "Manage Nodes" button on the SyncStatusPanel a no-op.
    if (layout === "landscape") setLandscapeTab("settings");
    setView("monero-nodes");
    await xmrNodes.openView();
  }, [xmrNodes, layout, setError, setSuccess, setView]);

  const openZephyrNodesView = useCallback(async () => {
    setError("");
    setSuccess("");
    if (layout === "landscape") setLandscapeTab("settings");
    setView("zephyr-nodes");
    await zphNodes.openView();
  }, [zphNodes, layout, setError, setSuccess, setView]);

  const openZanoNodesView = useCallback(async () => {
    setError("");
    setSuccess("");
    if (layout === "landscape") setLandscapeTab("settings");
    setView("zano-nodes");
    await zanoNodes.openView();
  }, [zanoNodes, layout, setError, setSuccess, setView]);

  const handleChainSwitch = (chain: ChainType) => {
    setActiveChain(chain);
    setError("");
    setSuccess("");
    setSendTo("");
    setSendAmount("");
    setShowPrivateKey(false);
    // Portrait: the scrollable container is `#pwnda-main-content`. When the
    // user scrolls down to the ASSETS card and picks a new chain, the
    // account / balance / history blocks for that chain live above the list,
    // so we snap the scroll surface back to the top so the new selection is
    // immediately visible without manual scrolling. No-op when no scrollable
    // container is found (e.g. landscape, design catalog).
    const main = document.getElementById("pwnda-main-content");
    if (main) main.scrollTo({ top: 0, behavior: "smooth" });
  };

  const copyToClipboard = (text: string, key?: string) => {
    navigator.clipboard.writeText(text);
    if (key) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1400);
    } else {
      setSuccess("Copied to clipboard!");
      setTimeout(() => setSuccess(""), 2000);
    }
  };

  // BIP39 phrase is stored on any non-XMR wallet's .mnemonic field
  const sharedMnemonic =
    Object.entries(walletsByChain)
      .filter(([chain]) => chain !== "monero")
      .map(([, w]) => w?.mnemonic)
      .find((m) => !!m) || "";

  /**
   * Scan-date editor, built once and handed to whichever layout is showing.
   *
   * Same slot pattern as `importPanelSlot`: App already owns every prop it
   * needs, so both roots take one node instead of five props each — and the
   * two layouts cannot drift, because there is only one instance.
   */
  const scanDateSlot = (
    <ScanDateCard
      xmrSeed={xmrSeedLoaded}
      zphSeed={zphSeedLoaded}
      sessionPassword={sessionPassword}
      saveXmrSeedToVault={saveXmrSeedToVault}
      saveZphSeedToVault={saveZphSeedToVault}
    />
  );

  // ── Onboarding ─────────────────────────────────────────────────
  //
  // Rendered AHEAD of the layout branch, so the pre-wallet flow is identical
  // in portrait and landscape by construction rather than by agreement. See
  // `AuthRouter` for the full rationale and the bug this shape removes: these
  // views used to live only inside `ViewRouter` (portrait), while the landscape
  // branch below short-circuited on `isLoggedIn` — which flips true mid-import,
  // before the password step — so in the default layout the password screen
  // never rendered and no wallet was ever written to disk.
  //
  // Keeping this above the layout branch means a future layout can't
  // accidentally swallow onboarding again: there is nothing left to swallow.

  // ── Landscape mode ─────────────────────────────────────────────
  const isLoggedIn = Object.keys(walletsByChain).length > 0;

  // In-flight desk swaps. Mounted HERE, above the landscape early return, so
  // the poller and its history writes keep running whichever layout is active
  // and whatever tab the user is on — a desk swap runs 10-60 minutes and both
  // swap views unmount on navigation. Gated on isLoggedIn so a locked or fresh
  // wallet fires zero desk invokes; deliberately NOT gated on VITE_DESK_LIVE,
  // which governs accepting a NEW swap, never resuming one.
  const deskTracker = useDeskTracker({ enabled: isLoggedIn });

  // In-flight BasicSwap sidecar swaps, mounted here for the same reason as the
  // desk tracker above: a swap runs 30-90 minutes and every swap view unmounts
  // on navigation, so ownership has to sit above the view router.
  //
  // The opt-in gate is enforced INSIDE the hook, not here: the fresh-install
  // contract is that no `swap_sidecar_*` command is invoked until the user has
  // accepted the setup screen, and `isLoggedIn` alone would not honour that.
  const sidecarTracker = useSidecarSwap({ enabled: isLoggedIn });
  /**
   * The convert pipeline (EARN tab / portrait CONVERT mode).
   *
   * Owned HERE, above the landscape/portrait fork, for the same reason
   * `deskTracker` and `sidecarTracker` are: hop 1 is a 30-90 minute
   * peer-to-peer swap, and both `SwapView` and the EARN view unmount on every
   * tab change. It delegates hop-1 tracking to `sidecarTracker` rather than
   * re-tracking anything, so there is exactly one source of truth for a bid.
   *
   * The two seed callbacks are what put the swap surface into the right state
   * for each hop. They set the pair + router and route the user to the Swap
   * tab; the user confirms the rate there. Nothing fires on its own.
   */
  const [convertSeed, setConvertSeed] = useState<{
    from: string;
    to: string;
    amount: string;
    router: "basicswap" | "intents" | "auto";
    nonce: number;
  } | null>(null);

  /**
   * Open the Swap tab with an asset pre-selected, from an asset's SWAP tile.
   *
   * Those tiles were dead for every coin but Zephyr — the landscape one was
   * literally `disabled={activeChain !== "zephyr"}`, so on BTC/ETH/SOL/... it
   * rendered a greyed control that had never done anything. Reported
   * 2026-08-29: "for all assets the swap button doesnt do anything anymore".
   *
   * Reuses the `convertSeed` channel EARN already uses to pre-fill the form,
   * rather than inventing a second one: same seed, same nonce-keyed effect in
   * both swap views, so a fix to pre-filling fixes both entry points.
   *
   * Zephyr routes here too. Its tile used to open the legacy ecosystem modal
   * — "it still has the old swap ui" — and the Swap tab now owns that surface.
   */
  const openSwapForAsset = useCallback(
    (ticker: string) => {
      setConvertSeed({
        from: ticker.toUpperCase(),
        to: "",
        amount: "",
        // AUTO lets the aggregator choose the venue rather than pinning one
        // on the user's behalf from a button that says only "Swap".
        router: "auto",
        nonce: Date.now(),
      });
      setView("swap");
      setLandscapeTab("swap");
    },
    [setView, setLandscapeTab],
  );

  const seedHop1 = useCallback(
    (amount: string) => {
      const xmrBal = parseFloat(balancesByChain.monero ?? "") || 0;
      setConvertSeed({
        from: "XMR",
        to: "LTC",
        amount: amount || (xmrBal > 0 ? String(xmrBal) : ""),
        router: "basicswap",
        nonce: Date.now(),
      });
      setView("swap");
      setLandscapeTab("swap");
    },
    [balancesByChain.monero, setView, setLandscapeTab]
  );

  const seedHop2 = useCallback(
    (amount: string, target: string) => {
      setConvertSeed({
        from: "LTC",
        to: target,
        amount,
        router: "intents",
        nonce: Date.now(),
      });
      setView("swap");
      setLandscapeTab("swap");
    },
    [setView, setLandscapeTab]
  );

  const convertPipeline = useConvertPipeline({
    enabled: isLoggedIn,
    sidecar: sidecarTracker ?? null,
    onSeedHop1: seedHop1,
    onSeedHop2: seedHop2,
  });

  /**
   * Adopt a freshly-submitted P2P swap into BOTH the tracker and, when the
   * convert pipeline is waiting for its first hop, the pipeline.
   *
   * Without this the pipeline seeded the form, the user confirmed a bid, and
   * nothing ever told the pipeline which bid it was — so it sat at
   * "hop1-running" forever and hop 2 was unreachable. The tracker adopt is
   * unconditional; the pipeline adopt is not, because a plain P2P swap the
   * user started from the Swap tab is not a conversion.
   */
  const adoptSidecarSwap = useCallback(
    (handle: Parameters<NonNullable<typeof sidecarTracker>["adopt"]>[0]) => {
      sidecarTracker?.adopt(handle);
      const expectsHop1 =
        convertPipeline.stage === "idle" || convertPipeline.stage === "hop1-running";
      const isConvertLeg =
        handle.sendCoin?.toUpperCase() === "XMR" &&
        handle.receiveCoin?.toUpperCase() === "LTC";
      if (expectsHop1 && isConvertLeg && convertSeed?.router === "basicswap") {
        (convertPipeline as unknown as {
          adoptHop1: (h: typeof handle) => void;
        }).adoptHop1(handle);
      }
    },
    [sidecarTracker, convertPipeline, convertSeed],
  );

  /**
   * XMR available to convert.
   *
   * The wallet cannot tell mined XMR from received XMR - one wallet, one
   * number - so this is the whole balance and the UI says "available", not
   * "mined". See EarnConvertBody's header note.
   */
  const earnSourceBalance = useMemo(() => {
    const raw = balancesByChain.monero;
    if (!raw || raw === "-" || raw === "\u2014" || raw === "Not initialized") return null;
    const n = parseFloat(raw.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }, [balancesByChain.monero]);

  /**
   * The Mine tab's display coin, and the convert rate it implies.
   *
   * Computed HERE rather than in the mining feature because it needs the
   * swap layer's fee model and the EARN target — and
   * `scripts/check-boundaries.mjs` bans `features/mining` from importing
   * `features/swap` so PwndaLite can ship mining without the swap engine.
   * Mining receives a plain number and a ticker.
   */
  const [mineDisplayCoin, setMineDisplayCoin] = useState<string | null>(() =>
    readMineDisplayCoin(),
  );
  const handleSelectMineDisplayCoin = useCallback((ticker: string) => {
    const t = ticker.toUpperCase();
    setMineDisplayCoin(t);
    writeMineDisplayCoin(t);
  }, []);
  /**
   * Assets the mined XMR can actually become.
   *
   * Same source as the EARN tab's own target list — the capability registry
   * via `getDropdownTickers({ router: "intents" })` — so the Mine dropdown
   * and EARN cannot offer different sets. Deliberately NOT 'every wallet
   * asset': the hero's number is the output of XMR -> LTC/BCH -> target, so
   * an asset with no NEAR destination leg is unreachable from mining even
   * though the wallet holds it, and offering it would produce a pick that
   * can only answer 'no route'.
   */
  const mineReachableTickers = useMemo(
    () => getDropdownTickers({ router: "intents" }),
    [],
  );

  /**
   * STABLE identity, and this is not a micro-optimisation.
   *
   * This was an inline arrow in the argument object below. It sits in the
   * hop-2 quote effect's dependency array inside `useRouteEstimate`, so a new
   * identity every render meant: effect fires -> quote resolves -> setState ->
   * render -> new identity -> effect fires. An unbounded render loop that
   * froze the window and took WebView2 to ~600 MB, reported 2026-08-29 as
   * "the wallet ui freeze ... I was no longer able to click any other buttons
   * or move the application window panel".
   *
   * It also called `deriveWalletAddresses(walletsByChain)` on EVERY
   * invocation, re-deriving the whole address set per asset id. That is now
   * memoised on the wallet set.
   */
  const swapWalletAddresses = useMemo(
    () => deriveWalletAddresses(walletsByChain),
    [walletsByChain],
  );
  const addressForAssetStable = useCallback(
    (assetId: string) => addressForAssetId(assetId, swapWalletAddresses),
    [swapWalletAddresses],
  );

  const miningProjection = useMiningProjection({
    displayCoin: mineDisplayCoin,
    earnTargetCoin: convertPipeline.targetCoin,
    prices: pricesByTicker,
    minedAmount: earnSourceBalance,
    // Which order book prices the route: the user's own node once they have
    // opted in, the public snapshot before that. The ESTIMATE is produced
    // either way — the gate belongs on the action, not the information.
    optedIn: swapOptedIn === true,
    // Lets the estimator quote the NEAR leg for real (a dry 1Click quote,
    // cached 20 min) instead of crossing spot prices. Absent addresses just
    // mean hop 2 stays price-crossed and labelled as such.
    addressForAsset: addressForAssetStable,
    // Only fetch a book while a surface that renders it is reachable. The
    // Mine and EARN tabs are the only consumers; a wallet-only session should
    // not be pulling order books.
    enabled: view === "mining" || landscapeTab === "mine" || landscapeTab === "earn",
  });

  const earnMiningState = useMemo(
    () => ({
      active: miner.isAnyMining,
      hardware: miner.miningHardware ? miner.miningHardware.toUpperCase() : null,
      hashrate: null as string | null,
    }),
    [miner.isAnyMining, miner.miningHardware]
  );


  // ── Auth views ────────────────────────────────────────────────
  //
  // MOVED HERE 2026-09-04. This block used to sit ~260 lines higher, ABOVE ten
  // useCallback/useMemo hooks. That made those hooks CONDITIONAL: on an auth
  // view App returned before reaching them, and the moment the user signed in
  // it rendered past this point and called them. React saw more hooks than the
  // previous render, threw "Rendered more hooks than during the previous
  // render", and unmounted the whole tree -- the app went to a black window at
  // exactly the moment of sign-in.
  //
  // Neither branch had the fault alone in an obvious way: the early return
  // arrived with the shared-AuthRouter refactor, the ten hooks with the swap
  // work. `tsc` cannot see it (hook ORDER is not a type), and the unit suites
  // never render App, so 1988 green tests said nothing about it. It is only
  // visible by loading the app and reading the console -- which is why the
  // repo requires a render pass for UI changes, and why skipping that pass on
  // the merge let this reach a real session.
  //
  // Keep this below every hook. If a future refactor wants an early return for
  // auth views, it belongs here or lower, never above the hook block.
  if (AUTH_VIEWS.has(view)) {
    return (
      <div className="window-shell">
        <div data-tauri-drag-region>
          <TitleBar onMin={handleMinimize} onClose={handleClose} />
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}
        <AuthRouter
          view={view}
          setView={setView}
          activeChain={activeChain}
          setActiveChain={setActiveChain}
          pendingBip39={pendingBip39}
          pendingXmrSeed={pendingXmrSeed}
          pendingZphSeed={pendingZphSeed}
          handleCreate={handleCreate}
          handleUnlock={handleUnlock}
          handleRemoveWallet={handleRemoveWallet}
          handleImport={handleImport}
          handleConfirmDerivation={handleConfirmDerivation}
          handleSetPassword={handleSetPassword}
          copyToClipboard={copyToClipboard}
        />
      </div>
    );
  }

  if (layout === "landscape" && isLoggedIn) {
    return (
      <LandscapeRoot
        engineOwnership={engineOwnershipState}
        deskTracker={deskTracker}
        sidecarTracker={sidecarTracker}
        convertPipeline={convertPipeline}
        convertSeed={convertSeed}
        onSidecarSwapAdopt={adoptSidecarSwap}
        earnSourceBalance={earnSourceBalance}
        miningProjection={miningProjection}
        mineReachableTickers={mineReachableTickers}
        onOpenSwapForAsset={openSwapForAsset}
        onSelectMineDisplayCoin={handleSelectMineDisplayCoin}
        earnMiningState={earnMiningState}
        scanDateSlot={scanDateSlot}
        // Seed-import panel for an independent-seed chain the user hasn't set
        // up. Mirrors the portrait branch in `DashboardView`; built here
        // because App already owns every prop these panels need, so landscape
        // gains one prop rather than eight. Landscape is the default layout,
        // so without this Monero and Zephyr had no entry point at all.
        importPanelSlot={
          activeChain === "monero" && !walletsByChain.monero ? (
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
          ) : undefined
        }
        view={view}
        setView={setView}
        activeChain={activeChain}
        setActiveChain={setActiveChain}
        walletsByChain={walletsByChain}
        unifiedHoldings={unifiedHoldings}
        showUnifiedPortfolio={showUnifiedPortfolio}
        addressFor={addressFor}
        wallet={wallet}
        landscapeTab={landscapeTab}
        setLandscapeTab={setLandscapeTab}
        layout={layout}
        setLayout={setLayout}
        balancesByChain={balancesByChain}
        balancesLoading={balancesLoading}
        pricesByTicker={pricesByTicker}
        priceHistoryByTicker={priceHistoryByTicker}
        refreshAllBalances={refreshAllBalances}
        refreshPrices={refreshPrices}
        refreshBalance={refreshBalance}
        refreshZphAssetBalances={refreshZphAssetBalances}
        xmrSeedLoaded={xmrSeedLoaded}
        xmrSyncState={xmrSyncState}
        xmrSyncPercent={xmrSyncPercent}
        xmrSyncWalletHeight={xmrSyncWalletHeight}
        xmrSyncDaemonHeight={xmrSyncDaemonHeight}
        xmrSyncBlocksPerSec={xmrSyncBlocksPerSec}
        xmrSyncEtaSeconds={xmrSyncEtaSeconds}
        xmrSyncError={xmrSyncError}
        xmrDefenderExcluded={xmrDefenderExcluded}
        xmrTxHistory={xmrTxHistory}
        xmrReceiveAddress={xmrReceiveAddress}
        xmrShowPrimary={xmrShowPrimary}
        setXmrShowPrimary={setXmrShowPrimary}
        refreshXmrReceive={refreshXmrReceive}
        retryXmrSync={retryXmrSync}
        handleXmrAddDefenderExclusion={handleXmrAddDefenderExclusion}
        zphSeedLoaded={zphSeedLoaded}
        zphSyncState={zphSyncState}
        zphSyncPercent={zphSyncPercent}
        zphSyncWalletHeight={zphSyncWalletHeight}
        zphSyncDaemonHeight={zphSyncDaemonHeight}
        zphSyncBlocksPerSec={zphSyncBlocksPerSec}
        zphSyncEtaSeconds={zphSyncEtaSeconds}
        zphSyncError={zphSyncError}
        zphDefenderExcluded={zphDefenderExcluded}
        zphAssetBalances={zphAssetBalances}
        retryZphSync={retryZphSync}
        handleZphAddDefenderExclusion={handleZphAddDefenderExclusion}
        zphReserveInfo={zphReserveInfo}
        zanoSeedLoaded={zanoSeedLoaded}
        zanoSyncState={zanoSyncState}
        zanoSyncError={zanoSyncError}
        zanoBinaryReady={zanoBinaryReady}
        zanoDownloading={zanoDownloading}
        zanoDownloadProgress={zanoDownloadProgress}
        zanoAssetBalances={zanoAssetBalances}
        zanoTxHistory={zanoTxHistory}
        zanoTxLoading={zanoTxLoading}
        setZanoSeedLoaded={setZanoSeedLoaded}
        saveZanoSeedToVault={saveZanoSeedToVault}
        startZanoSync={startZanoSync}
        retryZanoSync={retryZanoSync}
        handleZanoDownloadBinary={handleZanoDownloadBinary}
        refreshZanoAssetBalances={refreshZanoAssetBalances}
        chainTxByKey={chainTxByKey}
        chainTxLoading={chainTxLoading}
        chainTxErrors={chainTxErrors}
        ownedChains={ownedChains}
        addressByChain={addressByChain}
        sendTo={sendTo}
        setSendTo={setSendTo}
        sendAmount={sendAmount}
        setSendAmount={setSendAmount}
        sending={sending}
        showSendModal={showSendModal}
        openSendModal={openSendModalGuarded}
        closeSendModal={closeSendModal}
        handleSend={handleSend}
        sendAssetType={sendAssetType}
        showZphSwapModal={showZphSwapModal}
        setShowZphSwapModal={setShowZphSwapModal}
        zphSwapInitialSource={zphSwapInitialSource}
        setZphSwapInitialSource={setZphSwapInitialSource}
        sharedMnemonic={sharedMnemonic}
        showMnemonic={showMnemonic}
        setShowMnemonic={setShowMnemonic}
        showPrivateKey={showPrivateKey}
        setShowPrivateKey={setShowPrivateKey}
        showXmrSeed={showXmrSeed}
        setShowXmrSeed={setShowXmrSeed}
        showZphSeed={showZphSeed}
        zanoSeedPassphrase={zanoSeedPassphrase}
        showZanoSeed={showZanoSeed}
        setShowZanoSeed={setShowZanoSeed}
        setShowZphSeed={setShowZphSeed}
        handleLogout={handleLogout}
        addWallet={addWallet}
        renameWallet={renameWallet}
        removeWallet={removeWallet}
        walletOpBusy={walletOpBusy}
        switchWallet={switchWallet}
        currentSolanaDerivationChoice={activeDerivationChoice.solana}
        handleChangeSolanaDerivation={handleChangeSolanaDerivation}
        currentCardanoDerivationChoice={activeDerivationChoice.cardano}
        handleChangeCardanoDerivation={handleChangeCardanoDerivation}
        currentAlgorandDerivationChoice={activeDerivationChoice.algorand}
        handleChangeAlgorandDerivation={handleChangeAlgorandDerivation}
        currentLitecoinDerivationChoice={activeDerivationChoice.litecoin}
        handleChangeLitecoinDerivation={handleChangeLitecoinDerivation}
        handleChangeCoinDerivation={handleChangeCoinDerivation}
        handleApplyProfile={handleApplyProfile}
        miner={miner}
        miningOptedIn={miningEnabled}
        onEnableMining={enableMining}
        onDisableMining={handleDisableMining}
        xmrNodes={xmrNodes}
        zphNodes={zphNodes}
        zanoNodes={zanoNodes}
        copyToClipboard={copyToClipboard}
        setError={setError}
        openMoneroNodesView={openMoneroNodesView}
        openZephyrNodesView={openZephyrNodesView}
        openZanoNodesView={openZanoNodesView}
        handleMinimize={handleMinimize}
        handleClose={handleClose}
        sessionPassword={sessionPassword}
        setWalletsByChain={setWalletsByChain}
      />
    );
  }


  // ── Portrait mode (existing layout) ────────────────────────────
  // The per-view dispatch (the chain of `view === "..."` blocks plus the
  // window-shell chrome, alerts, modals, and BottomNav) lives in
  // `ViewRouter`. App owns all state/handlers and threads them through.
  return (
    <ViewRouter
      engineOwnership={engineOwnershipState}
      deskTracker={deskTracker}
      sidecarTracker={sidecarTracker}
      convertPipeline={convertPipeline}
      convertSeed={convertSeed}
      onSidecarSwapAdopt={adoptSidecarSwap}
      earnSourceBalance={earnSourceBalance}
      miningProjection={miningProjection}
      mineReachableTickers={mineReachableTickers}
      onOpenSwapForAsset={openSwapForAsset}
      onSelectMineDisplayCoin={handleSelectMineDisplayCoin}
      earnMiningState={earnMiningState}
      scanDateSlot={scanDateSlot}
      addWallet={addWallet}
      renameWallet={renameWallet}
      removeWallet={removeWallet}
      walletOpBusy={walletOpBusy}
      view={view}
      setView={setView}
      activeChain={activeChain}
      setActiveChain={setActiveChain}
      walletsByChain={walletsByChain}
      setWalletsByChain={setWalletsByChain}
      wallet={wallet}
      adapter={adapter}
      error={error}
      setError={setError}
      success={success}
      setSuccess={setSuccess}
      balance={balance}
      balancesByChain={balancesByChain}
      networkInfo={networkInfo}
      loading={loading}
      refreshBalance={refreshBalance}
      pricesByTicker={pricesByTicker}
      priceHistoryByTicker={priceHistoryByTicker}
      copiedKey={copiedKey}
      copyToClipboard={copyToClipboard}
      showPrivateKey={showPrivateKey}
      setShowPrivateKey={setShowPrivateKey}
      showMnemonic={showMnemonic}
      setShowMnemonic={setShowMnemonic}
      showXmrSeed={showXmrSeed}
      setShowXmrSeed={setShowXmrSeed}
      showZphSeed={showZphSeed}
      zanoSeedPassphrase={zanoSeedPassphrase}
      showZanoSeed={showZanoSeed}
      setShowZanoSeed={setShowZanoSeed}
      setShowZphSeed={setShowZphSeed}
      sharedMnemonic={sharedMnemonic}
      sessionPassword={sessionPassword}
      xmrSeedLoaded={xmrSeedLoaded}
      zphSeedLoaded={zphSeedLoaded}
      setXmrSeedLoaded={setXmrSeedLoaded}
      setZphSeedLoaded={setZphSeedLoaded}
      saveXmrSeedToVault={saveXmrSeedToVault}
      saveZphSeedToVault={saveZphSeedToVault}
      layout={layout}
      setLayout={setLayout}
      handleMinimize={handleMinimize}
      handleClose={handleClose}
      xmrSyncState={xmrSyncState}
      xmrSyncPercent={xmrSyncPercent}
      xmrSyncWalletHeight={xmrSyncWalletHeight}
      xmrSyncDaemonHeight={xmrSyncDaemonHeight}
      xmrSyncError={xmrSyncError}
      xmrBinaryReady={xmrBinaryReady}
      xmrDefenderExcluded={xmrDefenderExcluded}
      xmrDownloading={xmrDownloading}
      xmrDownloadProgress={xmrDownloadProgress}
      xmrTxHistory={xmrTxHistory}
      xmrTxLoading={xmrTxLoading}
      xmrReceiveAddress={xmrReceiveAddress}
      xmrShowPrimary={xmrShowPrimary}
      setXmrShowPrimary={setXmrShowPrimary}
      refreshXmrReceive={refreshXmrReceive}
      handleXmrAddDefenderExclusion={handleXmrAddDefenderExclusion}
      handleXmrDownloadBinary={handleXmrDownloadBinary}
      startXmrSync={startXmrSync}
      zphSyncState={zphSyncState}
      zphSyncPercent={zphSyncPercent}
      zphSyncWalletHeight={zphSyncWalletHeight}
      zphSyncDaemonHeight={zphSyncDaemonHeight}
      zphSyncError={zphSyncError}
      zphBinaryReady={zphBinaryReady}
      zphDefenderExcluded={zphDefenderExcluded}
      zphDownloading={zphDownloading}
      zphDownloadProgress={zphDownloadProgress}
      zphAssetBalances={zphAssetBalances}
      refreshZphAssetBalances={refreshZphAssetBalances}
      handleZphAddDefenderExclusion={handleZphAddDefenderExclusion}
      handleZphDownloadBinary={handleZphDownloadBinary}
      startZphSync={startZphSync}
      zphReserveInfo={zphReserveInfo}
      zanoSeedLoaded={zanoSeedLoaded}
      setZanoSeedLoaded={setZanoSeedLoaded}
      saveZanoSeedToVault={saveZanoSeedToVault}
      zanoSyncState={zanoSyncState}
      zanoSyncError={zanoSyncError}
      zanoBinaryReady={zanoBinaryReady}
      zanoDownloading={zanoDownloading}
      zanoDownloadProgress={zanoDownloadProgress}
      zanoAssetBalances={zanoAssetBalances}
      zanoTxHistory={zanoTxHistory}
      zanoTxLoading={zanoTxLoading}
      startZanoSync={startZanoSync}
      retryZanoSync={retryZanoSync}
      handleZanoDownloadBinary={handleZanoDownloadBinary}
      refreshZanoAssetBalances={refreshZanoAssetBalances}
      chainTxByKey={chainTxByKey}
      chainTxLoading={chainTxLoading}
      chainTxErrors={chainTxErrors}
      ownedChains={ownedChains}
      addressByChain={addressByChain}
      sendTo={sendTo}
      setSendTo={setSendTo}
      sendAmount={sendAmount}
      setSendAmount={setSendAmount}
      sending={sending}
      showSendModal={showSendModal}
      openSendModal={openSendModalGuarded}
      closeSendModal={closeSendModal}
      handleSend={handleSend}
      showZphSwapModal={showZphSwapModal}
      setShowZphSwapModal={setShowZphSwapModal}
      zphSwapInitialSource={zphSwapInitialSource}
      setZphSwapInitialSource={setZphSwapInitialSource}
      miner={miner}
      miningOptedIn={miningEnabled}
      onEnableMining={enableMining}
      onDisableMining={handleDisableMining}
      addressFor={addressFor}
      xmrNodes={xmrNodes}
      zphNodes={zphNodes}
      zanoNodes={zanoNodes}
      handleCreate={handleCreate}
      handleImport={handleImport}
      handleConfirmDerivation={handleConfirmDerivation}
      handleSetPassword={handleSetPassword}
      handleUnlock={handleUnlock}
      handleRemoveWallet={handleRemoveWallet}
      handleLogout={handleLogout}
      pendingBip39={pendingBip39}
      pendingXmrSeed={pendingXmrSeed}
      pendingZphSeed={pendingZphSeed}
      activeDerivationChoice={activeDerivationChoice}
      handleChangeSolanaDerivation={handleChangeSolanaDerivation}
      handleChangeCardanoDerivation={handleChangeCardanoDerivation}
      handleChangeAlgorandDerivation={handleChangeAlgorandDerivation}
      handleChangeLitecoinDerivation={handleChangeLitecoinDerivation}
      handleChangeCoinDerivation={handleChangeCoinDerivation}
      handleApplyProfile={handleApplyProfile}
      handleChainSwitch={handleChainSwitch}
      openMoneroNodesView={openMoneroNodesView}
      openZephyrNodesView={openZephyrNodesView}
      openZanoNodesView={openZanoNodesView}
    />
  );
}

export default App;
