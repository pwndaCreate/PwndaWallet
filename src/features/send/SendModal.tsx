import { useCallback, useEffect, useState } from "react";
import type { ChainAdapter, FeeEstimate } from "../../wallets/types";

type Tier = "slow" | "normal" | "fast";

export function SendModal({
  adapter,
  sendTo,
  setSendTo,
  sendAmount,
  setSendAmount,
  sending,
  onSend,
  onClose,
  assetLabel,
}: {
  adapter: ChainAdapter;
  sendTo: string;
  setSendTo: (v: string) => void;
  sendAmount: string;
  setSendAmount: (v: string) => void;
  sending: boolean;
  onSend: () => void;
  onClose: () => void;
  /** Overrides the asset shown in the title/amount unit. Used when sending a
   *  Zephyr ecosystem asset (ZEPHUSD/ZEPHRSV/ZEPHYRS) where the adapter ticker
   *  (ZEPH) would otherwise mislabel the send. Defaults to `adapter.ticker`. */
  assetLabel?: string;
}) {
  const sendTicker = assetLabel ?? adapter.ticker;
  const [fee, setFee] = useState<FeeEstimate | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [tier, setTier] = useState<Tier>("normal");

  // Fetch fee estimate on mount and refresh every 30 s while open. Adapters
  // throw `not initialized` for sidecar chains until the wallet is open;
  // we surface that as a one-line note rather than a hard error.
  const loadFee = useCallback(async () => {
    setFeeLoading(true);
    try {
      const r = await adapter.getFeeEstimate();
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
  }, [adapter]);

  useEffect(() => {
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
  }, [loadFee]);

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
   */
  const feeIsAdvisory = adapter.networkComputesFee === true;
  const feeReady = feeIsAdvisory || (!!selectedTierFee && selectedTierFee !== "—");

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
    label: tiers.length ? "Normal" : "Estimated",
    eta: fee?.normal.eta,
    value: fee?.normal.value,
  });
  if (fee?.fast)
    tiers.push({
      id: "fast",
      label: "Fast",
      eta: fee.fast.eta,
      value: fee.fast.value,
    });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog send-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Send {sendTicker}</h3>
        <div className="form-group">
          <label>Recipient</label>
          <input
            type="text"
            placeholder={adapter.addressPlaceholder}
            value={sendTo}
            onChange={(e) => setSendTo(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Amount</label>
          <input
            type="text"
            placeholder="0.0"
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Network fee</label>
          {/* UXS-20260516-112: fee section used to render a silent "—"
              forever when the fee fetch quietly failed. Now: show
              "fetching…" only while we have no data, show an explicit
              error + Retry button when the fetch failed, and block Send
              (see `feeReady` below) when we have no usable fee value AND the
              chain needs one from us. Chains where the NETWORK sets the fee
              (`networkComputesFee`, e.g. Monero) are never blocked by a
              display failure — that conflation made XMR unsendable on
              2026-08-29. No more silent em-dashes. */}
          {feeLoading && !fee ? (
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
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {tiers.map((t) => {
                const active = t.id === tier;
                return (
                  <button
                    key={t.id}
                    type="button"
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
                    <div style={{ fontSize: 11 }}>
                      {t.value ?? "—"}{" "}
                      <span style={{ fontSize: 9, opacity: 0.7 }}>{fee?.unit}</span>
                    </div>
                    {t.eta && (
                      <div style={{ fontSize: 9, opacity: 0.6, marginTop: 1 }}>{t.eta}</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="button-row">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={onSend}
            // UXS-20260516-112 AC #3: block Send until we actually
            // have a fee number to charge against. Title attribute
            // gives keyboard / screen-reader users an explanation
            // when the button is greyed out.
            disabled={sending || !sendTo || !sendAmount || !feeReady}
            title={
              !feeReady
                ? "Network fee isn't available yet — Send is disabled until the fee fetch succeeds."
                : undefined
            }
          >
            {sending ? "Sending…" : "► Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
