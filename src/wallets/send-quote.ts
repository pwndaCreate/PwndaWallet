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
 *
 * # Built once, on review (operator request, 2026-10-01)
 *
 * The Send modal priced a Zephyr send 600 ms after every edit and again every
 * 60 s, and each price was a build: the wallet asks the node for the coins it
 * spends with a fresh set of decoys, so a node seeing several builds of one
 * spend sees the real coin in all of them while the decoys change. Where a
 * quote builds the spend (`ChainAdapter.quoteBuildsSpend`: Monero, Zephyr) the
 * modal now shows an estimate that builds nothing (`cryptonote-fee.ts`), builds
 * once when the user presses Review, and Confirm relays that build
 * ({@link routeQuotedSend}).
 */
import type { ChainAdapter, SendQuote, SendQuoteErrorKind } from "./types";

/**
 * A quote older than this is rebuilt, not relayed — for adapters whose quote is
 * NOT the reviewed spend (Xelis prices with `estimate_fees` and always builds at
 * send). Corrected 2026-10-01: this said Zephyr's pricing record moves once per
 * block and the swap modal used the same window. A Zephyr same-asset send has no
 * pricing record (only conversions do, valid for 10 blocks), a reviewed Monero
 * or Zephyr send is relayed whatever its age ({@link routeQuotedSend}), and the
 * conversion modal has its own window (`ZPH_CONVERSION_MAX_AGE_MS`).
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

/** What `useSend` does with the quote the Send modal handed it. */
export type QuotedSendRoute =
  /** Broadcast the quote's transaction (`sendQuoted`). */
  | { kind: "relay"; quote: SendQuote }
  /** Build and send in one go (`sendTransaction`), as before quotes existed. */
  | { kind: "build" }
  /** Send nothing: the message says why. */
  | { kind: "refuse"; message: string };

/**
 * Relay the quote, build fresh, or refuse (2026-10-01).
 *
 * For most adapters a quote is relayed only while it is exactly this send and
 * under {@link SEND_QUOTE_MAX_AGE_MS}; otherwise the adapter builds the send
 * fresh. Where the quote IS the reviewed spend (`quoteBuildsSpend`: Monero,
 * Zephyr), the reviewed build is relayed whatever its age — a same-asset send
 * does not expire — and a send that was not reviewed, or was changed after its
 * review, is REFUSED: building and broadcasting it in one step would relay a
 * transaction, and a fee, the user never saw, and build the same spend a
 * second time.
 */
export function routeQuotedSend(
  adapter: Pick<ChainAdapter, "sendQuoted" | "quoteBuildsSpend">,
  quote: unknown,
  send: { to: string; amount: string; assetType?: string },
  now: number,
): QuotedSendRoute {
  const reviewed = adapter.quoteBuildsSpend === true;
  const maxAgeMs = reviewed ? Number.POSITIVE_INFINITY : SEND_QUOTE_MAX_AGE_MS;
  if (adapter.sendQuoted && quoteMatchesSend(quote, send, now, maxAgeMs)) {
    return { kind: "relay", quote };
  }
  if (reviewed) {
    return {
      kind: "refuse",
      message:
        "This send was not reviewed, or it changed after its review, so nothing was broadcast. " +
        "Review it to see its exact fee, then confirm. Nothing was sent.",
    };
  }
  return { kind: "build" };
}
