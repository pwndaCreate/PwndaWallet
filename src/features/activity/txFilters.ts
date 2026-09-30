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

/**
 * Which of the SENT / RECEIVED filters a row belongs to (2026-09-30). One
 * rule for both layouts; they each had their own copy of
 * `out || pending` / `in`, which left a send to yourself and a send that
 * failed on chain under neither filter — the operator saw rows under ALL
 * that SENT did not show.
 *
 *  - "sent": a send, a send to yourself, one that failed on chain, and one
 *    still waiting for a block;
 *  - "received": a receipt, including an incoming transfer that reverted;
 *  - null: a row whose direction the list could not read (an SPL transfer,
 *    `pending` in a block). It shows under ALL; its details read it.
 *
 * A failed or mempool row keeps the way it was meant to go in
 * `meta.intended` / `meta.netDirection`.
 */
export function txFilterSide(tx: ChainTx): "sent" | "received" | null {
  const hint = (key: "intended" | "netDirection"): string | undefined => {
    const v = tx.meta?.[key];
    return typeof v === "string" ? v : undefined;
  };
  switch (tx.direction) {
    case "in":
      return "received";
    case "out":
    case "self":
      return "sent";
    case "failed":
      // Without a hint a failed row is this wallet's own attempt: an
      // incoming transfer that reverts is recorded with `intended: "in"`.
      return hint("intended") === "in" ? "received" : "sent";
    case "pending": {
      const d = hint("intended") ?? hint("netDirection");
      if (d === "in") return "received";
      if (d === "out" || d === "self") return "sent";
      // In a block with no direction: not read. Otherwise a send this
      // wallet made, waiting for a block (as the filters always read it).
      return tx.height ? null : "sent";
    }
  }
  return null;
}
