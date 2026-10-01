import { useEffect, useMemo, useRef, useState } from "react";
import { openExternal } from "../../utils/openExternal";
import {
  ZPH_ASSETS,
  ZPH_ASSET_NAME,
  ZPH_UI_TICKER,
  atomicToZph,
  zphToAtomic,
  ZPH_ASSET_COLOR,
  clampZphDisplayDecimals,
  quoteAssetTransfer,
  type ZphAssetType,
  type ZphAssetBalance,
  type ZphTransferResponse,
} from "../../wallets/zph-rpc";
import { getZphSessionEpoch, relayZphTransaction } from "../../wallets/zph-wallet";
import { isSendOutcomeUnknown } from "../../wallets/send-outcome";
import { SEND_QUOTE_MAX_AGE_MS } from "../../wallets/send-quote";
import type { TxResult } from "../../wallets/types";
import { errorText } from "../../lib/errorText";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import { CoinIcon } from "../../components/CoinIcon";
import { ModalBackdrop } from "../../components/ModalBackdrop";

/**
 * Zephyr four-asset swap modal.
 *
 * Phase-1 single-leg flow only — direct ZPH↔ZSD, ZPH↔ZRS, ZSD↔ZYS work
 * one-shot via the protocol's `transfer { source_asset, destination_asset }`
 * RPC. Non-direct routes are filtered out of the dropdowns entirely so
 * the user can never construct an invalid pair.
 *
 * State machine: edit → quote → submitting → success | error
 * The quote step calls `quoteAssetTransfer` (do_not_relay:true +
 * get_tx_metadata:true) so the user sees a binding fee + builds the
 * tx, then `Confirm Swap` calls `relayTransfer(metadata)` to broadcast.
 *
 * Quotes auto-refresh every QUOTE_REFRESH_MS while the user is reviewing
 * — pricing record updates per block (~120s), so a stale quote could be
 * silently re-priced on relay. We pre-empt that by re-quoting on a timer.
 *
 * The quote/confirm timing lives in `createSwapFlow` below (2026-09-29
 * send-safety audit, finding 2), free of React so it is unit-tested
 * (`__tests__/zephyrSwapFlow.test.ts`).
 *
 * See [[zephyr-ecosystem-swap-plan]] for Phase 2/4/5/6 work this modal
 * does not yet do (reserve-ratio pre-flight, ZRS leverage warning,
 * etc.).
 */

/** A built, unrelayed conversion and when/by which wallet session it was built. */
export interface SwapQuote {
  response: ZphTransferResponse;
  quotedAt: number;
  /** `getZphSessionEpoch()` at build time; the relay refuses another session's build. */
  epoch: number | null;
}

export type SwapModalState =
  | { kind: "edit" }
  | { kind: "quote"; loading: true }
  | { kind: "quote"; loading: false; quote: SwapQuote }
  | { kind: "submitting" }
  | { kind: "success"; txHash: string; pending: boolean }
  /** The relay may have gone out (`SendOutcomeUnknownError`): no way back to Confirm. */
  | { kind: "unknown"; txHash: string; message: string }
  | { kind: "error"; message: string };

/** Auto-refresh cadence — kept under one block (~120s) so the user
 *  always sees a quote that's no more than ~60s away from a freshly
 *  re-priced tx. */
const QUOTE_REFRESH_MS = 60_000;

/**
 * May a quote built at `quotedAt` still be relayed as built? Under 90 s, the
 * same window `useSend` applies to Send-modal quotes (`SEND_QUOTE_MAX_AGE_MS`).
 */
export function swapQuoteIsFresh(quotedAt: number, now: number): boolean {
  const age = now - quotedAt;
  return age >= 0 && age < SEND_QUOTE_MAX_AGE_MS;
}

export interface SwapFlow {
  /** Leave any quote for the edit form; a build still running is dropped. */
  edit(): void;
  /**
   * Price the modal's current inputs. `silent` is the background refresh of a
   * SHOWN quote: it keeps that quote when it fails.
   */
  quote(silent?: boolean): Promise<void>;
  /** Relay the shown quote, or re-price it first when it is too old. */
  confirm(): Promise<void>;
  /** The modal is closing: every result still in flight is dropped. */
  dispose(): void;
  state(): SwapModalState;
}

/**
 * The quote → confirm → relay sequence (2026-09-29 send-safety audit,
 * finding 2).
 *
 * # The double conversion this exists to stop
 *
 * The modal re-quoted silently every 60 s. A re-quote in flight when Confirm
 * was pressed resolved DURING "submitting", put the modal back into "quote"
 * with a NEW signed transaction and a live Confirm button while relay #1 was
 * still running, so a second press relayed that one too: two conversions,
 * both spendable because the second build did not know the first's inputs were
 * being spent. And nothing checked a quote's age: a silent re-quote that
 * failed left an arbitrarily old transaction relayable.
 *
 * So, as in `quoteController.ts`: a generation counter, bumped whenever the
 * modal leaves a quote (Edit, Back, Confirm, close) or starts pricing a new
 * one. A build that finishes under an older generation describes a quote the
 * modal no longer shows, and is dropped. Confirm relays nothing older than
 * 90 s (`swapQuoteIsFresh`) — it re-prices instead, and the user confirms the
 * new quote — and one relay runs at a time.
 */
export function createSwapFlow(deps: {
  build: () => Promise<SwapQuote>;
  relay: (quote: SwapQuote) => Promise<TxResult>;
  onChange: (state: SwapModalState) => void;
  now?: () => number;
}): SwapFlow {
  const now = deps.now ?? (() => Date.now());
  let current: SwapModalState = { kind: "edit" };
  let generation = 0;
  let relaying = false;
  let disposed = false;

  const set = (next: SwapModalState) => {
    current = next;
    if (!disposed) deps.onChange(next);
  };

  async function quote(silent = false): Promise<void> {
    if (disposed || relaying) return;
    // A background refresh only ever replaces a quote that is on screen.
    if (silent && !(current.kind === "quote" && !current.loading)) return;
    const mine = ++generation;
    if (!silent) set({ kind: "quote", loading: true });
    let built: SwapQuote;
    try {
      built = await deps.build();
    } catch (e) {
      if (disposed || mine !== generation) return;
      if (silent) {
        // The shown quote stays; Confirm re-prices it once it is 90 s old.
        console.warn("[ZephyrSwapModal] auto-requote failed:", errorText(e));
        return;
      }
      set({ kind: "error", message: errorText(e, "Quote failed") });
      return;
    }
    if (disposed || mine !== generation) return;
    set({ kind: "quote", loading: false, quote: built });
  }

  return {
    state: () => current,
    edit() {
      if (disposed || relaying) return;
      generation++;
      set({ kind: "edit" });
    },
    quote,
    async confirm() {
      if (disposed || relaying) return;
      if (current.kind !== "quote" || current.loading) return;
      const q = current.quote;
      if (!swapQuoteIsFresh(q.quotedAt, now())) {
        await quote(false);
        return;
      }
      generation++; // any re-quote still building is for a quote being left
      relaying = true;
      set({ kind: "submitting" });
      try {
        const r = await deps.relay(q);
        set({ kind: "success", txHash: r.hash, pending: r.pending === true });
      } catch (e) {
        if (isSendOutcomeUnknown(e)) {
          set({ kind: "unknown", txHash: e.hash ?? q.response.tx_hash, message: errorText(e, "") });
        } else {
          set({ kind: "error", message: errorText(e, "Broadcast failed") });
        }
      } finally {
        relaying = false;
      }
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}

/**
 * Keep this much of the source asset back for the network fee when MAX fills
 * the amount, unless a quote for that asset has shown a larger fee: 0.001, a
 * wide margin over the 0.0000254 a two-input Zephyr transfer is quoted at in
 * `zph-wallet.test.ts`. A conversion over many small outputs can need more;
 * its quote then fails with the wallet's own "not enough unlocked money"
 * (a build, so nothing is sent) and the user lowers the amount.
 */
export const ZPH_CONVERSION_FEE_RESERVE_ATOMIC = 1_000_000_000n;

/**
 * The amount MAX fills in (2026-09-29 send-safety audit, finding 9): unlocked
 * minus the fee reserve, clamped DOWN to the 4 decimals a conversion allows.
 * Null when nothing convertible is left.
 *
 * It was the whole unlocked balance, clamped. The fee is paid in the SOURCE
 * asset, so a balance with ≤4 decimals left nothing for it and the quote
 * failed with "not enough unlocked money".
 */
export function maxConvertibleAmount(
  unlockedAtomic: number | bigint,
  feeReserveAtomic: bigint
): string | null {
  const unlocked =
    typeof unlockedAtomic === "bigint" ? unlockedAtomic : BigInt(Math.trunc(unlockedAtomic));
  const spendable = unlocked - (feeReserveAtomic > 0n ? feeReserveAtomic : 0n);
  if (spendable <= 0n) return null;
  const clamped = clampZphDisplayDecimals(atomicToZph(spendable), 4);
  return zphToAtomic(clamped) > 0n ? clamped : null;
}

const EXPLORER_TX_URL = (txid: string) =>
  `https://explorer.zephyrprotocol.com/tx/${txid}`;

/**
 * The exact six conversion paths the Zephyr protocol accepts in a single
 * `transfer` tx, expressed as plain English:
 *
 *   ZEPH → ZSD  — mint a stable dollar from your ZEPH
 *   ZEPH → ZRS  — mint leveraged ZEPH exposure from your ZEPH
 *   ZSD  → ZYS  — stake your ZSD for yield
 *   ZYS  → ZSD  — unstake yield, get ZSD + accrued yield back
 *   ZSD  → ZEPH — redeem your stable back into ZEPH
 *   ZRS  → ZEPH — exit your reserve position back into ZEPH
 *
 * Any other pair (e.g. ZPH→ZYS, ZRS→ZSD, ZYS→ZEPH) requires the user to
 * do two separate swaps and is intentionally excluded from the dropdown
 * so the protocol can't reject the tx mid-flight.
 */
const VALID_PAIRS: Array<[ZphAssetType, ZphAssetType]> = [
  ["ZPH", "ZSD"],
  ["ZPH", "ZRS"],
  ["ZSD", "ZYS"],
  ["ZYS", "ZSD"],
  ["ZSD", "ZPH"],
  ["ZRS", "ZPH"],
];

function isDirectPair(src: ZphAssetType, dst: ZphAssetType): boolean {
  return VALID_PAIRS.some(([a, b]) => a === src && b === dst);
}

function validDestinationsFor(src: ZphAssetType): ZphAssetType[] {
  return VALID_PAIRS.filter(([a]) => a === src).map(([, b]) => b);
}

/** Per-asset visual identity. Color tokens used for the asset pill,
 *  amount accent, and quote summary highlight. */
// Single definition in `wallets/zph-rpc`; aliased so the existing call sites
// below read unchanged.
const ASSET_COLOR = ZPH_ASSET_COLOR;

/** Plain-English description of each direct conversion — surfaced in
 *  the modal header so the user always sees what they're about to do. */
const PAIR_PURPOSE: Record<string, { verb: string; description: string }> = {
  "ZPH→ZSD": {
    verb: "MINT STABLE",
    description: "You want a stable dollar — direct mint at oracle rate.",
  },
  "ZPH→ZRS": {
    verb: "MINT RESERVE",
    description:
      "You want leveraged ZEPH exposure — direct mint of reserve share.",
  },
  "ZSD→ZYS": {
    verb: "STAKE YIELD",
    description:
      "You already have ZSD and want it to grow — stake into the yield share.",
  },
  "ZYS→ZSD": {
    verb: "UNSTAKE YIELD",
    description: "Unstake — get your ZSD back plus accrued yield.",
  },
  "ZSD→ZPH": {
    verb: "REDEEM ZSD",
    description: "Redeem your stablecoin back to ZEPH at oracle rate.",
  },
  "ZRS→ZPH": {
    verb: "EXIT RESERVE",
    description: "Exit your reserve position — get your ZEPH equity back.",
  },
};

function balanceOf(
  balances: ZphAssetBalance[] | null,
  asset: ZphAssetType
): { unlocked: number; locked: number } {
  if (!balances) return { unlocked: 0, locked: 0 };
  const entry = balances.find((b) => b.asset_type === asset);
  if (!entry) return { unlocked: 0, locked: 0 };
  return {
    unlocked: entry.unlocked_balance ?? 0,
    locked: (entry.balance ?? 0) - (entry.unlocked_balance ?? 0),
  };
}

/** Per-asset USD price from the scanner-API live snapshot. */
function priceOf(stats: ZphLiveStats | null, asset: ZphAssetType): number | null {
  if (!stats) return null;
  switch (asset) {
    case "ZPH":
      return stats.zeph_price ?? null;
    case "ZSD":
      return stats.zsd_price ?? null;
    case "ZRS":
      return stats.zrs_price ?? null;
    case "ZYS":
      return stats.zys_price ?? null;
  }
}

/**
 * Estimate the destination-asset amount the user will receive, given:
 *   - source asset + amount (post-fee, in source units)
 *   - dest asset
 *   - oracle prices from the scanner API
 *
 * Returns `null` when prices aren't available yet. The actual delivered
 * amount is determined by the protocol's worst-of (spot, MA) rule at
 * mine time; this is a best-effort spot-rate preview.
 */
function estimateDestAmount(
  sourceAsset: ZphAssetType,
  destAsset: ZphAssetType,
  sourceAmount: number,
  stats: ZphLiveStats | null
): number | null {
  const srcPrice = priceOf(stats, sourceAsset);
  const dstPrice = priceOf(stats, destAsset);
  if (srcPrice == null || dstPrice == null || dstPrice === 0) return null;
  return (sourceAmount * srcPrice) / dstPrice;
}

function fmtAmount(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  if (value >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (value >= 1) {
    return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

// ===========================================================================
// Asset pill — compact, color-coded selection chip used in the source/dest
// rows. Replaces the native `<select>` so the modal matches the project's
// terminal design vocabulary instead of looking like a system dialog.
// ===========================================================================

function AssetPill({
  asset,
  selected,
  disabled,
  onClick,
}: {
  asset: ZphAssetType;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const color = ASSET_COLOR[asset];
  // Map the ZphAssetType to the matching `CoinIcon` ticker. ZPH is the
  // base asset; ZSD / ZRS / ZYS each have their own ring + glyph in the
  // CoinIcon family (added in coin-icon-zephyr-glyphs).
  const iconSym = asset; // ZPH | ZSD | ZRS | ZYS already match
  const ticker = ZPH_UI_TICKER[asset];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: selected ? `${color}22` : "rgba(255,255,255,0.03)",
        border: `1px solid ${selected ? color : "rgba(255,255,255,0.12)"}`,
        borderRadius: 2,
        color: selected ? color : "var(--text)",
        fontFamily: "var(--mono)",
        fontSize: 12,
        letterSpacing: 0.6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "all .15s",
      }}
    >
      <CoinIcon
        sym={iconSym}
        size={20}
        accent={selected ? color : undefined}
        glow={selected}
      />
      <span style={{ fontWeight: 600 }}>{ticker}</span>
    </button>
  );
}

// ===========================================================================
// Completion animation — pixel-style progress fill that locks to green
// once every cell is filled. ~1.5s total.
// ===========================================================================

/**
 * `settled` is false while the relay is still running (2026-09-29). The fill
 * used to turn green and read "✓ SWAP COMPLETE" after ~1.1 s whatever the
 * relay was doing, so a broadcast still waiting on a slow node, or about to
 * fail, was already announced as complete.
 */
function CompletionAnimation({ settled = true }: { settled?: boolean }) {
  const TOTAL_CELLS = 14;
  const FRAME_MS = 80;
  const [filled, setFilled] = useState(0);

  useEffect(() => {
    if (filled >= TOTAL_CELLS) return;
    const t = window.setTimeout(() => setFilled((n) => n + 1), FRAME_MS);
    return () => window.clearTimeout(t);
  }, [filled]);

  const done = settled && filled >= TOTAL_CELLS;
  const cells = Array.from({ length: TOTAL_CELLS }, (_, i) => i < filled);
  const color = done ? "var(--success, #4ad97a)" : ASSET_COLOR.ZPH;

  return (
    <div
      style={{
        textAlign: "center",
        margin: "20px 0 12px",
        fontFamily: "var(--mono)",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          gap: 3,
          padding: "8px 12px",
          border: `1px solid ${color}`,
          background: `${color}11`,
          borderRadius: 2,
          transition: "all .2s",
        }}
      >
        {cells.map((on, i) => (
          <span
            key={i}
            style={{
              display: "inline-block",
              width: 10,
              height: 14,
              background: on ? color : "rgba(255,255,255,0.05)",
              transition: "background .12s",
            }}
          />
        ))}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 12,
          letterSpacing: 4,
          color,
          minHeight: "1em",
          transition: "color .2s",
        }}
      >
        {done ? "✓ SWAP COMPLETE" : "BROADCASTING…"}
      </div>
    </div>
  );
}

// ===========================================================================
// Modal
// ===========================================================================

export function ZephyrSwapModal({
  walletAddress,
  assetBalances,
  liveStats,
  initialSourceAsset,
  initialDestAsset,
  onClose,
  onSuccess,
}: {
  walletAddress: string;
  assetBalances: ZphAssetBalance[] | null;
  /** Oracle prices for the destination-amount estimate. From
   *  `useZphReserveInfo`. Modal still works without it (estimate hidden). */
  liveStats?: ZphLiveStats | null;
  initialSourceAsset?: ZphAssetType;
  initialDestAsset?: ZphAssetType;
  onClose: () => void;
  onSuccess?: (txHash: string) => void;
}) {
  const [sourceAsset, setSourceAsset] = useState<ZphAssetType>(
    initialSourceAsset ?? "ZPH"
  );
  const [destAsset, setDestAsset] = useState<ZphAssetType>(() => {
    const initialSource = initialSourceAsset ?? "ZPH";
    if (initialDestAsset && isDirectPair(initialSource, initialDestAsset)) {
      return initialDestAsset;
    }
    if (initialSource === "ZSD") return "ZYS";
    return validDestinationsFor(initialSource)[0] ?? "ZSD";
  });
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<SwapModalState>({ kind: "edit" });
  const [copied, setCopied] = useState(false);

  // What a build reads when it runs: the inputs as they are THEN, not as they
  // were when the flow was created.
  const inputsRef = useRef({ walletAddress, amount, sourceAsset, destAsset });
  inputsRef.current = { walletAddress, amount, sourceAsset, destAsset };
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  /** The fee of the latest quote per source asset, for MAX's reserve. */
  const lastFeeRef = useRef<Partial<Record<ZphAssetType, bigint>>>({});

  // Created in an effect, not in render, so StrictMode's mount → unmount →
  // mount gets a live flow rather than the disposed first one.
  const flowRef = useRef<SwapFlow | null>(null);
  useEffect(() => {
    const flow = createSwapFlow({
      build: async () => {
        const { walletAddress: dest, amount: typed, sourceAsset: src, destAsset: dst } =
          inputsRef.current;
        // Mint/redeem permits ≤4 decimals — clamp (round down) and reflect
        // it in the input so the quoted amount matches what's shown.
        const sendAmount = clampZphDisplayDecimals(typed, 4);
        if (sendAmount !== typed) setAmount(sendAmount);
        const epoch = getZphSessionEpoch();
        const response = await quoteAssetTransfer({
          destination: dest,
          amountZph: sendAmount,
          sourceAsset: src,
          destinationAsset: dst,
        });
        if (!response.tx_metadata || !response.tx_hash) {
          throw new Error(
            "Quote returned no tx_metadata — wallet-rpc may not support get_tx_metadata. Cannot offer a binding quote."
          );
        }
        if (Number.isSafeInteger(response.fee) && response.fee >= 0) {
          lastFeeRef.current[src] = BigInt(response.fee);
        }
        return { response, quotedAt: Date.now(), epoch };
      },
      relay: async (q) => {
        const r = await relayZphTransaction({
          txMetadata: q.response.tx_metadata ?? "",
          txHash: q.response.tx_hash,
          epoch: q.epoch,
        });
        onSuccessRef.current?.(r.hash);
        return r;
      },
      onChange: setState,
    });
    flowRef.current = flow;
    return () => {
      flow.dispose();
      if (flowRef.current === flow) flowRef.current = null;
    };
  }, []);

  // 1-second ticker drives the auto-refresh countdown between requotes.
  const [tickNow, setTickNow] = useState(Date.now());
  useEffect(() => {
    if (state.kind !== "quote" || state.loading) return;
    const id = window.setInterval(() => setTickNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.kind, state.kind === "quote" && !state.loading]);

  const validDests = useMemo(
    () => validDestinationsFor(sourceAsset),
    [sourceAsset]
  );

  // If destAsset becomes invalid for a new source, snap to first valid.
  useEffect(() => {
    if (validDests.includes(destAsset)) return;
    const next = sourceAsset === "ZSD" ? "ZYS" : validDests[0];
    if (next) setDestAsset(next);
    if (state.kind === "quote") flowRef.current?.edit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceAsset, validDests]);

  const srcBal = balanceOf(assetBalances, sourceAsset);
  const srcUnlockedDecimal = Number(atomicToZph(srcBal.unlocked));

  const amountNumeric = useMemo(() => {
    const n = parseFloat(amount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [amount]);

  const insufficientBalance =
    amountNumeric > 0 &&
    assetBalances !== null &&
    srcBal.unlocked > 0 &&
    amountNumeric > srcUnlockedDecimal;

  const canQuote =
    amountNumeric > 0 &&
    isDirectPair(sourceAsset, destAsset) &&
    !insufficientBalance;

  const pairKey = `${sourceAsset}→${destAsset}`;
  const purpose = PAIR_PURPOSE[pairKey] ?? {
    verb: "SWAP",
    description: `${ZPH_UI_TICKER[sourceAsset]} → ${ZPH_UI_TICKER[destAsset]}`,
  };

  const srcColor = ASSET_COLOR[sourceAsset];
  const dstColor = ASSET_COLOR[destAsset];

  // ---- Actions ----

  const handleQuote = (silent = false) => {
    if (!canQuote) return;
    void flowRef.current?.quote(silent);
  };

  // Auto-requote while quote is loaded. The flow drops a result that arrives
  // after the modal left this quote (Edit, Confirm, close).
  useEffect(() => {
    if (state.kind !== "quote" || state.loading) return;
    const id = window.setInterval(() => {
      void flowRef.current?.quote(true);
    }, QUOTE_REFRESH_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.kind,
    state.kind === "quote" && !state.loading ? state.quote.quotedAt : 0,
    sourceAsset,
    destAsset,
    amount,
  ]);

  const handleConfirm = () => {
    void flowRef.current?.confirm();
  };

  const reset = () => flowRef.current?.edit();

  // MAX keeps the network fee back (2026-09-29, finding 9): the fee is paid in
  // the SOURCE asset, so the whole unlocked balance could never convert.
  const maxAmount = maxConvertibleAmount(
    srcBal.unlocked,
    (() => {
      const quoted = lastFeeRef.current[sourceAsset] ?? 0n;
      return quoted > ZPH_CONVERSION_FEE_RESERVE_ATOMIC ? quoted : ZPH_CONVERSION_FEE_RESERVE_ATOMIC;
    })()
  );

  const handleSetMax = () => {
    if (maxAmount == null) return;
    // Zephyr swaps are always mint/redeem → ≤4 decimals. Show the clamped
    // amount so the user sees what will actually be sent.
    setAmount(maxAmount);
    if (state.kind === "quote") flowRef.current?.edit();
  };

  const handleFlipDirection = () => {
    if (!isDirectPair(destAsset, sourceAsset)) return;
    const newSrc = destAsset;
    const newDst = sourceAsset;
    setSourceAsset(newSrc);
    setDestAsset(newDst);
    setAmount("");
    if (state.kind === "quote") flowRef.current?.edit();
  };
  const canFlip = isDirectPair(destAsset, sourceAsset);

  // ---- Per-state body ----

  const body = () => {
    if (state.kind === "submitting") {
      return (
        <div style={{ padding: "30px 0" }}>
          <CompletionAnimation settled={false} />
        </div>
      );
    }

    /** The txid, clickable to the explorer, shift-click to copy. */
    const hashBlock = (txHash: string) => {
      const url = EXPLORER_TX_URL(txHash);
      return (
        <div className="form-group" style={{ marginBottom: 4 }}>
          <label
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: 1,
              color: "var(--text-dim)",
            }}
          >
            TRANSACTION HASH
          </label>
          <code
            onClick={(e) => {
              if (e.shiftKey) {
                void navigator.clipboard.writeText(txHash);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
                return;
              }
              void openExternal(url);
            }}
            title={`${txHash}\n(click: open in explorer · shift-click: copy)`}
            style={{
              display: "block",
              fontFamily: "var(--mono)",
              fontSize: 10,
              wordBreak: "break-all",
              cursor: "pointer",
              textDecoration: "underline",
              color: copied ? "var(--success, #4ad97a)" : ASSET_COLOR.ZPH,
              padding: "10px 12px",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 2,
              background: "rgba(255,255,255,0.03)",
              transition: "color .15s",
            }}
          >
            {txHash}
          </code>
          <p
            className="gas-info"
            style={{ marginTop: 4, fontSize: 9, letterSpacing: 0.5 }}
          >
            {copied
              ? "Copied to clipboard."
              : "Click to open in explorer · shift-click to copy."}
          </p>
        </div>
      );
    };

    if (state.kind === "success") {
      return (
        <>
          <CompletionAnimation />
          <p
            className="gas-info"
            style={{ marginTop: 0, marginBottom: 12, textAlign: "center" }}
          >
            Transaction broadcast. Your balance updates after the next
            block (~2 minutes).
          </p>

          {hashBlock(state.txHash)}

          <div className="button-row" style={{ marginTop: 16 }}>
            <button className="btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      );
    }

    // The relay may have reached the network (2026-09-29, finding 2). No
    // "Back": from Back, Get Quote + Confirm built and relayed a SECOND
    // conversion while the first could still land.
    if (state.kind === "unknown") {
      return (
        <>
          <p
            className="warning"
            style={{ marginTop: 0, whiteSpace: "pre-wrap" }}
          >
            Not confirmed: this conversion may have been broadcast. Check
            Activity or the explorer before converting again.
          </p>

          {hashBlock(state.txHash)}

          {state.message && (
            <p className="gas-info" style={{ marginTop: 4, fontSize: 9 }}>
              {state.message}
            </p>
          )}

          <div className="button-row" style={{ marginTop: 16 }}>
            <button className="btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      );
    }

    if (state.kind === "error") {
      return (
        <>
          <p
            className="warning"
            style={{ marginTop: 0, whiteSpace: "pre-wrap" }}
          >
            {state.message}
          </p>
          <div className="button-row">
            <button className="btn-secondary" onClick={onClose}>
              Close
            </button>
            <button className="btn-primary" onClick={reset}>
              ◄ Back
            </button>
          </div>
        </>
      );
    }

    const quoteLoaded = state.kind === "quote" && !state.loading;
    const quoteLoading = state.kind === "quote" && state.loading;
    const quote = quoteLoaded ? state.quote.response : null;
    const quoteAge = quoteLoaded ? tickNow - state.quote.quotedAt : 0;
    const refreshSec = Math.max(
      0,
      Math.round((QUOTE_REFRESH_MS - quoteAge) / 1000)
    );
    // Past 90 s Confirm re-prices before it relays (`swapQuoteIsFresh`); say so
    // instead of a countdown stuck at 0 after a failed refresh.
    const quoteExpired =
      quoteLoaded && !swapQuoteIsFresh(state.quote.quotedAt, tickNow);

    // Estimated destination amount (post-fee, oracle spot rate).
    let estimatedDest: number | null = null;
    if (quote && liveStats) {
      const sourceMinusFee =
        Number(atomicToZph(quote.amount)) - Number(atomicToZph(quote.fee));
      estimatedDest = estimateDestAmount(
        sourceAsset,
        destAsset,
        sourceMinusFee,
        liveStats
      );
    }

    const labelStyle: React.CSSProperties = {
      display: "block",
      fontFamily: "var(--mono)",
      fontSize: 10,
      letterSpacing: 1,
      color: "var(--text-dim)",
      marginBottom: 6,
    };

    return (
      <>
        {/* Purpose strip — tells the user in one line what this swap
            accomplishes. Color-coded to the destination asset. */}
        <div
          style={{
            padding: "10px 12px",
            marginBottom: 14,
            background: `${dstColor}11`,
            borderLeft: `3px solid ${dstColor}`,
            fontFamily: "var(--mono)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: 1.5,
              color: dstColor,
              fontWeight: 700,
            }}
          >
            ▶ {purpose.verb}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              marginTop: 3,
            }}
          >
            {purpose.description}
          </div>
        </div>

        {/* FROM — asset pills + amount input */}
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 6,
            }}
          >
            <span style={labelStyle}>FROM</span>
            {assetBalances !== null && (
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--text-dim)",
                }}
              >
                bal: {atomicToZph(srcBal.unlocked)}
                {srcBal.locked > 0
                  ? ` (+${atomicToZph(srcBal.locked)} locked)`
                  : ""}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {ZPH_ASSETS.map((a) => (
              <AssetPill
                key={a}
                asset={a}
                selected={a === sourceAsset}
                disabled={state.kind !== "edit"}
                onClick={() => {
                  setSourceAsset(a);
                  setAmount("");
                  if (state.kind === "quote") setState({ kind: "edit" });
                }}
              />
            ))}
          </div>

          {/* Amount input with MAX + ticker suffix */}
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "stretch",
              border: `1px solid ${insufficientBalance ? "#e34646" : `${srcColor}44`}`,
              borderRadius: 2,
              background: "rgba(255,255,255,0.02)",
              transition: "border-color .15s",
            }}
          >
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                if (state.kind === "quote") setState({ kind: "edit" });
              }}
              disabled={state.kind !== "edit"}
              style={{
                flex: 1,
                padding: "10px 12px",
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--text)",
                fontFamily: "var(--mono)",
                fontSize: 16,
                letterSpacing: 0.5,
              }}
            />
            <button
              type="button"
              onClick={handleSetMax}
              disabled={state.kind !== "edit" || maxAmount == null}
              style={{
                padding: "0 10px",
                background: "transparent",
                border: "none",
                borderLeft: "1px solid rgba(255,255,255,0.08)",
                color: "var(--text-dim)",
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: 1,
                cursor:
                  state.kind === "edit" && maxAmount != null
                    ? "pointer"
                    : "not-allowed",
              }}
            >
              MAX
            </button>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "0 12px",
                borderLeft: "1px solid rgba(255,255,255,0.08)",
                background: `${srcColor}11`,
                color: srcColor,
                fontFamily: "var(--mono)",
                fontSize: 12,
                letterSpacing: 0.6,
                fontWeight: 600,
              }}
            >
              {ZPH_UI_TICKER[sourceAsset]}
            </span>
          </div>
          {insufficientBalance && (
            <p
              style={{
                color: "#e34646",
                fontFamily: "var(--mono)",
                fontSize: 10,
                marginTop: 4,
                marginBottom: 0,
              }}
            >
              Amount exceeds your unlocked balance.
            </p>
          )}
        </div>

        {/* SWAP-DIRECTION TOGGLE */}
        <div style={{ textAlign: "center", margin: "8px 0 12px" }}>
          <button
            type="button"
            onClick={handleFlipDirection}
            disabled={!canFlip || state.kind !== "edit"}
            title={
              canFlip
                ? "Flip source ↔ destination"
                : "Reverse direction not directly supported"
            }
            style={{
              width: 36,
              height: 36,
              padding: 0,
              borderRadius: 18,
              border: `1px solid ${canFlip ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)"}`,
              background: "rgba(255,255,255,0.04)",
              color: canFlip ? "var(--text)" : "var(--text-dim)",
              fontSize: 16,
              cursor:
                canFlip && state.kind === "edit" ? "pointer" : "not-allowed",
              opacity: canFlip ? 1 : 0.5,
              transition: "all .15s",
            }}
          >
            ⇅
          </button>
        </div>

        {/* TO — destination pills */}
        <div style={{ marginBottom: 8 }}>
          <span style={labelStyle}>TO</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {validDests.map((a) => (
              <AssetPill
                key={a}
                asset={a}
                selected={a === destAsset}
                disabled={state.kind !== "edit"}
                onClick={() => {
                  setDestAsset(a);
                  if (state.kind === "quote") setState({ kind: "edit" });
                }}
              />
            ))}
          </div>
          <p
            className="gas-info"
            style={{ marginTop: 6, fontSize: 9, letterSpacing: 0.4 }}
          >
            {sourceAsset === "ZPH" &&
              "ZEPH has no direct path to ZEPHYRS — mint ZEPHUSD first, then stake."}
            {sourceAsset === "ZRS" &&
              "ZEPHRSV exits to ZEPH only. Then redeem or stake from ZEPH."}
            {sourceAsset === "ZYS" &&
              "ZEPHYRS only unstakes back to ZEPHUSD."}
            {sourceAsset === "ZSD" &&
              "Stake into yield (ZEPHYRS), or redeem back to base (ZEPH)."}
          </p>
        </div>

        {/* QUOTE PANEL */}
        {(quoteLoading || quote) && (
          <div
            style={{
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 2,
              padding: "12px 14px",
              marginTop: 14,
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: 1.5,
                color: "var(--text-dim)",
                marginBottom: 8,
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>QUOTE</span>
              {quoteLoaded && (
                <span style={{ fontSize: 9 }}>
                  {quoteExpired
                    ? "expired: Confirm re-quotes first"
                    : `↻ refreshing in ${refreshSec}s`}
                </span>
              )}
              {quoteLoading && <span style={{ fontSize: 9 }}>building…</span>}
            </div>

            {quoteLoading && (
              <div
                style={{
                  textAlign: "center",
                  padding: "8px 0",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                Fetching oracle rate from wallet-rpc…
              </div>
            )}

            {quote && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "6px 14px",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--text-dim)" }}>You send</span>
                <span style={{ textAlign: "right", color: srcColor }}>
                  {atomicToZph(quote.amount)} {ZPH_UI_TICKER[sourceAsset]}
                </span>

                <span style={{ color: "var(--text-dim)" }}>Network fee</span>
                <span style={{ textAlign: "right" }}>
                  {atomicToZph(quote.fee)} {ZPH_UI_TICKER[sourceAsset]}
                </span>

                <span style={{ color: "var(--text-dim)" }}>You receive</span>
                <span style={{ textAlign: "right", color: dstColor, fontWeight: 600 }}>
                  {estimatedDest != null
                    ? `~${fmtAmount(estimatedDest)} ${ZPH_UI_TICKER[destAsset]}`
                    : "(pending oracle data)"}
                </span>

                {estimatedDest != null && amountNumeric > 0 && (
                  <>
                    <span style={{ color: "var(--text-dim)" }}>Rate</span>
                    <span
                      style={{
                        textAlign: "right",
                        color: "var(--text-dim)",
                        fontSize: 11,
                      }}
                    >
                      1 {ZPH_UI_TICKER[sourceAsset]} ={" "}
                      {fmtAmount(estimatedDest / amountNumeric)}{" "}
                      {ZPH_UI_TICKER[destAsset]}
                    </span>
                  </>
                )}
              </div>
            )}

            {quote && (
              <p
                style={{
                  marginTop: 10,
                  marginBottom: 0,
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  color: "var(--text-dim)",
                  letterSpacing: 0.3,
                  lineHeight: 1.5,
                }}
              >
                Receive amount is an oracle-spot estimate. The protocol
                applies the worst of (spot, 24h MA) at mine time, so the
                actual delivered amount may be slightly less.
              </p>
            )}
          </div>
        )}

        {/* FOOTER BUTTONS */}
        {quoteLoaded ? (
          <div className="button-row" style={{ marginTop: 14 }}>
            <button className="btn-secondary" onClick={reset}>
              ◄ Edit
            </button>
            <button
              className="btn-primary"
              onClick={handleConfirm}
              style={{ background: dstColor, borderColor: dstColor, color: "#0a0a0a" }}
            >
              ► Confirm {purpose.verb}
            </button>
          </div>
        ) : quoteLoading ? (
          <div className="button-row" style={{ marginTop: 14 }}>
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" disabled>
              ⏳ Quoting…
            </button>
          </div>
        ) : (
          <div className="button-row" style={{ marginTop: 14 }}>
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={!canQuote}
              onClick={() => handleQuote(false)}
              title={
                amountNumeric <= 0
                  ? "Enter an amount greater than 0"
                  : insufficientBalance
                    ? "Amount exceeds your unlocked balance"
                    : "Get a binding fee quote"
              }
              style={
                canQuote
                  ? {
                      background: dstColor,
                      borderColor: dstColor,
                      color: "#0a0a0a",
                    }
                  : undefined
              }
            >
              ► Get Quote
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    // No click-away while a relay runs: its outcome would be lost with the modal.
    // The shared backdrop (2026-10-01): above the portrait bottom nav.
    <ModalBackdrop onClick={state.kind === "submitting" ? undefined : onClose}>
      <div
        className="modal-dialog send-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 460 }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 14,
            paddingBottom: 10,
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <h3 style={{ margin: 0 }}>ZEPHYR SWAP</h3>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 9,
              letterSpacing: 1,
              color: "var(--text-dim)",
            }}
          >
            ECOSYSTEM CONVERSION
          </span>
        </div>
        {body()}
      </div>
    </ModalBackdrop>
  );
}
