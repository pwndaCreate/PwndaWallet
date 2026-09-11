import type { BasicSwapActiveSwap } from "../../api/basicswap";
import { classifyBidState } from "./bidStates";
import type { SidecarTrackedSwap } from "./useSidecarSwap";

/**
 * Adopting the node's own list of in-progress swaps.
 *
 * # The bug this replaces
 *
 * The tracker rehydrated **once**, at mount, from
 * `sentbids?with_available_or_active`. On a cold start the swap node is not up
 * for a minute or two — longer since the autostart readiness gate, which waits
 * for the host wallets on purpose — so that single read threw, returned early,
 * and nothing re-armed it. Result, reported 2026-09-05: after a restart the
 * upstream console showed a swap in progress and the wallet's own P2P tab
 * showed nothing. The wallet had asked before there was anything to answer.
 *
 * So the sync is now a **repeating read of `/json/active`**, which is:
 *
 * * the same source the console's "Swaps in Progress" table renders, so the
 *   two cannot disagree about what is running;
 * * role-agnostic — it carries bids this node RECEIVED as well as ones it
 *   sent, where `sentbids` is half the book by construction (the same
 *   half-of-the-book trap the fee sweep and the reserved-balance gate each hit
 *   once);
 * * filter-free, so there is no `with_available_or_active` argument to get
 *   subtly wrong.
 *
 * Local knowledge always wins on merge: a swap this app adopted itself carries
 * a payout address and polled detail that `/json/active` does not have.
 */

/**
 * Map one active-swap row into the tracker's shape.
 *
 * # Which leg is which
 *
 * `/json/active` reports in the OFFER's frame (`js_active` builds every row
 * from `offer.coin_from` / `offer.coin_to`), so the mapping depends on the
 * role:
 *
 * * `was_sent` — this node bid on someone else's offer. It SENDS `coin_to` and
 *   RECEIVES `coin_from`, the same mapping the `sentbids` rehydrate used.
 * * otherwise — this node posted the offer, so the legs are the other way up.
 *
 * Verified against the live 2026-09-05 row: `coin_from: Litecoin`,
 * `coin_to: Monero`, `was_sent: true`, and the operator sent 0.00999997 XMR to
 * receive 0.09992627 LTC.
 */
export function activeSwapToTracked(row: BasicSwapActiveSwap): SidecarTrackedSwap {
  const sent = row.was_sent !== false;
  return {
    bidId: row.bid_id,
    offerId: row.offer_id,
    sendCoin: sent ? row.coin_to : row.coin_from,
    receiveCoin: sent ? row.coin_from : row.coin_to,
    sendAmount: (sent ? row.amount_to : row.amount_from) ?? "",
    receiveAmount: (sent ? row.amount_from : row.amount_to) ?? "",
    createdAt: row.created_at,
    detail: null,
    // No leg. `/json/active` carries `was_sent` but NOT `reverse_bid`, and on
    // a reverse ADS bid `was_sent: true` puts this node on the opposite leg —
    // so `was_sent` alone cannot answer it. The neutral copy holds for the one
    // poll cycle until `/json/bids/<id>` lands with `reverse_bid`; a guess
    // here would show the counterparty's story on four states. See
    // `bidStates.ts::swapLegOf`.
    stage: classifyBidState(row.bid_state),
    lastPolledAt: null,
    error: null,
    // Deliberately no `payoutAddress`: the node does not report one, and its
    // absence is what stops an automatic re-bid firing on a swap this app did
    // not place itself.
  };
}

/**
 * Merge the node's list into what the app already tracks.
 *
 * Rules, in order:
 *
 * 1. **A live swap is never dropped.** One the user just placed may not be in
 *    `swaps_in_progress` for a second or two.
 * 1b. **A FINISHED swap the node no longer lists IS dropped.** Rule 1 used to
 *    have no exception, so a completed or refunded swap sat on the Swap screen
 *    forever and came back on every restart — reported 2026-09-07 against a
 *    swap that had been over for a day. Terminal AND absent from the node's
 *    map is the safe pair: absence alone would drop a live swap the node
 *    briefly omits, and terminality alone would yank a result away while the
 *    user is still reading it, since the engine keeps a finished bid in
 *    `swaps_in_progress` for a while first.
 * 2. **Local detail wins.** An entry the app owns carries polled `detail`, a
 *    `payoutAddress` and retry bookkeeping; the node's row carries none of
 *    those, so it must never overwrite them.
 * 3. **The node's STAGE wins for a swap we have not polled yet** — that is the
 *    whole point of asking. A locally-adopted swap that has been polled keeps
 *    its own, which is at least as fresh.
 */
export function mergeActiveSwaps(
  local: readonly SidecarTrackedSwap[],
  fromNode: readonly SidecarTrackedSwap[],
): SidecarTrackedSwap[] {
  const byId = new Map(local.map((s) => [s.bidId, s]));
  const nodeIds = new Set(fromNode.map((s) => s.bidId));
  const added: SidecarTrackedSwap[] = [];
  for (const node of fromNode) {
    const mine = byId.get(node.bidId);
    if (!mine) {
      added.push(node);
      continue;
    }
    if (mine.lastPolledAt == null && mine.detail == null) {
      byId.set(node.bidId, { ...mine, stage: node.stage });
    }
  }
  // Node-known swaps first: the newest thing the user did is the thing they
  // are looking for, and `/json/active` orders by the engine's own map.
  const kept = local
    .map((s) => byId.get(s.bidId) ?? s)
    .filter((s) => !(s.stage.terminal && !nodeIds.has(s.bidId)));
  return [...added, ...kept];
}
