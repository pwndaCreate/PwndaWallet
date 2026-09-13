/**
 * Typing an amount in USD instead of in the coin — the Send modal's and the
 * Swap form's "$" field (2026-09-12, operator request, modelled on Exodus,
 * which offers a USD entry on both).
 *
 * Pure and dependency-free so both features share one tested conversion:
 * `src/lib` is importable from any feature (CLAUDE.md layout note).
 *
 * # Rounding: DOWN, to a precision every adapter accepts
 *
 * No adapter or coin table records a coin's decimal places, and several send
 * paths refuse excess precision outright (`decimalToAtomic`: "This asset has 6
 * decimal places; … Round it rather than letting the wallet drop digits.").
 * $10 of XRP at $0.51234 is 19.518287… XRP — sent verbatim that throws. So a
 * USD entry resolves to at most `usdEntryDecimals(ticker)` places, rounded
 * DOWN: the user never sends more value than the dollar figure they typed.
 */

/** Tickers whose chains carry fewer than 8 decimal places. */
const SIX_DECIMALS = new Set(["XRP", "ADA", "ALGO", "TRX", "USDT", "USDC", "USDT0", "PYUSD", "DAI"]);
const SEVEN_DECIMALS = new Set(["XLM"]);

/** Decimal places a USD-derived amount is rounded (down) to. 8 unless the
 *  coin is known to carry fewer — 8 is also the most a person reads. */
export function usdEntryDecimals(ticker: string): number {
  const t = ticker.trim().toUpperCase();
  if (SIX_DECIMALS.has(t)) return 6;
  if (SEVEN_DECIMALS.has(t)) return 7;
  return 8;
}

function parseUsd(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^\d*\.?\d*$/.test(cleaned) || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The coin amount for a typed USD value, as a plain decimal string.
 *
 * - `""` for an empty field (clearing USD clears the amount);
 * - `null` when the text is not a number or there is no usable price — the
 *   caller keeps the typed text and leaves the coin amount alone.
 */
export function coinAmountFromUsd(
  usdText: string,
  price: number | undefined,
  ticker: string,
): string | null {
  if (usdText.trim() === "") return "";
  const usd = parseUsd(usdText);
  if (usd == null || price == null || !Number.isFinite(price) || price <= 0) return null;
  const d = usdEntryDecimals(ticker);
  const scale = 10 ** d;
  // The epsilon absorbs binary-float error so an exact quotient is not floored
  // one unit short (0.29 * 1e8 === 28999999.999999996).
  const units = Math.floor((usd / price) * scale + 1e-6);
  return (units / scale).toFixed(d).replace(/\.?0+$/, "") || "0";
}

/** The USD value of a coin amount, 2 decimals, or `""` when either side is
 *  unusable (nothing typed, no price). */
export function usdTextFromCoin(amountText: string, price: number | undefined): string {
  const n = Number(amountText.trim());
  if (amountText.trim() === "" || !Number.isFinite(n) || n <= 0) return "";
  if (price == null || !Number.isFinite(price) || price <= 0) return "";
  return (n * price).toFixed(2);
}
