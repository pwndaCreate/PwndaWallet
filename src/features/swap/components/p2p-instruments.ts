/**
 * src/features/swap/components/p2p-instruments.ts
 *
 * Pure mappers from live P2P data to the instrument props in `p2p-ui.tsx`.
 *
 * Split out from the components so they are unit-testable without a DOM, and
 * so the ONE decision that matters here is visible in one place: what counts
 * as a good, mid, or poor offer.
 *
 * That decision is not made here. It is imported from
 * `swap-sidecar/spread.ts`, the same module the confirm modal's gate uses.
 * A gauge that draws "green" using a different threshold than the gate that
 * blocks the swap would be a lie with a very short fuse — the user would see
 * green, press review, and be told to type "I ACCEPT THIS RATE".
 */
import {
  SPREAD_GREEN_MAX_PCT,
  SPREAD_AMBER_MAX_PCT,
} from "../../swap-sidecar/spread";
import type { OfferBand } from "./p2p-ui";

/**
 * Band one offer by how far its rate sits from the reference market rate.
 *
 * `spreadPct` is signed the way `computeSpread` reports it: positive means
 * worse than market for the taker. A better-than-market offer is green — it
 * is not suspicious to be offered a good price, and the confirm modal says
 * so in its own sentence ("This swap is X% better than market").
 */
export function bandForSpread(spreadPct: number | null): OfferBand {
  if (spreadPct == null) return "poor";
  if (spreadPct <= SPREAD_GREEN_MAX_PCT) return "good";
  if (spreadPct <= SPREAD_AMBER_MAX_PCT) return "mid";
  return "poor";
}

/**
 * Band a whole book, best first.
 *
 * The offers are assumed already ranked (that is `rankOffers`' job); this
 * only classifies. `referenceRate` is the market rate in the same units as
 * each offer's rate — when it is null, every cell reads "poor" because
 * nothing can be verified, which is the same conservative direction
 * `computeSpread` takes with a missing feed.
 */
export function bandsForOffers(
  offerRates: readonly number[],
  referenceRate: number | null,
): OfferBand[] {
  if (referenceRate == null || referenceRate <= 0) {
    return offerRates.map(() => "poor" as OfferBand);
  }
  return offerRates.map((rate) => {
    if (!Number.isFinite(rate) || rate <= 0) return "poor";
    // Taker pays `rate`; higher than market = worse.
    const pct = ((rate - referenceRate) / referenceRate) * 100;
    return bandForSpread(pct);
  });
}

/**
 * Map a sidecar bid state key to the tracker's step index.
 *
 * Terminal-but-not-done outcomes (refunded, cancelled, recovered by the
 * counterparty) deliberately map to the LAST index: the arc is a progress
 * indicator, and those swaps are over. The surrounding panel is what says
 * which ending it was — the arc must not imply a refunded swap is still
 * "waiting for the other user".
 */
export function trackerIndexForStage(stage: string | null | undefined): number {
  switch (stage) {
    case "requesting":
      return 0;
    case "accepted":
      return 1;
    case "locking":
      return 2;
    case "waiting-counterparty":
      return 3;
    case "finalising":
      return 4;
    case "done":
    case "refunded":
    case "cancelled":
    case "counterparty-recovered":
      return 5;
    default:
      // Unknown / needs-attention: show the arc at the last confirmed point
      // rather than inventing progress.
      return 0;
  }
}
