/**
 * Pre-flight checks for swap-source amounts. Run BEFORE the user sees a
 * quote — the form catches insufficient-balance, below-minimum, and
 * chain-specific gotchas (NEAR account existence, Solana rent floor)
 * inline so the confirm modal never has to render those errors.
 *
 * The principle: any failure that's deterministic from local state +
 * conservative rules belongs in this module. Quote-side validation
 * (slippage, route availability, solver capacity) stays in the quote
 * call path — those need a network round-trip to know.
 */

import type { IntentsBlockchain } from "./near-intents-assets.generated";

export type PreflightStatus =
  | { kind: "ok" }
  | { kind: "below-minimum"; minimumDisplay: string; symbol: string }
  | { kind: "insufficient-balance"; needDisplay: string; haveDisplay: string; symbol: string }
  | { kind: "chain-prerequisite"; message: string }
  | { kind: "form-error"; message: string };

/**
 * Conservative per-symbol minimum atomic amounts. 1Click's actual
 * minimums vary by route and adjust dynamically; these are the floors
 * we surface to keep the user from sending an amount that 1Click will
 * reject for being "too small" (often $1 USD-equivalent).
 *
 * Unit: atomic of the source asset (wei / sat / lamport / yocto).
 *
 * If the user tries to swap below these, the form surfaces a friendly
 * "Below minimum" error rather than letting the quote fail. These
 * numbers are a defensive minimum — if 1Click's actual minimum is
 * higher for a given route, the quote endpoint will surface that and
 * the form re-renders the upstream message.
 */
const MINIMUM_ATOMIC_BY_SYMBOL: Record<string, bigint> = {
  // Roughly $0.50 USD at typical 2026 prices — per-asset.
  ETH: 200_000_000_000_000n, // 0.0002 ETH
  BTC: 1_000n, // 0.00001 BTC
  SOL: 5_000_000n, // 0.005 SOL
  NEAR: 100_000_000_000_000_000_000_000n, // 0.1 NEAR (also gas-prerequisite)
  POL: 1_000_000_000_000_000_000n, // 1 POL
  AVAX: 10_000_000_000_000_000n, // 0.01 AVAX
  BNB: 1_000_000_000_000_000n, // 0.001 BNB
  DOGE: 100_000_000n, // 1 DOGE
  XRP: 1_000_000n, // 1 XRP
  TRX: 5_000_000n, // 5 TRX
  USDC: 500_000n, // 0.5 USDC
  USDT: 500_000n, // 0.5 USDT
};

/**
 * Format an atomic-unit amount as a display string for the user.
 * Strips trailing zeros, no thousand-separators (we want to be
 * unambiguous about the actual floor).
 */
function atomicToDisplay(atomic: bigint, decimals: number): string {
  if (decimals === 0) return atomic.toString();
  const padded = atomic.toString().padStart(decimals + 1, "0");
  const intPart = padded.slice(0, -decimals);
  const fracPart = padded.slice(-decimals).replace(/0+$/, "");
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

export interface PreflightInput {
  symbol: string;
  blockchain: IntentsBlockchain;
  /** User-typed display amount (e.g. "0.005"). */
  displayAmount: string;
  /** User-typed amount converted to atomic units. */
  intendedAtomic: bigint;
  /** Asset's display decimals — for formatting messages. */
  decimals: number;
  /** User's current balance in atomic units, when known. */
  balanceAtomic?: bigint;
  /**
   * Estimated gas/fee cost in atomic units. For EVM, ~21000 × gasPrice;
   * for SOL ~5000 lamports per signature; for BTC/LTC, vbytes × feerate.
   * When omitted we don't run the fundability check (the form falls
   * back to the quote-time balance check).
   */
  estimatedFeeAtomic?: bigint;
}

/**
 * Run every pre-flight check applicable to this source. Returns the
 * first failure (callers render only one error at a time), or `{kind: "ok"}`.
 */
export function preflightSource(input: PreflightInput): PreflightStatus {
  if (input.intendedAtomic <= 0n) {
    return { kind: "form-error", message: `Enter an amount of ${input.symbol} to swap.` };
  }
  // Below-minimum check. Use the conservative floor for the symbol; if
  // the symbol isn't in the map, skip — 1Click's response will surface
  // the actual minimum.
  const minAtomic = MINIMUM_ATOMIC_BY_SYMBOL[input.symbol.toUpperCase()];
  if (minAtomic !== undefined && input.intendedAtomic < minAtomic) {
    return {
      kind: "below-minimum",
      minimumDisplay: atomicToDisplay(minAtomic, input.decimals),
      symbol: input.symbol,
    };
  }
  // Insufficient-balance check. Only when both sides are known.
  if (input.balanceAtomic !== undefined) {
    const fee = input.estimatedFeeAtomic ?? 0n;
    const need = input.intendedAtomic + fee;
    if (need > input.balanceAtomic) {
      return {
        kind: "insufficient-balance",
        needDisplay: atomicToDisplay(need, input.decimals),
        haveDisplay: atomicToDisplay(input.balanceAtomic, input.decimals),
        symbol: input.symbol,
      };
    }
  }
  // Chain-specific prerequisite hints.
  const chainPrereq = chainPrerequisite(input.blockchain, input);
  if (chainPrereq) return chainPrereq;
  return { kind: "ok" };
}

/**
 * Per-blockchain quirks that aren't a simple balance comparison.
 *
 *   - SOL: account needs ≥ ~890_880 lamports rent + 5000 fee. The
 *     intended-amount check above covers most cases; we fold a
 *     conservative buffer into the symbol-minimum.
 *
 *   - NEAR: implicit accounts need to be funded once before they can
 *     transact. The balance > 0 check is sufficient; if it isn't, the
 *     symbol-minimum (0.1 NEAR) catches it.
 *
 *   - BTC / LTC: dust-threshold (~330 sat for P2WPKH) — the symbol
 *     minimum is well above dust so we don't need a separate check.
 *
 *   - EVM (eth/arb/base/op/pol/avax/bnb): no chain prereqs beyond
 *     balance + min — every EVM has a flat-fee gas model, captured by
 *     the fundability check.
 */
function chainPrerequisite(
  blockchain: IntentsBlockchain,
  input: PreflightInput
): PreflightStatus | null {
  if (blockchain === "near" && input.balanceAtomic !== undefined) {
    // 0.1 NEAR = 1e23 yocto. If the user has less than that, they
    // can't pay storage + fees regardless of what they're trying to
    // send. (The implicit-account funding requirement is a separate
    // concern but covered by the same balance gate.)
    const NEAR_FLOOR = 100_000_000_000_000_000_000_000n;
    if (input.balanceAtomic < NEAR_FLOOR) {
      return {
        kind: "chain-prerequisite",
        message:
          "Your NEAR account needs at least 0.1 NEAR (storage + fees) before " +
          "any source-chain transaction can be built.",
      };
    }
  }
  if (blockchain === "sol" && input.balanceAtomic !== undefined) {
    // SOL accounts need ~0.00089 SOL rent plus 5000 lamports per fee. If
    // the wallet has less than ~0.001 SOL total, every send would fail
    // before a quote is issued.
    const SOL_FLOOR = 1_000_000n;
    if (input.balanceAtomic < SOL_FLOOR) {
      return {
        kind: "chain-prerequisite",
        message:
          "This Solana account has less than 0.001 SOL. Top up before swapping " +
          "(rent + fees floor).",
      };
    }
  }
  return null;
}

/**
 * Convert a PreflightStatus to a single short user-facing message
 * suitable for an inline error banner under the swap form.
 */
export function preflightMessage(status: PreflightStatus): string | null {
  switch (status.kind) {
    case "ok":
      return null;
    case "below-minimum":
      return `Below minimum: NEAR Intents requires at least ${status.minimumDisplay} ${status.symbol} per swap.`;
    case "insufficient-balance":
      return `Insufficient balance: have ${status.haveDisplay} ${status.symbol}, need ${status.needDisplay}.`;
    case "chain-prerequisite":
      return status.message;
    case "form-error":
      return status.message;
  }
}
