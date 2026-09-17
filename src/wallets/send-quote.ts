/**
 * A priced send: the network fee for ONE specific transfer, found by building
 * that transfer without broadcasting it.
 *
 * # Why (2026-09-15)
 *
 * Zephyr's Send modal never showed a fee. `zphAdapter.getFeeEstimate` asked
 * zephyr-wallet-rpc for `get_fee_estimate`, a DAEMON method the wallet-rpc does
 * not have, so every attempt ended in `RPC error -32601: Method not found`. On
 * the Monero family the wallet sets the fee itself, from the priority and the
 * weight of the transaction it builds, so the only exact answer is to build it:
 * `transfer` with `do_not_relay: true, get_tx_metadata: true` returns the fee
 * and a signed blob that `relay_tx` broadcasts unchanged. The Zephyr swap modal
 * has priced conversions that way since 2026-04-26.
 *
 * Nothing here names a chain. An adapter opts in by implementing
 * `ChainAdapter.quoteSend` (+ `sendQuoted`) and throwing `SendQuoteError` with
 * a kind the modal can act on.
 */
import type { SendQuote, SendQuoteErrorKind } from "./types";

/**
 * A quote older than this is rebuilt, not relayed. Zephyr's pricing record and
 * the chain tip move once per block (about 120 s); the swap modal uses the same
 * staleness window.
 */
export const SEND_QUOTE_MAX_AGE_MS = 90_000;

export class SendQuoteError extends Error {
  readonly kind: SendQuoteErrorKind;
  constructor(kind: SendQuoteErrorKind, message: string) {
    super(message);
    this.name = "SendQuoteError";
    this.kind = kind;
  }
}

/** The kind of a quote failure; anything that is not a `SendQuoteError` is "other". */
export function quoteErrorKind(e: unknown): SendQuoteErrorKind {
  return e instanceof SendQuoteError ? e.kind : "other";
}

/**
 * Should this quote failure refuse the Send button?
 *
 * Two answers are definitive: the wallet cannot fund amount + fee from unlocked
 * outputs, or the recipient is not a valid address for this network. Both fail
 * identically at broadcast whatever the fee. Everything else (a wallet still
 * syncing, a node timing out, an RPC error nobody classified) stays advisory:
 * the network sets the fee, and failing to price a send does not prove the
 * send will fail.
 */
export function isDefinitiveQuoteError(e: unknown): boolean {
  const k = quoteErrorKind(e);
  return k === "insufficient-funds" || k === "invalid-address";
}

/**
 * Does `quote` price exactly the send about to be made, recently enough to
 * broadcast its transaction as-is? When this is false the adapter builds a
 * fresh transaction instead; a quote is never relayed for different inputs.
 *
 * Takes `unknown` because `useSend.handleSend` receives whatever the caller
 * passes, and a click event must never be mistaken for a quote (the same trap
 * as `feeRate`, documented in `useSend.ts`).
 */
export function quoteMatchesSend(
  quote: unknown,
  send: { to: string; amount: string; assetType?: string },
  now: number,
  maxAgeMs: number = SEND_QUOTE_MAX_AGE_MS,
): quote is SendQuote {
  if (quote == null || typeof quote !== "object") return false;
  const q = quote as Partial<SendQuote>;
  if (typeof q.to !== "string" || typeof q.amount !== "string") return false;
  if (typeof q.quotedAt !== "number" || !Number.isFinite(q.quotedAt)) return false;
  if (q.ticket == null) return false;
  if (q.to !== send.to.trim() || q.amount !== send.amount.trim()) return false;
  if ((q.assetType ?? undefined) !== (send.assetType ?? undefined)) return false;
  const age = now - q.quotedAt;
  return age >= 0 && age < maxAgeMs;
}
