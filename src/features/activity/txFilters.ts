import type { ChainTx } from "../../wallets";

/**
 * T1.3 — "meaningful" = amount strictly greater than 0. Default filter
 * for new users so the Activity panel doesn't open as a wall of
 * `+0 XRP` rows from third-party drops, drips, faucets, and dust.
 *
 * Activity-feature-local helper: extracted 2026-06-16 from the
 * byte-identical copies in `ActivityViewPortrait.tsx` and
 * `ActivityView.tsx`. Lives in the activity slice (not `src/utils/`)
 * because it's only consumed within this feature.
 */
export function txIsMeaningful(tx: ChainTx): boolean {
  const n = parseFloat(tx.amount);
  return Number.isFinite(n) && n > 0;
}
