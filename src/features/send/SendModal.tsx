import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChainAdapter,
  FeeEstimate,
  GasBudget,
  SendQuote,
  SendableBalance,
} from "../../wallets/types";
import { feeNoteText, feeRateForSend, feeTotalFor, formatUsd } from "./feeDisplay";
import { coinAmountFromUsd, usdTextFromCoin } from "../../lib/usdAmount";
import { errorText } from "../../lib/errorText";
import { sendAssetTicker, sendAssetUsdPrice } from "../../wallets/tx-display";
import { stablecoinLegLabel } from "../../wallets/stablecoins";
import type { ZphLiveStats } from "../../wallets/zph-scanner-api";
import { useSendQuote } from "./useSendQuote";
import { ModalBackdrop } from "../../components/ModalBackdrop";
import {
  parseDestinationTag,
  parseSendMemo,
  setSendDestinationTag,
  setSendMemoText,
  setSendMemoType,
  useSendAssetType,
  useSendDestinationTag,
  useSendMemo,
} from "./sendAssetStore";

type Tier = "slow" | "normal" | "fast";

/**
 * Latest-reply-wins for an async read the modal re-issues as the user types
 * (2026-09-29 send-safety audit). `begin()` stamps a request; a reply is
 * applied only while `isCurrent(stamp)` — i.e. no newer request has started.
 *
 * `loadGas` re-ran on every keystroke of the recipient and the amount with no
 * such check, so replies could land out of order: a slow estimate for "1"
 * arriving after the one for "100" put back the "1" verdict, and the modal
 * could show "enough to cover the fee" for an amount it had not priced.
 */
export function createLatestGate(): { begin(): number; isCurrent(stamp: number): boolean } {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (stamp) => stamp === latest,
  };
}

export interface SendModalProps {
  adapter: ChainAdapter;
  /**
   * The address the send leaves FROM. Needed to answer whether it can pay the
   * fee, which on an ERC-20 send is a different balance from the one shown as
   * "Available". Optional so a caller that has no address yet still renders;
   * the gas check simply stays quiet.
   */
  fromAddress?: string;
  sendTo: string;
  setSendTo: (v: string) => void;
  sendAmount: string;
  setSendAmount: (v: string) => void;
  sending: boolean;
  /** `feeRate`: the selected tier as a per-(v)byte rate, when the chain's
   *  estimate is one (`feeRateForSend`); otherwise undefined. `quote`: the
   *  priced quote, for adapters with `quoteSend` (useSend relays it only if it
   *  still matches the send). */
  onSend: (feeRate?: number, quote?: SendQuote) => void;
  onClose: () => void;
  /** Overrides the asset shown in the title/amount unit. Defaults to the label
   *  for `assetType` (`sendAssetTicker`), i.e. `adapter.ticker` for every chain
   *  without per-send assets. */
  assetLabel?: string;
  /** The per-send asset selector `useSend` sends with (Zephyr: ZSD/ZRS/ZYS;
   *  undefined = the chain's native asset). Priced and labelled as such. */
  assetType?: string;
  /** USD price of the coin that PAYS the fee (`adapter.ticker`), for the
   *  fee total. Absent → the total is shown in the coin only. */
  usdPrice?: number;
  /** USD price of `assetType` when it is not the adapter's own coin (a Zephyr
   *  ecosystem asset's oracle price). Used for a fee charged in that asset. */
  assetUsdPrice?: number;
}

export function SendModal({
  adapter,
  fromAddress,
  sendTo,
  setSendTo,
  sendAmount,
  setSendAmount,
  sending,
  onSend,
  onClose,
  assetLabel,
  assetType,
  usdPrice,
  assetUsdPrice,
}: SendModalProps) {
  const sendTicker = assetLabel ?? sendAssetTicker(adapter.chain, adapter.ticker, assetType);
  // The network (and USD₮0's note) of a stablecoin leg, for the line under
  // the title. Undefined for every chain that is not a leg.
  const legLabel = stablecoinLegLabel(adapter.chain);

  // ── USD entry (2026-09-12) ────────────────────────────────────────────────
  //
  // Typing dollars sets the coin amount at `usdPrice`, rounded DOWN to a
  // precision the chain accepts (`coinAmountFromUsd`). Only when the asset
  // being sent IS the adapter's own coin: a Zephyr ecosystem send
  // (ZEPHUSD/ZEPHRSV/ZEPHYRS) reuses the ZEPH adapter, and `usdPrice` is
  // ZEPH's — converting a ZEPHUSD amount at it would be wrong by the peg.
  // The typed text is shown verbatim only while `sendAmount` is still what it
  // produced; editing the coin field makes it stale and the USD field follows.
  const amountUsdPrice =
    sendTicker === adapter.ticker && usdPrice != null && usdPrice > 0
      ? usdPrice
      : undefined;
  const [usdEdit, setUsdEdit] = useState<{ text: string; forAmount: string } | null>(null);
  const usdShown =
    usdEdit && usdEdit.forAmount === sendAmount
      ? usdEdit.text
      : usdTextFromCoin(sendAmount, amountUsdPrice);
  const onUsdChange = (text: string) => {
    const amt = coinAmountFromUsd(text, amountUsdPrice, adapter.ticker);
    if (amt === null) {
      setUsdEdit({ text, forAmount: sendAmount });
      return;
    }
    setUsdEdit({ text, forAmount: amt });
    setSendAmount(amt);
  };

  // ── Quote-driven fee (2026-09-15) ─────────────────────────────────────────
  //
  // Adapters that implement `quoteSend` (Zephyr) price THIS send by building it
  // without broadcasting; the tier estimate below is never fetched for them.
  // Zephyr's estimate called a daemon method its wallet-rpc does not have, so
  // the box showed an error forever and no fee was ever priced. Every other
  // chain keeps the tier UI exactly as it was.
  //
  // ── Reviewed sends: Monero and Zephyr (operator request, 2026-10-01) ─────
  //
  // That price was a build on every edit and every 60 s, and each build asks
  // the node for the coins it spends with fresh decoys: a node seeing several
  // builds of one spend can tell which coins are the wallet's. Where the quote
  // builds the spend (`quoteBuildsSpend`) the box shows an ESTIMATE that
  // builds nothing (`getFeeEstimate`: the node's rate × a typical send), the
  // button reads Review, and only that press builds — once. The exact fee of
  // that build is then shown, and Confirm relays exactly it.
  const quoteDriven = typeof adapter.quoteSend === "function";
  const reviewed = quoteDriven && adapter.quoteBuildsSpend === true;
  const priced = useSendQuote({
    adapter,
    to: sendTo,
    amount: sendAmount,
    assetType,
    enabled: quoteDriven && !sending,
  });

  // What the send can draw on right now, for adapters that can say (Zephyr:
  // unlocked vs total of the asset being sent). A full-balance send used to
  // fail only after the press, because the modal showed no spendable figure.
  const [sendable, setSendable] = useState<SendableBalance | null>(null);
  useEffect(() => {
    if (!adapter.getSendableBalance) {
      setSendable(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const b = await adapter.getSendableBalance!(assetType);
        if (!cancelled) setSendable(b);
      } catch (e) {
        if (!cancelled) setSendable(null);
        console.warn("[SendModal] sendable balance failed:", errorText(e));
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [adapter, assetType]);

  const [fee, setFee] = useState<FeeEstimate | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [tier, setTier] = useState<Tier>("normal");

  // ── can this address pay the fee at all? ────────────────────────────────
  //
  // Only ERC-20 adapters answer this: they are the ones where the fee is paid
  // in a coin the modal is NOT otherwise showing. `adapter.gasToken` is
  // present exactly on those, so its absence is the whole feature flag.
  //
  // Before 2026-09-09 nothing asked. `evm-factory.ts`'s ERC-20 branch called
  // `contract.transfer(...)` directly, so a wallet holding USDC on Arbitrum
  // and zero ETH rendered "Available: 500 USDC", a network fee, and an
  // enabled Send button — then surfaced the shortfall as a raw
  // `insufficient funds for intrinsic transaction cost` from `useSend`'s
  // catch-all, AFTER the press. Bridging a stablecoin to an L2 moves the
  // token and nothing else, so a zero-gas wallet holding real value is the
  // ordinary first state on Arbitrum and Base, not an edge case.
  const [gas, setGas] = useState<GasBudget | null>(null);
  // Only the reply to the NEWEST request is applied (2026-09-29): this runs
  // on every keystroke, and replies do not come back in order.
  const gasGate = useRef(createLatestGate()).current;

  const loadGas = useCallback(async () => {
    const stamp = gasGate.begin();
    if (!adapter.getGasBudget || !fromAddress) return;
    try {
      // `to`/`amount` are passed when present so the estimate is of the REAL
      // transfer; without them the adapter falls back to a per-chain gas
      // limit and can still settle the zero-balance case.
      const r = await adapter.getGasBudget(fromAddress, {
        to: sendTo || undefined,
        amount: sendAmount || undefined,
      });
      if (gasGate.isCurrent(stamp)) setGas(r);
    } catch (e) {
      // The adapter is documented not to throw; if a future one does, a
      // missing warning must not take the modal down with it.
      console.warn("[SendModal] gas budget failed:", e);
      if (gasGate.isCurrent(stamp)) setGas(null);
    }
  }, [adapter, fromAddress, sendTo, sendAmount, gasGate]);

  useEffect(() => {
    void loadGas();
  }, [loadGas]);

  /** A definite "cannot pay the fee". Never true on an unestimable answer. */
  const gasShort = gas?.sufficient === false;

  // XRP destination tag (2026-09-29): the raw field text lives in the send
  // store, so the value `useSend` signs is the value shown here.
  const tagRaw = useSendDestinationTag();
  const tagError = adapter.destinationTag ? parseDestinationTag(tagRaw).error : undefined;

  // Stellar memo (2026-09-29 send-safety audit): the same store pattern as the
  // tag, so the memo `useSend` sends is the memo shown here.
  const memoField = useSendMemo();
  const memoError = adapter.memo
    ? parseSendMemo(memoField.raw, memoField.type, adapter.memo.textMaxBytes).error
    : undefined;
  // A number typed as a TEXT memo is legal and sometimes right, so it does not
  // block; but MEMO_ID 123 and MEMO_TEXT "123" are different memos, and an
  // exchange that asked for one does not match the other.
  const memoLooksLikeId =
    !memoError && memoField.type === "text" && /^\d+$/.test(memoField.raw.trim());


  // Fetch fee estimate on mount and refresh every 30 s while open. Adapters
  // throw `not initialized` for sidecar chains until the wallet is open;
  // we surface that as a one-line note rather than a hard error.
  //
  // Reviewed adapters (Monero, Zephyr) fetch it too, for the estimate shown
  // until the review: it reads the node's fee rate and builds nothing, so
  // refreshing it is harmless. `assetType` because Zephyr's fee is charged in
  // the asset being sent.
  const fetchesEstimate = !quoteDriven || reviewed;
  const loadFee = useCallback(async () => {
    if (!fetchesEstimate) return;
    setFeeLoading(true);
    try {
      const r = await adapter.getFeeEstimate(assetType);
      setFee(r);
      setFeeError(null);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Strip stack-y / URL-bearing detail so the UI doesn't echo back
      // raw HTTP errors with user-bearing query strings (mirrors the
      // sanitization in UXS-20260516-101). The full text is in console.
      console.warn("[SendModal] fee fetch failed:", raw);
      const short =
        raw.includes("not initialized")
          ? "Wallet sidecar isn't ready yet. Try again in a moment."
          : raw.length > 120
            ? "Couldn't fetch the current network fee."
            : raw;
      setFeeError(short);
      setFee(null);
    } finally {
      setFeeLoading(false);
    }
  }, [adapter, fetchesEstimate, assetType]);

  useEffect(() => {
    if (!fetchesEstimate) return;
    let cancelled = false;
    void (async () => {
      await loadFee();
      if (cancelled) return;
    })();
    const id = window.setInterval(() => {
      if (!cancelled) void loadFee();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [loadFee, fetchesEstimate]);

  // Truthy when we have a usable fee value for the currently-selected
  // tier. Send is blocked when this is false (per UXS-20260516-112
  // acceptance criterion #3: never let the user broadcast blind).
  const selectedTierFee =
    fee?.[tier]?.value ?? fee?.normal?.value ?? null;
  /**
   * Whether a missing fee should BLOCK the send.
   *
   * It should not, when the network computes the fee itself. Monero's
   * `transfer` takes a priority and monero-wallet-rpc derives the fee; this
   * wallet never submits one and could not override it. Gating on it meant a
   * broken DISPLAY call made sending impossible — reported 2026-08-29 as
   * `RPC error -32601: Method not found  Send is disabled until a fee is
   * available.`, on every attempt.
   *
   * Chains that DO submit a fee keep the gate: there, no fee means no
   * correctly-constructed transaction, and blocking is the right answer.
   * Quote-driven adapters are gated on the quote instead (`quoteBlocks`).
   */
  const feeIsAdvisory = adapter.networkComputesFee === true;
  const feeReady =
    quoteDriven || feeIsAdvisory || (!!selectedTierFee && selectedTierFee !== "—");

  /**
   * A quote failure that refuses the send: not enough unlocked funds for amount
   * plus fee, or an invalid recipient. Any other quote failure is advisory,
   * because the network sets the fee (`isDefinitiveQuoteError`).
   */
  const quoteBlocks = quoteDriven && priced.failure?.definitive === true;

  const tiers: Array<{ id: Tier; label: string; eta?: string; value?: string }> = [];
  if (fee?.slow)
    tiers.push({
      id: "slow",
      label: "Slow",
      eta: fee.slow.eta,
      value: fee.slow.value,
    });
  tiers.push({
    id: "normal",
    // A fallback is the adapter's built-in default, not an estimate — say so.
    // Until 2026-09-12 LTC's hardcoded 10 sat/vB rendered as "ESTIMATED".
    label: fee?.isFallback ? "Default" : tiers.length ? "Normal" : "Estimated",
    // `?.` on `normal` too: an estimate without it used to crash the modal.
    eta: fee?.normal?.eta,
    value: fee?.normal?.value,
  });
  if (fee?.fast)
    tiers.push({
      id: "fast",
      label: "Fast",
      eta: fee.fast.eta,
      value: fee.fast.value,
    });

  // Whether any tier can be priced as a total (per-byte rate + typical size).
  const showsTotals = tiers.some((t) => feeTotalFor(fee, t.value, usdPrice) != null);

  // USD price of the coin a quoted fee is charged in: ZEPH at `usdPrice`, a
  // Zephyr ecosystem asset at its oracle price, anything else unpriced. The
  // same rule prices a reviewed adapter's estimate, whose unit is that coin.
  const feeUsdPriceFor = (ticker: string | null | undefined): number | undefined =>
    ticker == null
      ? undefined
      : ticker === adapter.ticker
        ? usdPrice
        : ticker === sendTicker
          ? assetUsdPrice
          : undefined;
  const quotedFeeUsdPrice = feeUsdPriceFor(priced.quote?.feeTicker ?? null);

  // The primary button of a reviewed send: Review builds the transaction
  // once; with its build on screen it becomes Confirm, which relays exactly
  // that build. Without inputs worth building (`priced.inputs`), Review waits.
  const reviewedQuote = reviewed ? priced.quote : null;
  const reviewBlocked = reviewed && !reviewedQuote && (priced.pending || !priced.inputs);

  return (
    // The shared backdrop (2026-10-01): rendered into document.body, so the
    // portrait bottom nav no longer paints over this modal or stays clickable
    // behind it, and moving the window no longer closes it.
    <ModalBackdrop onClick={onClose}>
      <div className="modal-dialog send-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Send {sendTicker}</h3>
        {/* Which network's token this is (2026-10-06; operator request
            2026-10-01). A USD₮0 leg reads "USDT" with "USD₮0" as its note,
            so Optimism's bridged USDT and its USD₮0 open a "Send USDT" that
            only this line tells apart. Every token leg says its network. */}
        {legLabel && (
          <div
            data-send-leg
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              color: "var(--text-dim)",
              marginTop: -6,
              marginBottom: 10,
            }}
          >
            on {legLabel.network}
            {legLabel.note && (
              <span
                data-leg-note
                style={{
                  marginLeft: 6,
                  padding: "0 4px",
                  border: "1px solid var(--border-soft)",
                  fontSize: 9,
                  letterSpacing: 0.4,
                }}
              >
                {legLabel.note}
              </span>
            )}
          </div>
        )}
        <div className="form-group">
          <label>Recipient</label>
          <input
            type="text"
            placeholder={adapter.addressPlaceholder}
            value={sendTo}
            onChange={(e) => setSendTo(e.target.value)}
          />
        </div>
        {/* XRP only (2026-09-29): exchanges receive every customer's XRP at one
            address and credit the account by tag. Rendered only for adapters
            that declare `destinationTag`, so no other chain grows a field it
            would ignore. Digits only, refused above 32 bits — never truncated.
            Kept exactly as typed (2026-09-29 send-safety audit): the field
            used to strip non-digits, so a pasted "123-456" became tag 123456
            without a word; now it is shown and refused, and Send stays off. */}
        {adapter.destinationTag && (
          <div className="form-group" data-destination-tag>
            <label>{adapter.destinationTag.label}</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="optional"
              aria-label={adapter.destinationTag.label}
              value={tagRaw}
              onChange={(e) => setSendDestinationTag(e.target.value)}
            />
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 9,
                lineHeight: 1.5,
                color: tagError ? "var(--warn)" : "var(--text-dim)",
                marginTop: 4,
              }}
            >
              {tagError ?? adapter.destinationTag.hint}
            </div>
          </div>
        )}
        {/* Stellar only (2026-09-29 send-safety audit): the memo an exchange
            credits the deposit by. Rendered only for adapters that declare
            `memo`. The TYPE is the user's pick, never guessed from the text:
            MEMO_ID 123 and MEMO_TEXT "123" are different memos. Refused, never
            repaired, when malformed. */}
        {adapter.memo && (
          <div className="form-group" data-send-memo>
            <label>{adapter.memo.label}</label>
            <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              <div role="group" aria-label="Memo type" style={{ display: "flex", gap: 4 }}>
                {(["text", "id"] as const).map((t) => {
                  const active = memoField.type === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      data-memo-type={t}
                      aria-pressed={active}
                      onClick={() => setSendMemoType(t)}
                      style={{
                        padding: "0 8px",
                        background: active ? "rgba(242,242,242,0.9)" : "transparent",
                        border: `1px solid ${active ? "rgba(242,242,242,0.9)" : "rgba(255,255,255,0.18)"}`,
                        color: active ? "#0a0a0a" : "var(--text-dim)",
                        cursor: "pointer",
                        fontFamily: "var(--mono)",
                        fontSize: 9,
                        letterSpacing: 0.6,
                      }}
                    >
                      {t === "text" ? "TEXT" : "ID"}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                inputMode={memoField.type === "id" ? "numeric" : undefined}
                placeholder="optional"
                aria-label={adapter.memo.label}
                value={memoField.raw}
                onChange={(e) => setSendMemoText(e.target.value)}
                style={{ flex: "1 1 auto", minWidth: 0 }}
              />
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 9,
                lineHeight: 1.5,
                color: memoError ? "var(--warn)" : "var(--text-dim)",
                marginTop: 4,
              }}
            >
              {memoError ??
                (memoLooksLikeId
                  ? "This memo is a number. If the recipient asked for a memo ID (MEMO_ID), choose ID — a text memo with the same digits does not match it."
                  : adapter.memo.hint)}
            </div>
          </div>
        )}
        <div className="form-group">
          <label>Amount</label>
          <input
            type="text"
            placeholder="0.0"
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
          />
          {sendable && (
            <div
              data-sendable
              style={{
                fontFamily: "var(--mono)",
                fontSize: 9,
                color: "var(--text-dim)",
                marginTop: 4,
              }}
            >
              Spendable now: {sendable.unlocked} {sendTicker}
              {sendable.total !== sendable.unlocked
                ? ` of ${sendable.total} (the rest is still locked; received funds unlock after confirmations)`
                : ""}
            </div>
          )}
        </div>

        {amountUsdPrice != null && (
          <div className="form-group" data-usd-entry>
            <label>Amount in USD</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              aria-label="Amount in USD"
              value={usdShown}
              onChange={(e) => onUsdChange(e.target.value)}
            />
            {sendAmount && usdShown && (
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  color: "var(--text-dim)",
                  marginTop: 4,
                }}
              >
                You're sending {sendAmount} {sendTicker} (≈ ${usdShown}) at $
                {amountUsdPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} per{" "}
                {sendTicker}.
              </div>
            )}
          </div>
        )}

        <div className="form-group">
          <label>Network fee</label>
          {reviewed ? (
            <ReviewedFee
              priced={priced}
              estimate={fee}
              estimateFailed={feeError != null}
              networkTicker={adapter.ticker}
              sendTicker={sendTicker}
              feeUsdPriceFor={feeUsdPriceFor}
            />
          ) : quoteDriven ? (
            <QuotedFee
              priced={priced}
              networkTicker={adapter.ticker}
              sendTicker={sendTicker}
              feeUsdPrice={quotedFeeUsdPrice}
            />
          ) : (
          /* UXS-20260516-112: fee section used to render a silent "—"
              forever when the fee fetch quietly failed. Now: show
              "fetching…" only while we have no data, show an explicit
              error + Retry button when the fetch failed, and block Send
              (see `feeReady` below) when we have no usable fee value AND the
              chain needs one from us. Chains where the NETWORK sets the fee
              (`networkComputesFee`, e.g. Monero) are never blocked by a
              display failure — that conflation made XMR unsendable on
              2026-08-29. No more silent em-dashes. */
          feeLoading && !fee ? (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
              Fetching current network fee…
            </div>
          ) : feeError ? (
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                color: "var(--warn)",
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span style={{ flex: "1 1 auto" }}>
                {feeError}{" "}
                {feeIsAdvisory
                  ? `${adapter.ticker} fees are set by the network when the transaction is built, so this does not block sending.`
                  : "Send is disabled until a fee is available."}
              </span>
              <button
                type="button"
                onClick={() => void loadFee()}
                disabled={feeLoading}
                style={{
                  background: "transparent",
                  border: "1px solid rgba(255,170,0,0.4)",
                  color: "var(--warn)",
                  cursor: "pointer",
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  padding: "2px 8px",
                }}
              >
                {feeLoading ? "Retrying…" : "Retry"}
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {tiers.map((t) => {
                  const active = t.id === tier;
                  const total = feeTotalFor(fee, t.value, usdPrice);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      data-fee-tier={t.id}
                      onClick={() => setTier(t.id)}
                      style={{
                        flex: "1 1 0",
                        padding: "6px 8px",
                        background: active ? "rgba(242,242,242,0.9)" : "transparent",
                        border: `1px solid ${
                          active ? "rgba(242,242,242,0.9)" : "rgba(255,255,255,0.18)"
                        }`,
                        color: active ? "#0a0a0a" : "var(--text-dim)",
                        cursor: tiers.length > 1 ? "pointer" : "default",
                        fontFamily: "var(--mono)",
                        fontSize: 10,
                        lineHeight: 1.3,
                        textAlign: "left",
                      }}
                    >
                      <div style={{ fontSize: 9, letterSpacing: 0.6, opacity: 0.8 }}>
                        {t.label.toUpperCase()}
                      </div>
                      {total ? (
                        <>
                          {/* The money first — a rate alone prices nothing. */}
                          <div style={{ fontSize: 11 }} data-fee-total>
                            ≈ {total.coin}{" "}
                            <span style={{ fontSize: 9, opacity: 0.7 }}>{adapter.ticker}</span>
                          </div>
                          <div style={{ fontSize: 9, opacity: 0.75 }}>
                            {total.usd ? `${total.usd} · ` : ""}
                            {t.value} {fee?.unit}
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 11 }}>
                          {t.value ?? "—"}{" "}
                          <span style={{ fontSize: 9, opacity: 0.7 }}>{fee?.unit}</span>
                        </div>
                      )}
                      {t.eta && (
                        <div style={{ fontSize: 9, opacity: 0.6, marginTop: 1 }}>{t.eta}</div>
                      )}
                    </button>
                  );
                })}
              </div>
              {fee?.isFallback && (
                <div
                  data-fee-fallback
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--warn)",
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    flexWrap: "wrap",
                    marginTop: 6,
                  }}
                >
                  <span style={{ flex: "1 1 auto" }}>
                    Live {adapter.ticker} fee rates are unreachable right now, so this is the
                    wallet's built-in default rate — not a market estimate.
                  </span>
                  <button
                    type="button"
                    onClick={() => void loadFee()}
                    disabled={feeLoading}
                    style={{
                      background: "transparent",
                      border: "1px solid rgba(255,170,0,0.4)",
                      color: "var(--warn)",
                      cursor: "pointer",
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      padding: "2px 8px",
                    }}
                  >
                    {feeLoading ? "Retrying…" : "Retry"}
                  </button>
                </div>
              )}
              {showsTotals && (
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 9,
                    color: "var(--text-dim)",
                    marginTop: 6,
                    lineHeight: 1.4,
                  }}
                >
                  Totals are for a typical send (one input, two outputs). A send that combines
                  several of your coins is larger and costs proportionally more.
                </div>
              )}
            </>
          )
          )}
        </div>

        {/* A cost of THIS send beyond the fee, shown before Send whatever the
            verdict (2026-10-06; operator request 2026-10-01): NEAR's storage
            deposit when a NEP-141 send must register the recipient with the
            token contract, and the store an Aptos token send creates for a
            first-time recipient. The shortfall box below only appears when
            the balance cannot cover it, which is too late to learn the cost. */}
        <GasNotice notice={gas?.notice} />

        {/* The second balance. Rendered only when the adapter has told us the
            fee is paid in a different coin (`gasToken`), and only when the
            answer is a definite no — `sufficient: null` means the node would
            not estimate and the balance is non-zero, which is not grounds to
            stop anybody. */}
        {gas && gas.sufficient === false && (
          <div
            data-gas-shortfall
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              lineHeight: 1.6,
              color: "var(--warn)",
              border: "1px solid rgba(255,170,0,0.4)",
              background: "rgba(255,170,0,0.06)",
              padding: "8px 10px",
              marginBottom: 12,
            }}
          >
            {gas.includesAmount ? (
              // NATIVE send: the amount and the fee come out of one balance,
              // so the shortfall is about the total, and naming a second coin
              // would be nonsense ("you need ETH to send ETH").
              // `gas.note` (XRP, 2026-09-29) replaces the fee sentence when the
              // balance must also cover something else — XRP's account reserve,
              // which is 100,000× the fee and the real reason a send is short.
              <>
                {gas.required
                  ? `This send needs about ${gas.required} ${gas.ticker} in total${gas.note ? "" : " — the amount plus the network fee"}. This address has ${gas.available}.`
                  : gas.note
                    ? null
                    : `This address has no ${gas.ticker} on ${gas.chainName}, so it cannot cover the amount and the network fee.`}
                <div style={{ marginTop: gas.required || !gas.note ? 4 : 0, opacity: 0.85 }}>
                  {gas.note ??
                    `The fee comes out of the same balance as the amount, so sending the full balance always leaves it slightly short. Lower the amount by at least the fee shown above.`}
                </div>
              </>
            ) : (
              // ERC-20 send: the amount is drawn from the TOKEN balance and
              // only gas touches the native one, so the sentence is about a
              // different coin entirely — and must name which chain's.
              <>
                {gas.required
                  ? `You need about ${gas.required} ${gas.ticker} on ${gas.chainName} to send ${sendTicker}. This address has ${gas.available}.`
                  : `You need ${gas.ticker} on ${gas.chainName} to pay the network fee for a ${sendTicker} send. This address has none.`}
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  {`Fees on ${gas.chainName} are paid in ${gas.ticker}, not in ${sendTicker}. Add ${gas.ticker} to this address and the send will go through.`}
                </div>
              </>
            )}
          </div>
        )}

        <div className="button-row">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            // The selected tier reaches the signer (2026-09-12). Wrapped in an
            // arrow on purpose: `onClick={onSend}` would hand the MouseEvent to
            // `handleSend` as its fee-rate argument. Quote-driven adapters pass
            // the priced quote instead (2026-09-15); `useSend` relays it only if
            // it is still exactly this send. A reviewed send (2026-10-01): the
            // first press builds the transaction once (Review); with that build
            // on screen the press is Confirm and hands it to `useSend`, which
            // relays exactly it.
            onClick={() =>
              reviewed
                ? reviewedQuote
                  ? onSend(undefined, reviewedQuote)
                  : priced.request()
                : quoteDriven
                  ? onSend(undefined, priced.quote ?? undefined)
                  : onSend(feeRateForSend(fee, selectedTierFee ?? undefined))
            }
            data-send-step={reviewed ? (reviewedQuote ? "confirm" : "review") : undefined}
            // UXS-20260516-112 AC #3: block Send until we actually
            // have a fee number to charge against. Title attribute
            // gives keyboard / screen-reader users an explanation
            // when the button is greyed out.
            // Blocked on a DEFINITE shortfall only. `gas.sufficient === false`
            // is either a priced estimate the balance cannot cover, or a zero
            // balance (where no positive fee is payable whatever the limit).
            // `null` — unestimable, non-zero balance — deliberately does not
            // block: refusing a send on a guess is its own bug.
            disabled={
              sending ||
              !sendTo ||
              !sendAmount ||
              !feeReady ||
              gasShort ||
              quoteBlocks ||
              reviewBlocked ||
              !!tagError ||
              !!memoError
            }
            title={
              tagError
                ? tagError
                : memoError
                ? memoError
                : quoteBlocks
                ? priced.failure?.message
                : gasShort
                  ? gas?.includesAmount
                    ? `This address does not hold enough ${gas?.ticker ?? "funds"} to cover the amount plus the network fee.`
                    : `This address has no ${gas?.ticker ?? "gas"} on ${gas?.chainName ?? "this network"} to pay the fee with.`
                  : !feeReady
                    ? "Network fee isn't available yet — Send is disabled until the fee fetch succeeds."
                    : reviewed
                      ? reviewedQuote
                        ? "Broadcasts exactly the transaction whose fee is shown above."
                        : priced.pending
                          ? "Building the transaction to show its exact fee…"
                          : !priced.inputs
                            ? "Enter a recipient and an amount to review."
                            : "Builds this transaction once to show its exact fee. Nothing is sent until you confirm."
                      : undefined
            }
          >
            {sending
              ? "Sending…"
              : reviewed
                ? reviewedQuote
                  ? "► Confirm send"
                  : priced.pending
                    ? "Building…"
                    : "► Review"
                : "► Send"}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

/**
 * A cost of the send beyond its fee (`GasBudget.notice`), shown whatever the
 * verdict (2026-10-06). Exported so a test can render it: the modal reads
 * the budget in an effect, which a static render does not run.
 */
export function GasNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return (
    <div
      data-gas-notice
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        lineHeight: 1.6,
        color: "var(--text-muted)",
        border: "1px solid var(--border-soft)",
        padding: "8px 10px",
        marginBottom: 12,
      }}
    >
      {notice}
    </div>
  );
}

const quoteRetryStyle = {
  background: "transparent",
  border: "1px solid rgba(255,170,0,0.4)",
  color: "var(--warn)",
  cursor: "pointer",
  fontFamily: "var(--mono)",
  fontSize: 10,
  padding: "2px 8px",
} as const;

/**
 * The fee box for quote-driven adapters: the fee of the transaction that will
 * actually be sent, in the asset that pays it, never a tier.
 */
function QuotedFee({
  priced,
  networkTicker,
  sendTicker,
  feeUsdPrice,
}: {
  priced: ReturnType<typeof useSendQuote>;
  /** The adapter's own coin (ZEPH), for the "set by the network" wording. */
  networkTicker: string;
  sendTicker: string;
  feeUsdPrice?: number;
}) {
  const { inputs, quote, failure, pending, retry } = priced;
  const base = { fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.5 } as const;

  if (!inputs) {
    return (
      <div data-send-quote="idle" style={{ ...base, color: "var(--text-dim)" }}>
        Enter a recipient and an amount to see the exact fee for this send.
      </div>
    );
  }
  if (failure) {
    return (
      <div
        data-send-quote="error"
        data-send-quote-kind={failure.kind}
        style={{
          ...base,
          color: "var(--warn)",
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ flex: "1 1 auto" }}>
          {failure.message}{" "}
          {failure.definitive
            ? "Send is disabled until this is fixed."
            : `${networkTicker} fees are set by the network when the transaction is built, so this does not block sending.`}
        </span>
        {!failure.definitive && (
          <button type="button" onClick={retry} disabled={pending} style={quoteRetryStyle}>
            {pending ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>
    );
  }
  if (!quote) {
    return (
      <div data-send-quote="pending" style={{ ...base, color: "var(--text-dim)" }}>
        Pricing this send…
      </div>
    );
  }
  const usd = formatUsd(Number(quote.fee), feeUsdPrice);
  const note = feeNoteText(quote);
  return (
    <div data-send-quote="ready" style={base}>
      <div style={{ fontSize: 12 }} data-fee-total>
        {quote.fee}{" "}
        <span style={{ fontSize: 9, opacity: 0.75 }}>
          {quote.feeTicker ?? "(charged by the network)"}
        </span>
        {usd && <span style={{ fontSize: 9, opacity: 0.75 }}> · {usd}</span>}
      </div>
      {/* Whatever the adapter says about THIS fee (2026-09-15). Generic on
          purpose: Xelis is the first quote to carry one, for the one-off
          charge on a recipient account that is not on chain yet. */}
      {note && (
        <div data-fee-note style={{ fontSize: 10, color: "var(--text)", marginTop: 3 }}>
          {note}
        </div>
      )}
      <div style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 2 }}>
        {quote.feeTicker && quote.feeTicker !== networkTicker && quote.feeTicker === sendTicker
          ? `Paid in ${sendTicker}, the asset being sent, not in ${networkTicker}. `
          : ""}
        Exact fee of this transaction. Sent within 90 s it is broadcast as priced; after that it
        is rebuilt and the fee can differ slightly.{pending ? " Refreshing…" : ""}
      </div>
    </div>
  );
}

/**
 * The fee box for a reviewed send (Monero, Zephyr — operator request
 * 2026-10-01). Until the review: an ESTIMATE that builds nothing (the node's
 * fee rate × a typical send, `getFeeEstimate`), or "Fee shown at
 * confirmation." when the rate could not be read — never a guessed number,
 * never 0. After Review: the exact fee of the ONE transaction that was built,
 * which Confirm broadcasts as is.
 */
function ReviewedFee({
  priced,
  estimate,
  estimateFailed,
  networkTicker,
  sendTicker,
  feeUsdPriceFor,
}: {
  priced: ReturnType<typeof useSendQuote>;
  estimate: FeeEstimate | null;
  /** The last read of the rate failed (`getFeeEstimate` threw). */
  estimateFailed: boolean;
  /** The adapter's own coin (XMR, ZEPH). */
  networkTicker: string;
  sendTicker: string;
  feeUsdPriceFor: (ticker: string | null | undefined) => number | undefined;
}) {
  const { quote, failure, pending, retry } = priced;
  const base = { fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.5 } as const;
  const dim = { fontSize: 9, color: "var(--text-dim)", marginTop: 2 } as const;
  // A fee charged in the asset being sent, not in the adapter's own coin.
  const paidIn = (ticker: string | null | undefined) =>
    ticker && ticker !== networkTicker && ticker === sendTicker
      ? `Paid in ${sendTicker}, the asset being sent, not in ${networkTicker}. `
      : "";

  if (quote) {
    const usd = formatUsd(Number(quote.fee), feeUsdPriceFor(quote.feeTicker));
    return (
      <div data-send-quote="ready" style={base}>
        <div style={{ fontSize: 12 }} data-fee-total>
          {quote.fee}{" "}
          <span style={{ fontSize: 9, opacity: 0.75 }}>
            {quote.feeTicker ?? "(charged by the network)"}
          </span>
          {usd && <span style={{ fontSize: 9, opacity: 0.75 }}> · {usd}</span>}
        </div>
        <div style={dim}>
          {paidIn(quote.feeTicker)}
          Exact fee of the transaction Confirm broadcasts, built once for this recipient and amount.
          Change either and it is built again only when you review again.
        </div>
      </div>
    );
  }

  const usual = estimate?.normal?.value;
  const busy = estimate?.fast?.value;
  const usd = usual != null ? formatUsd(Number(usual), feeUsdPriceFor(estimate?.unit)) : null;
  return (
    <div data-send-quote={failure ? "error" : pending ? "pending" : "estimate"} style={base}>
      {usual != null && estimate ? (
        <>
          <div style={{ fontSize: 12 }} data-fee-estimate>
            ≈ {usual} <span style={{ fontSize: 9, opacity: 0.75 }}>{estimate.unit} estimated</span>
            {usd && <span style={{ fontSize: 9, opacity: 0.75 }}> · {usd}</span>}
          </div>
          <div style={dim}>
            {paidIn(estimate.unit)}A typical send
            {estimate.typicalShape ? ` (${estimate.typicalShape})` : ""} at the network's current fee
            rate{busy != null ? `; about ${busy} ${estimate.unit} when the network is busy` : ""}. One that
            combines more of your coins costs more. Review builds this send once and shows its exact fee
            before anything is broadcast.
          </div>
        </>
      ) : estimateFailed ? (
        <div data-fee-estimate="none" style={{ color: "var(--text-dim)" }}>
          Fee shown at confirmation.
          <div style={dim}>
            The network's current fee rate could not be read, so there is no estimate. Review builds this
            send once and shows its exact fee before anything is broadcast.
          </div>
        </div>
      ) : (
        // Not read yet (the first paint, before the fetch starts, included).
        <div data-fee-estimate="reading" style={{ color: "var(--text-dim)" }}>
          Reading the network's current fee rate…
        </div>
      )}
      {pending && (
        <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
          Building the transaction to show its exact fee…
        </div>
      )}
      {failure && (
        <div
          data-send-quote-kind={failure.kind}
          style={{
            marginTop: 6,
            color: "var(--warn)",
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ flex: "1 1 auto" }}>
            {failure.message}{" "}
            {failure.definitive
              ? "Change the send, then review it again."
              : "Nothing was sent; you can review it again."}
          </span>
          {!failure.definitive && (
            <button type="button" onClick={retry} disabled={pending} style={quoteRetryStyle}>
              {pending ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Send modal for the asset the send flow is on, as BOTH layouts mount it.
 *
 * Reads the asset from `sendAssetStore`, the same value `useSend` sends with,
 * and derives the label and the asset's oracle price from it. Portrait used to
 * mount `SendModal` with no asset at all, so a ZEPHUSD send would have been
 * titled "Send ZEPH"; landscape computed its own label. One wrapper, one
 * derivation (2026-09-15).
 */
export function ActiveSendModal({
  zphStats,
  ...props
}: Omit<SendModalProps, "assetType" | "assetLabel" | "assetUsdPrice"> & {
  /** Zephyr oracle prices, for a fee charged in ZEPHUSD/ZEPHRSV/ZEPHYRS. */
  zphStats?: ZphLiveStats | null;
}) {
  const assetType = useSendAssetType();
  return (
    <SendModal
      {...props}
      assetType={assetType}
      assetUsdPrice={sendAssetUsdPrice(props.adapter.chain, assetType, zphStats)}
    />
  );
}
