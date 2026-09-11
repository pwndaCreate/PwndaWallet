import { useCallback, useEffect, useState } from "react";
import type { ChainAdapter, FeeEstimate, GasBudget } from "../../wallets/types";

type Tier = "slow" | "normal" | "fast";

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
}: {
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

  const loadGas = useCallback(async () => {
    if (!adapter.getGasBudget || !fromAddress) return;
    try {
      // `to`/`amount` are passed when present so the estimate is of the REAL
      // transfer; without them the adapter falls back to a per-chain gas
      // limit and can still settle the zero-balance case.
      const r = await adapter.getGasBudget(fromAddress, {
        to: sendTo || undefined,
        amount: sendAmount || undefined,
      });
      setGas(r);
    } catch (e) {
      // The adapter is documented not to throw; if a future one does, a
      // missing warning must not take the modal down with it.
      console.warn("[SendModal] gas budget failed:", e);
      setGas(null);
    }
  }, [adapter, fromAddress, sendTo, sendAmount]);

  useEffect(() => {
    void loadGas();
  }, [loadGas]);

  /** A definite "cannot pay the fee". Never true on an unestimable answer. */
  const gasShort = gas?.sufficient === false;


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
              <>
                {gas.required
                  ? `This send needs about ${gas.required} ${gas.ticker} in total — the amount plus the network fee. This address has ${gas.available}.`
                  : `This address has no ${gas.ticker} on ${gas.chainName}, so it cannot cover the amount and the network fee.`}
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  {`The fee comes out of the same balance as the amount, so sending the full balance always leaves it slightly short. Lower the amount by at least the fee shown above.`}
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
            onClick={onSend}
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
              sending || !sendTo || !sendAmount || !feeReady || gasShort
            }
            title={
              gasShort
                ? gas?.includesAmount
                  ? `This address does not hold enough ${gas?.ticker ?? "funds"} to cover the amount plus the network fee.`
                  : `This address has no ${gas?.ticker ?? "gas"} on ${gas?.chainName ?? "this network"} to pay the fee with.`
                : !feeReady
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
