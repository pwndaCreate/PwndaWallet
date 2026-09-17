/**
 * What the Send modal's fee box says, and which rate the send is signed with.
 *
 * # Why this exists (2026-09-12)
 *
 * The box showed a bare RATE — "ESTIMATED 10 sat/vB" on LTC — which answers
 * nothing a person sending money asks ("how much will this cost?"), and the
 * tier the user clicked was never passed to the signer: every UTXO send used
 * the adapter's own medium rate whatever was selected. Worse, that "10" was
 * LTC's hardcoded fallback shown as if it were a live estimate.
 *
 * Pure functions, so the arithmetic that turns a rate into money is tested
 * without mounting the modal.
 */
import type { FeeEstimate } from "../../wallets";
import type { SendQuote } from "../../wallets/types";

/**
 * A quote's fee note, trimmed and ready to show, or null when there is nothing
 * to add. Chain-agnostic: any adapter's quote may carry one (Xelis sets it when
 * the fee includes the one-off charge for a recipient account not yet on
 * chain). Added 2026-09-15.
 */
export function feeNoteText(quote: Pick<SendQuote, "feeNote"> | null | undefined): string | null {
  const note = quote?.feeNote;
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  return trimmed === "" ? null : trimmed;
}

/** Units that are a per-(v)byte rate in the coin's 1e-8 base unit. */
const PER_BYTE_RATE = /^(sat|duffs)\/v?B$/i;

/** Base units per coin for every per-byte-rate chain this app sends
 *  (BTC, LTC, BCH, DASH are all 1e8). */
const BASE_UNITS_PER_COIN = 1e8;

export function isPerByteRate(unit: string | undefined): boolean {
  return !!unit && PER_BYTE_RATE.test(unit.trim());
}

/**
 * The rate to sign with for the selected tier, in the adapter's base units per
 * (v)byte — or `undefined` to let the adapter choose. Only per-byte rates are
 * passed through: a total-denominated estimate (DOGE's "0.226 DOGE") is not a
 * rate and must never reach a `feeRateOverride`.
 */
export function feeRateForSend(
  estimate: FeeEstimate | null,
  tierValue: string | undefined,
): number | undefined {
  if (!estimate || estimate.isFallback || !isPerByteRate(estimate.unit)) return undefined;
  const n = Number(tierValue);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Relays reject fractional-sat rates below the floor; round UP, never down.
  return Math.max(Math.ceil(n), 1);
}

export interface FeeTotal {
  /** e.g. "0.00000141" — trailing zeros kept to 8 dp so columns line up. */
  coin: string;
  /** e.g. "$0.03", "< $0.01", or null when no price is known. */
  usd: string | null;
}

/** Approximate total for a typical send at `tierValue`, or null when the
 *  estimate is not a per-byte rate or carries no typical size. */
export function feeTotalFor(
  estimate: FeeEstimate | null,
  tierValue: string | undefined,
  usdPrice: number | undefined,
): FeeTotal | null {
  if (!estimate || !isPerByteRate(estimate.unit) || !estimate.typicalTxVBytes) return null;
  const rate = Number(tierValue);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  // Use the rate the signer will actually apply (rounded up), not the raw quote.
  const coins = (Math.max(Math.ceil(rate), 1) * estimate.typicalTxVBytes) / BASE_UNITS_PER_COIN;
  return { coin: coins.toFixed(8), usd: formatUsd(coins, usdPrice) };
}

/** "$0.03", "< $0.01", or null when there is no usable price. Also used by the
 *  Send modal's quoted-fee line (2026-09-15). */
export function formatUsd(coins: number, usdPrice: number | undefined): string | null {
  if (usdPrice == null || !Number.isFinite(usdPrice) || usdPrice <= 0) return null;
  const usd = coins * usdPrice;
  if (usd < 0.01) return "< $0.01";
  return `$${usd.toFixed(2)}`;
}
