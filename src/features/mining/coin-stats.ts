import type { ChainType } from "../../wallets";

/**
 * WhatToMine coin-stats fetcher.
 *
 * Single-source-of-truth for the volatile network params the earnings
 * estimator needs: live network hashrate, current block reward
 * (handles halvings + PoS reward shifts), block time. WhatToMine's
 * `/coins.json` endpoint covers every PoW-mineable coin and updates
 * every ~5 minutes; one fetch covers all four chains we mine.
 *
 * No API key. CORS-enabled. Failure modes (rate-limit, network down,
 * schema drift) leave the cache untouched and return null per chain
 * — callers fall through to per-chain explorers (`useNetworkHashrate`)
 * and finally to the hardcoded `NETWORK_PARAMS_DEFAULT` constants in
 * `earnings.ts`. See [[remote-connections-inventory]] §3a and
 * [[hardware-prediction]] for the full source-of-truth chain.
 */

/** Live coin params parsed out of WhatToMine's response. Each field
 *  may be null — the earnings estimator uses the live value when set
 *  and the hardcoded constant otherwise. */
export interface CoinStats {
  /** Network hashrate in H/s. */
  networkHashrate: number | null;
  /** Coins emitted per block (post-PoS / post-halving adjustments). */
  blockReward: number | null;
  /** Average block time in seconds. */
  blockTimeSecs: number | null;
  /** WhatToMine's reported coin/BTC exchange rate. We don't use this
   *  for USD math (CoinGecko is authoritative) but it's a useful
   *  sanity check. */
  exchangeRateBtc: number | null;
  /** Most recent block height — recent ⇒ data is fresh. */
  lastBlock: number | null;
  /** Algorithm name from WhatToMine ("RandomX", "KawPow", "Octopus"). */
  algorithm: string | null;
  /** Unix-ms timestamp the value was fetched. Used by the UI to show
   *  "(stale)" when older than ~10 min. */
  fetchedAt: number;
}

/** Map our `ChainType` → the human-readable key WhatToMine uses in
 *  its `coins` object. The key is the coin's full name on the site
 *  ("Monero", "Ravencoin", etc.) — *not* the ticker. */
const WTM_KEY_FOR_CHAIN: Partial<Record<ChainType, string>> = {
  monero: "Monero",
  zephyr: "Zephyr",
  ravencoin: "Ravencoin",
  conflux: "Conflux",
  ergo: "Ergo",
};

const URL = "https://whattomine.com/coins.json";
const TTL_MS = 300_000; // 5 minutes — matches WhatToMine's own update cadence
const STALE_AFTER_MS = 600_000; // After 10 min, mark UI as "(stale)"

let cache: { at: number; data: Record<string, CoinStats> } | null = null;
let inflight: Promise<Record<string, CoinStats>> | null = null;

interface WhatToMineCoinRow {
  tag?: string;
  algorithm?: string;
  block_time?: string | number;
  block_reward?: number;
  block_reward24?: number;
  last_block?: number;
  difficulty?: number;
  difficulty24?: number;
  nethash?: number;
  exchange_rate?: number;
  exchange_rate24?: number;
  // Other fields exist (`profitability24`, `btc_revenue`, etc.) — we
  // only model what we use, so the rest are ignored on parse.
}

interface WhatToMineResponse {
  coins?: Record<string, WhatToMineCoinRow>;
}

/** Parse one row's volatile fields. WhatToMine sometimes returns
 *  block_time as a string ("120.0") and sometimes as a number, hence
 *  the union. */
function parseRow(row: WhatToMineCoinRow): CoinStats {
  const blockTime =
    typeof row.block_time === "string"
      ? parseFloat(row.block_time)
      : typeof row.block_time === "number"
        ? row.block_time
        : null;
  return {
    networkHashrate: numOrNull(row.nethash),
    blockReward: numOrNull(row.block_reward),
    blockTimeSecs: blockTime != null && Number.isFinite(blockTime) ? blockTime : null,
    exchangeRateBtc: numOrNull(row.exchange_rate),
    lastBlock: numOrNull(row.last_block),
    algorithm: typeof row.algorithm === "string" ? row.algorithm : null,
    fetchedAt: Date.now(),
  };
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

/**
 * Fetch — with cache + inflight collapsing — the latest WhatToMine
 * snapshot. Returns a map keyed by `ChainType` (not ticker, not the
 * WhatToMine name) so callers can look up directly. Chains absent
 * from the response are simply absent from the map.
 */
export async function fetchCoinStats(): Promise<Record<string, CoinStats>> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const resp = await fetch(URL, { headers: { accept: "application/json" } });
      if (!resp.ok) {
        // Rate-limit / 5xx — keep the stale cache, callers will fall
        // through to per-chain explorers via useNetworkHashrate.
        return cache?.data ?? {};
      }
      const json = (await resp.json()) as WhatToMineResponse;
      const coins = json.coins ?? {};
      const out: Record<string, CoinStats> = {};
      for (const [chain, wtmKey] of Object.entries(WTM_KEY_FOR_CHAIN) as [
        ChainType,
        string,
      ][]) {
        const row = coins[wtmKey];
        if (!row) continue;
        out[chain] = parseRow(row);
      }
      if (Object.keys(out).length === 0) {
        // Schema drifted, key names changed, etc. Keep stale cache.
        return cache?.data ?? {};
      }
      cache = { at: Date.now(), data: out };
      return out;
    } catch {
      return cache?.data ?? {};
    } finally {
      inflight = null;
    }
  })();
  inflight = promise;
  return promise;
}

/** Sync accessor for the most-recently-cached value of one chain.
 *  Returns null when no fetch has succeeded yet. UI can use this for
 *  the first paint while `fetchCoinStats` settles in the background. */
export function getCachedCoinStats(chain: ChainType): CoinStats | null {
  return cache?.data[chain] ?? null;
}

/** Whether the cached data for a chain is older than the
 *  staleness threshold. UI uses this for the `(stale)` provenance
 *  pill on the EARNINGS block. */
export function isStale(stats: CoinStats | null): boolean {
  if (!stats) return false;
  return Date.now() - stats.fetchedAt > STALE_AFTER_MS;
}
