/**
 * A send that MAY have reached the network (2026-09-29).
 *
 * # Why this exists
 *
 * The 2026-09-29 send-safety audit found the same double-send on six chains
 * (EVM, Solana, Monero, XRP, Stellar, Aptos): the transaction was accepted by
 * a node, something failed AFTER that (a receipt poll, a timeout, a dropped
 * connection, an ambiguous RPC error), and the adapter reported it as
 * "Transaction failed" with the Send form still filled in. One more press
 * built and signed a NEW transaction — a new nonce, a new blockhash, new
 * inputs — so if the first one landed, the user paid twice.
 *
 * An adapter throws this instead of an ordinary error once a transaction
 * could have been broadcast and its outcome is not known. It is not a
 * failure, so the UI never says "failed" or "try again" for it: `useSend`
 * closes the form (the same press cannot be repeated) and tells the user to
 * check the hash first.
 *
 * Throw an ordinary `Error` for anything decided BEFORE broadcast (invalid
 * recipient, insufficient funds, a node refusing the transaction outright):
 * those are real failures, and retrying them is safe.
 */
export class SendOutcomeUnknownError extends Error {
  /** The transaction id, when it is known — so the user can look it up. */
  readonly hash?: string;

  constructor(message: string, hash?: string) {
    super(message);
    this.name = "SendOutcomeUnknownError";
    this.hash = hash;
  }
}

/**
 * True for a {@link SendOutcomeUnknownError}, including one that crossed a
 * module or realm boundary (checked by name as well as by class).
 */
export function isSendOutcomeUnknown(e: unknown): e is SendOutcomeUnknownError {
  return (
    e instanceof SendOutcomeUnknownError ||
    (typeof e === "object" &&
      e !== null &&
      (e as { name?: unknown }).name === "SendOutcomeUnknownError")
  );
}
