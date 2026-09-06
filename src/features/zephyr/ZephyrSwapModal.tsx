import { useEffect, useMemo, useState } from "react";
import { openExternal } from "../../utils/openExternal";
import {
  ZPH_ASSETS,
  ZPH_ASSET_NAME,
  ZPH_UI_TICKER,
  atomicToZph,
  ZPH_ASSET_COLOR,
  clampZphDisplayDecimals,
  quoteAssetTransfer,
  relayTransfer,
  type ZphAssetType,
  type ZphAssetBalance,
  type ZphTransferResponse,
} from "../../wallets/zph-rpc";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import { CoinIcon } from "../../components/CoinIcon";

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
 * See [[zephyr-ecosystem-swap-plan]] for Phase 2/4/5/6 work this modal
 * does not yet do (reserve-ratio pre-flight, ZRS leverage warning,
 * etc.).
 */

type ModalState =
  | { kind: "edit" }
  | { kind: "quote"; loading: true }
  | { kind: "quote"; loading: false; quote: ZphTransferResponse; quotedAt: number }
  | { kind: "submitting" }
  | { kind: "success"; txHash: string }
  | { kind: "error"; message: string };

/** Auto-refresh cadence — kept under one block (~120s) so the user
 *  always sees a quote that's no more than ~60s away from a freshly
 *  re-priced tx. */
const QUOTE_REFRESH_MS = 60_000;

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

function CompletionAnimation() {
  const TOTAL_CELLS = 14;
  const FRAME_MS = 80;
  const [filled, setFilled] = useState(0);

  useEffect(() => {
    if (filled >= TOTAL_CELLS) return;
    const t = window.setTimeout(() => setFilled((n) => n + 1), FRAME_MS);
    return () => window.clearTimeout(t);
  }, [filled]);

  const done = filled >= TOTAL_CELLS;
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
  const [state, setState] = useState<ModalState>({ kind: "edit" });
  const [copied, setCopied] = useState(false);

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
    if (state.kind === "quote") setState({ kind: "edit" });
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

  const handleQuote = async (silent = false) => {
    if (!canQuote) return;
    if (!silent) setState({ kind: "quote", loading: true });
    try {
      // Mint/redeem permits ≤4 decimals — clamp (round down) and reflect
      // it in the input so the quoted amount matches what's shown.
      const sendAmount = clampZphDisplayDecimals(amount, 4);
      if (sendAmount !== amount) setAmount(sendAmount);
      const quote = await quoteAssetTransfer({
        destination: walletAddress,
        amountZph: sendAmount,
        sourceAsset,
        destinationAsset: destAsset,
      });
      if (!quote.tx_metadata) {
        throw new Error(
          "Quote returned no tx_metadata — wallet-rpc may not support get_tx_metadata. Cannot offer a binding quote."
        );
      }
      setState({ kind: "quote", loading: false, quote, quotedAt: Date.now() });
    } catch (e: any) {
      if (silent) {
        console.warn("[ZephyrSwapModal] auto-requote failed:", e);
        return;
      }
      setState({
        kind: "error",
        message: typeof e === "string" ? e : (e?.message ?? "Quote failed"),
      });
    }
  };

  // Auto-requote while quote is loaded.
  useEffect(() => {
    if (state.kind !== "quote" || state.loading) return;
    const id = window.setInterval(() => {
      void handleQuote(true);
    }, QUOTE_REFRESH_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.kind,
    state.kind === "quote" && !state.loading ? state.quotedAt : 0,
    sourceAsset,
    destAsset,
    amount,
  ]);

  const handleConfirm = async () => {
    if (state.kind !== "quote" || state.loading) return;
    setState({ kind: "submitting" });
    try {
      const r = await relayTransfer(state.quote.tx_metadata!);
      const finalHash = r.tx_hash || state.quote.tx_hash;
      setState({ kind: "success", txHash: finalHash });
      onSuccess?.(finalHash);
    } catch (e: any) {
      setState({
        kind: "error",
        message: typeof e === "string" ? e : (e?.message ?? "Broadcast failed"),
      });
    }
  };

  const reset = () => setState({ kind: "edit" });

  const handleSetMax = () => {
    if (srcBal.unlocked <= 0) return;
    // Zephyr swaps are always mint/redeem → ≤4 decimals. Show the clamped
    // amount so the user sees what will actually be sent.
    setAmount(clampZphDisplayDecimals(atomicToZph(srcBal.unlocked), 4));
    if (state.kind === "quote") setState({ kind: "edit" });
  };

  const handleFlipDirection = () => {
    if (!isDirectPair(destAsset, sourceAsset)) return;
    const newSrc = destAsset;
    const newDst = sourceAsset;
    setSourceAsset(newSrc);
    setDestAsset(newDst);
    setAmount("");
    if (state.kind === "quote") setState({ kind: "edit" });
  };
  const canFlip = isDirectPair(destAsset, sourceAsset);

  // ---- Per-state body ----

  const body = () => {
    if (state.kind === "submitting") {
      return (
        <div style={{ padding: "30px 0" }}>
          <CompletionAnimation />
        </div>
      );
    }

    if (state.kind === "success") {
      const url = EXPLORER_TX_URL(state.txHash);
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
                  void navigator.clipboard.writeText(state.txHash);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                  return;
                }
                void openExternal(url);
              }}
              title={`${state.txHash}\n(click: open in explorer · shift-click: copy)`}
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
              {state.txHash}
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
    const quote = quoteLoaded ? state.quote : null;
    const quoteAge = quoteLoaded ? tickNow - state.quotedAt : 0;
    const refreshSec = Math.max(
      0,
      Math.round((QUOTE_REFRESH_MS - quoteAge) / 1000)
    );

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
              disabled={state.kind !== "edit" || srcBal.unlocked <= 0}
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
                  state.kind === "edit" && srcBal.unlocked > 0
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
                  ↻ refreshing in {refreshSec}s
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
    <div className="modal-overlay" onClick={onClose}>
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
    </div>
  );
}
