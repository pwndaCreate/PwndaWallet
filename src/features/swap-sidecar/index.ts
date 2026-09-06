/**
 * Public surface of the BasicSwap sidecar feature.
 *
 * Cross-feature imports go through THIS file only (BOUNDARIES.md) — reaching
 * into the private modules from another feature is what the boundary check
 * exists to stop.
 *
 * The sidecar is **desktop-only and opt-in**: nothing here downloads, spawns,
 * or `invoke`s a `swap_sidecar_*` command until the user has accepted the setup
 * screen (see `useSwapSidecarOptIn`). PwndaLite never links this feature.
 *
 * It is also the wallet's **only** route for XMR and ZEPH — NEAR Intents
 * carries neither (verified against the live catalog), which is why the swap
 * router resolves those pairs here rather than treating this as a niche add-on.
 */

// ── Opt-in gate (plaintext, readable before vault unlock) ────────────
export {
  SWAP_SIDECAR_OPT_IN_STORE_KEY,
  useSwapSidecarOptIn,
} from "./swapSidecarOptIn";

// ── In-flight swap ownership (mount ABOVE the view router) ───────────
export {
  useSidecarSwap,
  isBasicswapRoutable,
  basicswapLegsFor,
  basicswapPickerTickers,
  correctedBasicswapPair,
  fetchMinFillableAmount,
  SidecarQuoteError,
  BASICSWAP_COUNTERPARTY_TICKERS,
  type SidecarSwapState,
  type SidecarSwapHandle,
  type SidecarTrackedSwap,
  type SidecarQuote,
  type BasicswapLegs,
  type MinFillableAmount,
} from "./useSidecarSwap";

// ── Swap-node balances (C0.1) ───────────────────────────────────────
// The hook polls; the card is props-only. Mount sites own the hook and
// pass its result down — that is what lets the same card render in the
// landscape Swap column, portrait Swap, and the wallet dashboard without
// three independent polls of the same endpoint.
export {
  useSidecarBalances,
  syncStateOf,
  syncSentence,
  type SyncState,
  balanceRowsFrom,
  isZeroAmount,
  isNodeNotRunning,
  SidecarBalanceShapeError,
  SIDECAR_NOT_RUNNING,
  BALANCES_POLL_MS,
  BALANCES_POLL_FLOOR_MS,
  type SidecarBalanceRow,
  type SidecarBalancesState,
} from "./useSidecarBalances";

// ── Per-coin DEX enablement + the selection gate (C3) ───────────────
// `useDexCoins` is the pre-invoke mirror (readable before the vault is
// unlocked); `useCoinStatuses` is the authority. `gateBlocks` fails CLOSED and
// is what a send path branches on — never on `SelectionGate.reason`, which is
// display copy.
export {
  DEX_COINS_STORE_KEY,
  useDexCoins,
  useCoinStatuses,
  liveEnabledTickersFrom,
  useSelectionGate,
  readDexCoins,
  writeDexCoin,
  normalizeDexCoins,
  dexCoinsDrift,
  dexCoinsOrphans,
  gateBlocks,
  gateSentence,
  type DexCoinState,
  type CoinStatusesState,
  type SelectionGateState,
  type DexAdoption,
  type CoinEnableStatus,
  type CoinMode,
  type SelectionGate,
} from "./dexCoins";

// ── Zero-move adoption (C3.5) ───────────────────────────────────────
// The per-coin descriptor strategy, measured against the real binaries. LTC
// accepts `importdescriptors` and has NO `listdescriptors`: the read-back must
// be SKIPPED there, not attempted-and-forgiven. `precheckImport` is a UX
// pre-flight, not a gate — Rust refuses independently.
export {
  ADOPTION_MEASURED_ON,
  DEFAULT_RANGE_END,
  MAX_RANGE_END,
  adoptionPlanFor,
  coinsWithAdoptionPlan,
  defaultAdoptionFor,
  shouldAttemptReadBack,
  readBackAbsenceIsFailure,
  expectedBranchLabels,
  coveredBothBranches,
  reportContainsKeyMaterial,
  precheckImport,
  importOptionsFor,
  useDescriptorImport,
  type CoinAdoptionPlan,
  type DescriptorMethod,
  type ReadBackPolicy,
  type ImportBlockCode,
  type ImportPrecheck,
  type ImportOptions,
  type DescriptorImportState,
  type DescriptorImportReport,
} from "./descriptorAdoption";

// ── Destination-pinned sweep-back (C4 / C6) ─────────────────────────
// Nothing here accepts a destination address. `confirm(phrase)` is the only
// execute path, and the phrase is the last 6 characters of the Rust-derived
// destination.
export {
  SWEEP_TOKEN_TTL_MS,
  SWEEP_CONFIRM_LEN,
  useSweepBack,
  confirmPhraseFor,
  isConfirmPhraseValid,
  sweepPlanExpired,
  sweepPlanMsRemaining,
  formatCountdown,
  sweepSummary,
  type SweepPlan,
  type SweepBackState,
} from "./sweepBack";

// ── The node's Monero wallet (C6) ───────────────────────────────────
export {
  XMR_DECIMALS,
  useDexXmrWallet,
  subtractAmount,
  isNegativeAmount,
  spendableXmr,
  displayAddress,
  type DexXmrWalletState,
} from "./dexXmrWallet";

// ── Daemon-direct routing, read side (C2) ───────────────────────────
// Probed live. A coin missing from the probe is UNKNOWN, and every predicate
// treats unknown as "cannot route".
export {
  useDaemonCapabilities,
  routingSummary,
  capabilityFor,
  canRouteDaemonDirect,
  preferredFeeMode,
  type DaemonCapability,
  type DaemonCapabilitiesState,
} from "./daemonRouting";

// ── Components ──────────────────────────────────────────────────────
export { SwapBalancesCard } from "./SwapBalancesCard";
export { SidecarSwapTracker } from "./SidecarSwapTracker";
export { SidecarConfirmModal } from "./SidecarConfirmModal";
export { SidecarSetupWizard, SIDECAR_FOOTPRINT } from "./SidecarSetupWizard";
export { SidecarStatusCard } from "./SidecarStatusCard";
export { EngineOwnershipStrip } from "./EngineOwnershipStrip";
export { DexCoinCard } from "./DexCoinCard";
// Particl is surfaced from the SWAP NODE's wallet rather than a ChainType
// adapter of its own — one seed phrase, one PART balance. See the card's
// header for why a second derived PART wallet would be actively harmful.
export { DexParticlCard } from "./DexParticlCard";

// The public market preview — readable with no node and no opt-in, which is
// the whole point: the P2P surfaces can show a real market before the user
// commits to running anything. Data module + hook are exported alongside the
// component so a future surface can render the same snapshot differently
// without a second fetch (the hook caches process-wide).
export { MarketPreview } from "./MarketPreview";
export {
  MARKETS_SNAPSHOT_HOST,
  MARKETS_SNAPSHOT_URL,
  fetchMarketSnapshot,
  parseSnapshot,
  shortAge,
  shortMaker,
} from "./marketsSnapshot";
export type {
  MarketOffer,
  MarketPair,
  MarketSnapshot,
} from "./marketsSnapshot";
export { useMarketsSnapshot } from "./useMarketsSnapshot";
export { useSwapAutoSetup, runSharePass, AUTO_SETUP_RETRY_MS } from "./useSwapAutoSetup";
export type { SharePassResult } from "./useSwapAutoSetup";
export { useChainSync } from "./useChainSync";
export type { ChainSyncState } from "./useChainSync";
export type { SwapAutoSetupState } from "./useSwapAutoSetup";
export { SweepBackConfirmCard } from "./SweepBackConfirmCard";
export { DexXmrWalletCard } from "./DexXmrWalletCard";
export { useXmrHostWalletConsent } from "./useXmrHostWalletConsent";
export type { XmrHostWalletConsentState } from "./useXmrHostWalletConsent";
// C-RZ / C-RX — the ZEPH/ZANO twin of the Monero consent hook (2026-09-04).
export { useCnHostWalletConsent } from "./useCnHostWalletConsent";
export type { CnHostWalletConsentState } from "./useCnHostWalletConsent";

// ── C8 authority switch — the wallet dashboard's balance override ────
export {
  SHARED_COIN_CHAINS,
  applySharedCoinBalances,
  isSharedCoinChain,
  readSharedBalance,
  sharedChains,
  verifiedSharedTickers,
  type SharedCoinBalance,
} from "./sharedCoinBalance";
export {
  fetchSharedCoinOverrides,
  SHARED_BALANCE_TIMEOUT_MS,
  type SharedBalanceDeps,
} from "./fetchSharedCoinOverrides";

// ── The safety core ─────────────────────────────────────────────────
// The spread gate is not a nicety: the measured book carries offers from
// +0.2% to +14% over mid plus stale bait, so an unguarded taker can be walked
// into a very bad fill. A missing price feed is treated as RED (cannot
// verify), never silently green.
export {
  computeSpread,
  evaluateSpreadGate,
  formatSpreadSentence,
  formatBandNote,
  marketRateFromPrices,
  marketRateFromUsd,
  normalizeOverrideInput,
  isOverrideTyped,
  SPREAD_THRESHOLDS,
  SPREAD_GREEN_MAX_PCT,
  SPREAD_AMBER_MAX_PCT,
  SPREAD_OVERRIDE_PHRASE,
  type SpreadBand,
  type SpreadReason,
  type SpreadAssessment,
  type SpreadGate,
  type SpreadThresholds,
} from "./spread";

// ── Swap-state translation (refunds are NORMAL outcomes) ────────────
export {
  classifyBidState,
  stageForBidState,
  bidStageLabel,
  isTerminal,
  isRefundOutcome,
  shouldSurface,
  type BidStage,
  type BidSeverity,
  type BidStateName,
} from "./bidStates";

// ── Offer ranking + validation (price-only, never maker-preferential) ─
export {
  rankOffers,
  bestOffer,
  toTakerOffers,
  protocolFloorForPair,
  snapDown,
  type TakerOffer,
  type PairFloor,
} from "./offers";
