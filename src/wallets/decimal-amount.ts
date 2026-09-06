/**
 * Decimal amount → atomic units. One implementation, because there were seven and
 * three of them silently sent the wrong amount.
 *
 * # The bug this exists to close
 *
 * Found 2026-09-02 by a unit test written for the new Algorand encoder:
 * `algoToMicro("1.2.3")` returned `1_200_000` instead of throwing. The shape was
 *
 * ```ts
 * const [whole, frac = ""] = amount.trim().split(".");
 * ```
 *
 * `"1.2.3".split(".")` is `["1","2","3"]`; destructuring takes the first two and
 * **discards the rest**. Validating `whole` and `frac` individually — which the newer
 * call sites did — does not help, because both fragments are valid digits. The user
 * asked to send 1.2.3 (a typo, or a paste of a version string) and the wallet sent
 * 1.2 of something without a word.
 *
 * A sweep found the same shape in seven places. `erg-wallet.ts` and
 * `spl-token-wallet.ts` were safe by accident: they test the WHOLE string against
 * `/^\d+(\.\d+)?$/` first, which rejects the second dot. The three sidecar helpers —
 * `xmrToPiconero`, `zphToAtomic`, `zanoToAtomic` — had no validation at all, and
 * additionally **truncated** excess precision via `.slice(0, decimals)`, so
 * `xmrToPiconero("0.0000000000001")` quietly returned `0`.
 *
 * # The rules
 *
 * - The entire string must match `^\d+(\.\d+)?$` after trimming. No signs, no
 *   exponents, no thousands separators, no second dot, no empty string.
 * - More fractional digits than the asset has is an ERROR, never a truncation.
 *   Silently dropping precision is how "send my whole balance" becomes "send some of
 *   it", and it rounds in the chain's favour, never the user's.
 * - All arithmetic is `BigInt`. Nothing here ever touches a float: `0.1 * 1e12` is
 *   `100000000000.00002`, and that is a real amount of money on a 12-decimal chain.
 */

/** The one shape a decimal amount may take. Anchored — no partial matches. */
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Parse `amount` as a decimal quantity of an asset with `decimals` places.
 *
 * @throws if the string is not a plain decimal, or carries more precision than the
 *         asset can represent.
 */
export function decimalToAtomic(
  amount: string,
  decimals: number,
  label = "amount",
): bigint {
  const t = String(amount ?? "").trim();
  if (!DECIMAL.test(t)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(amount)} — expected a plain decimal number.`,
    );
  }
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `This asset has ${decimals} decimal place${decimals === 1 ? "" : "s"}; ` +
        `${t} has ${frac.length}. Round it rather than letting the wallet drop digits.`,
    );
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Atomic units → a trimmed decimal string. Inverse of `decimalToAtomic`. */
export function atomicToDecimal(atomic: bigint, decimals: number): string {
  const neg = atomic < 0n;
  const n = neg ? -atomic : atomic;
  const scale = 10n ** BigInt(decimals);
  const whole = n / scale;
  const frac = (n % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
