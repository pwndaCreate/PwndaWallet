/**
 * Pure formatting for the wallet-surface "swap node" sub-line (C0.1).
 *
 * Split out of `SwapBalanceSubline.tsx` so it runs under the node-env vitest
 * pool with no JSX transform — the decision this file encodes ("is there
 * anything to show at all?") is the one that can go wrong invisibly, so it is
 * the part that needs tests.
 *
 * # Why the string is never turned into a number
 *
 * Engine amounts are decimal STRINGS and stay strings across the boundary
 * (frozen interface contract § 0.3 — "never `+amount`, never `String(n)`").
 * A `parseFloat` round-trip would be a silent precision edit on a balance the
 * user is about to compare against their wallet, and `parseFloat` also
 * cheerfully accepts `"1e5"`, `"0x10"`, `"12abc"` and `"Infinity"` — none of
 * which are amounts. So zero-ness is decided on the digits themselves and the
 * displayed text is a substring of what the engine sent.
 */

/**
 * True when `raw` is a well-formed non-negative decimal amount that is
 * strictly greater than zero.
 *
 * Deliberately strict: leading `+`/`-`, exponents, hex, whitespace inside the
 * number and any trailing junk are all rejected rather than coerced. A
 * malformed amount renders nothing, which is the honest outcome — the
 * alternative is showing a number nobody can trace to a balance.
 */
export function isPositiveAmount(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return false;
  // Well-formed AND non-zero: "0", "0.0", "0.000" all have no significant
  // digit and must not draw a sub-line.
  return /[1-9]/.test(s);
}

/**
 * Drop insignificant trailing zeros without touching the significant digits.
 * `"0.04210000"` → `"0.0421"`, `"1.000"` → `"1"`, `"100"` → `"100"`.
 *
 * Assumes `isPositiveAmount(raw)` — callers go through `swapBalanceLabel`.
 */
export function trimAmount(raw: string): string {
  const s = raw.trim();
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The sub-line's text, or `null` when the row must render nothing.
 *
 * `null` is the answer for: sidecar off (caller passes `undefined`), a coin
 * the node does not hold, a zero balance, and any malformed amount. A user
 * who does not swap therefore sees no change at all on the wallet surface —
 * that is the requirement, not a nicety.
 */
export function swapBalanceLabel(
  raw: string | null | undefined,
  ticker: string,
): string | null {
  if (!isPositiveAmount(raw)) return null;
  return `${trimAmount(raw as string)} ${ticker.toUpperCase()}`;
}
