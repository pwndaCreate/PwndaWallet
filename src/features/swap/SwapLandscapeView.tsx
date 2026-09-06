import { EngineOwnershipStrip } from "../swap-sidecar";
import { coercePairForRouter, useRouterPairCoercion } from "./routerPairs";
import type { EngineOwnership } from "../../lib/swapSeedFingerprint";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChainType, WalletInfo } from "../../wallets";
import type { ZphAssetBalance, ZphAssetType } from "../../wallets/zph-rpc";
import { ST, Dot } from "../../components/Primitives";
import { CoinIcon } from "../../components/CoinIcon";
import { SwapModeTabs } from "./components/swap-ui";
import {
  buildSwapModeTabs,
  activeSwapModeTab,
  ZEPHYR_TAB_ID,
} from "./components/swap-mode-tabs";
import { SwapForm } from "./SwapForm";
import {
  SWAP_COIN_META,
  SWAP_PAIRS,
  fmtBal,
  isIntentsRoutable,
  isSwapKitRoutable,
  liveCrossRate,
  pairKey,
} from "./swap-data";
import { useSwapQuote } from "./useSwapQuote";
import { DeskConfirmModal } from "./DeskConfirmModal";
import type { DeskSwapSummary } from "../../api/desk-rust";
import { SwapConfirmModal } from "./SwapConfirmModal";
// ONE implementation, imported — never a landscape-local fork. A second
// copy of either is the same drift the router list already suffered; see
// landscapeRouterParity.test.ts, which fails if these stop being imports.
import { BasicswapStrip, ActiveSidecarSwapsPanel } from "./SwapView";
import { SidecarConfirmModal } from "../swap-sidecar/SidecarConfirmModal";
import {
  isBasicswapRoutable,
  type SidecarSwapHandle,
  type SidecarTrackedSwap,
} from "../swap-sidecar/useSidecarSwap";
import { defaultBlockchainFor } from "./intents-dedup";
import type { IntentsBlockchain } from "./near-intents-assets.generated";
import { ZephyrEcosystemSwapCard } from "../zephyr/ZephyrEcosystemSwapCard";
import {
  useChainSync,
  useSwapSidecarOptIn,
  useCoinStatuses,
  liveEnabledTickersFrom,
} from "../swap-sidecar";
import {
  loadSwapHistory,
  type SwapHistoryEntry,
} from "./swap-history-store";
import { useSwapSettings } from "../settings/useSwapSettings";
import { deriveWalletAddresses } from "./asset-address-resolver";
import {
  addressForTicker,
  isDeskRoutableFromRegistry,
} from "./asset-capabilities";
import {
  ROUTER_PREFERENCE_OPTIONS,
  quickPairsFor,
  type RouterPreference,
} from "./router-modes";

/**
 * Landscape Swap — a single centred column (rebuilt 2026-08-21).
 *
 * In reading order: route strip → form → the swap node's own balances →
 * quick pairs → history → provider disclosure. One column, `maxWidth`
 * 540, the same shape every other wallet's swap screen uses.
 *
 * # What this replaced, and why
 *
 * This was a 3-column trading-desk grid: a 320 px form rail, a centre
 * column carrying a price hero + 24h chart + orderbook, and a 320 px
 * market-stats rail. It went in three rounds, all driven by the same
 * operator complaint:
 *
 *  1. The **orderbook** was removed outright. It never had a live source
 *     — `ORDERBOOK_BIDS`/`ORDERBOOK_ASKS` were static rows carried over
 *     from the original design mockup — and worse, it rendered
 *     identically no matter which router was selected, including NEAR
 *     Intents, a solver-based aggregator with no bid/ask depth concept
 *     at all. So on the one route that works end to end it was not just
 *     fake numbers, it was a UI paradigm that does not apply.
 *  2. The **collapse toggle** ("▸ show market data") went with it. It had
 *     been the previous round's answer and was the wrong one: hiding a
 *     surface by default does not make it correct, and the operator
 *     could not find the control anyway.
 *  3. The **chart + market stats** followed here. `24h high`/`low`/
 *     `change` were derived from the same cross-rate series the chart
 *     drew, which falls back to a synthetic curve whenever either side
 *     lacks cached history — so on most pairs they were shaped like data
 *     without being data. `24h volume` and `spread` never had a source
 *     at all and rendered a literal "—".
 *
 * What survived is what a swap screen actually needs: the route the user
 * picked, the form, the balances that route spends from, and an honest
 * one-line disclosure of how settlement works. The rate a user acts on
 * is the quote inside {@link SwapForm}, fetched per-amount — not
 * inferred from two USD spot histories.
 *
 * Full incident trail: `PwndaWalletVault/log.md`, 2026-08-21.
 */
export function SwapLandscapeView({
  engineOwnership = "unknown",
  walletsByChain,
  balancesByChain,
  pricesByTicker,
  zphAssetBalances,
  onOpenZephyrSwapModal,
  onSwapToast,
  onDeskSwapAccepted,
  onSidecarSwapAccepted,
  sidecarActiveSwaps,
  onOpenSidecarTracker,
  convertSeed,
}: {
  /** Whose Grove engine is running. Only `"foreign"` renders anything —
   *  see `EngineOwnershipStrip`. */
  engineOwnership?: EngineOwnership;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  balancesByChain: Partial<Record<ChainType, string>>;
  pricesByTicker: Record<string, number>;
  zphAssetBalances?: ZphAssetBalance[] | null;
  /** User's slippage preference (0.02 = 2%). Defaults to 0.02. */
  slippage?: number;
  onOpenZephyrSwapModal: (initialSource?: ZphAssetType) => void;
  onSwapToast: (msg: string) => void;
  /** Called when a desk swap is accepted. The parent holds the summary and
   *  mounts the tracker ABOVE the view router, because this view unmounts on
   *  tab change - a certainty during a 10-60 minute swap. */
  onDeskSwapAccepted?: (summary: DeskSwapSummary) => void;
  /** Same contract as `onDeskSwapAccepted`, for a BasicSwap P2P swap. */
  onSidecarSwapAccepted?: (handle: SidecarSwapHandle) => void;
  /** Mirrors SwapView.tsx — see `ActiveSidecarSwapsPanel` there for why this
   *  reopen affordance exists. */
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

}) {
  const [fromCoin, setFromCoinRaw] = useState("ETH");
  /**
   * Mode tabs, derived once. See components/swap-mode-tabs.ts for why this
   * is derived rather than listed: a hardcoded copy is how two dead tabs
   * (SwapKit, Desk) survived their own routers being retired.
   */
  const swapModeTabs = useMemo(() => buildSwapModeTabs(), []);


  const [toCoin, setToCoinRaw] = useState("BTC");
  const [fromBlockchain, setFromBlockchain] = useState<IntentsBlockchain | undefined>(
    () => defaultBlockchainFor("ETH", { sourceOnly: true }) ?? undefined
  );
  const [toBlockchain, setToBlockchain] = useState<IntentsBlockchain | undefined>(
    () => defaultBlockchainFor("BTC") ?? undefined
  );
  const setFromCoin = (next: string) => {
    setFromCoinRaw(next);
    const def = defaultBlockchainFor(next, { sourceOnly: true });
    setFromBlockchain(def ?? undefined);
  };
  const setToCoin = (next: string) => {
    setToCoinRaw(next);
    const def = defaultBlockchainFor(next);
    setToBlockchain(def ?? undefined);
  };
  const [fromAmt, setFromAmt] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deskConfirmOpen, setDeskConfirmOpen] = useState(false);
  const [sidecarConfirmOpen, setSidecarConfirmOpen] = useState(false);
  const [history, setHistory] = useState<SwapHistoryEntry[]>([]);

  const sourceAddress = useMemo(
    () => addressForTicker(fromCoin, walletsByChain),
    [fromCoin, walletsByChain]
  );
  const destinationAddress = useMemo(
    () => addressForTicker(toCoin, walletsByChain),
    [toCoin, walletsByChain]
  );

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
    void setPreferredRouter(convertSeed.router as RouterPreference);
    // Only overwrite a side the seed actually names. An asset's SWAP tile
    // seeds the FROM coin and leaves the destination alone; blanking it
    // would hand the user an incomplete form instead of a ready one.
    if (convertSeed.from) setFromCoin(convertSeed.from);
    if (convertSeed.to) setToCoin(convertSeed.to);
    if (convertSeed.amount) setFromAmt(convertSeed.amount);
  }, [convertSeed, setPreferredRouter]);


  // C0.1 — the swap node's own balances. This is the surface where "the coins
  // I can trade right now" is a different number from "the coins in my
  // wallet", and until it is shown the difference only becomes visible as a
  // failed swap. Polling is gated on the opt-in flag, not on this view being
  // open: `optedIn !== true` (including the null in-flight read) means no
  // `swap_sidecar_*` invoke fires at all, per the fresh-install contract.
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
  // The P2P picker's live gate (2026-09-04). `basicswapPickerTickers` has
  // taken a `liveEnabled` set since 2026-08-22, and NEITHER view ever passed
  // one — so every protocol-legal coin was offered whether or not the node
  // ran it, and a ZEPH/ZANO the engine had parked for the session built a
  // pair that could only dead-end. Same source portrait uses (SwapView), so
  // the two pickers cannot disagree about what the node is running.
  const coinStatuses = useCoinStatuses({ enabled: sidecarOptedIn === true });
  const basicswapEnabledTickers = useMemo(
    () => liveEnabledTickersFrom(coinStatuses.statuses),
    [coinStatuses.statuses],
  );
  // Option C redesign (2026-05-25) — Zephyr is a 4th tab alongside
  // AUTO/SWAPKIT/NEAR. Cross tabs share the form; Zephyr swaps in the
  // 4-asset grid body.
  const [swapMode, setSwapMode] = useState<"cross" | "zephyr">("cross");
  const walletAddresses = useMemo(
    () => deriveWalletAddresses(walletsByChain),
    [walletsByChain]
  );
  const liveQuoteState = useSwapQuote({
    from: fromCoin,
    to: toCoin,
    amount: fromAmt,
    slippage: slippageFraction,
    preferredRouter,
    sourceAddress: sourceAddress ?? undefined,
    destinationAddress: destinationAddress ?? undefined,
    walletAddresses,
    fromBlockchain,
    toBlockchain,
    paused: confirmOpen || deskConfirmOpen || sidecarConfirmOpen,
  });

  useEffect(() => {
    let cancel = false;
    loadSwapHistory()
      .then((rows) => {
        if (!cancel) setHistory(rows);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [confirmOpen, deskConfirmOpen]);

  // BasicSwap — the ONLY route carrying XMR against a bitcoin-family coin,
  // and the only peer-to-peer route for a bitcoin-family pair. Mirrors
  // SwapView.tsx line for line; landscape shipped the router TAB for this
  // without the surface behind it once already (2026-08-22), which is why
  // landscapeRouterParity.test.ts now asserts the mounts and not just the tab.
  const basicswapRoutable = isBasicswapRoutable(fromCoin, toCoin);
  const basicswapReady =
    basicswapRoutable &&
    liveQuoteState.quote?.source === "basicswap" &&
    !!liveQuoteState.quote?.basicswapQuote &&
    !!destinationAddress;

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

  // Pre-2026-05-25 this only checked `isSwapKitRoutable`. NEAR-Intents-
  // only pairs (AVAX→ADA etc.) silently produced `swapKitReady=false`
  // and the swap button never got a confirm handler. Modal dispatches
  // on `quote.kind` for both routers, so widening the predicate is the
  // whole fix. Mirrors the SwapView.tsx + SwapForm.tsx changes.
  const swapKitReady =
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

  // Destination = payout (receives the bought coin); source = refund (where
  // funds are reclaimed if the swap fails). Not a signing address.
  const openDeskConfirm = () => {
    if (!liveQuoteState.quote) return;
    if (!sourceAddress || !destinationAddress) {
      onSwapToast(
        `Need a ${toCoin} wallet to receive and a ${fromCoin} wallet to refund to. Create them first.`
      );
      return;
    }
    setDeskConfirmOpen(true);
  };

  const openSwapKitConfirm = () => {
    if (!liveQuoteState.quote) return;
    if (!sourceAddress || !destinationAddress) {
      onSwapToast(
        `Need wallets for both ${fromCoin} and ${toCoin}. Create them first.`
      );
      return;
    }
    setConfirmOpen(true);
  };

  // `meta` survives the 2026-08-21 chart removal for ONE field —
  // `meta.provider`, read by the provider disclosure at the foot of the
  // column. The cross-rate series and the 24h high/low/change derived
  // from it went with the chart; the live rate a user acts on is the
  // quote inside `SwapForm`, which is fetched per-amount rather than
  // inferred from two USD spot histories.
  const meta = SWAP_PAIRS[pairKey(fromCoin, toCoin)];

  return (
    <div
      className="no-scroll-bar"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        background: "var(--bg)",
        display: "flex",
        justifyContent: "center",
        padding: "22px 18px 48px",
        animation: "fade-in .2s ease",
      }}
    >
      <div style={{ position: "absolute", left: 18, right: 18, top: 6, zIndex: 2 }}>
        <EngineOwnershipStrip ownership={engineOwnership} />
      </div>
      {/* ONE centered column (2026-08-21). This was a 3-column
          trading-desk grid — form rail | chart + orderbook | market
          stats rail. The operator asked for "a regular swap tab like
          every other crypto wallet" with Exodus / Atomic / Phantom as
          the reference, and all three are the same shape: a single
          centered card, from-asset over to-asset, one primary action,
          and a one-line provider disclosure. Everything that used to
          fill the side rails was either not real (the orderbook — see
          the removal note in the module header) or derived from the
          same sometimes-synthetic chart series the rate hero used
          (24h high / low / change; volume and spread never had a
          source at all and rendered a literal "—").

          What survived the cut is what a wallet swap screen actually
          needs, in reading order: route → form → the balances the
          route spends from → shortcuts → history → disclosure.

          `display: block` on the column is load-bearing (L1,
          2026-05-25): a flex column forces children carrying
          `minHeight: 0` — the `<Card>` inside
          `<ZephyrEcosystemSwapCard>` — below their content height,
          collapsing the Card body to ~0 px while its children paint
          into the next sibling's band. */}
      <div
        style={{
          width: "100%",
          maxWidth: 540,
          display: "block",
        }}
      >
        <div
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 2,
            textTransform: "uppercase",
            marginBottom: 12,
            fontFamily: "var(--font-mono)",
          }}
        >
          <ST delay={0}>swap · atomic exchange</ST>
        </div>

        {/* Option C 4-tab strip (2026-05-25). AUTO/SWAPKIT/NEAR drive
            the cross-chain router; ZEPHYR swaps the body to the
            Zephyr in-protocol asset grid. */}
        {/* Mode tabs — the SAME shared strip portrait renders (frame 1b).
            This block already derived its routers (after the 2026-08-19
            drift), but it still owned its own markup and label map. Both now
            live in components/swap-mode-tabs.ts + <SwapModeTabs>, so the two
            surfaces cannot diverge in appearance either. */}
        <div style={{ marginBottom: 12 }}>
          <SwapModeTabs
            tabs={swapModeTabs}
            active={activeSwapModeTab(swapMode, preferredRouter)}
            onSelect={(id) => {
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

        {swapMode === "cross" && (
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
            onOpenSwapKitConfirm={swapKitReady ? openSwapKitConfirm : undefined}
            onOpenDeskConfirm={deskReady ? openDeskConfirm : undefined}
            onOpenBasicswapConfirm={openBasicswapConfirm}
            deskAddressesMissing={
              deskRoutable && (!sourceAddress || !destinationAddress)
            }
            onSwapToast={onSwapToast}
            compact
            suppressRouterStrip
          />
        )}

        {/* In-flight swaps. NOT gated on the router — a running swap is not a
            property of which quote tab is selected. */}
        {swapMode === "cross" && (
          <ActiveSidecarSwapsPanel
            swaps={sidecarActiveSwaps}
            onOpen={onOpenSidecarTracker}
          />
        )}

        {/* The P2P surface itself. Landscape offered this router tab with
            nothing behind it for weeks; the strip is what the tab leads to. */}
        {swapMode === "cross" &&
          (basicswapRoutable || preferredRouter === "basicswap") && (
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

        {swapMode === "zephyr" && (
          <ZephyrEcosystemSwapCard
            zphAssetBalances={zphAssetBalances}
            onOpenZephyrSwapModal={onOpenZephyrSwapModal}
            hasZephyrWallet={!!walletsByChain.zephyr}
            embedded
          />
        )}

        {/* The swap-node balances card, sweep-back and the ZEPH/ZANO cards
            LEFT this tab on 2026-09-05 — see `SwapView.tsx` at the same spot
            and `settings/SwapNodeExtras.tsx`, which both layouts mount. */}

          {/* The Particl card LEFT this tab (frame 1c). Its one actionable
              number — the sync percentage that gates whether the order book
              is complete — is now the `PART n%` chip on the strip above, and
              the full card lives in Settings ▸ swap node. The explainer that
              used to sit here (why an unsynced PART blocks swaps between two
              coins that are not Particl) is preserved as that chip's
              `title`. */}

        {/* Quick pairs now live inside <SwapForm> — see the note in
            SwapView.tsx. Landscape rendered its own copy with a different
            tile layout; two copies of the same affordance is exactly the
            drift the shared-component rule exists to stop. */}
        {/* ── History + disclosure ─────────────────────────────
            What is left of the old RIGHT rail. The market block that
            used to head it (spot rate, 24h high/low/change, volume,
            spread) went with the chart: high/low/change were derived
            from the same series the chart drew, so on any pair without
            cached history they were synthetic; volume and spread never
            had a source and always rendered a literal "—". The two
            blocks below are real — `history` is this device's own
            persisted swap log, and the provider rows are fixed facts
            about how a pwnda swap settles, which is exactly the
            disclosure Exodus and Atomic both put under their form. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            marginTop: 24,
            paddingTop: 18,
            borderTop: "1px solid var(--border-soft)",
          }}
        >
        {/* Recent swaps */}
        <div>
          <div
            style={{
              fontSize: 9.5,
              color: "var(--text-muted)",
              letterSpacing: 1.5,
              textTransform: "uppercase",
              marginBottom: 10,
              fontFamily: "var(--font-mono)",
            }}
          >
            <ST delay={140}>recent swaps</ST>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {history.length === 0 && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-dim)",
                  padding: "10px 0",
                }}
              >
                No swaps yet.
              </div>
            )}
            {history.slice(0, 10).map((h) => {
              const fromAmtNum = parseFloat(h.fromAmount);
              const toAmtNum = parseFloat(h.toAmount);
              return (
                <div
                  key={h.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 0",
                    borderBottom: "1px solid var(--border-soft)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                  >
                    <CoinIcon sym={h.fromAsset} size={16} glow={false} />
                    <span style={{ color: "var(--text-dim)", fontSize: 8 }}>
                      →
                    </span>
                    <CoinIcon sym={h.toAsset} size={16} glow={false} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="tnum"
                      style={{ fontSize: 10, color: "var(--text)" }}
                    >
                      {Number.isFinite(fromAmtNum) ? fmtBal(fromAmtNum) : h.fromAmount}{" "}
                      → {Number.isFinite(toAmtNum) ? fmtBal(toAmtNum) : h.toAmount}
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        color: "var(--text-dim)",
                        marginTop: 1,
                      }}
                    >
                      {prettyAgo(h.createdAt)} · {h.status}
                    </div>
                  </div>
                  <Dot
                    color={
                      h.status === "success"
                        ? "green"
                        : h.status === "pending"
                          ? "amber"
                          : "red"
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>

        <Divider />

        {/* Provider */}
        <div>
          <div
            style={{
              fontSize: 9.5,
              color: "var(--text-muted)",
              letterSpacing: 1.5,
              textTransform: "uppercase",
              marginBottom: 10,
              fontFamily: "var(--font-mono)",
            }}
          >
            <ST delay={180}>provider</ST>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 10,
              fontFamily: "var(--font-mono)",
            }}
          >
            <KvRow k="engine" v={meta?.provider ?? "Pwnda Atomic"} />
            <KvRow k="type" v="non-custodial" />
            <KvRow k="privacy" v="no KYC" tone="accent" />
            <KvRow k="escrow" v="atomic lock" />
          </div>
        </div>
      </div>
      </div>

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
          quote's source is basicswap) so no other route can open it. Address
          semantics match the desk's, not the aggregators': this is the PAYOUT
          wallet, never a signing address. */}
      {basicswapReady && liveQuoteState.quote && destinationAddress && (
        <SidecarConfirmModal
          open={sidecarConfirmOpen}
          quote={liveQuoteState.quote}
          fromAsset={fromCoin}
          toAsset={toCoin}
          payoutAddress={destinationAddress}
          onSubmitted={(handle) => {
            setSidecarConfirmOpen(false);
            // Same reason as portrait: the form must not keep quoting a trade
            // that is already in flight (2026-09-05).
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

// `addressFor` switch deleted 2026-05-25 — see `asset-capabilities.ts`
// for the registry-driven replacement (`addressForTicker`). Mirror of
// the same deletion in `SwapView.tsx`.

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

/* ──────────────────────────────────────────────────────────── */

function KvRow({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: "accent" | "warn";
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
      }}
    >
      <span
        style={{
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        {k}
      </span>
      <span
        className="tnum"
        style={{
          color:
            tone === "accent"
              ? "var(--accent)"
              : tone === "warn"
                ? "var(--warn)"
                : "var(--text)",
        }}
      >
        {v}
      </span>
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "var(--border-soft)",
        margin: "4px 0",
      }}
    />
  );
}
