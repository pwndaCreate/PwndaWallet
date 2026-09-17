/**
 * The banner text for a failed send.
 *
 * 2026-09-15: `useSend` built this as `"Transaction failed: " + e.message`.
 * Tauri rejects `invoke` with a plain string for Rust `Result<_, String>`
 * errors, and every wallet-rpc passthrough is one, so a Zephyr or Monero send
 * failure rendered as "Transaction failed: undefined". See `lib/errorText.ts`.
 */
import { errorText } from "../../lib/errorText";

export function sendFailureText(e: unknown): string {
  return "Transaction failed: " + errorText(e, "the wallet returned no error message.");
}
