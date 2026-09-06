import { EngineOwnershipStrip } from "../swap-sidecar";
import { coercePairForRouter, useRouterPairCoercion } from "./routerPairs";
import type { EngineOwnership } from "../../lib/swapSeedFingerprint";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChainType, WalletInfo } from "../../wallets";
import type { ZphAssetBalance, ZphAssetType } from "../../wallets/zph-rpc";
import { ST } from "../../components/Primitives";
import { CoinIcon } from "../../components/CoinIcon";
import {
  SwapModeTabs,
  PixelCta,
  Chip,
  ChipRow,
  FootNote,
  ReceiveBanner,
  StatusSquare,
} from "./components/swap-ui";
import {
  OffersInstrument,
  RateVsMarketGauge,
} from "./components/p2p-ui";
import { bandsForOffers } from "./components/p2p-instruments";
import {
  buildSwapModeTabs,
  activeSwapModeTab,
  ZEPHYR_TAB_ID,
} from "./components/swap-mode-tabs";
import { EarnConvertBody } from "./EarnConvertBody";
import type { ConvertPipelineState } from "./useConvertPipeline";
import type { ConversionRow } from "./components/earn-ui";
import { SwapForm } from "./SwapForm";
import {
  SWAP_PAIRS,
  SWAP_COIN_META,
  fmtBal,
  isIntentsRoutable,
  isSwapKitRoutable,
  liveCrossRate,
} from "./swap-data";
import { useSwapQuote, type NormalizedQuote } from "./useSwapQuote";
import { DeskConfirmModal } from "./DeskConfirmModal";
import type { DeskSwapSummary } from "../../api/desk-rust";
import { SwapConfirmModal } from "./SwapConfirmModal";
import {
  loadSwapHistory,
  type SwapHistoryEntry,
} from "./swap-history-store";
import { useSwapSettings } from "../settings/useSwapSettings";
import { deriveWalletAddresses } from "./asset-address-resolver";
import { defaultBlockchainFor } from "./intents-dedup";
import type { IntentsBlockchain } from "./near-intents-assets.generated";
import { ZephyrEcosystemSwapCard } from "../zephyr/ZephyrEcosystemSwapCard";
import { DeskSizingStrip } from "./DeskSizingStrip";
import {
  addressForTicker,
  isDeskRoutableFromRegistry,
} from "./asset-capabilities";
import { quickPairsFor, type RouterPreference } from "./router-modes";
import { SidecarConfirmModal } from "../swap-sidecar/SidecarConfirmModal";
import {
  isBasicswapRoutable,
  type SidecarSwapHandle,
  type SidecarTrackedSwap,
} from "../swap-sidecar/useSidecarSwap";
import { useSwapSidecarOptIn } from "../swap-sidecar/swapSidecarOptIn";
import { BID_ARC, arcProgress } from "../swap-sidecar/bidStates";
import {
  elapsedSeconds,
  etaStanding,
  etaWindow,
  formatElapsed,
  formatEtaRange,
} from "../swap-sidecar/swapEta";
import { useNowTick } from "../swap-sidecar/useNowTick";
import {
  useChainSync,
  MarketPreview,
  useCoinStatuses,
  liveEnabledTickersFrom,
} from "../swap-sidecar";
import { formatAmount } from "../swap-sidecar/types";

/**
 * Portrait Swap dashboard — design v2 atomic-exchange surface.
 *
 * Form on top + sub-tabs (`swap` / `history`) + popular pairs grid.
 * Swap routing branches:
 *   - Zephyr-ecosystem pair → existing `<ZephyrSwapModal>` (parent-controlled)
 *   - SwapKit-routable pair (e.g. ETH→BTC) → `<SwapConfirmModal>` here
 *   - Anything else → "coming soon" toast via `setSuccess`
 *
 * History is read live from `swap-history-store` (persisted via
 * `tauri-plugin-store` on every confirm-modal completion).
 */
export function SwapView({
  engineOwnership = "unknown",
  walletsByChain,
  balancesByChain,
  pricesByTicker,
  zphAssetBalances,
  slippage,
  onOpenZephyrSwapModal,
  onSwapToast,
  onDeskSwapAccepted,
  onSidecarSwapAccepted,
  sidecarActiveSwaps,
  onOpenSidecarTracker,
  convertSeed,
  convertPipeline,
  earnSourceBalance = null,
  earnMiningState = { active: false },
  earnConversions = [],
}: {
  /** Whose Grove engine is running. Only `"foreign"` renders anything —
   *  see `EngineOwnershipStrip`. */
  engineOwnership?: EngineOwnership;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  balancesByChain: Partial<Record<ChainType, string>>;
  pricesByTicker: Record<string, number>;
  zphAssetBalances?: ZphAssetBalance[] | null;
  /** Slippage tolerance as a fraction (0.02 = 2%). User-configurable in
   *  Settings → Swap; defaults to 0.02 if the parent doesn't pass it. */
  slippage?: number;
  onOpenZephyrSwapModal: (initialSource?: ZphAssetType) => void;
  onSwapToast: (msg: string) => void;
  /** Called when a desk swap is accepted. The parent holds the summary and
   *  mounts the tracker ABOVE the view router, because this view unmounts on
   *  tab change - a certainty during a 10-60 minute swap. */
  onDeskSwapAccepted?: (summary: DeskSwapSummary) => void;
  /**
   * Called when a BasicSwap bid is accepted by the local node. Same contract
   * as `onDeskSwapAccepted` and for the same reason: this view unmounts on any
   * tab change, which is a certainty during a 30-90 minute swap, so the
   * tracker must live above the view router. Wire it to
   * `useSidecarSwap().adopt` in `ViewRouter.tsx`.
   */
  onSidecarSwapAccepted?: (handle: SidecarSwapHandle) => void;
  /**
   * Every bid the app-level tracker is still following, and the way back into
   * it. Both come from `useSidecarSwap` via `ViewRouter`/`LandscapeRoot`, which
   * own the hook because the tracker must outlive this view.
   *
   * These exist because `openTracker` was built and then never wired to a
   * click: closing the tracker modal mid-swap left tracking running with no
   * way back in (2026-08-23). See `ActiveSidecarSwapsPanel` below.
   */
  sidecarActiveSwaps?: SidecarTrackedSwap[];
  onOpenSidecarTracker?: (bidId: string) => void;
  /**
   * A pending pre-fill from the convert pipeline (frames 1d/1e).
   *
   * The pipeline decides WHEN a hop should be set up; this view owns HOW,
   * because the pair + amount + router live in its own state. `nonce` is what
   * makes a repeat request (same pair, same amount) apply again instead of
   * being swallowed as "no change".
   */
  convertSeed?: {
    from: string;
    to: string;
    amount: string;
    router: "basicswap" | "intents" | "auto";
    nonce: number;
  } | null;

  /** The shared convert pipeline. Portrait reaches it through the
   *  CONVERT segment below rather than a sixth nav tab (frame 1g). */
  convertPipeline?: ConvertPipelineState;
  earnSourceBalance?: number | null;
  earnMiningState?: { active: boolean; hardware?: string | null; hashrate?: string | null };
  earnConversions?: readonly ConversionRow[];
}) {
  const [fromCoin, setFromCoinRaw] = useState("ETH");
  const [toCoin, setToCoinRaw] = useState("BTC");
  const [fromBlockchain, setFromBlockchain] = useState<IntentsBlockchain | undefined>(
    () => defaultBlockchainFor("ETH", { sourceOnly: true }) ?? undefined
  );
  const [toBlockchain, setToBlockchain] = useState<IntentsBlockchain | undefined>(
    () => defaultBlockchainFor("BTC") ?? undefined
  );
  // Wrap setFromCoin / setToCoin so picking a new symbol auto-resets
  // its blockchain to the default for that symbol — otherwise the
  // pill could be left pointing at a stale chain ("USDC on Base" → user
  // picks BTC → blockchain is still "base" until next render).
  const setFromCoin = (next: string) => {
    setFromCoinRaw(next);
    const def = defaultBlockchainFor(next, { sourceOnly: true });
    if (def) setFromBlockchain(def);
    else setFromBlockchain(undefined);
  };
  const setToCoin = (next: string) => {
    setToCoinRaw(next);
    const def = defaultBlockchainFor(next);
    if (def) setToBlockchain(def);
    else setToBlockchain(undefined);
  };
  const [fromAmt, setFromAmt] = useState("");
  const [subTab, setSubTab] = useState<"swap" | "history">("swap");
  /** Frame 1e: the Swap tab has two modes in portrait. */
  const [portraitMode, setPortraitMode] = useState<"swap" | "convert">("swap");
  /**
   * Mode tabs, derived once. See components/swap-mode-tabs.ts for why this
   * is derived rather than listed: a hardcoded copy is how two dead tabs
   * (SwapKit, Desk) survived their own routers being retired.
   */
  const swapModeTabs = useMemo(() => buildSwapModeTabs(), []);


  // Option C redesign (2026-05-25) — Zephyr lives in the same routing
  // strip as AUTO/SWAPKIT/NEAR but swaps the body to the Zephyr asset
  // grid instead of routing the cross-chain form to a different
  // upstream. Mutually-exclusive with the cross-chain form to avoid the
  // 2026-05-07 source/destination lockout bugs.
  const [swapMode, setSwapMode] = useState<"cross" | "zephyr">("cross");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deskConfirmOpen, setDeskConfirmOpen] = useState(false);
  const [sidecarConfirmOpen, setSidecarConfirmOpen] = useState(false);
  const [history, setHistory] = useState<SwapHistoryEntry[]>([]);

  // Fresh-install contract: NOTHING invokes a `swap_sidecar_*` command before
  // the user has opted in. `optedIn === null` means the read is still in
  // flight and is treated as not-enabled, the same rule the mining gate uses.
  const { optedIn: sidecarOptedIn } = useSwapSidecarOptIn();
  const chainSync = useChainSync({ enabled: sidecarOptedIn === true });
  // Is the node actually answering? `useChainSync` only fills `byTicker` from a
  // successful read, so an opted-in wallet with an empty map is a node that is
  // down or still starting. Used to stop MIN asking a stopped node for the
  // offer book and hanging on the 30-second HTTP timeout (2026-09-05).
  // `undefined` while the first poll is outstanding: not-known must not
  // disable the button.
  const sidecarNodeUp =
    sidecarOptedIn === true ? Object.keys(chainSync.byTicker).length > 0 : undefined;
  // The P2P picker's live gate — see SwapLandscapeView for why (2026-09-04).
  const coinStatuses = useCoinStatuses({ enabled: sidecarOptedIn === true });
  const basicswapEnabledTickers = useMemo(
    () => liveEnabledTickersFrom(coinStatuses.statuses),
    [coinStatuses.statuses],
  );

  // User-tunable slippage + router preference from the Settings panel.
  const { slippageFraction, preferredRouter, setPreferredRouter } = useSwapSettings();
  // The pair has to fit the router the user actually lands on, not just the
  // one they click into — see the hook. (2026-09-05: P2P opened on ETH → BTC.)
  useRouterPairCoercion({
    router: preferredRouter,
    fromCoin,
    toCoin,
    setFromCoin: setFromCoin,
    setToCoin: setToCoin,
  });
  /**
   * Apply a convert-pipeline pre-fill.
   *
   * Keyed on `nonce` alone: the user may run the same conversion twice, and a
   * dependency list of the VALUES would silently drop the second run.
   */
  const appliedSeedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!convertSeed) return;
    if (appliedSeedRef.current === convertSeed.nonce) return;
    appliedSeedRef.current = convertSeed.nonce;
    setSwapMode("cross");
    setSubTab("swap");
    void setPreferredRouter(convertSeed.router as RouterPreference);
    // Only overwrite a side the seed actually names. An asset's SWAP tile
    // seeds the FROM coin and leaves the destination alone; blanking it
    // would hand the user an incomplete form instead of a ready one.
    if (convertSeed.from) setFromCoin(convertSeed.from);
    if (convertSeed.to) setToCoin(convertSeed.to);
    if (convertSeed.amount) setFromAmt(convertSeed.amount);
  }, [convertSeed, setPreferredRouter]);

  const effectiveSlippage = slippage ?? slippageFraction;

  const sourceAddress = useMemo(
    () => addressForTicker(fromCoin, walletsByChain),
    [fromCoin, walletsByChain]
  );
  const destinationAddress = useMemo(
    () => addressForTicker(toCoin, walletsByChain),
    [toCoin, walletsByChain]
  );

  // Pre-derived bundle of every chain's address, fed into the resolver
  // for NEAR Intents recipient/refundTo lookup. The resolver REJECTS
  // (with IntentsValidationError) when the bundle is missing the right
  // chain, before any proxy round-trip — saves a daily-cap point.
  const walletAddresses = useMemo(
    () => deriveWalletAddresses(walletsByChain),
    [walletsByChain]
  );

  // Fetch a live quote — `preferredRouter` selects SwapKit / Intents / auto.
  // `paused` suspends the 30s auto-refresh while the confirm modal is
  // open: don't burn rate-limit quota on RPCs the broadcast needs, and
  // don't re-quote out from under the user mid-commit.
  const liveQuoteState = useSwapQuote({
    from: fromCoin,
    to: toCoin,
    amount: fromAmt,
    slippage: effectiveSlippage,
    preferredRouter,
    sourceAddress: sourceAddress ?? undefined,
    destinationAddress: destinationAddress ?? undefined,
    walletAddresses,
    fromBlockchain,
    toBlockchain,
    paused: confirmOpen || deskConfirmOpen || sidecarConfirmOpen,
  });

  // Load persisted swap history on mount + whenever the History tab opens
  // (so a swap that completes mid-session shows up without a manual reload).
  useEffect(() => {
    let cancel = false;
    loadSwapHistory()
      .then((rows) => {
        if (!cancel) setHistory(rows);
      })
      .catch(() => {
        /* gracefully fall back to empty list */
      });
    return () => {
      cancel = true;
    };
  }, [subTab, confirmOpen, deskConfirmOpen, sidecarConfirmOpen]);

  // True when we have a quote (SwapKit OR NEAR Intents) and both wallets.
  // Pre-2026-05-25 the predicate only checked `isSwapKitRoutable`, which
  // meant NEAR-Intents-only pairs (e.g. AVAX→ADA — ADA's swapKitAsset is
  // null because SwapKit routes Cardano through NEAR Intents under the
  // hood) silently produced `confirmReady=false` and the form's swap
  // button never got the `onOpenSwapKitConfirm` handler. The modal
  // already dispatches on `quote.kind` for both routers, so widening
  // this predicate is sufficient.
  // The `source !== "pwnda-desk"` term is load-bearing: the aggregator path
  // ends in SwapConfirmModal (password -> build/sign/broadcast), which is the
  // wrong flow for a desk quote entirely. Gate on the quote actually on screen,
  // not merely on pair routability.
  const confirmReady =
    (isSwapKitRoutable(fromCoin, toCoin) || isIntentsRoutable(fromCoin, toCoin)) &&
    !!liveQuoteState.quote &&
    liveQuoteState.quote.source !== "pwnda-desk" &&
    !!sourceAddress &&
    !!destinationAddress;

  const deskRoutable = isDeskRoutableFromRegistry(fromCoin, toCoin);
  const deskReady =
    deskRoutable &&
    liveQuoteState.quote?.source === "pwnda-desk" &&
    !!sourceAddress &&
    !!destinationAddress;

  // Same shape as `deskReady`, and gated on the QUOTE'S source rather than on
  // pair routability alone for the same reason: the sidecar confirm modal is
  // the wrong flow entirely for an aggregator quote, and a pair can be
  // routable on more than one venue.
  //
  // Only a payout address is required. There is no refund address to collect:
  // on an atomic swap the timelock returns funds to the swap NODE's own
  // wallet, so asking the user for one would imply a choice they do not have.
  const basicswapRoutable = isBasicswapRoutable(fromCoin, toCoin);
  const basicswapReady =
    basicswapRoutable &&
    liveQuoteState.quote?.source === "basicswap" &&
    !!liveQuoteState.quote?.basicswapQuote &&
    !!destinationAddress;

  const openConfirm = () => {
    if (!liveQuoteState.quote) return;
    if (!sourceAddress) {
      onSwapToast(
        `No source wallet for ${fromCoin}. Create the wallet first, then retry.`
      );
      return;
    }
    if (!destinationAddress) {
      onSwapToast(
        `No destination wallet for ${toCoin}. Create the wallet first, then retry.`
      );
      return;
    }
    setConfirmOpen(true);
  };

  // Address semantics FLIP versus the aggregators: for the desk the
  // destination address is where the bought coin lands (payout) and the
  // SOURCE-side address is where funds are reclaimed if the swap fails
  // (refund) — it is not a signing address.
  const openDeskConfirm = () => {
    if (!liveQuoteState.quote) return;
    if (!sourceAddress) {
      onSwapToast(
        `No ${fromCoin} wallet to refund to if the swap fails. Create it first, then retry.`
      );
      return;
    }
    if (!destinationAddress) {
      onSwapToast(
        `No ${toCoin} wallet to receive the swap. Create it first, then retry.`
      );
      return;
    }
    setDeskConfirmOpen(true);
  };

  const openBasicswapConfirm = () => {
    if (!liveQuoteState.quote?.basicswapQuote) return;
    if (!destinationAddress) {
      onSwapToast(
        `No ${toCoin} wallet to receive the swap. Create it first, then retry.`
      );
      return;
    }
    setSidecarConfirmOpen(true);
  };

  return (
    <div
      style={{
        animation: "fade-in .2s ease",
        padding: "4px 2px",
      }}
    >
      <EngineOwnershipStrip ownership={engineOwnership} compact />
      {/* ── SWAP / CONVERT segments (canvas frame 1e) ──────────────
          Portrait does NOT get a sixth bottom-nav tab for the convert
          pipeline: frame 1g drew that and it crams five 8px labels into a
          560px bar. The pipeline lives here instead, as a mode of the Swap
          tab, and renders the SAME <EarnConvertBody> the landscape EARN tab
          does. Hidden entirely when the pipeline is not wired, so this can
          never be a segment that switches to nothing. */}
      {convertPipeline && (
        <div style={{ display: "flex", border: "1px solid var(--border)", background: "var(--surface)", marginBottom: 14 }}>
          {([
            { id: "swap" as const, icon: "⇄", label: "Swap" },
            { id: "convert" as const, icon: "◎", label: "Convert" },
          ]).map((seg, i) => {
            const on = portraitMode === seg.id;
            return (
              <button
                key={seg.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setPortraitMode(seg.id)}
                style={{
                  flex: 1,
                  padding: "10px 4px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 7,
                  background: on ? "var(--accent-soft)" : "transparent",
                  color: on ? "var(--accent)" : "var(--text-muted)",
                  border: "none",
                  borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}`,
                  borderLeft: i === 0 ? undefined : "1px solid var(--border-soft)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                }}
              >
                <span style={{ fontSize: 13, lineHeight: 1 }}>{seg.icon}</span>
                {seg.label}
              </button>
            );
          })}
        </div>
      )}

      {portraitMode === "convert" && convertPipeline ? (
        <EarnConvertBody
          variant="portrait"
          pipeline={convertPipeline}
          sourceBalance={earnSourceBalance}
          pricesByTicker={pricesByTicker}
          mining={earnMiningState}
          conversions={earnConversions}
        />
      ) : (
      <>
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 2,
            textTransform: "uppercase",
            fontFamily: "var(--font-mono)",
          }}
        >
          <ST delay={0}>swap</ST>{" "}
          <span style={{ color: "var(--accent)" }}>·</span>{" "}
          <ST delay={60}>cross-chain</ST>
        </div>
        <div
          style={{
            fontSize: 22,
            color: "var(--white)",
            fontWeight: 600,
            marginTop: 4,
            fontFamily: "var(--font-mono)",
          }}
        >
          <ST speed={18} delay={100}>
            Exchange assets
          </ST>
        </div>
      </div>

      {/* Option C 4-tab strip (2026-05-25): AUTO BEST / SWAPKIT / NEAR /
          ZEPHYR. The first three switch the cross-chain router; ZEPHYR
          swaps the entire body to the in-protocol asset grid (ZEPH /
          ZEPHUSD / ZEPHRSV / ZEPHYRS). History stays a separate toggle. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 16,
          alignItems: "center",
        }}
      >
        {/* Mode tabs — ONE shared strip (frame 1b).
            Was a hardcoded six-entry array whose `SwapKit` and `Desk` tabs
            called a setter that rejects them: a click that changed nothing
            and said nothing (finding F2). The list now derives from the
            live router options, so a retired router cannot reappear as a
            dead tab. See components/swap-mode-tabs.ts. */}
        <div style={{ flex: 1, minWidth: 280 }}>
          <SwapModeTabs
            tabs={swapModeTabs}
            active={activeSwapModeTab(swapMode, preferredRouter)}
            onSelect={(id) => {
              setSubTab("swap");
              if (id === ZEPHYR_TAB_ID) {
                setSwapMode("zephyr");
              } else {
                setSwapMode("cross");
                setPreferredRouter(id as RouterPreference);
                // 2026-09-04: a tab is a venue; keep the pair only if that
                // venue can route it (`routerPairs.ts`). ETH → BTC on the P2P
                // tab was the reported case.
                const next = coercePairForRouter(id as RouterPreference, {
                  from: fromCoin,
                  to: toCoin,
                });
                if (next) {
                  setFromCoin(next.from);
                  setToCoin(next.to);
                }
              }
            }}
          />
        </div>
        <button
          onClick={() => setSubTab(subTab === "history" ? "swap" : "history")}
          className="qbtn"
          style={{
            fontSize: 10,
            padding: "6px 12px",
            letterSpacing: 1,
            textTransform: "uppercase",
            borderColor: subTab === "history" ? "var(--accent-mid)" : "var(--border)",
            color: subTab === "history" ? "var(--accent)" : "var(--text-muted)",
            background: subTab === "history" ? "var(--accent-soft)" : "transparent",
          }}
        >
          history
        </button>
      </div>

      {subTab === "swap" && swapMode === "zephyr" && (
        <ZephyrEcosystemSwapCard
          zphAssetBalances={zphAssetBalances}
          onOpenZephyrSwapModal={onOpenZephyrSwapModal}
          hasZephyrWallet={!!walletsByChain.zephyr}
          embedded
        />
      )}

      {subTab === "swap" && swapMode === "cross" && (
        <>
          <SwapForm
            nodeRunning={sidecarNodeUp}
            fromCoin={fromCoin}
            toCoin={toCoin}
            setFromCoin={setFromCoin}
            setToCoin={setToCoin}
            basicswapEnabledTickers={basicswapEnabledTickers}
            fromAmt={fromAmt}
            setFromAmt={setFromAmt}
            fromBlockchain={fromBlockchain}
            toBlockchain={toBlockchain}
            setFromBlockchain={setFromBlockchain}
            setToBlockchain={setToBlockchain}
            walletsByChain={walletsByChain}
            balancesByChain={balancesByChain}
            pricesByTicker={pricesByTicker}
            zphAssetBalances={zphAssetBalances}
            liveQuote={liveQuoteState.quote}
            liveLoading={liveQuoteState.loading}
            liveError={liveQuoteState.error}
            intentsMinimum={liveQuoteState.intentsMinimum}
            onProbeMinimum={liveQuoteState.probeMinimumNow}
            belowMinimum={liveQuoteState.belowMinimum}
            preferredRouter={preferredRouter}
            onPreferredRouterChange={(p) => void setPreferredRouter(p)}
            onOpenZephyrSwapModal={onOpenZephyrSwapModal}
            onOpenSwapKitConfirm={confirmReady ? openConfirm : undefined}
            onOpenDeskConfirm={deskReady ? openDeskConfirm : undefined}
            onOpenBasicswapConfirm={openBasicswapConfirm}
            deskAddressesMissing={
              deskRoutable && (!sourceAddress || !destinationAddress)
            }
            onSwapToast={onSwapToast}
            suppressRouterStrip
          />

          {/* CC-25: the desk's own size window, its basis, and any sizing input
              it could not look up. Rendered whenever the pair is desk-routable
              rather than only once a quote exists — the point is to show an
              under-minimum amount BEFORE quoting, which is the desk's own EXIT
              for the item. */}
          {deskRoutable && (
            <DeskSizingStrip fromCoin={fromCoin} toCoin={toCoin} amount={fromAmt} />
          )}

          {/* The BasicSwap route carries its OWN action button rather than
              reusing SwapForm's.

              SwapForm's `atomicPreviewFallback` predicate
              (`!zephRouteable && !swapKitRoutable && !intentsRoutable &&
              !deskRoutable && numericFrom > 0`) is true for every
              BasicSwap-only pair — XMR/ZEPH are null on both aggregator asset
              maps and the desk settles only an ADA leg — so it sets
              `atomicPreviewBlocked` and paints a disabled "Atomic swap
              unavailable" button underneath a live quote. That is the third
              occurrence of the 2026-05-25 gating bug and the fix belongs in
              SwapForm (add `&& !basicswapRoutable`, mirrored in
              `swap-form-gating.test.ts`). Until it lands, this strip is what
              the user actually clicks; when it lands, this strip is still the
              right home for the spread preview and the advanced console. */}
          {/* In-flight swaps, ABOVE the router-gated strip and deliberately
              NOT gated on the router: a swap already running is not a
              property of which quote tab happens to be selected. */}
          <ActiveSidecarSwapsPanel
            swaps={sidecarActiveSwaps}
            onOpen={onOpenSidecarTracker}
          />

          {(basicswapRoutable || preferredRouter === "basicswap") && (
            <BasicswapStrip
              fromCoin={fromCoin}
              toCoin={toCoin}
              routable={basicswapRoutable}
              quote={liveQuoteState.quote}
              loading={liveQuoteState.loading}
              error={liveQuoteState.error}
              ready={basicswapReady}
              destinationMissing={!destinationAddress}
              optedIn={sidecarOptedIn === true}
              onReview={openBasicswapConfirm}
              onSwapToast={onSwapToast}
              nodeRunning={sidecarOptedIn === true}
              partSyncPercent={
                chainSync.byTicker.PART
                  ? chainSync.byTicker.PART.verifiedPct
                  : null
              }
            />
          )}

          {/* The Particl card LEFT this tab (frame 1c). Its one actionable
              number — the sync percentage that gates whether the order book
              is complete — is now the `PART n%` chip on the strip above, and
              the full card lives in Settings ▸ swap node. The explainer that
              used to sit here (why an unsynced PART blocks swaps between two
              coins that are not Particl) is preserved as that chip's
              `title`. */}

          {/* The swap-node balances card, the sweep-back section and the
              ZEPH/ZANO remote-wallet cards LEFT this tab on 2026-09-05 — the
              operator's words: "I only want things pertaining to any swaps".
              Sweep-back and the CN cards now live in Settings
              (`SwapNodeExtras`); the balances card is gone, because for a
              shared coin it duplicated the wallet's own number. */}

          {/* Quick pairs moved INTO <SwapForm> (frame 1b) so portrait and
              landscape cannot drift, and so the tiles sit directly under
              the CTA where the mock puts them. This block used to render a
              second, differently-styled copy right here. */}
        </>
      )}

      {subTab === "history" && <HistoryList history={history} />}

      {/* Option C 2026-05-25 — ZephyrEcosystemSwapCard is now mounted
          inside the swap-mode conditional above (embedded as the Zephyr
          tab body) instead of always-rendered below. This eliminates
          the dual-surface confusion ("which one do I use?") while still
          respecting the mutual-exclusion constraint that made the
          standalone card necessary in the first place: separate tab
          body = no shared coin pickers = no 2026-05-07 lockout. */}

      </>
      )}

      {/* Confirm modal — opens on `Swap` for SwapKit-routable pairs. */}
      {liveQuoteState.quote && sourceAddress && destinationAddress && (
        <SwapConfirmModal
          open={confirmOpen}
          fromAsset={fromCoin}
          toAsset={toCoin}
          fromAmount={fromAmt}
          fromBlockchain={fromBlockchain}
          quote={liveQuoteState.quote}
          sourceAddress={sourceAddress}
          sourceMnemonic={
            // ADA is the one TS-signed swap source — it needs the mnemonic
            // (same value ADA Send uses). undefined for every other source.
            fromCoin.toUpperCase() === "ADA"
              ? walletsByChain.cardano?.mnemonic
              : undefined
          }
          destinationAddress={destinationAddress}
          onClose={() => setConfirmOpen(false)}
        />
      )}

      {/* Desk confirm modal. Gated on `deskReady` (which asserts the quote's
          source is pwnda-desk) rather than the shared predicate, so an
          aggregator quote can never open it.

          ADDRESS ORDER IS REVERSED vs SwapConfirmModal and is easy to get
          wrong: for the desk the DESTINATION wallet receives the bought coin
          (payout) and the SOURCE wallet is the reclaim target (refund). */}
      {deskReady && liveQuoteState.quote && sourceAddress && destinationAddress && (
        <DeskConfirmModal
          open={deskConfirmOpen}
          quote={liveQuoteState.quote}
          fromAsset={fromCoin}
          toAsset={toCoin}
          fromAmount={fromAmt}
          fromDecimals={SWAP_COIN_META[fromCoin.toUpperCase()]?.decimals ?? 8}
          payoutAddress={destinationAddress}
          refundAddress={sourceAddress}
          onAccepted={(s) => {
            setDeskConfirmOpen(false);
            // Hand the swap UP: the tracker is mounted above the view router
            // so it survives tab navigation during a 10-60 minute swap.
            onDeskSwapAccepted?.(s);
          }}
          onClose={() => setDeskConfirmOpen(false)}
        />
      )}

      {/* BasicSwap confirm modal. Gated on `basicswapReady` (which asserts the
          quote's source) so an aggregator or desk quote can never open it.

          Only a payout address is passed. Unlike the desk there is no refund
          address to collect: an atomic swap's timelock returns funds to the
          swap NODE's own wallet, and offering the user a refund field would
          imply a choice the protocol does not give them. */}
      {basicswapReady && liveQuoteState.quote && destinationAddress && (
        <SidecarConfirmModal
          open={sidecarConfirmOpen}
          quote={liveQuoteState.quote}
          fromAsset={fromCoin}
          toAsset={toCoin}
          payoutAddress={destinationAddress}
          onSubmitted={(handle) => {
            setSidecarConfirmOpen(false);
            // The amount and its quote belong to the swap that was just
            // sent. Left in place, the form kept showing a live rate and a
            // "REVIEW SWAP" button for a trade already in flight, and the
            // in-progress card underneath was the only sign anything had
            // happened (2026-09-05). Clear it: the tracker is the swap now.
            setFromAmt("");
            // Hand the swap UP: the tracker is mounted above the view router
            // so it survives tab navigation during a 30-90 minute swap.
            onSidecarSwapAccepted?.(handle);
          }}
          onClose={() => setSidecarConfirmOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The P2P panel — "easy mode" (canvas frames 1c landscape / 1f portrait).
 *
 * Exported from this file and imported by `SwapLandscapeView`, unchanged from
 * before: one implementation, two surfaces. `landscapeRouterParity.test.ts`
 * asserts that import, because a forked copy is how this feature shipped
 * portrait-only for weeks in the first place.
 *
 * # What the redesign changed, and what it deliberately did not
 *
 * The old panel said everything in sentences: a spread verdict, a band note,
 * an offer count, a not-routable explanation, a 30–90-minute expectation.
 * Frame 1c turns the *measurements* into instruments — an offer row, a
 * gauge, chips — because a number that must be read as prose is a number the
 * user skips.
 *
 * Three things stayed prose-shaped on purpose:
 *
 * 1. **The engine-not-enabled branch.** It is an instruction, not a
 *    measurement, and it names where to go.
 * 2. **The route error.** `useSidecarSwap` writes those sentences to be read
 *    verbatim ("No one is currently offering X for Y…"); an icon cannot say
 *    which of eight things went wrong.
 * 3. **The refund line.** Kept as the footer's second clause. It is the one
 *    fact that changes what a user does when a swap stalls, and the
 *    behavior contract treats losing safety information as a regression,
 *    not a simplification.
 *
 * The unroutable-pair paragraph IS gone, per the handoff: invalid pairs are
 * unpickable upstream (`CoinPickerButton` filters on
 * `basicswapEnabledTickers`), so the sentence explained a state the user can
 * no longer reach by picking.
 */
export function BasicswapStrip({
  fromCoin,
  toCoin,
  routable,
  quote,
  loading,
  error,
  ready,
  destinationMissing,
  optedIn,
  onReview,
  onSwapToast,
  nodeRunning,
  partSyncPercent,
}: {
  fromCoin: string;
  toCoin: string;
  routable: boolean;
  quote: NormalizedQuote | null;
  loading: boolean;
  error: string | null;
  ready: boolean;
  destinationMissing: boolean;
  optedIn: boolean;
  onReview: () => void;
  onSwapToast: (msg: string) => void;
  /** Drives the `NODE` status chip. */
  nodeRunning?: boolean;
  /** Drives the `PART n%` chip — the order book is empty below 100%. */
  partSyncPercent?: number | null;
}) {
  // How long a swap on THIS pair should take, from the two chains' own
  // confirmation depths. It was the constant "30–90 min" for every route,
  // which overstates LTC↔XMR by about three times (2026-09-05).
  const stripEta = etaWindow(fromCoin, toCoin);
  const book = quote?.source === "basicswap" ? quote.basicswapQuote : undefined;
  const spread = book?.spread ?? null;

  // Offer cells, banded against the SAME thresholds the confirm gate uses.
  const offerRates = (book?.rankedOffers ?? []).map((o) => o.effectiveRate);
  const bands = bandsForOffers(offerRates, spread?.marketRate ?? null);

  return (
    <div
      style={{
        marginTop: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily: "var(--font-mono)",
      }}
    >
      {/* The public market, readable with no node and no opt-in.

          Rendered for opted-in users too, not just as a conversion nudge:
          the local book is empty while Particl syncs, and "the network is
          busy, your node is still catching up" is a different message from
          "there is nothing here". Placed ABOVE the not-enabled sentence
          deliberately — it is the reason to read that sentence. */}
      <MarketPreview enabled optedIn={optedIn} compact />

      {/* Engine not enabled — an instruction, kept as words. */}
      {!optedIn && (
        <div
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface)",
            padding: 12,
            fontSize: 10,
            lineHeight: 1.5,
            color: "var(--text-muted)",
          }}
        >
          The swap node is not enabled on this wallet. Turn it on in Settings —
          nothing is downloaded or started until you do.
        </div>
      )}

      {/* Route error — verbatim, for the reason in this component's doc. */}
      {optedIn && error && (
        <div
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface)",
            padding: 12,
            fontSize: 10,
            lineHeight: 1.5,
            color: "var(--text-muted)",
          }}
        >
          {error}
        </div>
      )}

      {optedIn && !error && loading && !book && (
        <div
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface)",
            padding: 12,
            fontSize: 10,
            color: "var(--text-dim)",
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          reading the offer book…
        </div>
      )}

      {/* ── The instruments ─────────────────────────────────────── */}
      {optedIn && book && (
        <>
          <div style={{ display: "flex", gap: 10 }}>
            <OffersInstrument
              total={book.rankedOffers.length}
              bands={bands}
            />
            <RateVsMarketGauge
              spreadPct={spread?.spreadPct ?? null}
              unverified={spread ? !spread.verified : true}
            />
          </div>

          <ReceiveBanner
            amount={formatAmount(book.receiveAmount, book.receiveDecimals)}
            ticker={toCoin}
            usdLabel={null}
          />
        </>
      )}

      {/* CTA — the ONLY working P2P entry point (SwapForm's own P2P branch
          is unreachable; see the note at this file's `openBasicswapConfirm`).
          Gated states carry their reason in the label rather than being
          silently disabled. */}
      {optedIn && (
        <PixelCta
          disabled={!ready}
          onClick={() => {
            if (!routable) {
              onSwapToast(
                `${fromCoin} → ${toCoin} is not a peer-to-peer pair.`,
              );
              return;
            }
            onReview();
          }}
          label={
            destinationMissing
              ? `${toCoin} WALLET NEEDED`
              : loading && !book
                ? "READING THE OFFER BOOK…"
                : !book
                  ? "NO OFFER TO TAKE YET"
                  : "► REVIEW SWAP"
          }
        />
      )}

      {/* Status chips — the duration expectation, the refund guarantee, and
          the two node facts that used to need their own cards. The duration
          is per pair; see `stripEta` above. */}
      {optedIn && (
        <ChipRow>
          <Chip style={{ fontVariantNumeric: "tabular-nums" }}>
            {stripEta ? formatEtaRange(stripEta) : "30–90 min"}
          </Chip>
          <Chip tone="accent">refund-safe ✓</Chip>
          <Chip tone={nodeRunning ? "accent" : "muted"}>
            <StatusSquare
              size={5}
              color={nodeRunning ? "var(--accent)" : "var(--text-dim)"}
              pulse={!!nodeRunning}
            />
            node
          </Chip>
          {partSyncPercent != null && (
            <Chip
              tone={partSyncPercent >= 100 ? "muted" : "warn"}
              title={
                partSyncPercent >= 100
                  ? "Particl is synced — the order book is complete"
                  : "Particl carries every offer; the book is incomplete until this reaches 100%"
              }
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              part {Math.floor(partSyncPercent)}%
            </Chip>
          )}
        </ChipRow>
      )}

      {optedIn && (
        <FootNote>
          you swap with another user · nothing moves until you confirm
        </FootNote>
      )}
    </div>
  );
}

const STRIP_NOTE: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.5,
  color: "var(--text-muted)",
};

function HistoryList({ history }: { history: SwapHistoryEntry[] }) {
  if (history.length === 0) {
    return (
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          padding: 24,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-dim)",
          textAlign: "center",
          letterSpacing: 0.5,
        }}
      >
        No swaps yet. Completed swaps will appear here.
      </div>
    );
  }
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      {history.map((h, i) => (
        <div
          key={h.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            borderBottom:
              i < history.length - 1
                ? "1px solid var(--border-soft)"
                : "none",
            fontFamily: "var(--font-mono)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <CoinIcon sym={h.fromAsset} size={20} glow={false} />
            <span
              style={{
                margin: "0 4px",
                color: "var(--text-dim)",
                fontSize: 10,
              }}
            >
              →
            </span>
            <CoinIcon sym={h.toAsset} size={20} glow={false} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="tnum"
              style={{ fontSize: 11, color: "var(--text)" }}
            >
              {h.fromAmount} {h.fromAsset} → ~{h.toAmount} {h.toAsset}
            </div>
            <div
              style={{
                fontSize: 9,
                color: "var(--text-dim)",
                marginTop: 2,
                display: "flex",
                gap: 8,
              }}
            >
              <span>{prettyAgo(h.createdAt)}</span>
              {h.sourceExplorerUrl && (
                <a
                  href={h.sourceExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  source ↗
                </a>
              )}
              {h.destExplorerUrl && (
                <a
                  href={h.destExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  dest ↗
                </a>
              )}
            </div>
          </div>
          <span
            style={{
              fontSize: 9,
              color:
                h.status === "success"
                  ? "var(--accent)"
                  : h.status === "pending"
                    ? "var(--warn)"
                    : h.status === "refunded"
                      ? "var(--warn)"
                      : "var(--danger)",
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            {h.status}
          </span>
        </div>
      ))}
    </div>
  );
}

function prettyAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d ago`;
  return `${Math.floor(secs / (7 * 86400))}w ago`;
}

/** Resolve a swap-coin ticker to the user's address on that chain. */
// `addressFor` switch deleted 2026-05-25 — see `asset-capabilities.ts`
// for the registry-driven replacement (`addressForTicker`). Three bugs
// in a day taught us that scattered chainKind switches are how
// silent address-resolution gaps creep in (the CARDANO blocker that
// disabled the swap button despite a valid NEAR Intents quote).

/**
 * A small, ALWAYS-VISIBLE list of BasicSwap swaps still in flight, with a
 * click to reopen the tracker.
 *
 * # The gap this closes (incident, 2026-08-23)
 *
 * `useSidecarSwap` already exposed everything needed to reopen a closed
 * tracker — `swaps` (every tracked bid, not just the focused one) and
 * `openTracker(bidId)` — and nothing in the app ever called `openTracker`.
 * Confirmed by grep: zero call sites outside the hook itself. The operator
 * closed the tracker modal mid-swap and had no way back in; tracking kept
 * running the whole time, invisibly.
 *
 * # Two deliberate choices
 *
 * **Not gated on `preferredRouter`.** `BasicswapStrip` is, correctly — it is
 * a quote surface. This is not: a swap in flight has to stay reachable when
 * the user switches tabs to price something else, which is exactly when they
 * would lose it otherwise.
 *
 * **Filters on `stage.terminal`, not on a state allow-list.** `bidStates.ts`
 * already decides what "still moving" means; re-deriving it here would be a
 * second copy to drift. A settled or failed swap drops off on its own.
 *
 * Shared: portrait mounts it directly, `SwapLandscapeView` imports it from
 * here — one implementation, matching the `BasicswapStrip` precedent.
 */
export function ActiveSidecarSwapsPanel({
  swaps,
  onOpen,
}: {
  swaps?: SidecarTrackedSwap[];
  onOpen?: (bidId: string) => void;
}) {
  const inFlight = (swaps ?? []).filter((s) => !s.stage.terminal);
  // The clock. Ticks only while something is actually in flight, and is read
  // BEFORE the early return so the hook order never changes.
  const now = useNowTick(inFlight.length > 0);
  if (inFlight.length === 0 || !onOpen) return null;

  // Rebuilt 2026-09-05. This was a one-line button inside a thin green
  // border — after "Run in background" it was the only sign a swap existed,
  // and the operator could not tell it from the wall of text around it. A
  // swap in flight is the most important thing on this tab: it gets the
  // step, a progress bar, the last check, and room.
  return (
    <div
      data-active-swaps
      style={{
        border: "1px solid var(--accent)",
        background: "rgba(0,255,102,0.08)",
        padding: "12px 14px",
        marginBottom: 14,
        fontFamily: "var(--font-mono)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 10,
          letterSpacing: 1.6,
          textTransform: "uppercase",
          color: "var(--accent)",
          marginBottom: 10,
        }}
      >
        <StatusSquare size={7} color="var(--accent)" pulse />
        {inFlight.length === 1
          ? "swap in progress"
          : `${inFlight.length} swaps in progress`}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {inFlight.map((s) => {
          const progress = arcProgress(s.stage.stage);
          const attention = s.stage.severity === "attention";
          const step = s.stage.label || s.detail?.state_description || "Working";
          // Elapsed + expected, per pair. The single most useful thing this
          // card can say is "yes, still going, and here is how long that has
          // been" — see `swapEta.ts` (2026-09-05, operator request).
          const elapsed = elapsedSeconds(s.createdAt, now);
          const window = etaWindow(s.sendCoin, s.receiveCoin);
          const standing = etaStanding(elapsed, window);
          return (
            <button
              key={s.bidId}
              onClick={() => onOpen(s.bidId)}
              title="Open the swap tracker"
              data-active-swap
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                background: "var(--surface)",
                border: `1px solid ${attention ? "rgba(255,170,0,0.5)" : "var(--border-hi)"}`,
                color: "var(--text)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 10,
                  fontSize: 12,
                }}
              >
                <span>
                  {s.sendAmount} {s.sendCoin} → {s.receiveAmount} {s.receiveCoin}
                </span>
                <span
                  data-swap-elapsed
                  style={{
                    fontSize: 11,
                    letterSpacing: 0.5,
                    whiteSpace: "nowrap",
                    color:
                      standing === "overdue"
                        ? "var(--warn)"
                        : attention
                          ? "var(--warn)"
                          : "var(--accent)",
                  }}
                >
                  {elapsed == null ? "OPEN ↗" : formatElapsed(elapsed)}
                </span>
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 13,
                  color: attention ? "var(--warn)" : "var(--accent)",
                }}
              >
                {step}
              </div>
              {progress != null && (
                <div
                  aria-hidden
                  style={{
                    marginTop: 8,
                    height: 4,
                    background: "var(--border)",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: `${Math.max(6, Math.round(progress * 100))}%`,
                      background: "var(--accent)",
                    }}
                  />
                </div>
              )}
              <div style={{ marginTop: 6, fontSize: 9, color: "var(--text-dim)" }}>
                {progress != null
                  ? `step ${Math.min(BID_ARC.length, Math.round(progress * (BID_ARC.length - 1)) + 1)} of ${BID_ARC.length}`
                  : s.stage.severity === "attention"
                    ? "needs a look"
                    : "in progress"}
                {s.lastPolledAt
                  ? ` · checked ${Math.max(1, Math.floor((now - s.lastPolledAt) / 1000))}s ago`
                  : " · waiting for the first check"}
                {window
                  ? ` · ${standing === "onTrack" ? "usually" : "usually only"} ${formatEtaRange(window)}`
                  : ""}
                {" · keeps running if you leave · "}
                {/* The clock took the header's slot, so the "this opens
                    something" affordance moves here rather than being lost. */}
                <span style={{ color: "var(--text)" }}>OPEN ↗</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
