/**
 * The human-readable text of a caught value, whatever shape it arrived in.
 *
 * # Why this exists (2026-09-15)
 *
 * Tauri's `invoke` rejects with a plain STRING when the Rust command returns
 * `Result<_, String>`, and every wallet-rpc passthrough (`zph_rpc_call`,
 * `xmr_rpc_call`, ...) does: `wallet_rpc_common.rs` formats a JSON-RPC error
 * as `RPC error <code>: <message>`. Code written for `Error` objects then reads
 * `.message` off a string and gets `undefined`:
 *
 *   - `useSend.ts` rendered `"Transaction failed: " + e.message`, so a sidecar
 *     send failure displayed as `Transaction failed: undefined`;
 *   - `zph-wallet.ts`'s validate_address catch called `e.message.startsWith`,
 *     which throws a TypeError from inside the catch and replaces the real RPC
 *     error with `Cannot read properties of undefined (reading 'startsWith')`.
 *
 * The inline `typeof e === "string" ? e : e.message` idiom is written out about
 * a dozen times across the app. This is that idiom once, with the remaining
 * shapes (null, plain objects carrying a `message`, anything else) handled
 * instead of crashing or printing `[object Object]`.
 */
export function errorText(e: unknown, fallback = "Unknown error"): string {
  if (typeof e === "string") return e.trim() === "" ? fallback : e;
  if (e instanceof Error) return e.message.trim() === "" ? fallback : e.message;
  if (e != null && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim() !== "") return m;
    return fallback;
  }
  if (e == null) return fallback;
  const s = String(e);
  return s.trim() === "" || s === "[object Object]" ? fallback : s;
}
