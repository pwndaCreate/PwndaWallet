/**
 * src/features/swap/hop2Quote.ts
 *
 * The NEAR Intents leg of the convert route, quoted for real — cached and
 * rate-limited so a mining screen can ask for it.
 *
 * # Why a dry quote and not a price cross
 *
 * Hop 2 was estimated from spot USD until 2026-08-28: `amountIn × priceIn /
 * priceOut`, minus a flat 0.3%. That ignores solver spread, bridge fees and
 * per-pair liquidity, which for a small amount on a thin pair are not a
 * rounding error. The operator asked for real quotes on both legs.
 *
 * 1Click supports `dry: true` — a genuine quote that does **not** generate a
 * deposit address or commit solver liquidity. `intents-pair-min-probe.ts`
 * already uses it to discover per-pair minimums, so this is an established
 * pattern against this endpoint, not a new use of it.
 *
 * # Why it is cached this hard
 *
 * The consumer is a Mine tab that re-renders on every price tick and an EARN
 * tab a user may sit on. Quoting per render would hammer the solver relay for
 * a number that is advisory by construction. The operator's guidance was
 * "polling can be cached and we can rate limit each poll and estimate for like
 * every 10-30 mins", so:
 *
 *   - results are cached for {@link HOP2_TTL_MS} (20 minutes, mid-range);
 *   - amounts are BUCKETED, so a balance ticking up by dust reuses the same
 *     quote instead of missing the cache on every satoshi;
 *   - one in-flight request per key, and a global floor between calls.
 *
 * A cached quote is stale by design and the surface says so — the route
 * estimate carries `hop2Basis` and every consumer renders behind `≈`.
 */
import { getIntentsQuote } from "../../api/proxy";
import type { IntentsQuoteRequest } from "../../lib/proxy-types";
import { chainsForSymbol } from "./intents-dedup";

/** How long a quote is reused. Mid-point of the operator's 10-30 min range. */
export const HOP2_TTL_MS = 20 * 60_000;

/** Never fire two upstream quotes closer together than this, across all pairs. */
export const HOP2_MIN_INTERVAL_MS = 15_000;

/**
 * Amount buckets, so a slowly-growing balance does not miss the cache.
 *
 * Quotes are bucketed to 2 significant figures. A balance drifting from
 * 0.4213 to 0.4219 XMR reuses the 0.42 quote; a jump to 0.5 does not. The
 * error this introduces is far smaller than the staleness already accepted by
 * a 20-minute TTL, and it turns "every render is a cache miss" into "a few
 * quotes an hour".
 */
export function bucketAmount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const mag = Math.floor(Math.log10(n));
  const step = Math.pow(10, mag - 1);
  return Math.round(n / step) * step;
}

interface Entry {
  amountOut: number | null;
  at: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<number | null>>();
let lastCallAt = 0;

/** Test seam. */
export function __resetHop2Cache(): void {
  cache.clear();
  inFlight.clear();
  lastCallAt = 0;
}

function key(from: string, to: string, bucket: number): string {
  return `${from}/${to}/${bucket}`;
}

/**
 * Atomic-units string for a decimal amount, without floating-point drift at
 * high decimal counts. Mirrors `intents-pair-min-probe.ts`'s approach.
 */
function toAtomic(amount: number, decimals: number): string {
  const safe = Math.min(decimals, 15);
  const scaled = Math.floor(amount * 10 ** safe);
  if (scaled <= 0) return "0";
  if (decimals <= 15) return String(scaled);
  return (BigInt(scaled) * 10n ** BigInt(decimals - 15)).toString();
}

export interface Hop2QuoteArgs {
  fromTicker: string;
  toTicker: string;
  amount: number;
  /** Resolved wallet addresses, for a response shape identical to a real quote. */
  addressFor: (assetId: string) => string;
}

/**
 * Quote hop 2, or `null` when it cannot be quoted.
 *
 * `null` is not an error to swallow: the caller reports that the second leg is
 * unpriced rather than substituting a price cross, because silently swapping
 * one basis for another is how a number stops meaning what its label says.
 */
export async function quoteHop2(args: Hop2QuoteArgs): Promise<number | null> {
  const { fromTicker, toTicker, amount, addressFor } = args;
  const bucket = bucketAmount(amount);
  if (bucket <= 0) return null;

  const k = key(fromTicker, toTicker, bucket);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < HOP2_TTL_MS) return hit.amountOut;

  const pending = inFlight.get(k);
  if (pending) return pending;

  // Global floor between upstream calls. A burst of surfaces mounting at once
  // must not turn into a burst of quotes.
  if (Date.now() - lastCallAt < HOP2_MIN_INTERVAL_MS) {
    return hit ? hit.amountOut : null;
  }

  /**
   * `resolveAsset` needs an explicit blockchain; a ticker can exist on
   * several. The estimator has no chain preference to express, so it takes the
   * registry's first entry for the symbol — the same list the swap form's
   * chain sub-selector renders, in the same order, so the estimate quotes the
   * chain the form would default to rather than an arbitrary one.
   */
  const from = chainsForSymbol(fromTicker)[0] ?? null;
  const to = chainsForSymbol(toTicker)[0] ?? null;
  if (!from || !to) return null;

  const run = (async (): Promise<number | null> => {
    lastCallAt = Date.now();
    try {
      const req: IntentsQuoteRequest = {
        // No deposit address, no solver liquidity committed — the same mode
        // the per-pair minimum probe uses.
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100, // 1%, advisory
        originAsset: from.assetId,
        destinationAsset: to.assetId,
        amount: toAtomic(bucket, from.decimals),
        depositType: "ORIGIN_CHAIN",
        recipientType: "DESTINATION_CHAIN",
        refundType: "ORIGIN_CHAIN",
        recipient: addressFor(to.assetId),
        refundTo: addressFor(from.assetId),
        deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
        quoteWaitingTimeMs: 0,
      };
      const res = await getIntentsQuote(req);
      const outAtomic = res?.quote?.amountOut;
      if (typeof outAtomic !== "string" || outAtomic === "") return null;
      const out = Number(outAtomic) / 10 ** to.decimals;
      return Number.isFinite(out) && out > 0 ? out : null;
    } catch {
      // A refused or unreachable quote is "not priced", never zero.
      return null;
    }
  })()
    .then((v) => {
      cache.set(k, { amountOut: v, at: Date.now() });
      return v;
    })
    .finally(() => {
      inFlight.delete(k);
    });

  inFlight.set(k, run);
  return run;
}
