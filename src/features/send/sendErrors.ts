/**
 * The banner text for a failed send.
 *
 * 2026-09-15: `useSend` built this as `"Transaction failed: " + e.message`.
 * Tauri rejects `invoke` with a plain string for Rust `Result<_, String>`
 * errors, and every wallet-rpc passthrough is one, so a Zephyr or Monero send
 * failure rendered as "Transaction failed: undefined". See `lib/errorText.ts`.
 */
import { errorText } from "../../lib/errorText";
import type { SendOutcomeUnknownError } from "../../wallets/send-outcome";
import type { TxResult } from "../../wallets";

export function sendFailureText(e: unknown): string {
  return "Transaction failed: " + errorText(e, "the wallet returned no error message.");
}

/**
 * The banner for a send that MAY have gone out (2026-09-29). Never "failed",
 * never "try again": a second press would sign a new transaction and, if the
 * first one lands, pay twice. See `wallets/send-outcome.ts`.
 */
export function sendOutcomeUnknownText(e: SendOutcomeUnknownError): string {
  const detail = errorText(e, "");
  return (
    "Not confirmed: this transaction may have been sent. " +
    (e.hash ? `Hash: ${e.hash}. ` : "") +
    "Check Activity or a block explorer before sending again." +
    (detail ? ` (${detail})` : "")
  );
}

/** The success banner: "sent" only once the wallet has seen it confirmed. */
export function sendSuccessText(r: TxResult): string {
  return r.pending
    ? `Transaction submitted, not confirmed yet. Hash: ${r.hash}`
    : `Transaction sent! Hash: ${r.hash}`;
}
