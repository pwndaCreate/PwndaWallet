/**
 * src/features/mining/minedAssetView.ts
 *
 * What every Mine surface is allowed to SAY about the mined coin's value, as
 * one view model: SIMPLE (both layouts), landscape PRO and portrait PRO.
 *
 * # Why this exists
 *
 * The convert rate injected from the swap layer (`MiningProjection`) is
 * always an **XMR → target** rate: `useMiningProjection` prices the EARN
 * pipeline, and that pipeline only routes XMR. Multiplying anything that is
 * not XMR by it produces a number with a real-looking ticker and no meaning.
 *
 * SIMPLE knew that (`canProject`, from `capabilityFor`). Landscape PRO did
 * not: its BAL chip and its per-hour/day/month rows multiplied by
 * `projection.ratePerXmr` with no capability check, so a Xelis session showed
 * XEL earnings × an XMR rate, labelled in the target coin — found in the
 * portrait-vs-landscape parity audit, 2026-09-16. Three surfaces each deciding
 * for themselves whether the rate applies is how one of them forgot.
 *
 * So the decision is made HERE, once, and the surfaces render the result:
 *
 *   - a coin with a route (`capability.kind === "route"`, XMR today) gets the
 *     injected projection, the mined XMR balance and the route status;
 *   - every other coin gets the NATIVE identity projection (rate 1, its own
 *     ticker), no balance (the injected balance is XMR's), no route status,
 *     and the capability note that says why.
 *
 * `ratePerXmr` is read in exactly one function in this file, behind
 * `canProject`. `__tests__/mineViewParity.test.ts` fails if a view reads it.
 *
 * # Boundary
 *
 * Mining may not import `features/swap`, so nothing here knows how the rate
 * was made — it only decides whether the rate applies.
 */
import { useMemo } from "react";
import type { ChainType } from "../../wallets";
import { getCoinMeta } from "../../wallets/coin-metadata";
import type { MiningProjection } from "../../types/mining";
import {
  capabilityFor,
  type MinedAssetCapability,
} from "./minedAssetCapability";
import { MINING_COINS } from "./miningCoins";
import { formatProjected } from "./components/mine-simple";

export interface MinedAssetViewInput {
  /** The coin the displayed lane mines. */
  miningCoin: ChainType;
  /**
   * The injected XMR → target projection. Absent in PwndaLite. Only ever
   * applied to a coin whose capability is `route`.
   */
  projection?: MiningProjection | null;
  /** The wallet's XMR balance. Only meaningful for a route coin. */
  minedAmount?: number | null;
  /** Spot USD prices by uppercase ticker. */
  pricesByTicker?: Record<string, number>;
}

export interface MinedAssetView {
  /** Ticker of the coin being mined — `XEL` on a Xelis session, never a borrowed `XMR`. */
  minedTicker: string;
  capability: MinedAssetCapability;
  /** True only when the mined coin has a route out. The one case the XMR rate applies. */
  canProject: boolean;
  /** The capability's note when there is no route; `null` when there is one. */
  capabilityNote: string | null;
  /** The projection to render: the injected one for a route coin, the native identity otherwise. */
  projection: MiningProjection;
  /** The ticker every figure is denominated in. */
  displayTicker: string;
  /** True when {@link displayTicker} is the mined coin: no conversion, no `≈`. */
  isNative: boolean;
  /** Mined balance to show. `null` for a coin with no route (the injected balance is XMR's). */
  minedAmount: number | null;
  /** USD price of one mined coin, or `null` when unknown (never 0). */
  minedPriceUsd: number | null;
  /** Route status, for the hero. Always idle for a coin with no route. */
  routeLoading: boolean;
  routeFailureText: string | null;
  routeSourceNote: string | null;
  retryRoute?: () => void;
  /** Mined-coin units → display-coin units. `null` when the rate is unknown. */
  toDisplay: (minedUnits: number | null | undefined) => number | null;
  /** `≈ 0.00012 ETH`, `0.0412 XEL`, or `—`. */
  formatDisplay: (minedUnits: number | null | undefined) => string;
  /** Mined-coin units per day → USD per day. `null` without an estimate or a price. */
  usdPerDay: (minedPerDay: number | null | undefined) => number | null;
}

function tickerOf(coin: ChainType): string {
  return (
    MINING_COINS.find((c) => c.chain === coin)?.sym ??
    getCoinMeta(coin)?.ticker ??
    String(coin).toUpperCase()
  );
}

function positivePrice(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function minedAssetView({
  miningCoin,
  projection = null,
  minedAmount = null,
  pricesByTicker,
}: MinedAssetViewInput): MinedAssetView {
  const minedTicker = tickerOf(miningCoin);
  const capability = capabilityFor(miningCoin);
  const canProject = capability.kind === "route";

  const nativeIdentity: MiningProjection = {
    targetTicker: minedTicker,
    ratePerXmr: 1,
    xmrPriceUsd: null,
    fromEarnTarget: false,
  };
  const effective: MiningProjection =
    canProject && projection ? projection : nativeIdentity;
  const displayTicker = effective.targetTicker;
  const isNative = displayTicker === minedTicker;

  // The ONLY read of the XMR rate on any Mine surface. `canProject` is what
  // makes it legitimate; the native identity never reaches the multiply.
  const rate = canProject && !isNative ? effective.ratePerXmr : null;
  const toDisplay = (v: number | null | undefined): number | null => {
    if (v == null || !Number.isFinite(v)) return null;
    if (isNative) return v;
    return rate == null ? null : v * rate;
  };

  const minedPriceUsd =
    positivePrice(pricesByTicker?.[minedTicker]) ??
    (canProject ? positivePrice(projection?.xmrPriceUsd) : null);

  return {
    minedTicker,
    capability,
    canProject,
    capabilityNote: capability.kind === "route" ? null : capability.note,
    projection: effective,
    displayTicker,
    isNative,
    minedAmount: canProject ? minedAmount : null,
    minedPriceUsd,
    routeLoading: canProject ? projection?.routeLoading === true : false,
    routeFailureText: canProject ? (projection?.routeFailureText ?? null) : null,
    routeSourceNote: canProject ? (projection?.routeSourceNote ?? null) : null,
    retryRoute: canProject ? projection?.retryRoute : undefined,
    toDisplay,
    formatDisplay: (v) => {
      const d = toDisplay(v);
      if (d == null) return "—";
      return `${isNative ? "" : "≈ "}${formatProjected(d, displayTicker)} ${displayTicker}`;
    },
    usdPerDay: (perDay) =>
      perDay != null && Number.isFinite(perDay) && minedPriceUsd != null
        ? perDay * minedPriceUsd
        : null,
  };
}

/** {@link minedAssetView}, memoised for a render. */
export function useMinedAssetView(input: MinedAssetViewInput): MinedAssetView {
  const { miningCoin, projection, minedAmount, pricesByTicker } = input;
  return useMemo(
    () => minedAssetView({ miningCoin, projection, minedAmount, pricesByTicker }),
    [miningCoin, projection, minedAmount, pricesByTicker],
  );
}

/** `$0.42/day`, at a precision that does not round a small miner to zero. */
export function formatUsdPerDay(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0.00/day";
  if (usd >= 100) return `$${usd.toFixed(0)}/day`;
  if (usd >= 1) return `$${usd.toFixed(2)}/day`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}/day`;
  return `$${usd.toFixed(4)}/day`;
}
