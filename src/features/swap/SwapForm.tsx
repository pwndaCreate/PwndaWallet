import { useEffect, useRef, useState } from "react";
import { CoinIcon } from "../../components/CoinIcon";
import { Btn } from "../../components/PrimitivesV2";
import {
  SWAP_COINS,
  SWAP_COIN_META,
  fmtBal,
  getDropdownTickers,
  getPairMeta,
  getSwapCoinMeta,
  isIntentsRoutable,
  isSourceCapable,
  isSwapKitRoutable,
  isZephyrEcosystemPair,
  liveCrossRate,
  tickerToChain,
  tickerToZphAssetType,
} from "./swap-data";
// Desk routability lives ONLY in the capability registry — swap-data has no
// desk shim by design, and leader/follower must never be re-derived here.
import {
  isDeskRoutableFromRegistry,
  ASSET_CAPABILITIES,
} from "./asset-capabilities";
import {
  basicswapPickerTickers,
  isBasicswapRoutable,
  fetchMinFillableAmount,
  SidecarQuoteError,
} from "../swap-sidecar";
import { formatAmount } from "../swap-sidecar/types";
import { sidecarFeesReserve } from "../../api/basicswap";
import { feeAppliesToSend, spendableAfterReserve } from "./feeReserve";
import { minPresetTitle, planMinPreset } from "./minPreset";
import {
  isGrouped,
  networkLabelFor,
  pickerRows,
  symbolFor,
} from "./picker-rows";
import { NetworkPill } from "./NetworkPill";
import {
  AmountCard,
  FlipButton,
  QuotePanel,
  PixelCta,
  Chip,
  ChipRow,
  LabeledDivider,
  QuickPairs,
} from "./components/swap-ui";
import { quickPairsFor } from "./router-modes";
import type { IntentsBlockchain } from "./near-intents-assets.generated";
import {
  formatAtomicAmount,
  getMinDepositAtomicForAsset,
} from "./useSwapQuote";
import { decimalToBaseUnitsBigInt } from "./swap-sources";
import type { NormalizedQuote } from "./useSwapQuote";
import {
  ROUTER_PREFERENCE_OPTIONS,
  SWAPKIT_CANARY_ACTIVE,
  effectiveModeForSource,
  type RouterPreference,
  type RouterSource,
} from "./router-modes";
import type { WalletInfo, ChainType } from "../../wallets";
import {
  atomicToZph,
  type ZphAssetBalance,
  type ZphAssetType,
} from "../../wallets/zph-rpc";

/**
 * Shared swap-form chrome — used by both portrait and landscape Swap
 * views. The portrait variant is the design's "atomic exchange" focal
 * card; the landscape variant is the same structure shrunk into the
 * left column.
 */
export function SwapForm({
  nodeRunning,
  fromCoin,
  toCoin,
  setFromCoin,
  setToCoin,
  fromAmt,
  setFromAmt,
  fromBlockchain,
  toBlockchain,
  setFromBlockchain,
  setToBlockchain,
  walletsByChain,
  balancesByChain,
  pricesByTicker,
  zphAssetBalances,
  liveQuote,
  liveLoading,
  liveError,
  intentsMinimum,
  onProbeMinimum,
  belowMinimum: belowMinimumProp,
  preferredRouter,
  basicswapEnabledTickers,
  onPreferredRouterChange,
  onOpenZephyrSwapModal,
  onOpenSwapKitConfirm,
  onOpenDeskConfirm,
  onOpenBasicswapConfirm,
  basicswapAddressMissing,
  deskAddressesMissing,
  onSwapToast,
  compact = false,
  suppressRouterStrip = false,
}: {
  /**
   * Is the swap node up? Optional and `undefined` when the caller does not
   * know — only an explicit `false` changes behaviour. Used to keep MIN from
   * asking a stopped node for the offer book and hanging on the HTTP timeout
   * (2026-09-05).
   */
  nodeRunning?: boolean;
  fromCoin: string;
  toCoin: string;
  setFromCoin: (c: string) => void;
  setToCoin: (c: string) => void;
  fromAmt: string;
  setFromAmt: (v: string) => void;
  /**
   * Per-side blockchain selection — present only when the parent has
   * adopted the dedup-aware (symbol, blockchain) state model. When
   * undefined, the form renders the legacy single-chain dropdown without
   * a network sub-selector.
   */
  fromBlockchain?: IntentsBlockchain;
  toBlockchain?: IntentsBlockchain;
  setFromBlockchain?: (b: IntentsBlockchain) => void;
  setToBlockchain?: (b: IntentsBlockchain) => void;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  balancesByChain: Partial<Record<ChainType, string>>;
  pricesByTicker: Record<string, number>;
  /** Per-asset Zephyr balances (ZPH / ZSD / ZRS / ZYS). Drives the
   *  `bal:` reading and dropdown balance column when one of the four
   *  ecosystem tickers is selected. Null until the first balance
   *  fetch lands. */
  zphAssetBalances?: ZphAssetBalance[] | null;
  /** Live SwapKit / NEAR Intents quote for the current (from, to, amount).
   *  When non-null, the form renders rate/fees/eta/provider from this
   *  instead of the static `SWAP_PAIRS` table. Provided by the parent's
   *  `useSwapQuote` call. */
  liveQuote?: NormalizedQuote | null;
  liveLoading?: boolean;
  liveError?: string | null;
  /** NEAR Intents per-asset (or per-pair, learned) minimum. Form renders
   *  it as an inline hint below YOU SEND and uses `belowMinimum` to gate
   *  the Swap button. Null when no minimum is known.
   *
   *  `source` says where the value came from: "probe" (adaptive
   *  EXACT_OUTPUT probe), "upstream-error" (parsed from a real-quote
   *  rejection), or "loading" (probe in flight — render a placeholder).
   *  When `source === "probe"` and `expectedAmountOutUsd` is present,
   *  the hint renders an USD-anchor sub-line. */
  intentsMinimum?: {
    displayAmount: string;
    ticker: string;
    source: "probe" | "upstream-error" | "loading" | "usd-limit";
    expectedAmountOutUsd?: string;
    /** The floor as upstream stated it, in dollars. `source === "usd-limit"`
     *  only, where `displayAmount` is a price conversion of ours rather than
     *  a number the bridge ever gave. */
    usdFloor?: string;
    /** USD-equivalent of `displayAmount` itself (not the destination-
     *  anchor USD below) — rendered as "(~$X)" right next to the
     *  minimum's scalar amount. */
    minimumUsd?: string;
    destinationDisplayName?: string;
  } | null;
  /** Ask NEAR for this pair's minimum on demand (`useSwapQuote.probeMinimumNow`).
   *  Behind the MIN button when no minimum is known yet (2026-09-04). */
  onProbeMinimum?: (
    hiAmountDisplay?: string,
  ) => Promise<{ amount: string | null; detail: string | null }>;
  /** True when the user's typed amount is below `intentsMinimum`. */
  belowMinimum?: boolean;
  /** User's preferred routing system. Drives the segmented control. */
  preferredRouter?: RouterPreference;
  /** Passed straight through to both `CoinPickerButton`s — see that
   *  component's own doc for what this filters. */
  basicswapEnabledTickers?: ReadonlySet<string> | null;
  /** Setter for the segmented control. */
  onPreferredRouterChange?: (next: RouterPreference) => void;
  /** Wired by the parent to open the existing ZephyrSwapModal when
   *  the pair is a Zephyr-ecosystem one. The arg lets us seed the
   *  modal with the user's currently-selected source asset (so they
   *  don't lose context when the modal opens). */
  onOpenZephyrSwapModal?: (initialSource?: ZphAssetType) => void;
  /** Wired by the parent to open `<SwapConfirmModal>` when the pair is
   *  SwapKit-routable AND a fresh quote is in hand. The form passes
   *  through the live quote so the modal can render fees / eta exactly
   *  as the user just saw them. */
  onOpenSwapKitConfirm?: () => void;
  /** Opens the desk confirm modal. Separate from `onOpenSwapKitConfirm`,
   *  which opens `SwapConfirmModal` — a one-shot build/sign/broadcast flow
   *  the desk does not use. Optional so other consumers keep compiling. */
  onOpenDeskConfirm?: () => void;
  /**
   * Opens the BasicSwap (P2P) confirm modal. Mirrors `onOpenDeskConfirm`
   * exactly (2026-08-22): the parent passes it only when its own
   * `basicswapReady` holds (quote source is basicswap AND a payout address
   * exists), and this form's `basicswapReady` re-checks the quote's source so
   * an aggregator quote can never open the P2P modal. Before this the primary
   * button had no P2P branch at all and fell through to the dead
   * "Atomic swap (preview)" placeholder while a live P2P quote sat beneath it.
   */
  /**
   * Open the P2P confirm modal. **Required for the P2P button to work at all**
   * — `basicswapReady` below checks it, so an absent prop makes the CTA fall
   * through to "NO OFFER TO TAKE YET" no matter how good the offer book is.
   *
   * It was absent in BOTH layouts until 2026-09-05: the P2P route worked only
   * through `BasicswapStrip`'s own separate button, and the form's CTA — the
   * one directly under the amount, the one a user actually presses — was dead
   * for the entire life of the prop. The operator hit it against a live,
   * amount-negotiable BCH → XMR offer sized well inside its range
   * (min 0.001 XMR, max 1.0 XMR, asking 0.0186 XMR) and was told there was no
   * offer to take.
   */
  onOpenBasicswapConfirm?: () => void;
  /** True when the pair is BasicSwap-routable but the wallet has no address
   *  for the coin being RECEIVED (the only address a P2P bid needs — the
   *  timelock refund goes to the swap node's own wallet, not to a refund
   *  address the user picks). Mirrors `deskAddressesMissing`: paints an
   *  actionable "Wallet required" instead of a misleading "no offer yet". */
  basicswapAddressMissing?: boolean;
  /** True when the pair is desk-routable but a payout/refund address is
   *  missing. Gates the button with an actionable label instead of a
   *  silently dead one. */
  deskAddressesMissing?: boolean;
  /** Wired by the parent to surface a "coming soon" toast for any
   *  pair the atomic-swap engine can't handle yet. */
  onSwapToast?: (msg: string) => void;
  compact?: boolean;
  /** When true, the internal routing strip is hidden so the parent can
   *  render the 4-tab AUTO/SWAPKIT/NEAR/ZEPHYR strip externally (Option C
   *  redesign 2026-05-25). Banner still renders below the form body. */
  suppressRouterStrip?: boolean;
}) {
  const meta = getPairMeta(fromCoin, toCoin);
  const liveRate = liveCrossRate(fromCoin, toCoin, pricesByTicker);
  const numericFrom = parseFloat(fromAmt) || 0;

  /**
   * Quick-pair tiles (canvas frame 1b).
   *
   * Derived from `quickPairsFor(preferredRouter)` rather than hardcoding the
   * four pairs the mock happens to draw. The mock was drawn on the Auto tab;
   * rendering that same list on P2P would offer ETH→BTC, which BasicSwap
   * cannot route — a tile that fills the form with a pair the current router
   * will refuse is a dead control by another name. Capped at 4 to keep the
   * row on one line at the narrowest (portrait) width.
   */
  /**
   * The network name each amount card shows in its footer (frame 1b's
   * "ETHEREUM" / "BITCOIN" pill). Read from the asset registry's own
   * `network` field so it can never disagree with what the router thinks
   * the asset is. Suppressed when the multi-chain `NetworkPill` selector is
   * present — that control already names the network AND lets the user
   * change it, so a static label beside it would be duplicate chrome.
   */
  const sourceNetworkLabel =
    fromBlockchain !== undefined
      ? null
      : (ASSET_CAPABILITIES[fromCoin.toUpperCase()]?.network ?? null);
  const destinationNetworkLabel =
    toBlockchain !== undefined
      ? null
      : (ASSET_CAPABILITIES[toCoin.toUpperCase()]?.network ?? null);

  const quickPairs = quickPairsFor(preferredRouter ?? "auto")
    .slice(0, 4)
    .map((p) => {
      const [from, to] = p.split("→");
      return { from, to };
    })
    .filter((p) => p.from && p.to);
  // When we have a SwapKit live quote, prefer its math over the static table.
  const liveExpected = liveQuote ? Number(liveQuote.expectedReceive) : null;
  const rate =
    liveExpected != null && numericFrom > 0
      ? liveExpected / numericFrom
      : (liveRate ?? meta.rate);
  const toAmt = liveExpected != null ? liveExpected : numericFrom * rate;
  const feeAmt = liveQuote
    ? Number(liveQuote.totalFeesSource)
    : numericFrom * (meta.fee / 100);
  // Stale-safe receive display: when the most recent quote attempt
  // errored (liveError set), show "—" rather than the static
  // SWAP_PAIRS-rate fallback. Those rates are pre-2026 placeholders
  // and could mislead the user into thinking they're getting a price
  // they're not.
  const receiveDisplay = liveError
    ? "—"
    : toAmt > 0
      ? fmtBal(toAmt)
      : "0.00";
  const receiveActive = !liveError && toAmt > 0;

  // ── USD equivalents for YOU SEND / YOU RECEIVE ─────────────────
  // Prefer the live-quote-supplied USD values (1Click returns
  // `amountInUsd` and `amountOutUsd` on every Intents quote response —
  // verified in the per-pair-minimums research §8). When no live quote
  // is in hand, fall back to the local prices map; either source is
  // rounded for display via `formatUsdSubLine`. Returns null when no
  // price is known so the sub-line self-hides instead of rendering
  // "$0.00" misleadingly.
  const intentsQuoteForUsd =
    liveQuote && liveQuote.source === "intents"
      ? liveQuote.intentsQuote
      : null;
  const sourceUsd: number | null = (() => {
    const live = intentsQuoteForUsd?.amountInUsd;
    if (live && Number.isFinite(Number(live)) && Number(live) > 0) {
      return Number(live);
    }
    const price = pricesByTicker[fromCoin.toUpperCase()];
    if (!price || price <= 0 || numericFrom <= 0) return null;
    return numericFrom * price;
  })();
  const destinationUsd: number | null = (() => {
    const live = intentsQuoteForUsd?.amountOutUsd;
    if (live && Number.isFinite(Number(live)) && Number(live) > 0) {
      return Number(live);
    }
    const price = pricesByTicker[toCoin.toUpperCase()];
    if (!price || price <= 0 || toAmt <= 0) return null;
    return toAmt * price;
  })();

  const swapKitRoutable = isSwapKitRoutable(fromCoin, toCoin);
  const intentsRoutable = isIntentsRoutable(fromCoin, toCoin);
  const deskRoutable = isDeskRoutableFromRegistry(fromCoin, toCoin);

  // Real balance for the "BAL: …" label. The four Zephyr ecosystem
  // tickers (ZEPH / ZEPHUSD / ZEPHRSV / ZEPHYRS) live on a separate
  // per-asset balance feed (`zphAssetBalances`) — `balancesByChain`
  // only carries the top-level ZEPH balance. Use the right source
  // per-ticker.
  const fromBalance = balanceForTicker(
    fromCoin,
    walletsByChain,
    balancesByChain,
    zphAssetBalances ?? null
  );

  // ─── NEAR Intents per-asset minimum-amount enforcement ──────────
  // Resolve the active source asset's nep141 id (taking the chain pill
  // into account when it's set) and look up the deposit minimum from
  // the cached `/api/intents/tokens` response. The cache primes lazily
  // on the first eligible quote — skip the check when nothing is in the
  // map yet (graceful degradation; quote-side will surface the upstream
  // 4xx if we missed enforcement here).
  const fromMetaResolved =
    getSwapCoinMeta(fromCoin, fromBlockchain) ?? SWAP_COIN_META[fromCoin];
  const fromAssetId = fromMetaResolved?.nearIntentsAsset ?? null;
  const fromDecimals = fromMetaResolved?.decimals ?? 0;
  const minDepositAtomic = fromAssetId
    ? getMinDepositAtomicForAsset(fromAssetId)
    : null;
  // Convert the user's typed amount to atomic units once for every
  // downstream consumer (hint tone, button disable, percent-button
  // greying).
  let inputAtomic: bigint = 0n;
  if (fromAmt && fromMetaResolved) {
    try {
      inputAtomic = decimalToBaseUnitsBigInt(fromAmt, fromDecimals);
    } catch {
      inputAtomic = 0n;
    }
  }
  // Combine the form's per-asset check (token cache only) with the
  // hook's authoritative computation (per-asset MAX per-pair learned
  // from upstream rejection). Either firing means "below minimum".
  const belowMinimumLocal =
    minDepositAtomic !== null &&
    inputAtomic > 0n &&
    inputAtomic < minDepositAtomic;
  const belowMinimum = belowMinimumLocal || !!belowMinimumProp;
  const minDisplay =
    minDepositAtomic !== null
      ? formatAtomicAmount(minDepositAtomic, fromDecimals)
      : null;
  // "(~$6.16)" appended right next to the minimum's scalar amount, in
  // both the green and red states. Self-hides when the source token's
  // price isn't cached yet.
  const minimumUsdSuffix = intentsMinimum?.minimumUsd
    ? ` (~$${formatUsdSubLine(intentsMinimum.minimumUsd)})`
    : "";
  // A dollar denominated limit is a different sentence. The bridge named a
  // price, not an amount of the coin, so the coin figure is our conversion
  // and is marked approximate, and the bridge's own number leads. Writing it
  // the other way round would put a number in the user's mouth that upstream
  // never said, and it drifts with the market besides.
  const usdLimit =
    intentsMinimum?.source === "usd-limit" && intentsMinimum.usdFloor
      ? `$${Number(intentsMinimum.usdFloor).toLocaleString("en-US")}`
      : null;
  const usdLimitAmount = intentsMinimum
    ? `about ${intentsMinimum.displayAmount} ${intentsMinimum.ticker}`
    : "";
  // Form-level warning: even MAX of the user's balance is below the
  // minimum. balanceFor returns a number; convert to atomic for the
  // comparison so we don't introduce float-precision noise on small
  // wei values.
  let balanceBelowMinimum = false;
  if (minDepositAtomic !== null && fromBalance != null && fromMetaResolved) {
    try {
      const balAtomic = decimalToBaseUnitsBigInt(
        fromBalance.toString(),
        fromDecimals
      );
      balanceBelowMinimum = balAtomic < minDepositAtomic;
    } catch {
      /* keep balanceBelowMinimum=false on parse failure */
    }
  }

  // True when we can route the swap through the existing modal flow.
  const zephRouteable =
    isZephyrEcosystemPair(fromCoin, toCoin) && !!onOpenZephyrSwapModal;
  const swapKitReady =
    swapKitRoutable && !!onOpenSwapKitConfirm && !!liveQuote && !liveError && !liveLoading;
  // `onOpenSwapKitConfirm` is misnamed historically but is router-agnostic:
  // it just opens `SwapConfirmModal`, which dispatches on `quote.kind` and
  // calls `executeIntentsTrade` for NEAR Intents quotes (the swapkit branch
  // calls `executeSwapKitRoute`). So a NEAR-Intents-only pair like AVAX→ADA
  // legitimately reuses the same handler — the modal does the right thing.
  const intentsReady =
    intentsRoutable && !!onOpenSwapKitConfirm && !!liveQuote && !liveError && !liveLoading;
  // The desk gets its OWN readiness + its own modal. The `source` check is
  // load-bearing: on a pair that is ever routable both ways, an aggregator
  // quote must not authorize the desk modal (they terminate in different
  // executors). No TTL term here on purpose — the form has no timer, so a
  // freshness test would only be evaluated at render and would be an unsound
  // guarantee; expiry is re-checked at accept time.
  const deskReady =
    deskRoutable &&
    !!onOpenDeskConfirm &&
    !!liveQuote &&
    liveQuote.source === "pwnda-desk" &&
    !liveError &&
    !liveLoading;
  // BasicSwap (P2P) readiness — the SAME shape as `deskReady`, for the same
  // reason: its own modal, its own executor, and a `source` check so a quote
  // from any other venue can never open it. `basicswapRoutable` is also read
  // by `atomicPreviewFallback` below, where it first became load-bearing.
  const basicswapRoutable = isBasicswapRoutable(fromCoin, toCoin);
  const basicswapReady =
    basicswapRoutable &&
    !!onOpenBasicswapConfirm &&
    !!liveQuote &&
    liveQuote.source === "basicswap" &&
    !liveError &&
    !liveLoading;
  // Insufficient-funds gate, surfaced at the FORM level (2026-08-22) — was
  // previously only checked inside SidecarConfirmModal, so a user reviewed
  // the whole confirm screen before discovering the node can't fund the
  // bid. Same verdict `assessBidFunding` already computes for the confirm
  // modal's own panel (`book.funding`), read one level earlier so the
  // primary button can refuse the click instead of opening a dead end.
  const basicswapFundingShort =
    basicswapReady && liveQuote?.basicswapQuote?.funding.state === "short";
  // ─── HARD-STOP for "Atomic swap (preview)" ────────────────────────
  // Per the wiki disclosure (`swap-subsystem-state-2026-05-08.md`
  // Section 5), "Pwnda Atomic" is a legacy UI placeholder — no protocol
  // implementation, no settlement, just a toast on click. Disable the
  // button entirely unless an explicit env flag opts in. Same defence-
  // in-depth pattern as the mock-mode broadcast guard.
  //
  // Once a real atomic-swap engine is wired (HTLC, escrow, or another
  // protocol), set VITE_PWNDA_ATOMIC_PREVIEW_ENABLED=true to lift this.
  //
  // Pre-2026-05-25 this only checked `!swapKitRoutable` — which meant
  // NEAR-Intents-only pairs (AVAX→ADA, etc.) silently fell into the
  // placeholder branch even when a real Intents quote was in hand.
  // Including `!intentsRoutable` fixes that gating bug.
  //
  // 2026-07-19: `!deskRoutable` added for the same reason, on the desk's
  // flagship pair. Without it XMR→ADA with a typed amount sets
  // atomicPreviewBlocked (the env opt-in is unset), which forces
  // swapEnabled=false and paints "Atomic swap unavailable" while a live desk
  // quote renders directly above it — a byte-for-byte repeat of the AVAX→ADA
  // bug. This four-term predicate has now swallowed a whole router class
  // twice; `swap-form-gating.test.ts` mirrors it so a third time fails a test.
  //
  // 2026-08-22: the third time happened anyway — `!basicswapRoutable` added.
  // The 2026-07-19 note above said the test mirror would catch a third
  // occurrence, but the mirror only knows the terms it was handed, and the
  // BasicSwap route was added without handing it one. Result: XMR→LTC with a
  // live P2P quote rendered "Atomic swap unavailable" on THIS button while the
  // strip below it showed a priced, reviewable offer — observed in both
  // layouts during the 2026-08-22 audit. The mirror now carries the term, and
  // the lesson for the NEXT route is the real one: adding a router to
  // `RouterPreference` is not done until this predicate AND its test mirror
  // both know about it.
  const atomicPreviewFallback =
    !zephRouteable &&
    !swapKitRoutable &&
    !intentsRoutable &&
    !deskRoutable &&
    !basicswapRoutable &&
    numericFrom > 0;
  const atomicPreviewOptIn =
    String(import.meta.env.VITE_PWNDA_ATOMIC_PREVIEW_ENABLED ?? "").toLowerCase() ===
    "true";
  const atomicPreviewBlocked = atomicPreviewFallback && !atomicPreviewOptIn;

  // ─── SwapKit-mispicked guidance ──────────────────────────────────
  // The user explicitly picked SwapKit, but this pair isn't on
  // SwapKit — AND there IS an alternative router (NEAR Intents or
  // Zephyr) that CAN route it. Yesterday's AVAX→ADA UX trap: the
  // form silently fell to a disabled "Atomic swap unavailable"
  // button with stale rate rows below it, and the user had no way
  // to tell from the form alone what they needed to do.
  //
  // This predicate scopes the "switch routing to continue" UX to
  // EXACTLY that case. The user-explicit gate (preferredRouter ===
  // "swapkit") is important: in Auto Best mode the resolver picks
  // for them and there's nothing for them to switch. The
  // alternative-exists gate is important: if NO router can route
  // the pair, we leave the existing Pwnda Atomic placeholder
  // behavior in place (that's a genuinely different failure mode).
  const swapKitMispicked =
    preferredRouter === "swapkit" &&
    !swapKitRoutable &&
    (intentsRoutable || zephRouteable) &&
    numericFrom > 0;

  const swapEnabled =
    (zephRouteable || swapKitReady || intentsReady || deskReady || basicswapReady || !!onSwapToast) &&
    numericFrom > 0 &&
    !belowMinimum &&
    !atomicPreviewBlocked &&
    !swapKitMispicked &&
    !(deskRoutable && deskAddressesMissing) &&
    // A P2P pair with no reviewable quote yet (book loading, empty, or no
    // payout wallet) disables the button rather than letting the legacy
    // `!!onSwapToast` term keep it live with a placeholder label.
    !(basicswapRoutable && !basicswapReady) &&
    !basicswapFundingShort;

  const flip = () => {
    const f = fromCoin;
    // 2026-09-04: reversing a QUOTED trade should reverse its size too. The
    // amount used to stay put — 0.0027 BTC → ADA became 0.0027 ADA → BTC,
    // worth six hundredths of a cent, which NEAR rejected as "No liquidity
    // available" and the operator read as a broken route. Carry the quoted
    // receive amount over as the new send amount when there is one.
    const carried =
      receiveActive && toAmt > 0
        ? toAmt.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")
        : null;
    setFromCoin(toCoin);
    setToCoin(f);
    if (carried) setFromAmt(carried);
  };

  const setPercent = (pct: number) => {
    if (fromBalance == null) return;
    const v = (fromBalance * pct).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    setFromAmt(v);
    // MAX on a peer-to-peer swap that SENDS the scripted leg must leave the
    // fee behind (2026-09-05). Otherwise the swap completes, the watcher goes
    // to collect, the balance is zero, and the record defers forty times and
    // expires — a fee declared and never taken. The amount comes from Rust's
    // own schedule; this file does no fee arithmetic.
    if (pct < 1) return;
    if (!feeAppliesToSend({ router: preferredRouter, fromTicker: fromCoin, toTicker: toCoin })) {
      return;
    }
    void sidecarFeesReserve(fromCoin, String(fromBalance))
      .then((reserveStr) => {
        const reserve = Number(reserveStr);
        if (!Number.isFinite(reserve) || reserve <= 0) return;
        const spendable = spendableAfterReserve(fromBalance, reserve);
        if (spendable <= 0) return;
        setFromAmt(spendable.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""));
      })
      .catch(() => {
        /* Fee unknown — leave MAX as the plain balance. A swap must never be
           blocked by the fee path (`the_swap_path_does_not_depend_on_the_fee`). */
      });
  };

  // MIN — the BasicSwap-only counterpart to 25%/50%/75%/MAX (2026-08-22).
  // Those read the WALLET balance; this reads the BOOK, because "the
  // smallest amount worth typing" for a peer-to-peer offer has nothing to
  // do with what the user holds — it's the cheapest fillable minimum among
  // reasonably-priced live offers. No amount has to exist yet for this to
  // run (unlike a quote), so it needs its own fetch and its own busy state.
  const [minFetching, setMinFetching] = useState(false);
  // 2026-09-04: MIN is no longer P2P-only. `planMinPreset` decides per router
  // — the book for P2P, NEAR's own minimum (already learned for the hint
  // below YOU SEND) for Intents/Auto, disabled-with-a-reason for the desk —
  // and the button always renders. It used to be gated on
  // `preferredRouter === "basicswap" && basicswapRoutable`, which hid it on
  // NEAR entirely and on P2P whenever the pair carried over from NEAR was not
  // P2P-routable: "the min button disappeared for all the swaps".
  const minPlan = planMinPreset({
    preferredRouter: preferredRouter ?? "auto",
    nodeRunning,
    basicswapRoutable,
    intentsMinimum,
    fromCoin,
    perAssetMinDisplay: minDisplay,
    probeAvailable: intentsRoutable && !!onProbeMinimum,
  });
  const handleProbeMin = async () => {
    if (!onProbeMinimum || minFetching) return;
    setMinFetching(true);
    try {
      // The size the search can start from: what is quoting right now, else
      // the whole balance. Without one the USD schedules are all NEAR gets,
      // and for a source with no listed price (ADA) those find nothing.
      const hi =
        liveQuote && !liveError && numericFrom > 0
          ? fromAmt
          : fromBalance != null && fromBalance > 0
            ? fromBalance.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")
            : undefined;
      const { amount, detail } = await onProbeMinimum(hi);
      if (amount) {
        setFromAmt(amount);
      } else {
        const said = detail ? ` NEAR said: ${detail.replace(/^Quote request rejected by upstream: /, "").slice(0, 220)}` : "";
        onSwapToast?.(
          hi
            ? `NEAR Intents did not quote ${fromCoin} → ${toCoin} at any size up to ${hi} ${fromCoin}.${said}`
            : `NEAR Intents found no fillable size for ${fromCoin} → ${toCoin} — enter any amount or fund the wallet so MIN has a size to search from.${said}`,
        );
      }
    } finally {
      setMinFetching(false);
    }
  };
  const handleMinPreset = () => {
    switch (minPlan.kind) {
      case "book":
        void handleMinClick();
        return;
      case "probe":
        void handleProbeMin();
        return;
      case "fill":
        setFromAmt(minPlan.amount);
        return;
      case "wait":
        onSwapToast?.("Still finding the minimum for this pair — try again in a moment.");
        return;
      default:
        return;
    }
  };
  const handleMinClick = async () => {
    if (minFetching) return;
    setMinFetching(true);
    try {
      const result = await fetchMinFillableAmount({ from: fromCoin, to: toCoin });
      // formatAmount, never String(n): a raw JS number below ~1e-6 stringifies
      // to exponent notation ("1e-8"), which the amount field can't usefully
      // hold and upstream's own parser rejects outright. Same bug class this
      // codebase already fixed everywhere else a book-derived number reaches
      // a text field — MIN was the one place it had been missed.
      setFromAmt(formatAmount(result.sendAmount, result.sendDecimals));
      // An all-or-nothing offer's "minimum" is its whole size, which can be
      // much larger than the word suggests — and larger than the balance. Say
      // so, or the user reads a big number as a bug (2026-09-05).
      if (result.allOrNothing) {
        onSwapToast?.(
          `The cheapest offer is all-or-nothing: ${formatAmount(result.sendAmount, result.sendDecimals)} ${fromCoin} exactly, or nothing. ` +
            (result.anyPartialFillOffered
              ? "Other offers accept part of their size — raise the amount to reach one."
              : "Every offer on this book is take-it-all right now."),
        );
      } else if (!result.outlierGateApplied) {
        onSwapToast?.(
          "Could not check the book against a market price, so this is the raw minimum — it has not been screened for outliers."
        );
      }
    } catch (e) {
      onSwapToast?.(
        e instanceof SidecarQuoteError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not read the offer book."
      );
    } finally {
      setMinFetching(false);
    }
  };

  const handleSwap = () => {
    if (zephRouteable) {
      // Seed the modal with the user's selected source asset so they
      // don't lose context (modal would otherwise default to ZPH→ZSD).
      onOpenZephyrSwapModal?.(tickerToZphAssetType(fromCoin) ?? undefined);
    } else if (basicswapReady) {
      // BasicSwap P2P: its own confirm modal (spread gate, typed override,
      // bid submit) — never SwapConfirmModal's build/sign/broadcast flow.
      onOpenBasicswapConfirm?.();
    } else if (deskReady) {
      // The desk has its own modal: no vault password stage (the Rust desk
      // store is keyring-backed) and no TS build/sign/broadcast.
      onOpenDeskConfirm?.();
    } else if (deskRoutable && deskAddressesMissing) {
      onSwapToast?.(
        `A ${toCoin} address (to receive) and a ${fromCoin} address (to refund to if the swap fails) are both required — open those chains in the dashboard first.`
      );
    } else if (swapKitReady || intentsReady) {
      // Both routers funnel through `SwapConfirmModal` — it dispatches on
      // `quote.kind` and calls the right executor (`executeSwapKitRoute`
      // for SwapKit, `executeIntentsTrade` for NEAR Intents).
      onOpenSwapKitConfirm?.();
    } else if (swapKitRoutable || intentsRoutable || deskRoutable) {
      // Routable pair but no quote in hand yet — most often "amount below
      // minimum" or "loading". Surface the live error if we have one.
      onSwapToast?.(
        liveError ?? "Quote not ready yet. Wait a moment and try again."
      );
    } else {
      onSwapToast?.(
        `${fromCoin} → ${toCoin} atomic swap isn't wired yet — feature in development.`
      );
    }
  };

  const fs = compact ? 10 : 11;

  // Banner state. When the user has explicitly selected a non-auto
  // upstream we show the banner immediately (even before the first
  // quote, using the configured-mode fallback inside `<RouterBanner>`).
  // In auto mode we only show the banner once the resolver has picked a
  // side — color tracks the resolved source.
  const showRouterPreferenceUi = !!onPreferredRouterChange && !!preferredRouter;
  const bannerInfo = liveQuote
    ? effectiveModeForSource(liveQuote.source, liveQuote.swapKitRoute)
    : null;
  /**
   * Banner visibility, narrowed by the 2026-08-28 redesign.
   *
   * Frame 1b deletes the "Routing through <router>. Quotes are live; nothing
   * moves until you confirm a swap." paragraph — the trust chips under the
   * CTA carry that claim in three words instead of twenty.
   *
   * It does NOT delete the banner. The same component renders the
   * mock/testing-mode warning ("… testing mode (mock data) — no real swap
   * will execute", plus the mock-upstream detection note), and that is a
   * safety message, not chrome: the whole point is to tell the user the
   * thing in front of them will not do what it says. A redesign that
   * removes prose must not remove *that* sentence, so the banner now
   * renders only when the route is mocked.
   */
  const routerIsMocked = (() => {
    const effective =
      bannerInfo ?? effectiveModeForSource(fallbackBannerSource(preferredRouter ?? "auto"));
    return !effective.isLive || effective.mockDetected === true;
  })();
  const showBanner = showRouterPreferenceUi && routerIsMocked;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: compact ? 8 : 12,
      }}
    >
      {/* ROUTING segmented control — drives which upstream is queried.
          Suppressed when the parent renders a 4-tab AUTO/SWAPKIT/NEAR/
          ZEPHYR strip above the form (Option C redesign 2026-05-25). */}
      {!suppressRouterStrip && showRouterPreferenceUi && preferredRouter && onPreferredRouterChange && (
        <div>
          <div
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              letterSpacing: 1.5,
              textTransform: "uppercase",
              marginBottom: 6,
              fontFamily: "var(--font-mono)",
            }}
          >
            routing
          </div>
          <div
            role="tablist"
            style={{
              display: "flex",
              gap: 4,
              border: "1px solid var(--border)",
              padding: 3,
              background: "var(--surface)",
            }}
          >
            {ROUTER_PREFERENCE_OPTIONS.map((opt) => {
              const active = opt.value === preferredRouter;
              return (
                <button
                  key={opt.value}
                  role="tab"
                  aria-selected={active}
                  onClick={() => onPreferredRouterChange(opt.value)}
                  title={opt.hint}
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: compact ? 9 : 10,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    border: "none",
                    background: active ? "var(--accent-soft)" : "transparent",
                    color: active ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer",
                    borderLeft: active
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                    transition: "background .12s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* MODE BANNER — yellow for mock/test mode, green for live. */}
      {showBanner && (
        <RouterBanner preferredRouter={preferredRouter!} info={bannerInfo} />
      )}

      {/* Source-chain prerequisite hint (e.g. NEAR's "needs 0.1 NEAR for
          fees"). Surfaces from `SWAP_COIN_META[fromCoin].sourcePrerequisiteHint`. */}
      {SWAP_COIN_META[fromCoin]?.sourcePrerequisiteHint && (
        <div
          style={{
            padding: "8px 10px",
            background: "rgba(0,255,102,0.06)",
            border: "1px solid rgba(0,255,102,0.3)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: 0.4,
            lineHeight: 1.4,
          }}
        >
          <span style={{ color: "var(--accent)", marginRight: 4 }}>!</span>
          {SWAP_COIN_META[fromCoin].sourcePrerequisiteHint}
        </div>
      )}

      {/* NEAR Intents minimum hint. Three render states:
            - "loading": probe in flight; shows "Finding minimum…"
            - solid green: min cached; shows "Min: X TICKER for FROM → TO"
              with USD-anchor sub-line when we have it
            - red: typed amount below min; shows below-min copy
          The probe runs on every (from, to) change and caches per pair
          for 5 minutes. See `intents-pair-min-probe.ts`. */}
      {intentsMinimum && (
        <div
          style={{
            padding: "6px 10px",
            background: belowMinimum
              ? "rgba(239,68,68,0.10)"
              : intentsMinimum.source === "loading"
                ? "rgba(255,255,255,0.04)"
                : "rgba(0,255,102,0.06)",
            border: belowMinimum
              ? "1px solid rgba(239,68,68,0.45)"
              : intentsMinimum.source === "loading"
                ? "1px solid rgba(255,255,255,0.15)"
                : "1px solid rgba(0,255,102,0.25)",
            color: belowMinimum ? "#fca5a5" : "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: 0.4,
            lineHeight: 1.4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div>
            <span
              style={{
                color: belowMinimum
                  ? "#ef4444"
                  : intentsMinimum.source === "loading"
                    ? "var(--text-dim)"
                    : "var(--accent)",
                marginRight: 4,
              }}
            >
              {belowMinimum ? "✗" : intentsMinimum.source === "loading" ? "…" : "ⓘ"}
            </span>
            {intentsMinimum.source === "loading"
              ? `Finding minimum for ${fromCoin} → ${toCoin}…`
              : usdLimit
                ? belowMinimum
                  ? `Below NEAR Intents temporary limit: ${usdLimit} per swap (${usdLimitAmount})`
                  : `Temporary NEAR Intents limit: ${usdLimit} per swap (${usdLimitAmount})`
                : belowMinimum
                  ? `Below NEAR Intents minimum: ${intentsMinimum.displayAmount} ${intentsMinimum.ticker}${minimumUsdSuffix}`
                  : `Min: ${intentsMinimum.displayAmount} ${intentsMinimum.ticker}${minimumUsdSuffix} for ${fromCoin} → ${intentsMinimum.destinationDisplayName ?? toCoin}`}
          </div>
          {/* Why the floor is this large, and why changing the amount is the
              only lever. Without it the hint reads as a wallet rule, and the
              obvious next move is to try the other direction, which fails the
              same way because the limit follows the asset onto either leg. */}
          {usdLimit && (
            <div
              data-usd-limit-note
              style={{
                color: "var(--text-dim)",
                fontSize: 9,
                paddingLeft: 14,
              }}
            >
              (set by the bridge these assets use, not by the wallet. It counts
              the swap's dollar value on either side, so flipping the pair does
              not avoid it.)
            </div>
          )}
          {/* USD-anchor sub-line — probe entries only, where the
              minimum was learned by asking "what's the input for
              ~$X of destination?" Shows the user that the displayed
              minimum corresponds to a known USD output level so they
              understand sending more produces more (proportionally). */}
          {intentsMinimum.source === "probe" &&
            intentsMinimum.expectedAmountOutUsd &&
            !belowMinimum && (
              <div
                style={{
                  color: "var(--text-dim)",
                  fontSize: 9,
                  paddingLeft: 14,
                }}
              >
                (receives ~${formatUsdSubLine(intentsMinimum.expectedAmountOutUsd)} of {intentsMinimum.destinationDisplayName ?? toCoin}; send more to receive more)
              </div>
            )}
        </div>
      )}

      {/* ── SEND / FLIP / RECEIVE ──────────────────────────────────
          Redesign 2026-08-28 (canvas frame 1b): the three loose stacks
          (label row, bare .field input, sub-lines) become two framed cards
          with the flip control straddling their shared border. The
          functional pieces that used to sit as free-floating sub-lines —
          minimum hints, the balance-below-minimum warning, the network
          sub-selector, the percent chips — are unchanged and now live in
          each card's footer slot. `CoinPickerButton` is passed straight
          through: it owns which assets are pickable, and a mock is not a
          reason to grow a second dropdown. */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <AmountCard
          label="you send"
          amount={fromAmt}
          onAmountChange={setFromAmt}
          ticker={fromCoin}
          balanceLabel={
            fromBalance != null ? `bal ${fmtBal(fromBalance)}` : "bal —"
          }
          onMax={fromBalance != null ? () => setPercent(1) : undefined}
          networkLabel={sourceNetworkLabel}
          usdLabel={
            sourceUsd != null
              ? `≈ $${formatUsdSubLine(sourceUsd.toString())}`
              : null
          }
          pickerSlot={
            <CoinPickerButton
              ticker={fromCoin}
              otherTicker={toCoin}
              onPick={setFromCoin}
              fontSize={fs}
              walletsByChain={walletsByChain}
              balancesByChain={balancesByChain}
              zphAssetBalances={zphAssetBalances ?? null}
              onlySourceCapable
              preferredRouter={preferredRouter}
              basicswapEnabledTickers={basicswapEnabledTickers}
            />
          }
          footerSlot={
            <>
              {/* Network sub-selector — multi-chain symbols only. */}
              {fromBlockchain !== undefined && setFromBlockchain && (
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-dim)",
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    network
                  </span>
                  <NetworkPill
                    symbol={fromCoin}
                    blockchain={fromBlockchain}
                    onPick={setFromBlockchain}
                    side="source"
                  />
                </div>
              )}

              {/* Minimum hint — kept: it is the difference between a
                  disabled button the user understands and one they do not. */}
              {minDisplay && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 9,
                    fontFamily: "var(--font-mono)",
                    color: belowMinimum ? "var(--danger)" : "var(--text-dim)",
                    letterSpacing: 0.4,
                  }}
                >
                  {belowMinimum
                    ? `below minimum (${minDisplay} ${fromCoin})`
                    : `min ${minDisplay} ${fromCoin}`}
                </div>
              )}

              {/* Balance-below-minimum warning — a real dead end, so it
                  keeps its full sentence rather than becoming a chip. */}
              {balanceBelowMinimum && minDisplay && fromBalance != null && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 10px",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: "var(--danger)",
                    background: "rgba(255,59,59,0.08)",
                    border: "1px solid rgba(255,59,59,0.4)",
                    lineHeight: 1.5,
                  }}
                >
                  ⚠ Your {fromCoin} balance ({fmtBal(fromBalance)} {fromCoin})
                  is below the minimum ({minDisplay} {fromCoin}) for this
                  route. Add funds or pick a different source asset.
                </div>
              )}

              {/* MIN + percent chips. MIN sits first (2026-09-05): it is the
                  smallest size, so it reads left of 25% the way the row
                  ascends. */}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button
                  className="qbtn"
                  onClick={handleMinPreset}
                  disabled={minFetching || minPlan.kind === "none" || minPlan.kind === "wait"}
                  title={minPresetTitle(minPlan)}
                  data-min-plan={minPlan.kind}
                  style={{
                    flex: 1,
                    padding: "3px 4px",
                    fontSize: 8,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    opacity: minPlan.kind === "none" ? 0.4 : undefined,
                  }}
                >
                  {minFetching ? "…" : "Min"}
                </button>
                {[
                  { label: "25%", v: 0.25 },
                  { label: "50%", v: 0.5 },
                  { label: "75%", v: 0.75 },
                  { label: "MAX", v: 1 },
                ].map((p) => {
                  let percentBelowMin = false;
                  if (
                    minDepositAtomic !== null &&
                    fromBalance != null &&
                    fromMetaResolved
                  ) {
                    try {
                      const balAtomic = decimalToBaseUnitsBigInt(
                        fromBalance.toString(),
                        fromDecimals
                      );
                      const numerator =
                        balAtomic * BigInt(Math.round(p.v * 1_000_000));
                      const portionAtomic = numerator / 1_000_000n;
                      if (portionAtomic < minDepositAtomic)
                        percentBelowMin = true;
                    } catch {
                      /* leave percentBelowMin=false on parse failure */
                    }
                  }
                  const disabled = fromBalance == null || percentBelowMin;
                  const tooltip =
                    percentBelowMin && minDisplay
                      ? `Below minimum (${minDisplay} ${fromCoin})`
                      : undefined;
                  return (
                    <button
                      key={p.label}
                      className="qbtn"
                      onClick={() => setPercent(p.v)}
                      disabled={disabled}
                      title={tooltip}
                      style={{
                        flex: 1,
                        padding: "3px 4px",
                        fontSize: 8,
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        opacity: percentBelowMin ? 0.4 : undefined,
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </>
          }
        />

        <FlipButton onClick={flip} />

        <AmountCard
          label="you receive"
          amount={receiveDisplay}
          readOnly
          amountColor={receiveActive ? "var(--accent)" : "var(--text-dim)"}
          ticker={toCoin}
          usdLabel={
            destinationUsd != null
              ? `≈ $${formatUsdSubLine(destinationUsd.toString())}`
              : null
          }
          networkLabel={destinationNetworkLabel}
          overlapTop
          pickerSlot={
            <CoinPickerButton
              ticker={toCoin}
              otherTicker={fromCoin}
              onPick={setToCoin}
              fontSize={fs}
              walletsByChain={walletsByChain}
              balancesByChain={balancesByChain}
              zphAssetBalances={zphAssetBalances ?? null}
              preferredRouter={preferredRouter}
              basicswapEnabledTickers={basicswapEnabledTickers}
            />
          }
          footerSlot={
            <>
              {toBlockchain !== undefined && setToBlockchain && (
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-dim)",
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    network
                  </span>
                  <NetworkPill
                    symbol={toCoin}
                    blockchain={toBlockchain}
                    onPick={setToBlockchain}
                    side="destination"
                  />
                </div>
              )}
              {SWAP_COIN_META[toCoin]?.coverageNote && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 9,
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                    lineHeight: 1.5,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span aria-hidden style={{ fontSize: 11 }}>ℹ</span>
                  <span>{SWAP_COIN_META[toCoin].coverageNote}</span>
                </div>
              )}
            </>
          }
        />
      </div>

      {/* SwapKit-mispicked guidance (2026-05-26). User explicitly
          picked SwapKit, this pair isn't on SwapKit, and at least one
          alternative router (NEAR Intents or Zephyr) CAN route it.
          Yellow info tone — this isn't an error, it's an actionable
          configuration tip. Replaces the silent "Atomic swap
          unavailable" trap that surfaced during the AVAX→ADA test. */}
      {swapKitMispicked && (
        <div
          style={{
            background: "rgba(255,174,66,0.08)",
            border: "1px solid #ffae42",
            padding: compact ? 8 : 10,
            color: "var(--text)",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            lineHeight: 1.5,
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
          role="status"
        >
          <span aria-hidden style={{ color: "#ffae42", fontSize: 12 }}>⚠</span>
          <div>
            <strong style={{ color: "#ffae42" }}>
              SwapKit doesn't route this pair.
            </strong>
            <br />
            Switch to <strong>NEAR</strong> or <strong>Auto Best</strong> to
            find a route for {fromCoin} → {toCoin}.
          </div>
        </div>
      )}

      {/* ── QUOTE PANEL ────────────────────────────────────────────
          Redesign 2026-08-28 (canvas frame 1b): four compact rows, no
          prose. Two deletions are deliberate and worth naming:

          - The "Enter an amount to see the quote, fee, and minimum
            received." placeholder card is gone. The panel simply does not
            render until there is something to show; an empty card that
            explains it is empty is the kind of chrome this pass removes.
          - "Provider" left the panel. It is not a number the user acts on
            mid-form, and the confirm modal — which is where committing
            actually happens — still names the provider in full.

          `liveLoading` / `liveError` keep their own lines: a quote that is
          arriving and a quote that failed are different states, and
          collapsing either into silence would be the "no feedback" the
          behavior contract forbids. */}
      {(numericFrom > 0 || liveLoading || liveError) && (
        <>
          {numericFrom > 0 && (
            <QuotePanel
              rows={[
                {
                  label: "rate",
                  value: swapKitMispicked
                    ? "—"
                    : rate > 0
                      ? `1 ${fromCoin} = ${fmtBal(rate)} ${toCoin}`
                      : "—",
                  accent: true,
                  marker: liveQuote ? "LIVE" : liveRate ? undefined : "STATIC",
                  markerPulse: !!liveQuote,
                },
                {
                  label: "min received",
                  value: swapKitMispicked
                    ? "—"
                    : liveQuote
                      ? `${liveQuote.minReceived} ${toCoin}`
                      : "—",
                },
                {
                  label: "fee",
                  value: swapKitMispicked
                    ? "—"
                    : liveQuote
                      ? `${fmtBal(feeAmt)} ${fromCoin}`
                      : `${meta.fee}% · ${fmtBal(feeAmt)} ${fromCoin}`,
                },
                {
                  label: "time",
                  value: swapKitMispicked
                    ? "—"
                    : liveQuote
                      ? liveQuote.etaPretty
                      : meta.est,
                },
              ]}
            />
          )}
          {liveLoading && (
            <div
              style={{
                fontSize: 9,
                color: "var(--text-dim)",
                letterSpacing: 1,
                textTransform: "uppercase",
                fontFamily: "var(--font-mono)",
              }}
            >
              quoting…
            </div>
          )}
          {liveError && (
            <div
              style={{
                fontSize: 9,
                color: "var(--danger)",
                letterSpacing: 0.4,
                fontFamily: "var(--font-mono)",
                lineHeight: 1.5,
              }}
            >
              {liveError}
            </div>
          )}
        </>
      )}

      {/* Canary banner — gated on VITE_SWAPKIT_CANARY. Surfaces during
          the first window after the SwapKit live cutover so users know
          to test with a small amount. Independent of the MOCK_UUID
          hard-stop in useSwapQuote.ts — that one is defense; this one
          is informational. Flip the flag off in a follow-up commit
          after the first successful canary swap. */}
      {shouldShowCanaryBanner({
        preferredRouter,
        liveQuoteSource: liveQuote?.source,
        swapKitRoutable,
      }) && (
        <div
          role="status"
          style={{
            padding: "8px 10px",
            background: "rgba(255,170,0,0.10)",
            border: "1px solid rgba(255,170,0,0.55)",
            color: "var(--warn)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: 0.4,
            lineHeight: 1.4,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span aria-hidden style={{ fontSize: 12 }}>⚠</span>
          <span style={{ flex: 1 }}>
            SwapKit just went live. Test with a small amount first.
          </span>
        </div>
      )}

      {/* ── PRIMARY CTA ────────────────────────────────────────────
          Redesign 2026-08-28 (canvas frame 1b): pixel font, accent frame.
          `--pixel` is reserved for the wordmark and primary CTAs
          (design-system.md), and this is the CTA.

          The label ladder is UNCHANGED — every branch below already
          existed, and each one is the difference between a disabled
          button the user can act on and a dead one they cannot. The mock
          shows the happy path ("► SWAP"); the ladder is what the other
          states render, so keeping it is what stops this from becoming a
          dead control. */}
      <span
        title={
          belowMinimum && minDisplay
            ? `Below minimum swap amount for this asset (${minDisplay} ${fromCoin})`
            : undefined
        }
        style={{ display: "block" }}
      >
        <PixelCta
          disabled={!swapEnabled}
          onClick={handleSwap}
          label={
            numericFrom <= 0
              ? "ENTER AMOUNT"
              : belowMinimum
                ? "BELOW MINIMUM"
                : swapKitMispicked
                  ? "SWITCH ROUTING TO CONTINUE"
                  : zephRouteable
                    ? "► SWAP"
                    : basicswapRoutable && basicswapAddressMissing
                      ? "WALLET REQUIRED"
                      : basicswapFundingShort
                        ? "SWAP NODE CANNOT FUND THIS"
                        : basicswapReady
                          ? "► REVIEW SWAP"
                          : basicswapRoutable
                            ? liveLoading
                              ? "READING THE OFFER BOOK…"
                              : "NO OFFER TO TAKE YET"
                    : deskRoutable && deskAddressesMissing
                      ? "WALLET REQUIRED"
                      : deskReady
                        ? "► SWAP (ATOMIC)"
                        : deskRoutable
                          ? liveLoading
                            ? "QUOTING…"
                            : "QUOTE UNAVAILABLE"
                          : swapKitReady || intentsReady
                            ? "► SWAP"
                            : swapKitRoutable || intentsRoutable
                              ? liveLoading
                                ? "QUOTING…"
                                : "QUOTE UNAVAILABLE"
                              : atomicPreviewBlocked
                                ? "ATOMIC SWAP UNAVAILABLE"
                                : "ATOMIC SWAP (PREVIEW)"
          }
        />
      </span>

      {/* Trust chips — the message the deleted "Routing through …"
          paragraph used to carry, at a size that does not compete with
          the quote. These are claims about the product's custody model,
          true on every route the form can take. */}
      <ChipRow>
        <Chip>non-custodial</Chip>
        <Chip tone="accent">no kyc</Chip>
        <Chip>atomic lock</Chip>
      </ChipRow>

      {/* Quick pairs — tapping fills both selectors. */}
      <LabeledDivider label="quick pairs" style={{ marginTop: 4 }} />
      <QuickPairs
        pairs={quickPairs}
        onPick={(f, t) => {
          setFromCoin(f);
          setToCoin(t);
        }}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Coin picker button — opens a real dropdown menu listing every
   swap-supported coin (XMR / BTC / ETH / ZEPH / SOL). Each row
   shows the user's actual balance (when held) so picking the
   from-coin is informed. The currently-selected ticker is
   highlighted; the *other* side's ticker is disabled so the user
   can't pick a same-coin pair.
   ────────────────────────────────────────────────────────────── */
function CoinPickerButton({
  ticker,
  otherTicker,
  onPick,
  fontSize,
  walletsByChain,
  balancesByChain,
  zphAssetBalances,
  onlySourceCapable,
  preferredRouter,
  basicswapEnabledTickers,
}: {
  ticker: string;
  /** The other side's coin — disabled in the dropdown so the user
   *  can't accidentally select a same-coin pair. */
  otherTicker?: string;
  onPick: (next: string) => void;
  fontSize: number;
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  balancesByChain: Partial<Record<ChainType, string>>;
  zphAssetBalances?: ZphAssetBalance[] | null;
  /** When true, dropdown filters to coins the wallet can ACT AS THE
   *  SOURCE for. Used on the FROM side; the TO side shows everything. */
  onlySourceCapable?: boolean;
  /**
   * Which route the user is on. The roster is route-dependent (2026-08-22):
   * BasicSwap can settle XMR against BTC/LTC/DOGE/DASH/BCH, so on that
   * route the picker offers only those — and only the family that pairs
   * with whatever is already picked opposite. Undefined → the aggregator
   * roster, as before.
   */
  preferredRouter?: RouterPreference;
  /**
   * The counterparty tickers the local BasicSwap node currently reports
   * `enabled && configured` (2026-08-22). A second, live filter on top of
   * the protocol-legal roster above: DOGE/DASH/BCH are legal BasicSwap
   * counterparty legs but ship off by default, so a fresh install's picker
   * should show BTC/LTC (the default-on pair) until the user activates
   * more coins — at which point they appear here automatically, with no
   * further wiring. `undefined`/`null` while the node's status hasn't
   * loaded yet shows the full protocol-legal roster rather than an empty
   * one. Ignored off the BasicSwap route.
   */
  basicswapEnabledTickers?: ReadonlySet<string> | null;
}) {
  const [open, setOpen] = useState(false);
  /** Which multi-network symbol is expanded, if any. Reset on close so
   *  reopening the picker always starts from the symbol list. */
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click or escape — standard click-away pattern.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setExpandedSymbol(null);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const balanceFor = (sym: string): number | null =>
    balanceForTicker(
      sym,
      walletsByChain,
      balancesByChain,
      zphAssetBalances ?? null
    );

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        className="qbtn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 12px",
          background: "#060606",
          fontSize,
          height: "100%",
          minHeight: 36,
          borderColor: open ? "var(--accent-mid)" : "var(--border)",
        }}
      >
        <CoinIcon sym={symbolFor(ticker)} size={18} glow={false} />
        <span style={{ color: "var(--text)" }}>{symbolFor(ticker)}</span>
        {/* The network is part of the asset's identity, not decoration.
            USDC on Arbitrum and USDC on Base are different tokens at
            different contracts, so the CLOSED button has to say which one is
            selected or the form claims to swap "USDC" from nowhere. */}
        {networkLabelFor(ticker) && (
          <span
            data-network-chip
            style={{
              fontSize: 8,
              letterSpacing: 0.4,
              padding: "1px 4px",
              border: "1px solid var(--border)",
              color: "var(--text-dim)",
            }}
          >
            {networkLabelFor(ticker)}
          </span>
        )}
        <span
          style={{
            color: "var(--text-dim)",
            fontSize: 9,
            transition: "transform .12s ease",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            display: "inline-block",
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 200,
            background: "var(--bg-2)",
            border: "1px solid var(--border-hi)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            padding: 4,
          }}
        >
          {/* The roster is ROUTE-DEPENDENT (2026-08-22). On the aggregator
              routes it is the Pwnda × NEAR Intents intersection (BTC/ETH/
              SOL/LTC source-capable; +BCH/DOGE/XRP/TRX destination-only)
              unioned with the desk's XMR/ZEPH. On the BasicSwap route it is
              narrowed to the coins that route can actually settle — and to
              the FAMILY that pairs with the other side, so picking XMR
              opposite shows only BTC/LTC/DOGE/DASH/BCH and vice versa.
              Before this the P2P tab listed ETH/SOL/BNB/ADA/AVAX/POL/XLM/SUI,
              none of which BasicSwap carries, and the only thing telling the
              user so was the strip underneath after they had already built
              the pair. Zephyr ecosystem swaps live in their own
              `<ZephyrEcosystemSwapCard>` — in-protocol routing, not a
              cross-chain route, so it never enters this list. */}
          {pickerRows(
            preferredRouter === "basicswap"
              ? basicswapPickerTickers(
                  getDropdownTickers({ sourceOnly: onlySourceCapable }),
                  otherTicker,
                  basicswapEnabledTickers,
                )
              : getDropdownTickers({
                  sourceOnly: onlySourceCapable,
                  router: preferredRouter,
                }),
          ).map((row) => {
            // A symbol carried on more than one network is ONE row that
            // expands, not N rows. The roster gained fifteen stablecoin legs
            // on 2026-09-09 (`USDC-ARB`, `USDT0-POL`, …) because the
            // capability registry holds one chain per entry; rendering them
            // flat would triple the dropdown and ask the user to decode
            // `USDC-BSC`. The assets rail groups the same money the same way.
            const grouped = isGrouped(row);
            const expanded = expandedSymbol === row.symbol;
            const soleKey = row.legs[0];
            const isSelected = row.legs.includes(ticker);
            // Only an ungrouped row can BE the other side; a grouped row is
            // disabled per-network below, because USDC-ARB opposite USDC-BASE
            // is a legitimate pair.
            const isDisabled = !grouped && soleKey === otherTicker;
            const bal = grouped ? null : balanceFor(soleKey);

            return (
              <div key={row.symbol} style={{ display: "contents" }}>
                <button
                  role="option"
                  aria-selected={isSelected}
                  aria-expanded={grouped ? expanded : undefined}
                  disabled={isDisabled}
                  onClick={() => {
                    if (isDisabled) return;
                    if (grouped) {
                      // Expand. There is no bare "USDC" to select — every
                      // choice resolves to exactly one network's leg.
                      setExpandedSymbol(expanded ? null : row.symbol);
                      return;
                    }
                    onPick(soleKey);
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    background: isSelected
                      ? "rgba(0,255,102,0.06)"
                      : "transparent",
                    border: "none",
                    borderLeft: isSelected
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                    color: isSelected ? "var(--accent)" : "var(--text)",
                    cursor: isDisabled ? "not-allowed" : "pointer",
                    opacity: isDisabled ? 0.35 : 1,
                    textAlign: "left",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    letterSpacing: 0.4,
                    transition: "background .1s ease",
                    width: "100%",
                  }}
                  onMouseEnter={(e) => {
                    if (isDisabled || isSelected) return;
                    e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    if (isDisabled || isSelected) return;
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <CoinIcon sym={row.symbol} size={20} glow={false} />
                  <span style={{ flex: 1 }}>{row.symbol}</span>

                  {grouped ? (
                    <span
                      data-network-count
                      style={{ fontSize: 9, color: "var(--text-dim)" }}
                    >
                      {row.legs.length} networks {expanded ? "\u25be" : "\u25b8"}
                    </span>
                  ) : bal != null ? (
                    <span
                      className="tnum"
                      style={{ fontSize: 10, color: "var(--text-dim)" }}
                    >
                      {fmtBal(bal)}
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 9,
                        color: "var(--text-dim)",
                        opacity: 0.6,
                      }}
                    >
                      —
                    </span>
                  )}

                  {isDisabled && (
                    <span
                      style={{
                        fontSize: 8,
                        color: "var(--text-dim)",
                        letterSpacing: 0.5,
                        textTransform: "uppercase",
                      }}
                    >
                      other side
                    </span>
                  )}
                </button>

                {/* The network choice. Indented under its symbol so the
                    relationship is visible, and every entry names the chain
                    in full — "Arbitrum", not "ARB" — because picking the
                    wrong network is how funds end up somewhere the user
                    cannot easily reach them. */}
                {grouped &&
                  expanded &&
                  row.networks.map((n) => {
                    const legSelected = n.key === ticker;
                    const legDisabled = n.key === otherTicker;
                    const legBal = balanceFor(n.key);
                    return (
                      <button
                        key={n.key}
                        role="option"
                        aria-selected={legSelected}
                        disabled={legDisabled}
                        onClick={() => {
                          if (legDisabled) return;
                          onPick(n.key);
                          setExpandedSymbol(null);
                          setOpen(false);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 10px 6px 30px",
                          background: legSelected
                            ? "rgba(0,255,102,0.06)"
                            : "transparent",
                          border: "none",
                          borderLeft: legSelected
                            ? "2px solid var(--accent)"
                            : "2px solid transparent",
                          color: legSelected ? "var(--accent)" : "var(--text)",
                          cursor: legDisabled ? "not-allowed" : "pointer",
                          opacity: legDisabled ? 0.35 : 1,
                          textAlign: "left",
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          letterSpacing: 0.3,
                          width: "100%",
                        }}
                        onMouseEnter={(e) => {
                          if (legDisabled || legSelected) return;
                          e.currentTarget.style.background =
                            "rgba(255,255,255,0.04)";
                        }}
                        onMouseLeave={(e) => {
                          if (legDisabled || legSelected) return;
                          e.currentTarget.style.background = "transparent";
                        }}
                      >
                        <span style={{ flex: 1 }}>{n.network}</span>
                        {legBal != null ? (
                          <span
                            className="tnum"
                            style={{ fontSize: 9, color: "var(--text-dim)" }}
                          >
                            {fmtBal(legBal)}
                          </span>
                        ) : null}
                        {legDisabled && (
                          <span
                            style={{
                              fontSize: 8,
                              color: "var(--text-dim)",
                              letterSpacing: 0.5,
                              textTransform: "uppercase",
                            }}
                          >
                            other side
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Decide whether to render the SwapKit-cutover canary banner.

   Gated on the build-time `VITE_SWAPKIT_CANARY` env flag (exposed as
   `SWAPKIT_CANARY_ACTIVE` from router-modes). The banner shows up only
   when the user's current selection could actually route through
   SwapKit — pure NEAR Intents picks hide it, since they weren't part
   of the cutover. That keeps the warning relevant: a user swapping
   ETH→BTC via NEAR Intents doesn't need to be told SwapKit just went
   live.

   Exported (instead of file-local) so unit tests can pin the logic
   without rendering React.
   ────────────────────────────────────────────────────────────── */
export function shouldShowCanaryBanner(args: {
  preferredRouter: RouterPreference | undefined;
  // `RouterSource` (not a narrowed literal union) so adding a router — the
  // 2026-07-19 `pwnda-desk` addition — doesn't break this signature. The
  // predicate is SwapKit-specific by design: a desk-sourced quote falls
  // through to `false`, which is correct (the canary is about the SwapKit
  // live cutover, not about every router).
  liveQuoteSource: RouterSource | undefined;
  swapKitRoutable: boolean;
}): boolean {
  if (!SWAPKIT_CANARY_ACTIVE) return false;
  // Explicit SwapKit / Auto preference — banner is relevant even before
  // the first quote lands, since the user has signaled SwapKit may run.
  if (args.preferredRouter === "swapkit") return true;
  if (args.preferredRouter === "auto" && args.swapKitRoutable) return true;
  // NEAR-only preference: banner relevant only if the resolved live
  // quote actually came from SwapKit (defensive — shouldn't happen
  // when preferredRouter === "intents", but the resolver wins ties).
  if (args.liveQuoteSource === "swapkit") return true;
  return false;
}

/* ──────────────────────────────────────────────────────────────
   Format the destination USD anchor for the minimum-hint sub-line.
   `quote.amountOutUsd` from 1Click comes back as a string like
   "5.1472" — we trim to 2 decimal places + commas for thousands.
   For tiny values (<$0.01) we render four decimals so the hint stays
   informative for cheap stablecoin pairs.
   ────────────────────────────────────────────────────────────── */
export function formatUsdSubLine(rawUsd: string): string {
  const n = Number(rawUsd);
  if (!Number.isFinite(n) || n <= 0) return "0.00";
  if (n >= 0.01) return n.toFixed(2);
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/* ──────────────────────────────────────────────────────────────
   Resolve a ticker's user balance. The four Zephyr ecosystem
   tickers (ZEPH / ZEPHUSD / ZEPHRSV / ZEPHYRS) read from the
   per-asset feed (`zphAssetBalances`) — `balancesByChain[zephyr]`
   only carries the ZEPH balance, not the other three.
   ────────────────────────────────────────────────────────────── */
function balanceForTicker(
  ticker: string,
  walletsByChain: Partial<Record<ChainType, WalletInfo>>,
  balancesByChain: Partial<Record<ChainType, string>>,
  zphAssetBalances: ZphAssetBalance[] | null
): number | null {
  const zphAsset = tickerToZphAssetType(ticker);
  if (zphAsset && zphAssetBalances) {
    // ZEPH-family ticker: prefer the per-asset feed when available.
    // The atomic-units → display string conversion lives in
    // `wallets/zph-rpc.ts`; we parse the result back to a number for
    // arithmetic / dropdown display.
    const entry = zphAssetBalances.find((b) => b.asset_type === zphAsset);
    if (!entry) return null;
    const display = atomicToZph(entry.unlocked_balance ?? entry.balance ?? 0);
    const n = parseFloat(display);
    return Number.isFinite(n) ? n : null;
  }
  // Generic chain: balancesByChain keyed by the wallet's chain.
  const chain = tickerToChain(ticker);
  if (!chain || !walletsByChain[chain]) return null;
  const raw = balancesByChain[chain];
  if (!raw || raw === "—" || raw === "--") return null;
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Which upstream the no-quote fallback banner should describe, for a given
 * router preference.
 *
 * Extracted and exported ONLY so it can be tested exhaustively. This mapping
 * has now silently lost a router TWICE — 2026-07-19 for `pwnda-desk`, and
 * again for `basicswap` — because a missing arm falls through to `"intents"`
 * and tells the user a completely different upstream will route their swap.
 * That is a correctness bug, not cosmetics: `basicswap` is the ONLY route
 * carrying XMR and ZEPH, so "Routing through NEAR Intents" on the P2P tab is
 * not merely wrong, it names a route that cannot do the trade at all.
 *
 * `auto` legitimately maps to Intents (the default upstream when the form has
 * no resolved quote to report yet).
 */
export function fallbackBannerSource(
  preferredRouter: RouterPreference
): RouterSource {
  switch (preferredRouter) {
    case "swapkit":
      return "swapkit";
    case "pwnda-desk":
      return "pwnda-desk";
    case "basicswap":
      return "basicswap";
    case "intents":
    case "auto":
      return "intents";
  }
}

/* ──────────────────────────────────────────────────────────────
   Routing-mode banner. Yellow when the active upstream is mock
   (or the SwapKit response carries the mock UUID — defence in
   depth); green when live. Only shown when the user has selected
   SwapKit-only or NEAR-only.
   ────────────────────────────────────────────────────────────── */
function RouterBanner({
  preferredRouter,
  info,
}: {
  preferredRouter: RouterPreference;
  info: ReturnType<typeof effectiveModeForSource> | null;
}) {
  // When the form has no quote yet, fall back to the *configured* mode for
  // the user's preferred upstream (not the resolved-quote one). This makes
  // the banner show up immediately rather than waiting for the first
  // successful quote.
  // 2026-07-19 fix: this collapsed every non-swapkit preference onto the NEAR
  // Intents banner. Since VITE_INTENTS_LIVE defaults TRUE and VITE_DESK_LIVE
  // defaults FALSE, a user sitting on the Desk tab with no quote yet was told a
  // LIVE bridge would route their swap — the exact inversion of the truth. Map
  // each preference to its own source; `auto` keeps the Intents default.
  const target: RouterSource = fallbackBannerSource(preferredRouter);
  const fallback = effectiveModeForSource(target);
  const effective = info ?? fallback;

  const isMock = !effective.isLive;
  // UXS-20260516-104: mocked routes stay amber (warn); live routes use
  // a neutral cyan-ish info palette so the banner reads "FYI, here is
  // your route" rather than "ALL CLEAR, GO" — the latter signal
  // belongs only in the confirm modal where money actually moves.
  const bg = isMock ? "rgba(255,170,0,0.10)" : "rgba(160,180,200,0.06)";
  const bd = isMock ? "rgba(255,170,0,0.55)" : "rgba(160,180,200,0.30)";
  const fg = isMock ? "var(--warn)" : "var(--text)";
  const dot = isMock ? "🟡" : "ℹ";

  // Mock-detection annotation when the heuristic UUID matched.
  const mockNote = effective.mockDetected
    ? " (mock upstream detected)"
    : "";

  return (
    <div
      role="status"
      style={{
        background: bg,
        border: `1px solid ${bd}`,
        color: fg,
        padding: "8px 10px",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: 0.4,
        display: "flex",
        alignItems: "center",
        gap: 8,
        lineHeight: 1.4,
      }}
    >
      <span aria-hidden style={{ fontSize: 12 }}>{dot}</span>
      <span style={{ flex: 1 }}>{effective.banner}{mockNote}</span>
    </div>
  );
}
