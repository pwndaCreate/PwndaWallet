import { useUtxoReceiveAddress } from "../../lib/utxoAccountRegistry";
import { HederaSetupPanel } from "./HederaSetupPanel";
import { isHederaAccountMissing } from "../../wallets/hbar-wallet";
import {
  groupStablecoins,
  isStablecoinChain,
  stablecoinNetworkFor,
  type StablecoinGroup,
} from "../../wallets/stablecoins";
import { useState, useEffect, type ReactNode } from "react";
import type { ChainType, WalletInfo } from "../../wallets";
import { getAdapter, ALL_CHAINS } from "../../wallets";
import { explorerTxUrl } from "../../wallets/explorers";
import { openExternal } from "../../utils/openExternal";
import { assetRank } from "../../wallets/coin-metadata";
import type { XmrTransfer } from "../../wallets/xmr-wallet";
import { piconeroToXmr } from "../../wallets/xmr-rpc";
import type { ZphAssetBalance, ZphAssetType } from "../../wallets/zph-rpc";
import {
  ZPH_UI_TICKER,
  ZPH_ASSET_NAME,
  ZPH_ASSET_COLOR,
  atomicToZph,
} from "../../wallets/zph-rpc";
import type { ChainTx } from "../../wallets/types";
import { mergeChainTx } from "../activity/useTxHistory";
import { ST } from "../../components/Primitives";
import { CoinIcon } from "../../components/CoinIcon";
import { MiniSpark } from "../../components/PrimitivesV2";
import { useResizableRails } from "../../components/ResizableRails";
import { SyncStatusPanel } from "../landscape/SyncStatusPanel";
import { ZephyrProtocolStatsCard } from "../zephyr/ZephyrProtocolStatsCard";
import { BtcLegacyPanel } from "./BtcLegacyPanel";
import { AdaLegacyPanel } from "./AdaLegacyPanel";
import { CardanoDerivationPanel } from "./CardanoDerivationPanel";
import { SolanaDerivationPanel } from "./SolanaDerivationPanel";
import { DerivationInfoCard } from "./DerivationInfoCard";
import { LitecoinDerivationPanel } from "./LitecoinDerivationPanel";
import { AlgorandDerivationPanel } from "./AlgorandDerivationPanel";
import { placeholderSparkFor } from "./spark-fallback";
import { SwapBalanceSubline } from "./SwapBalanceSubline";
import {
  classifyBalance,
  formatMissingLabel,
  isMissingFromTotal,
} from "./balance-status";
import { useSidecarBalances, useSwapSidecarOptIn } from "../swap-sidecar";
import { DexXmrWalletSection } from "../monero/DexXmrWalletSection";
import { fmtRelative } from "../../utils/format";
import { zphAssetPrice, type ZphLiveStats } from "../../wallets/zph-scanner-api";
import { UtxoAccountCard } from "./UtxoAccountCard";

/* ══════ Types ═════════════════════════════════════════════════ */
type SyncState = "idle" | "starting" | "syncing" | "synced" | "error" | "connection-lost";

interface BaseSyncSessionProps {
  syncState: SyncState;
  syncPercent: number;
  walletHeight: number;
  daemonHeight: number;
  blocksPerSec: number | null;
  etaSeconds: number | null;
  syncError: string;
  defenderExcluded: boolean | null;
  onRetry: () => void;
  onManageNodes: () => void;
  onAddDefenderExclusion: () => void;
}

export interface XmrSessionForLandscape extends BaseSyncSessionProps {
  receiveAddress: string | null;
  showPrimary: boolean;
  setShowPrimary: (v: boolean) => void;
  onNewSubaddress: () => Promise<void>;
}

export interface ZphSessionForLandscape extends BaseSyncSessionProps {
  assetBalances?: ZphAssetBalance[] | null;
  onOpenSwap?: (source: ZphAssetType) => void;
  reserveStats?: ZphLiveStats | null;
  reserveLoading?: boolean;
  reserveError?: string | null;
  reserveFetchedAt?: number | null;
}

/* ══════ helpers ═════════════════════════════════════════════ */
function parseBalanceNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function getUsd(
  ticker: string,
  rawBalance: string | undefined,
  prices: Record<string, number>
): number | null {
  const price = prices[ticker.toUpperCase()];
  if (price == null) return null;
  const n = parseBalanceNumber(rawBalance);
  if (n == null) return null;
  return n * price;
}

/** Same conversion as `getUsd`, for a total already summed to a number. */
function getUsdFromAmount(
  ticker: string,
  amount: number,
  prices: Record<string, number>
): number | null {
  const price = prices[ticker.toUpperCase()];
  if (price == null) return null;
  return amount * price;
}

function fmtUsd(usd: number): string {
  if (usd >= 1000) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${usd.toFixed(2)}`;
}

function fmtBalance(raw: string | undefined): string {
  if (!raw || raw === "--") return "—";
  const n = parseBalanceNumber(raw);
  if (n == null) return raw;
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function truncAddr(addr: string): string {
  if (!addr) return "—";
  if (addr.length <= 22) return addr;
  return `${addr.slice(0, 11)}…${addr.slice(-8)}`;
}

const PLACEHOLDER_SPARK = [4, 5, 4, 6, 5, 7, 6, 7, 8, 9, 8, 10];

// ZPH_ASSET_COLOR now comes from `wallets/zph-rpc` — see its doc comment for
// why the three local copies were removed.

/* ══════ WalletLandscapeView ══════════════════════════════════
   v2 design: 3-column layout with no Card chrome on the left/right
   columns — clean column separators only. Center column has the
   focal coin block + action grid + address row + recent activity.
   ────────────────────────────────────────────────────────────── */
/** Chains with a bespoke derivation panel in the LANDSCAPE view. Smaller
 *  than the portrait set — landscape mounts only BTC/ADA/SOL — so the generic
 *  finder must fill in for the rest. */
const LANDSCAPE_DERIVATION_PANEL_CHAINS = new Set<ChainType>([
  "bitcoin",
  "cardano",
  "solana",
]);

export function WalletLandscapeView({
  walletsByChain,
  activeChain,
  setActiveChain,
  balancesByChain,
  balancesLoading,
  onRefreshBalances,
  pricesByTicker,
  xmrTxHistory,
  xmrSession,
  zanoCenterSlot,
  onOpenSwapForAsset,
  zphSession,
  importPanelSlot,
  onSend,
  // Generic per-chain tx history — used for the Recent block on every
  // non-XMR chain. XMR keeps its own dedicated path because it carries
  // sync-state semantics the generic feed doesn't.
  chainTxByKey,
  addressByChain,
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
  onCopy,
}: {
  walletsByChain: Partial<Record<ChainType, WalletInfo>>;
  activeChain: ChainType;
  setActiveChain: (c: ChainType) => void;
  balancesByChain: Partial<Record<ChainType, string>>;
  balancesLoading: boolean;
  onRefreshBalances: () => void;
  pricesByTicker: Record<string, number>;
  xmrTxHistory: XmrTransfer[];
  xmrSession: XmrSessionForLandscape | null;
  /** Open the Swap tab with this asset pre-selected on AUTO. */
  onOpenSwapForAsset?: (ticker: string) => void;
  zphSession: ZphSessionForLandscape | null;
  /** Zano's center-column content (import panel when not loaded; sync + assets
   *  when loaded), built by LandscapeRoot from the shared Zano components and
   *  rendered INLINE here — same as the monero/zephyr center sections — so Zano
   *  is not a detached footer below this view. Only rendered on the zano panel. */
  zanoCenterSlot?: ReactNode;
  /**
   * Seed-import panel for the active chain, when that chain uses an
   * independent seed and has no wallet yet (Monero / Zephyr).
   *
   * Passed in as a rendered node rather than plumbing the panel's six data
   * props down through `LandscapeRoot` — App.tsx already holds all of them
   * for the portrait `DashboardView`, so building the element there and
   * handing it over keeps this view presentational and adds one prop instead
   * of eight.
   *
   * Undefined when the active chain doesn't need a panel.
   */
  importPanelSlot?: React.ReactNode;
  /** Open the send modal. Optional Zephyr asset (ZSD/ZRS/ZYS) sends that
   *  ecosystem asset instead of the chain's native one. */
  onSend: (assetType?: ZphAssetType) => void;
  chainTxByKey?: Record<string, ChainTx[]>;
  addressByChain?: Record<string, string>;
  /** 24h USD-price history per ticker (oldest first). Populated by
   *  fetchUsdPriceHistory in App.tsx. Tickers with no data simply
   *  aren't keyed; spark fallbacks to PLACEHOLDER_SPARK in that case. */
  priceHistoryByTicker?: Record<string, number[]>;
  /** Mnemonic for legacy / multi-path discovery panels. Optional —
   *  panels self-hide when unavailable. */
  sharedMnemonic?: string | null;
  /** Live `derivationChoice.solana` from the vault. */
  currentSolanaDerivationChoice?: string;
  /** Save+re-derive callback when user picks an alternative SOL path. */
  onChangeSolanaDerivation?: (newChoice: string) => Promise<void>;
  /** Live `derivationChoice.cardano` from the vault. */
  currentCardanoDerivationChoice?: string;
  /** Save+re-derive callback when user picks an alternative ADA derivation. */
  onChangeCardanoDerivation?: (newChoice: string) => Promise<void>;
  /** Live `derivationChoice.algorand` from the vault. */
  currentAlgorandDerivationChoice?: string;
  /** Save+re-derive callback when user picks an alternative ALGO derivation. */
  onChangeAlgorandDerivation?: (newChoice: string) => Promise<void>;
  /** Live `derivationChoice.litecoin` from the vault (Exodus L… vs ltc1q…). */
  currentLitecoinDerivationChoice?: string;
  /** Save+re-derive callback when user picks an alternative LTC derivation. */
  onChangeLitecoinDerivation?: (newChoice: string) => Promise<void>;
  /** Copy-to-clipboard helper used by the legacy panels. */
  onCopy?: (text: string) => void;
}) {
  const [copiedAddr, setCopiedAddr] = useState(false);
  // When a Zephyr ecosystem asset (ZSD/ZRS/ZYS) row is selected, the center
  // focal panel shows IT instead of ZEPH — same address + Send/Receive/Swap,
  // just scoped to that asset. Cleared whenever a different chain is selected.
  const [focusedZphAsset, setFocusedZphAsset] = useState<ZphAssetType | null>(
    null
  );
  // Which stablecoin families are manually expanded. A family whose leg is the
  // active chain expands regardless — see `renderStablecoinRow`.
  const [expandedStables, setExpandedStables] = useState<Set<string>>(
    () => new Set()
  );
  // Drop any focused Zephyr sub-asset when the active chain leaves Zephyr, so
  // returning to it later starts on the ZEPH focal rather than a stale asset.
  useEffect(() => {
    if (activeChain !== "zephyr") setFocusedZphAsset(null);
  }, [activeChain]);

  // "Smart" portfolio order: holdings value descending (biggest first),
  // then the canonical market-cap rank for zero / unpriced rows, then name
  // — so the list reads like Exodus instead of the arbitrary derivation
  // order. `getUsd` returns null when a row couldn't be priced.
  const chains = (Object.entries(walletsByChain) as [ChainType, WalletInfo][])
    // Stablecoin legs are STACKED into one row per symbol below, the way
    // Exodus does it — thirteen "USDC (Base)" / "USDT (BNB Chain)" rows read
    // as thirteen unrelated coins when what the user holds is USDC and USDT
    // on several networks. They are still real chains underneath (own
    // adapter, own send/receive/history); only the rail groups them.
    .filter(([c]) => !isStablecoinChain(c))
    .sort(([ca], [cb]) => {
      const ua = getUsd(getAdapter(ca).ticker, balancesByChain[ca], pricesByTicker);
      const ub = getUsd(getAdapter(cb).ticker, balancesByChain[cb], pricesByTicker);
      const va = ua != null && ua > 0 ? ua : -1;
      const vb = ub != null && ub > 0 ? ub : -1;
      if (va !== vb) return vb - va;
      const ra = assetRank(getAdapter(ca).ticker);
      const rb = assetRank(getAdapter(cb).ticker);
      if (ra !== rb) return ra - rb;
      return getAdapter(ca).displayName.localeCompare(getAdapter(cb).displayName);
    });
  /**
   * Independent-seed chains (XMR / ZEPH / ZANO) that have no wallet yet.
   *
   * `chains` above is built from `walletsByChain`, so a chain whose seed has
   * never been imported is simply absent from the rail — and every one of
   * those chains gates its import panel on `activeChain === <chain>`, which
   * only this list can set. That is a closed loop: the chain is invisible
   * until it is imported, and it cannot be imported until it is visible.
   *
   * It went unnoticed because Monero and Zephyr seeds are generated during
   * onboarding, so for a wallet created in-app they are always in
   * `walletsByChain`. Zano is import-only, so it was the first chain to
   * actually fall into the hole (2026-08-28) — but a user who forgets a
   * Monero wallet lands in exactly the same place, which is why this is
   * keyed on `usesIndependentSeed` rather than special-casing Zano.
   *
   * Deliberately NOT merged into `chains`: that array feeds the portfolio
   * total, the sparkline history, and the vault's "N chains" count, none of
   * which should count a wallet that does not exist. These rows are
   * presentation only — an entry point, rendered after the held rows.
   */
  const importableChains = (ALL_CHAINS as readonly ChainType[]).filter(
    (c) => !!getAdapter(c).usesIndependentSeed && !walletsByChain[c],
  );

  /** Wallets that actually exist, as opposed to rows shown in the asset list
   *  (which also includes not-yet-set-up independent-seed chains). */
  const walletCount = Object.keys(walletsByChain).length;
  const activeWallet = walletsByChain[activeChain] ?? null;
  const activeAdapter = getAdapter(activeChain);
  const activeBalance = balancesByChain[activeChain];
  const activeUsd = getUsd(activeAdapter.ticker, activeBalance, pricesByTicker);

  // Portfolio total (latest, from spot prices). `missingCount` = held chains
  // whose value couldn't be loaded (failed balance or no price) and are thus
  // absent from the total — a genuine 0 balance is known-empty, not missing.
  let totalUsd = 0;
  let anyPriced = false;
  const missingNames: string[] = [];
  chains.forEach(([chain, w]) => {
    // A listed-but-unset chain (XMR/ZPH before the user supplies a seed) is
    // not a FAILED load — it's an absent wallet. Counting it would surface a
    // spurious "Monero, Zephyr not loaded" warning on every fresh BIP39-only
    // restore, which is the opposite of the reassurance this label exists for.
    if (!w) return;
    const a = getAdapter(chain);
    const rawBal = balancesByChain[chain];
    const usd = getUsd(a.ticker, rawBal, pricesByTicker);
    if (usd != null) {
      totalUsd += usd;
      anyPriced = true;
      return;
    }
    // Shared classifier — see balance-status.ts. Portrait used to treat an
    // unreadable balance as known-empty while this counted it as missing, so
    // the same wallet reported a different number of "not loaded" chains
    // depending on which way the window was turned.
    const status = classifyBalance(rawBal);
    const hasPrice = pricesByTicker[a.ticker.toUpperCase()] != null;
    if (isMissingFromTotal(status, hasPrice)) missingNames.push(a.displayName);
  });
  const missingLabel = formatMissingLabel(missingNames);

  // Held Zephyr ecosystem assets (ZSD / ZRS / ZYS) surfaced as their OWN rows
  // in the assets list instead of being buried in a sub-card under ZEPH. ZPH
  // itself is already the `zephyr` chain row, so it's excluded. Priced via the
  // live reserve stats; rows are added to the portfolio total too.
  const zephyrAssetRows = (() => {
    const balances = zphSession?.assetBalances;
    if (!balances) return [] as Array<{
      asset: ZphAssetType;
      ticker: string;
      name: string;
      balanceStr: string;
      usd: number | null;
    }>;
    const stats = zphSession?.reserveStats ?? null;
    return balances
      .filter((b) => b.asset_type !== "ZPH" && b.balance > 0)
      .map((b) => {
        const price = zphAssetPrice(stats, b.asset_type);
        const units = b.balance / 1e12; // Zephyr atomic = 1e12
        return {
          asset: b.asset_type,
          ticker: ZPH_UI_TICKER[b.asset_type],
          name: ZPH_ASSET_NAME[b.asset_type],
          balanceStr: atomicToZph(b.balance),
          usd: price != null ? units * price : null,
        };
      });
  })();
  for (const r of zephyrAssetRows) {
    if (r.usd != null) {
      totalUsd += r.usd;
      anyPriced = true;
    }
  }

  // Stablecoin families, each with its per-network breakdown and a total.
  // Rows with nothing held anywhere are dropped: a fresh wallet should not
  // grow three permanent $0.00 rows it never asked for.
  const stablecoinGroups = groupStablecoins(balancesByChain).filter(
    (g) => (g.total ?? 0) > 0 || g.rows.some((r) => r.chain === activeChain),
  );
  const stablecoinUsd = (g: StablecoinGroup): number | null =>
    g.total == null ? null : getUsdFromAmount(g.symbol, g.total, pricesByTicker);
  for (const g of stablecoinGroups) {
    const usd = stablecoinUsd(g);
    if (usd != null) {
      totalUsd += usd;
      anyPriced = true;
    }
  }

  /**
   * The assets rail, in ONE value-sorted order.
   *
   * The Zephyr ecosystem rows used to be appended after the chain rows AND
   * after the not-yet-imported placeholder rows, so a $70 ZYS holding sat
   * below every $0.00 chain in the list — the sort said "biggest first" and
   * three real holdings were exempt from it because they are sub-assets of
   * `zephyr` rather than chains of their own, and the render simply
   * concatenated two lists. Merging them into one array and sorting that is
   * what makes the stated rule actually true of everything on screen.
   *
   * `chains` itself is left alone: it feeds the portfolio total, the
   * sparkline history and the vault's "N chains" count, none of which should
   * gain three rows.
   */
  const assetListRows: Array<
    | { kind: "chain"; chain: ChainType; w: WalletInfo; usd: number | null; ticker: string; name: string }
    | { kind: "zph"; row: (typeof zephyrAssetRows)[number]; usd: number | null; ticker: string; name: string }
    | { kind: "stable"; group: StablecoinGroup; usd: number | null; ticker: string; name: string }
  > = [
    ...chains.map(([chain, w]) => {
      const a = getAdapter(chain);
      return {
        kind: "chain" as const,
        chain,
        w,
        usd: getUsd(a.ticker, balancesByChain[chain], pricesByTicker),
        ticker: a.ticker,
        name: a.displayName,
      };
    }),
    ...zephyrAssetRows.map((row) => ({
      kind: "zph" as const,
      row,
      usd: row.usd,
      ticker: row.ticker,
      name: row.name,
    })),
    ...stablecoinGroups.map((group) => ({
      kind: "stable" as const,
      group,
      usd: stablecoinUsd(group),
      ticker: group.symbol,
      name: group.displayName,
    })),
  ].sort((a, b) => {
    const va = a.usd != null && a.usd > 0 ? a.usd : -1;
    const vb = b.usd != null && b.usd > 0 ? b.usd : -1;
    if (va !== vb) return vb - va;
    const ra = assetRank(a.ticker);
    const rb = assetRank(b.ticker);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  // ── Swap-node balances (C0.1) ────────────────────────────────────────────
  // Read here, rendered as a subordinate sub-line on the asset rows below.
  // Gated on the opt-in flag exactly like every other sidecar surface: a user
  // who never enabled swaps issues no `swap_sidecar_*` invoke and — because
  // `rows` stays empty and `SwapBalanceSubline` returns null for an absent
  // amount — sees a byte-identical assets list.
  const { optedIn: sidecarOptedIn } = useSwapSidecarOptIn();
  const { rows: swapRows } = useSidecarBalances({
    enabled: sidecarOptedIn === true,
  });

  // ── Focal asset resolution ───────────────────────────────────────────────
  // Default focal = the active chain. When a Zephyr ecosystem asset (ZSD/ZRS/
  // ZYS) is selected, override the focal display + actions with that asset so
  // it gets the standard panel (balance / address / Send / Receive / Swap).
  const effectiveZphAsset: ZphAssetType | null =
    activeChain === "zephyr" && focusedZphAsset && focusedZphAsset !== "ZPH"
      ? focusedZphAsset
      : null;
  const focalZphRow = effectiveZphAsset
    ? zephyrAssetRows.find((r) => r.asset === effectiveZphAsset) ?? null
    : null;
  const focalTicker = focalZphRow ? focalZphRow.ticker : activeAdapter.ticker;
  const focalName = focalZphRow ? focalZphRow.name : activeAdapter.displayName;
  const focalColor = focalZphRow
    ? ZPH_ASSET_COLOR[effectiveZphAsset as ZphAssetType]
    : activeAdapter.color;
  const focalIconSym = focalZphRow
    ? (effectiveZphAsset as string)
    : activeAdapter.ticker;
  const focalBalanceText = focalZphRow
    ? focalZphRow.balanceStr
    : fmtBalance(activeBalance);
  const focalUsd = focalZphRow ? focalZphRow.usd : activeUsd;
  const focalPrice = focalZphRow
    ? zphAssetPrice(zphSession?.reserveStats ?? null, effectiveZphAsset as ZphAssetType)
    : pricesByTicker[activeAdapter.ticker.toUpperCase()] ?? null;

  // ── Sparkline series ─────────────────────────────────────────
  // 1. Portfolio total over time = Σ_chain (current_balance × historical_price[t])
  //    Uses the longest available history length so chains with fewer
  //    points line up by index from oldest.
  // 2. Active asset position over time = current_balance × historical_price[t]
  //    of the active chain. Same shape as the portfolio spark, scoped.
  // 3. Active asset price over time = raw historical_price[t] of active.
  // All three fall back to PLACEHOLDER_SPARK when data isn't ready.
  const history = priceHistoryByTicker ?? {};
  const portfolioSpark: number[] = (() => {
    let maxLen = 0;
    for (const [chain] of chains) {
      const t = getAdapter(chain).ticker.toUpperCase();
      const h = history[t];
      if (h && h.length > maxLen) maxLen = h.length;
    }
    if (maxLen === 0) return PLACEHOLDER_SPARK;
    const series = new Array<number>(maxLen).fill(0);
    let contributed = false;
    for (const [chain] of chains) {
      const a = getAdapter(chain);
      const h = history[a.ticker.toUpperCase()];
      if (!h || h.length === 0) continue;
      const bal = parseBalanceNumber(balancesByChain[chain]);
      if (bal == null || bal === 0) continue;
      // Right-align: the latest historical point should land at the
      // tail of the series so partial-history chains contribute to the
      // recent end first.
      const offset = maxLen - h.length;
      for (let i = 0; i < h.length; i++) {
        series[offset + i] += bal * h[i];
      }
      contributed = true;
    }
    return contributed ? series : PLACEHOLDER_SPARK;
  })();

  const activeTickerUpper = activeAdapter.ticker.toUpperCase();
  const activeHistory = history[activeTickerUpper] ?? [];
  const activeBalNum = parseBalanceNumber(activeBalance) ?? 0;
  // "Effectively zero" guard: fmtBalance rounds dust amounts (e.g.
  // 1 satoshi = 0.00000001 BTC) down to the string "0", but the
  // numeric balance is still a tiny non-zero value. Multiplying that
  // tiny value through the price history produces a curve identical
  // in shape to the price chart, just at a microscopic scale —
  // MiniSpark then normalises by min/max and you see what looks like
  // a real position chart for an asset you don't actually hold. Gate
  // on the displayed balance instead so a "0" display always renders
  // a flat zero spark.
  const activeBalDisplay = fmtBalance(activeBalance);
  const positionEffectivelyZero =
    activeBalDisplay === "0" || activeBalDisplay === "—";
  // Position spark: balance × historical_price across the window.
  // When the balance is effectively zero we render an explicit flat
  // zero series. The PLACEHOLDER_SPARK fallback is reserved for when
  // we genuinely don't know yet, i.e. price history hasn't loaded.
  const positionSpark =
    activeHistory.length === 0
      ? placeholderSparkFor(activeTickerUpper + ":pos")
      : positionEffectivelyZero
        ? new Array(activeHistory.length).fill(0)
        : activeHistory.map((p) => p * activeBalNum);
  const priceSpark =
    activeHistory.length > 0
      ? activeHistory
      : placeholderSparkFor(activeTickerUpper);

  // 24h delta — first vs last point of the portfolio spark when we
  // have real data. Falls back to "—" when we don't.
  const portfolioDelta24h: { pct: number; positive: boolean } | null = (() => {
    if (portfolioSpark === PLACEHOLDER_SPARK) return null;
    const first = portfolioSpark[0];
    const last = portfolioSpark[portfolioSpark.length - 1];
    if (!first || !last || first <= 0) return null;
    const pct = ((last - first) / first) * 100;
    return { pct, positive: pct >= 0 };
  })();

  const copyAddr = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 1400);
  };

  // Active chain's recent activity. XMR has a dedicated history; every
  // other chain falls back to the generic per-chain feed.
  const xmrRecent = xmrTxHistory.slice(0, 6);
  const genericRecent = (() => {
    if (activeChain === "monero") return [];
    if (!chainTxByKey) return [];
    return mergeChainTx({ txByChain: chainTxByKey }, activeChain).txs.slice(0, 6);
  })();

  const utxoReceiveAddress = useUtxoReceiveAddress(
    activeChain,
    activeWallet?.mnemonic,
  );

  const xmrDisplayAddress = (() => {
    if (activeChain !== "monero" || !activeWallet) return null;
    if (xmrSession?.showPrimary !== false) return activeWallet.address;
    return xmrSession.receiveAddress ?? activeWallet.address;
  })();
  // Same rotation portrait uses, from the SAME hook -- an address that rotates
  // on one layout and silently reuses index 0 on the other is invisible drift:
  // both screens show *an* address and only one is safe to hand out twice.
  const focalAddress =
    activeChain === "monero"
      ? xmrDisplayAddress ?? (activeWallet?.address ?? "")
      : utxoReceiveAddress ?? activeWallet?.address ?? "";

  const sendDisabled =
    (activeChain === "monero" && xmrSession?.syncState !== "synced") ||
    (activeChain === "zephyr" && zphSession?.syncState !== "synced");

  const showXmrSync =
    activeChain === "monero" &&
    xmrSession != null &&
    xmrSession.syncState !== "idle" &&
    xmrSession.syncState !== "synced";
  const showZphSync =
    activeChain === "zephyr" &&
    zphSession != null &&
    zphSession.syncState !== "idle" &&
    zphSession.syncState !== "synced";

  // Resizable landscape rails — left/right column widths are user-draggable
  // and persisted; the center column stays fluid. Keeps the 3-column format.
  const rails = useResizableRails("pwnda-landscape-rails-wallet");

  /**
   * One Zephyr ecosystem asset row. Lives in `assetListRows` (sorted by
   * value with every chain row) instead of being concatenated after the
   * list — see that array's comment for the bug that caused.
   */
  /**
   * One STACKED stablecoin row: the family total, expanding to its per-network
   * balances. Clicking a network selects that leg's real `ChainType`, so the
   * focal panel, Send, Receive, Swap and history all work unchanged — the
   * grouping is presentation only.
   *
   * Auto-expands when the active chain is one of its legs, so arriving here
   * from anywhere else does not leave the selected network hidden.
   */
  const renderStablecoinRow = (g: StablecoinGroup) => {
    const anyLegActive = g.rows.some((r) => r.chain === activeChain);
    const open = expandedStables.has(g.symbol) || anyLegActive;
    const usd = stablecoinUsd(g);
    const held = g.rows.filter((r) => (r.amount ?? 0) > 0);
    return (
      <div key={`stable-${g.symbol}`}>
        <button
          onClick={() =>
            setExpandedStables((prev) => {
              const next = new Set(prev);
              if (next.has(g.symbol)) next.delete(g.symbol);
              else next.add(g.symbol);
              return next;
            })
          }
          title={`${g.displayName} across ${g.rows.length} networks`}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            background: anyLegActive ? `${g.color}14` : "transparent",
            border: "none",
            borderLeft: anyLegActive
              ? `2px solid ${g.color}`
              : "2px solid transparent",
            borderBottom: "1px solid var(--border-soft)",
            boxShadow: anyLegActive ? `inset 0 0 22px -6px ${g.color}66` : "none",
            cursor: "pointer",
            textAlign: "left",
            fontFamily: "var(--font-mono)",
            color: anyLegActive ? g.color : "var(--text)",
          }}
        >
          <CoinIcon sym={g.symbol} size={20} color={g.color} glow={anyLegActive ? "accent" : false} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4 }}>
              {g.displayName}
            </div>
            <div style={{ fontSize: 8, color: "var(--text-dim)", marginTop: 1 }}>
              {g.symbol} ·{" "}
              {held.length > 0
                ? `${held.length} of ${g.rows.length} networks`
                : `${g.rows.length} networks`}{" "}
              {open ? "▾" : "▸"}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div className="tnum" style={{ fontSize: 11 }}>
              {g.total == null ? "—" : fmtBalance(String(g.total))}
            </div>
            <div
              className="tnum"
              style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 1 }}
            >
              {usd != null ? fmtUsd(usd) : "—"}
            </div>
          </div>
        </button>

        {open &&
          g.rows.map((r) => {
            const legActive = r.chain === activeChain;
            const legUsd = getUsd(g.symbol, r.balance, pricesByTicker);
            return (
              <button
                key={r.chain}
                onClick={() => {
                  setActiveChain(r.chain);
                  setFocusedZphAsset(null);
                }}
                title={`${g.symbol} on ${r.network}`}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 14px 7px 40px",
                  background: legActive
                    ? `${g.color}10`
                    : "rgba(255,255,255,0.012)",
                  border: "none",
                  borderLeft: legActive
                    ? `2px solid ${g.color}`
                    : "2px solid transparent",
                  borderBottom: "1px solid var(--border-soft)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "var(--font-mono)",
                  color: legActive ? g.color : "var(--text-muted)",
                  opacity: (r.amount ?? 0) > 0 ? 1 : 0.62,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10 }}>{r.network}</div>
                  {r.nearIntents && (
                    <div
                      style={{
                        fontSize: 7.5,
                        color: "var(--text-dim)",
                        marginTop: 1,
                        letterSpacing: 0.3,
                      }}
                    >
                      swappable via NEAR
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div className="tnum" style={{ fontSize: 10 }}>
                    {fmtBalance(r.balance)}
                  </div>
                  <div
                    className="tnum"
                    style={{ fontSize: 8, color: "var(--text-dim)" }}
                  >
                    {legUsd != null ? fmtUsd(legUsd) : "—"}
                  </div>
                </div>
              </button>
            );
          })}
      </div>
    );
  };

  const renderZphAssetRow = (r: (typeof zephyrAssetRows)[number]) => {
            const assetColor = ZPH_ASSET_COLOR[r.asset];
            const assetActive = effectiveZphAsset === r.asset;
            return (
            <button
              key={`zph-asset-${r.asset}`}
              onClick={() => {
                setActiveChain("zephyr");
                setFocusedZphAsset(r.asset);
              }}
              title={`Show ${r.name}`}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                background: assetActive ? `${assetColor}14` : "transparent",
                border: "none",
                borderLeft: assetActive
                  ? `2px solid ${assetColor}`
                  : "2px solid transparent",
                borderBottom: "1px solid var(--border-soft)",
                boxShadow: assetActive ? `inset 0 0 22px -6px ${assetColor}66` : "none",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "var(--font-mono)",
                color: assetActive ? assetColor : "var(--text)",
                transition: "background .12s ease",
              }}
            >
              <CoinIcon
                sym={r.asset}
                size={20}
                color={ZPH_ASSET_COLOR[r.asset]}
                glow={assetActive ? "accent" : false}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: 0.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.name}
                </div>
                <div
                  style={{
                    fontSize: 8,
                    color: "var(--text-dim)",
                    marginTop: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.ticker} · Zephyr asset
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div className="tnum" style={{ fontSize: 11 }}>
                  {r.balanceStr}
                </div>
                <div
                  className="tnum"
                  style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 1 }}
                >
                  {r.usd != null ? fmtUsd(r.usd) : "—"}
                </div>
              </div>
            </button>
            );
  };

  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: rails.gridTemplateColumns,
        gap: 1,
        background: "var(--border)",
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
        animation: "fade-in .2s ease",
      }}
    >
      {rails.handles}
      {/* ── LEFT: Portfolio + assets list ────────────────────── */}
      <div style={{ background: "var(--bg)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-soft)", flexShrink: 0 }}>
          <div
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              letterSpacing: 2,
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
            }}
          >
            Portfolio
            {missingLabel && (
              <span
                title={`These held chains couldn't be valued (balance or price failed to load) and are excluded from the total, so it's understated: ${missingNames.join(
                  ", "
                )}.`}
                style={{ color: "var(--warn)", marginLeft: 6, letterSpacing: 0 }}
              >
                · {missingLabel}
              </span>
            )}
          </div>
          <div
            className="hero-num tnum"
            style={{
              fontSize: 26,
              marginTop: 4,
              lineHeight: 1.1,
            }}
          >
            {/* Always 2 decimals — the total is a computed sum; cents convey
                "approximate" without an "≈" glyph. */}
            <ST speed={18} delay={100}>
              {anyPriced
                ? `$${totalUsd.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : "— USD"}
            </ST>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span
              className="tnum"
              style={{
                color: portfolioDelta24h
                  ? portfolioDelta24h.positive
                    ? "var(--accent)"
                    : "var(--warn)"
                  : "var(--text-dim)",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
              }}
              title={portfolioDelta24h ? "24h portfolio delta" : "24h delta — fetching"}
            >
              {portfolioDelta24h
                ? `${portfolioDelta24h.positive ? "+" : ""}${portfolioDelta24h.pct.toFixed(2)}%`
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
            <MiniSpark
              values={portfolioSpark}
              w={80}
              h={14}
              color={
                portfolioSpark === PLACEHOLDER_SPARK
                  ? "var(--text-dim)"
                  : portfolioDelta24h?.positive
                    ? "var(--accent)"
                    : "var(--warn)"
              }
              minRangeFrac={0.08}
            />
            <button
              onClick={onRefreshBalances}
              disabled={balancesLoading}
              title="Refresh balances"
              style={{
                marginLeft: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                padding: "2px 8px",
                background: "transparent",
                border: "1px solid var(--border)",
                color: balancesLoading ? "var(--text-dim)" : "var(--text-muted)",
                cursor: balancesLoading ? "default" : "pointer",
                opacity: balancesLoading ? 0.5 : 1,
              }}
            >
              {balancesLoading ? "…" : "↻"}
            </button>
          </div>
        </div>

        <div className="no-scroll-bar" style={{ flex: 1, overflowY: "auto" }}>
          {assetListRows.length === 0 ? (
            <div
              style={{
                padding: 14,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--text-dim)",
              }}
            >
              No wallets loaded.
            </div>
          ) : (
            assetListRows.map((item) => {
              // Zephyr's ecosystem assets sort INTO this list by value now,
              // rather than being appended below every chain row (and below
              // the not-imported placeholders) regardless of what they hold.
              if (item.kind === "zph") return renderZphAssetRow(item.row);
              if (item.kind === "stable") return renderStablecoinRow(item.group);
              const { chain, w } = item;
              const a = getAdapter(chain);
              const active = chain === activeChain && !effectiveZphAsset;
              const rawBal = balancesByChain[chain];
              const balText = fmtBalance(rawBal);
              const usd = getUsd(a.ticker, rawBal, pricesByTicker);
              return (
                <button
                  key={chain}
                  onClick={() => {
                    setActiveChain(chain);
                    setFocusedZphAsset(null);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    background: active ? `${a.color}14` : "transparent",
                    border: "none",
                    borderLeft: active ? `2px solid ${a.color}` : "2px solid transparent",
                    borderBottom: "1px solid var(--border-soft)",
                    // The box glows with the coin, so focus is legible without
                    // colour having to do double duty.
                    boxShadow: active ? `inset 0 0 22px -6px ${a.color}66` : "none",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "var(--font-mono)",
                    color: active ? a.color : "var(--text)",
                    transition: "background .12s ease, box-shadow .12s ease",
                  }}
                >
                  {/* Every coin carries its OWN colour at rest (2026-09-02).
                      It used to be white until selected and coloured only when
                      active, which made colour mean "focused" instead of
                      meaning "which coin" — the rail read as a monochrome list.
                      Focus is now the halo plus the row's border/tint, so the
                      two signals are independent. */}
                  <CoinIcon
                    sym={a.ticker}
                    size={20}
                    color={a.color}
                    glow={active ? "accent" : false}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Show the chain's display name, not the bare ticker —
                        the EVM L2s (Ethereum / Arbitrum / Base / Optimism) all
                        share ticker "ETH" and the same derived address, so a
                        ticker-only label rendered as several indistinguishable
                        "ETH" rows. The ticker still appears on the subline. */}
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: 0.4,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.displayName}
                    </div>
                    <div
                      style={{
                        fontSize: 8,
                        color: "var(--text-dim)",
                        marginTop: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.ticker} · {w ? truncAddr(w.address) : "tap to set up"}
                    </div>
                    {/* Swap-node holding for this coin, when there is one.
                        Deliberately in the NAME column and not the amount
                        column on the right — the right column is the
                        wallet's own money, and a second figure there would
                        read as part of the same balance. */}
                    <SwapBalanceSubline
                      raw={swapRows[a.ticker.toUpperCase()]?.balance}
                      ticker={a.ticker}
                    />
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div className="tnum" style={{ fontSize: 11 }}>{balText}</div>
                    <div
                      className="tnum"
                      style={{
                        fontSize: 9,
                        color: "var(--text-dim)",
                        marginTop: 1,
                      }}
                    >
                      {usd != null ? fmtUsd(usd) : "—"}
                    </div>
                  </div>
                </button>
              );
            })
          )}
          {/* Independent-seed chains with no wallet yet — the entry point to
              their import panel, which is gated on this click setting
              `activeChain`. See `importableChains` for why these are separate
              from the held rows above and excluded from every total. */}
          {importableChains.map((chain) => {
            const a = getAdapter(chain);
            const active = chain === activeChain && !effectiveZphAsset;
            return (
              <button
                key={`import-${chain}`}
                onClick={() => {
                  setActiveChain(chain);
                  setFocusedZphAsset(null);
                }}
                title={`Import a ${a.displayName} wallet`}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  background: active ? `${a.color}14` : "transparent",
                  border: "none",
                  borderLeft: active ? `2px solid ${a.color}` : "2px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  opacity: active ? 1 : 0.72,
                }}
              >
                <CoinIcon sym={a.ticker} size={22} color={a.color} glow={active ? "accent" : false} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
                    {a.displayName}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: "var(--text-dim)",
                      marginTop: 1,
                    }}
                  >
                    {a.ticker} · not imported
                  </div>
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    color: "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  import ▸
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── CENTER: focal coin + actions + address + recent ─── */}
      <div
        className="no-scroll-bar"
        style={{
          background: "var(--bg)",
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {/* Inner flowing column. The OUTER div is the scroll container; this
            inner sizes to its content so cards keep their natural height.
            Previously the center was ONE height-constrained flex column, and
            because <Card> is flex/minHeight:0 the cards got compressed when the
            content overflowed — their flex:1 bodies then spilled and overlapped
            (the Zephyr "jumbled text" bug). Now the column scrolls instead. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
            padding: 28,
            minHeight: "100%",
            boxSizing: "border-box",
          }}
        >
          {activeWallet ? (
          <>
            {/* Focal coin (or focused Zephyr ecosystem asset) */}
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <CoinIcon
                sym={focalIconSym}
                size={64}
                accent={focalColor}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-dim)",
                    letterSpacing: 1.5,
                    textTransform: "uppercase",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {focalName}
                </div>
                <div
                  className="hero-num tnum"
                  style={{ fontSize: 38, marginTop: 2, lineHeight: 1 }}
                >
                  <ST speed={16} delay={80}>{focalBalanceText}</ST>
                  <span
                    style={{ fontSize: 13, color: "var(--text-muted)", marginLeft: 8 }}
                  >
                    {focalTicker}
                  </span>
                </div>
                <div
                  className="tnum"
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    marginTop: 6,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  ≈ <ST speed={18} delay={160}>
                    {focalUsd != null ? fmtUsd(focalUsd) : "—"}
                  </ST>
                </div>
              </div>
              <div style={{ flex: 1 }} />
              <MiniSpark
                values={positionSpark}
                w={120}
                h={36}
                color={focalColor}
              />
            </div>

            {/* Sync panel — only when there's something to say */}
            {showXmrSync && xmrSession && (
              <SyncStatusPanel
                chain="monero"
                label="Monero Sync"
                accentColor={activeAdapter.color}
                syncState={xmrSession.syncState}
                syncPercent={xmrSession.syncPercent}
                walletHeight={xmrSession.walletHeight}
                daemonHeight={xmrSession.daemonHeight}
                blocksPerSec={xmrSession.blocksPerSec}
                etaSeconds={xmrSession.etaSeconds}
                syncError={xmrSession.syncError}
                defenderExcluded={xmrSession.defenderExcluded}
                onRetry={xmrSession.onRetry}
                onManageNodes={xmrSession.onManageNodes}
                onAddDefenderExclusion={xmrSession.onAddDefenderExclusion}
              />
            )}
            {showZphSync && zphSession && (
              <SyncStatusPanel
                chain="zephyr"
                label="Zephyr Sync"
                accentColor={activeAdapter.color}
                syncState={zphSession.syncState}
                syncPercent={zphSession.syncPercent}
                walletHeight={zphSession.walletHeight}
                daemonHeight={zphSession.daemonHeight}
                blocksPerSec={zphSession.blocksPerSec}
                etaSeconds={zphSession.etaSeconds}
                syncError={zphSession.syncError}
                defenderExcluded={zphSession.defenderExcluded}
                onRetry={zphSession.onRetry}
                onManageNodes={zphSession.onManageNodes}
                onAddDefenderExclusion={zphSession.onAddDefenderExclusion}
              />
            )}

            {/* Action row — Send / Receive / Swap */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 10,
              }}
            >
              <ActionTile
                glyph="▲"
                label="Send"
                onClick={() => onSend(effectiveZphAsset ?? undefined)}
                disabled={sendDisabled}
              />
              <ActionTile
                glyph="▼"
                label="Receive"
                onClick={() => copyAddr(focalAddress)}
              />
              {/* Every asset, not just Zephyr.

                  This was `disabled={activeChain !== "zephyr"}`: on BTC, ETH,
                  SOL and every other coin it rendered a greyed control that
                  had never done anything, and Zephyr's opened the legacy
                  ecosystem modal rather than the Swap tab. Both now go to the
                  same place — the Swap tab with this asset pre-selected on
                  the AUTO route. */}
              <ActionTile
                glyph="⇄"
                label="Swap"
                onClick={() => onOpenSwapForAsset?.(activeAdapter.ticker)}
                disabled={!onOpenSwapForAsset}
                accent
              />
            </div>

            {/* Address row */}
            <div
              style={{
                background: "#060606",
                border: "1px solid var(--border)",
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  color: "var(--text-dim)",
                  letterSpacing: 1.2,
                  textTransform: "uppercase",
                  fontFamily: "var(--font-mono)",
                }}
              >
                Addr
              </span>
              <code
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                  letterSpacing: 0.3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={focalAddress}
              >
                {focalAddress}
              </code>
              <button
                className="qbtn"
                onClick={() => copyAddr(focalAddress)}
                style={{
                  padding: "5px 10px",
                  fontSize: 10,
                  color: copiedAddr ? "var(--accent)" : undefined,
                  borderColor: copiedAddr ? "var(--accent)" : undefined,
                }}
              >
                {copiedAddr ? "✓" : "copy"}
              </button>
              <button
                className="qbtn"
                onClick={() => copyAddr(focalAddress)}
                style={{ padding: "5px 10px", fontSize: 10 }}
                title="QR — copies address (dedicated modal coming in v2.1)"
              >
                qr
              </button>
            </div>

            {/* Monero subaddress affordances inside the focal column */}
            {activeChain === "monero" && xmrSession && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontFamily: "var(--font-mono)",
                  fontSize: 9.5,
                  color: "var(--text-dim)",
                  marginTop: -10,
                }}
              >
                {xmrSession.showPrimary
                  ? "Primary (4…). For per-payment privacy, switch to a fresh subaddress."
                  : "Subaddress (8…). Generate a fresh one per payment to avoid on-chain linking."}
                <div style={{ flex: 1 }} />
                {xmrSession.showPrimary ? (
                  <button
                    className="qbtn"
                    style={{ padding: "3px 8px", fontSize: 9 }}
                    onClick={() => xmrSession.setShowPrimary(false)}
                    disabled={!xmrSession.receiveAddress}
                  >
                    show subaddress
                  </button>
                ) : (
                  <>
                    <button
                      className="qbtn"
                      style={{ padding: "3px 8px", fontSize: 9 }}
                      onClick={() => void xmrSession.onNewSubaddress()}
                    >
                      new
                    </button>
                    <button
                      className="qbtn"
                      style={{ padding: "3px 8px", fontSize: 9 }}
                      onClick={() => xmrSession.setShowPrimary(true)}
                    >
                      show primary
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Zephyr protocol stats (reserve ratio, oracle prices, APY). The
                per-asset holdings that used to live in a <ZephyrAssetsCard>
                here are now top-level rows in the left assets list. */}
            {activeChain === "zephyr" && zphSession && (
              <ZephyrProtocolStatsCard
                stats={zphSession.reserveStats ?? null}
                loading={zphSession.reserveLoading ?? false}
                error={zphSession.reserveError ?? null}
                fetchedAt={zphSession.reserveFetchedAt ?? null}
              />
            )}

            {/* Hedera has no account until one is created ON-NETWORK — a
                protocol rule, not a wallet fault. Without this the user just
                saw "No account (create on network)" as a balance and read it
                as broken. Shares the panel with portrait. */}
            {activeChain === "hedera" &&
              isHederaAccountMissing(balancesByChain.hedera) &&
              activeWallet && (
                <HederaSetupPanel
                  publicKeyHex={activeWallet.address}
                  onCopy={onCopy}
                />
              )}

            {/* Zano — its sync/assets/import, rendered INLINE in the focal
                column exactly like the monero/zephyr sections above, instead of
                as a detached footer below this view. Content built by
                LandscapeRoot from the shared Zano components. */}
            {activeChain === "zano" && zanoCenterSlot}

            {/* Derivation, for EVERY chain. Mounted here as well as in the
                portrait dashboard — landscape is the DEFAULT layout, so a
                surface that exists only in portrait effectively doesn't
                exist. (Same gap that hid Monero/Zephyr from the asset list
                and skipped the password step; worth checking both roots
                whenever a wallet-surface is added.) */}
            {activeWallet && (
              <DerivationInfoCard
                chain={activeChain}
                hasDedicatedPanel={LANDSCAPE_DERIVATION_PANEL_CHAINS.has(activeChain)}
                mnemonic={sharedMnemonic}
                onCopy={onCopy}
              />
            )}

            {/* Legacy / alternative-derivation panels — self-hide when
                no funds at the legacy address. Always mounted on the
                matching chain's wallet tab so users with stranded funds
                see them without going through Settings. */}
            {activeChain === "bitcoin" && sharedMnemonic && activeWallet && onCopy && (
              <BtcLegacyPanel
                mnemonic={sharedMnemonic}
                standardAddress={activeWallet.address}
                onCopy={onCopy}
              />
            )}
            {activeChain === "cardano" && sharedMnemonic && onCopy && (
              <AdaLegacyPanel mnemonic={sharedMnemonic} onCopy={onCopy} />
            )}
            {activeChain === "cardano" &&
              sharedMnemonic &&
              currentCardanoDerivationChoice &&
              onChangeCardanoDerivation &&
              onCopy && (
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
              onChangeSolanaDerivation &&
              onCopy && (
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
              onChangeAlgorandDerivation &&
              onCopy && (
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
              onChangeLitecoinDerivation &&
              onCopy && (
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
              activeWallet &&
              onCopy && (
                <UtxoAccountCard
                  chain={activeChain}
                  mnemonic={sharedMnemonic}
                  address={activeWallet.address}
                  onCopy={onCopy}
                />
              )}

            {/* Recent activity */}
            <div>
              <div
                style={{
                  fontSize: 9.5,
                  color: "var(--text-muted)",
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  fontFamily: "var(--font-mono)",
                  marginBottom: 8,
                  paddingBottom: 6,
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                Recent
              </div>
              {activeChain === "monero" ? (
                xmrRecent.length === 0 ? (
                  <EmptyMsg
                    text={
                      xmrSession?.syncState === "synced"
                        ? "No recent transactions."
                        : "Transaction history available after sync."
                    }
                  />
                ) : (
                  <ActivityList
                    chain="monero"
                    items={xmrRecent.map((tx) => {
                      const isIn = tx.type === "in" || tx.type === "pool";
                      return {
                        key: `${tx.txid}-${tx.type}`,
                        direction: isIn ? ("in" as const) : ("out" as const),
                        amount: piconeroToXmr(tx.amount),
                        ticker: "XMR",
                        when: fmtRelative(tx.timestamp),
                        peer:
                          tx.confirmations > 0
                            ? `${tx.confirmations} conf`
                            : "unconfirmed",
                        hash: tx.txid,
                      };
                    })}
                  />
                )
              ) : genericRecent.length === 0 ? (
                /* Zephyr and Zano read history from their own wallet-rpc and
                   return an EMPTY page when no session is open
                   (zph-wallet.ts:688). Rendering the same "No recent
                   transactions." as a genuinely empty chain told the user they
                   had none, when the truth was that nothing had been asked.
                   Monero already distinguished the two; these now do too. */
                <EmptyMsg
                  text={
                    (activeChain === "zephyr" || activeChain === "zano") &&
                    zphSession?.syncState !== "synced"
                      ? "Transaction history available after sync."
                      : "No recent transactions."
                  }
                />
              ) : (
                <ActivityList
                  chain={activeChain}
                  items={genericRecent.map((tx) => ({
                    key: `${tx.hash}-${tx.direction}`,
                    direction:
                      tx.direction === "in"
                        ? ("in" as const)
                        : tx.direction === "failed"
                          ? ("failed" as const)
                          : ("out" as const),
                    amount: tx.amount,
                    ticker: activeAdapter.ticker,
                    when: fmtRelative(tx.timestamp),
                    peer:
                      tx.confirmations !== undefined && tx.confirmations > 0
                        ? `${tx.confirmations} conf`
                        : "unconfirmed",
                    hash: tx.hash,
                  }))}
                />
              )}
            </div>
          </>
          ) : importPanelSlot ? (
            /* Monero / Zephyr selected but not set up yet. Landscape is the
               DEFAULT layout, so without this the only route to an XMR/ZPH
               seed was to switch to portrait first — which is why those two
               chains were effectively undiscoverable. */
            <div style={{ maxWidth: 560 }}>{importPanelSlot}</div>
          ) : (
            <EmptyMsg
              text={`No ${activeAdapter.displayName} wallet imported.`}
            />
          )}
        </div>
      </div>

      {/* ── RIGHT: Quick send + market mini + sync mini ─────── */}
      <div
        className="no-scroll-bar"
        style={{
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          padding: 18,
          gap: 18,
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {/* Quick send — landscape-ONLY convenience shortcut. Opens the SAME
            SendModal as the focal SEND tile above (both call
            onSend(effectiveZphAsset ?? undefined) → openSendModal → identical
            modal/gate). Intentional desktop redundancy: a persistent send entry
            next to the market/vault rail so the user needn't return to the
            center action row. Portrait has a single SEND button. See
            PwndaWalletVault [[landscape-resizable-rails]] § Dual send. */}
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
            Quick send
          </div>
          <button
            onClick={() => onSend(effectiveZphAsset ?? undefined)}
            disabled={sendDisabled}
            style={{
              width: "100%",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              padding: "10px 14px",
              letterSpacing: 0.8,
              background: "var(--white)",
              border: "1px solid var(--white)",
              color: "#0a0a0a",
              cursor: sendDisabled ? "default" : "pointer",
              opacity: sendDisabled ? 0.35 : 1,
              transition: "all .12s",
            }}
          >
            ► Send {focalTicker}
          </button>
          {sendDisabled && (
            <div
              style={{
                fontSize: 9,
                color: "var(--text-dim)",
                marginTop: 6,
                textAlign: "center",
                fontFamily: "var(--font-mono)",
              }}
            >
              Awaiting sync to enable sends
            </div>
          )}
        </div>

        {/* Market mini */}
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
            Market · {focalTicker}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 10, fontFamily: "var(--font-mono)" }}>
            <Row
              k="price"
              v={focalPrice != null ? fmtUsd(focalPrice) : "—"}
              tnum
            />
            <Row k="balance" v={focalBalanceText} tnum />
            <Row
              k="value"
              v={focalUsd != null ? fmtUsd(focalUsd) : "—"}
              tnum
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <MiniSpark
              values={priceSpark}
              w={260}
              h={36}
              color={activeAdapter.color}
            />
          </div>
        </div>

        {/* C6 — the swap node's own Monero wallet, shown only on the Monero
            panel and only after opt-in. `DexXmrWalletCard` was exported from
            the sidecar barrel and mounted NOWHERE, so the account that
            actually holds XMR mid-swap was invisible.

            It reuses the `swapRows` already polled above — no second poll —
            and carries its own divider + "this is not your vault's XMR" copy,
            because two Monero balances on one screen is exactly the confusion
            that gets one of them spent by mistake. */}
        {activeChain === "monero" && (
          <DexXmrWalletSection optedIn={sidecarOptedIn} row={swapRows.XMR} />
        )}

        {/* Vault info */}
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
            Vault
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 10, fontFamily: "var(--font-mono)" }}>
            <Row
              k="wallets"
              // Counts wallets that actually exist, NOT rows in the list —
              // the list also carries not-yet-set-up independent-seed chains
              // (XMR/ZPH) so they're reachable, and counting those here would
              // overstate what the vault holds.
              v={`${walletCount} chain${walletCount !== 1 ? "s" : ""}`}
            />
            <Row k="encryption" v="AES-256-GCM" />
            <Row k="custody" v="Non-custodial" />
            <Row k="storage" v="Local only" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════ helpers ═════════════════════════════════════════════ */

function ActionTile({
  glyph,
  label,
  onClick,
  disabled,
  accent,
}: {
  glyph: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      className={`qbtn${accent ? " accent" : ""}`}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "14px 8px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
        fontSize: 10,
        letterSpacing: 1.5,
        textTransform: "uppercase",
      }}
    >
      <span style={{ fontSize: 18, color: "var(--accent)" }}>{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

function ActivityList({
  items,
  chain,
}: {
  items: Array<{
    key: string;
    direction: "in" | "out" | "failed";
    amount: string | number;
    ticker: string;
    when: string;
    peer?: string;
    hash?: string;
  }>;
  /** Every item in one list is the currently active chain — matches
   *  `ChainTxCard`'s one-chain-per-card contract, so `explorerTxUrl` only
   *  needs this once rather than threaded per row. */
  chain: ChainType;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {items.map((it) => {
        const isIn = it.direction === "in";
        const failed = it.direction === "failed";
        return (
          <div
            key={it.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 0",
              borderBottom: "1px solid var(--border-soft)",
              fontFamily: "var(--font-mono)",
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: failed
                  ? "var(--danger)"
                  : isIn
                    ? "var(--accent)"
                    : "var(--warn)",
                width: 14,
              }}
            >
              {failed ? "✗" : isIn ? "▼" : "▲"}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="tnum"
                style={{
                  fontSize: 11,
                  color: failed
                    ? "var(--danger)"
                    : isIn
                      ? "var(--accent)"
                      : "var(--text)",
                }}
              >
                {failed ? "" : isIn ? "+" : "−"}
                {it.amount} {it.ticker}
              </div>
              {it.peer && (
                <div style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 1 }}>
                  {it.peer}
                </div>
              )}
              {/* Click → open in chain explorer, shift-click → copy. Same
                  pattern as ChainTxCard (portrait) and the Activity tab —
                  this was the one place in the app showing a transaction
                  row with no way to reach its id. */}
              {it.hash && (
                <code
                  style={{
                    display: "block",
                    fontSize: 8.5,
                    color: "var(--text-dim)",
                    marginTop: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                  title={`${it.hash}\nClick: open in explorer · Shift-click: copy`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.shiftKey) {
                      void navigator.clipboard.writeText(it.hash!);
                      return;
                    }
                    const url = explorerTxUrl(chain, it.hash!);
                    if (url) void openExternal(url);
                    else void navigator.clipboard.writeText(it.hash!);
                  }}
                >
                  {it.hash.length > 24
                    ? `${it.hash.slice(0, 16)}…${it.hash.slice(-6)}`
                    : it.hash}
                </code>
              )}
            </div>
            <span className="tnum" style={{ fontSize: 9, color: "var(--text-dim)" }}>
              {it.when}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EmptyMsg({ text }: { text: string }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--text-dim)",
        padding: 8,
      }}
    >
      {text}
    </div>
  );
}

function Row({ k, v, tnum }: { k: string; v: string; tnum?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
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
      <span className={tnum ? "tnum" : ""} style={{ color: "var(--text)" }}>
        {v}
      </span>
    </div>
  );
}
