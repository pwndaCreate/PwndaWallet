/**
 * Best-effort extractors for the actual delivered amount from a terminal
 * status response. Drives the drift-tracking columns in the swap history
 * (`SwapHistoryEntry.actualReceived`) — see `swap-history-store.ts`.
 *
 * Both `IntentsStatusResponse` and `SwapKitTrackResponse` are typed as
 * `{ status, [k: string]: unknown }` because the proxy passes through
 * upstream shapes the wallet doesn't otherwise care about. The actual
 * amount lives in different places per provider, and the shape isn't
 * locked in proxy-types. These extractors hunt the common locations
 * defensively and return `undefined` when the field isn't present, so
 * a future upstream shape change degrades gracefully (no drift chip
 * instead of crashed status poll).
 *
 * Decimals handling: the response amounts are atomic units (wei / sat /
 * lamport / atto-ADA, etc.). The history UI formats with the
 * destination asset's `decimals` field from `ASSET_CAPABILITIES` —
 * these extractors only return the raw atomic-decimal string, NOT a
 * display value. Conversion at render time keeps the schema canonical.
 */

import type { IntentsStatusResponse, SwapKitTrackResponse } from "../../lib/proxy-types";
import { ASSET_CAPABILITIES } from "./asset-capabilities";

/** Convert an atomic-units string to a display-units string given
 *  the destination asset ticker. Returns null when the ticker or
 *  the input string is unparseable. */
export function formatActualReceived(
  atomicString: string | undefined,
  toAsset: string
): string | null {
  if (!atomicString) return null;
  const cap = ASSET_CAPABILITIES[toAsset.toUpperCase()];
  if (!cap) return null;
  const trimmed = atomicString.trim();
  // Accept either "12345" or "12345.0" — drop any fractional tail that
  // sneaks in from a server-side float-format quirk. Atomic units are
  // integers by definition.
  const intPart = trimmed.split(".")[0];
  if (!/^\d+$/.test(intPart)) return null;
  let value: bigint;
  try {
    value = BigInt(intPart);
  } catch {
    return null;
  }
  const decimals = cap.decimals;
  if (decimals === 0) return value.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = value % divisor;
  // Render fraction with leading zeros to `decimals` width, then trim
  // trailing zeros for visual density.
  const fracPadded = frac.toString().padStart(decimals, "0");
  const fracTrimmed = fracPadded.replace(/0+$/, "");
  return fracTrimmed.length === 0 ? whole.toString() : `${whole}.${fracTrimmed}`;
}

/**
 * Pull the actual delivered atomic-units amount from a NEAR Intents
 * terminal status response. The 1Click `/api/intents/status/{depositAddress}`
 * SUCCESS shape includes `swap.amountOut` (the canonical executed amount)
 * with a `swap.amountOutFormatted` display-units backup. Order of fallback:
 *
 *   resp.swap.amountOut       → most reliable, atomic units
 *   resp.amountOut            → some response variants flatten this
 *   resp.quote.amountOut      → very old responses echo the quote here
 *
 * Returns `undefined` when none of those are present. Drift indicator
 * just hides; everything else still renders.
 */
export function extractActualReceivedFromIntents(
  resp: IntentsStatusResponse | undefined
): string | undefined {
  if (!resp || typeof resp !== "object") return undefined;
  const swap = (resp as { swap?: { amountOut?: unknown } }).swap;
  const direct = (resp as { amountOut?: unknown }).amountOut;
  const inQuote = (resp as { quote?: { amountOut?: unknown } }).quote?.amountOut;
  const candidates = [swap?.amountOut, direct, inQuote];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
    if (typeof c === "number" && Number.isFinite(c)) return c.toString();
  }
  return undefined;
}

/**
 * Pull the actual delivered atomic-units amount from a SwapKit /track
 * terminal response. SwapKit's track shape varies by provider (the
 * `legs` array is per-protocol) — common locations:
 *
 *   resp.legs[last].amount    → destination-leg amount on most providers
 *   resp.amountOut            → newer aggregated field
 *   resp.expectedBuyAmount    → fallback; matches the quote, NOT the
 *                              actual settled amount (so drift always
 *                              reads zero) — used only when nothing
 *                              else is available, marked in the
 *                              comment so future readers know the limit
 *
 * Returns `undefined` for shapes that don't expose any of these. The
 * spec for #22 explicitly defers SwapKit accuracy: "investigate but
 * defer if it doesn't". So the wallet captures what's available and
 * the History UI hides the drift indicator when undefined.
 */
export function extractActualReceivedFromSwapKit(
  resp: SwapKitTrackResponse | undefined
): string | undefined {
  if (!resp || typeof resp !== "object") return undefined;
  const direct = (resp as { amountOut?: unknown }).amountOut;
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct.toString();
  const legs = (resp as { legs?: unknown[] }).legs;
  if (Array.isArray(legs) && legs.length > 0) {
    const last = legs[legs.length - 1];
    if (last && typeof last === "object") {
      const amt = (last as { amount?: unknown }).amount;
      if (typeof amt === "string" && amt.length > 0) return amt;
      if (typeof amt === "number" && Number.isFinite(amt)) return amt.toString();
    }
  }
  // Last-ditch fallback: NOT a real actual amount — this is the
  // quote-time expectation echoed back. Returning it makes drift
  // calculation read zero, which is misleading. Returning undefined
  // is more honest. Comment kept so a future "but the field is right
  // there!" PR understands why.
  return undefined;
}
