/**
 * src/features/mining/minedAssetCapability.ts
 *
 * What the Mine tab is allowed to claim about each mineable coin.
 *
 * # Why a coin needs a capability at all
 *
 * The SIMPLE hero answers "what is my mining worth, in a coin I actually
 * want". That answer requires a **two-hop route out of the mined coin**:
 * mined coin → LTC/BCH over BasicSwap, then → the target over NEAR Intents.
 * Only XMR has that route today. The others fail at different points, and the
 * differences matter to the user:
 *
 *   - **XMR** — full route. The hero shows a projected balance in the chosen
 *     coin, priced from a real order book.
 *   - **ZEPH / ZANO** — a real USD price feed, but still no route THIS FILE can
 *     honestly claim. As of the Grove expansion plan's Phase B (2026-09-03)
 *     both coins have real BasicSwap chainclient modules and are legitimate
 *     scriptless legs in the swap tab (`swap/asset-capabilities.ts`,
 *     `swap-sidecar/useSidecarSwap.ts`) — so "no BasicSwap route" is no longer
 *     the accurate reason. What is still missing, specifically for the MINE
 *     hero's two-hop projection: (1) `swap/routeEstimate.ts`'s `ROUTE_SOURCE`
 *     is hardcoded to `"XMR"`, not generalised per mined coin (master plan §8
 *     Q2 names this as the needed change, and it is not any Phase C unit's
 *     `owns` — a gap, not an oversight); (2) the host-wallet consent + activation
 *     that would let the engine actually hold a shared ZEPH/ZANO wallet
 *     (C-RZ/C-RX/C-T2) had not landed as of this file's last edit; (3) even
 *     once both land, ZEPH/ZANO books are initially maker-only from pwnda's
 *     own desk (§8 Q2), so a projected balance would be pricing against a
 *     single maker, not a market. So the hero can honestly say what the mined
 *     coin is WORTH without claiming it can be converted. When ALL THREE close,
 *     they move to `route` and this file is the one place to change.
 *   - **RVN / CFX** — no two-way hop into an unmineable-style asset at all,
 *     and adding one is not on the roadmap. The asset estimate is `unavailable`
 *     and the hero falls back to daily USD revenue, which is the honest
 *     answer to "is this worth running" for a coin you cannot route out of.
 *
 * # Why this is a table and not an `if`
 *
 * The capability is a per-coin FACT that changes as the engine gains pairs,
 * and it is consumed by the hero, the target picker and the EARN promo. A
 * conditional spread across three surfaces is three places to forget ZEPH when
 * it ships. `Record<ChainType, …>`-shaped lookup with an explicit default keeps
 * the claim in one place.
 *
 * This file lives in `features/mining` and imports nothing from `swap` — the
 * capability describes what the ROUTE can do, but stating it does not require
 * reaching into the routing code, and mining may not import it anyway.
 */
import type { ChainType } from "../../wallets";

export type MinedAssetCapability =
  /** A real convert route exists: show a projected balance in the target. */
  | { kind: "route" }
  /**
   * No route yet, but the coin has a price. Show USD value, and say plainly
   * that converting is not wired up rather than implying it is.
   */
  | { kind: "usd-only"; note: string }
  /**
   * No route and none planned. The asset estimate is not offered at all; the
   * surface shows daily USD revenue instead.
   */
  | { kind: "unavailable"; note: string };

/**
 * Per-coin capability.
 *
 * Keyed by `ChainType` so a coin added to the mining roster without a decision
 * here falls to {@link DEFAULT_CAPABILITY} — which is `unavailable`, the
 * conservative direction: a new coin claims nothing until someone says it can.
 */
const CAPABILITY: Partial<Record<ChainType, MinedAssetCapability>> = {
  monero: { kind: "route" },

  // Grove's BasicSwap engine gained real ZEPH/ZANO chainclients 2026-09-03
  // (Phase B), so the swap TAB can already route these coins — but the MINE
  // hero's two-hop projection is a separate pipeline (`routeEstimate.ts`,
  // hardcoded to XMR) that has not been generalised. Until it is, a ZEPH/ZANO
  // miner gets a truthful USD figure and an explicit "not yet" rather than a
  // projection through a route this file cannot verify end to end.
  zephyr: {
    kind: "usd-only",
    note: "converting ZEPH is not wired into the mining route yet — coming with Grove",
  },
  zano: {
    kind: "usd-only",
    note: "converting ZANO is not wired into the mining route yet — coming with Grove",
  },

  // No XMR-family pair and no two-way hop into the swap graph. Daily revenue
  // is the useful number here, and pretending otherwise would be inventing a
  // route.
  ravencoin: {
    kind: "unavailable",
    note: "RVN has no swap route out of mining — daily revenue shown instead",
  },
  conflux: {
    kind: "unavailable",
    note: "CFX has no swap route out of mining — daily revenue shown instead",
  },
  ergo: {
    kind: "unavailable",
    note: "ERG has no swap route out of mining — daily revenue shown instead",
  },
};

export const DEFAULT_CAPABILITY: MinedAssetCapability = {
  kind: "unavailable",
  note: "no swap route out of this coin yet — daily revenue shown instead",
};

export function capabilityFor(coin: ChainType): MinedAssetCapability {
  return CAPABILITY[coin] ?? DEFAULT_CAPABILITY;
}

/** True when the hero may render a projected balance in another asset. */
export function canProjectAsset(coin: ChainType): boolean {
  return capabilityFor(coin).kind === "route";
}
