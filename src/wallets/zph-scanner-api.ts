/**
 * Zephyr Protocol Scanner API client.
 *
 * Reserve ratio, asset supplies, oracle prices, and yield APY are not
 * exposed by the daemon's standard JSON-RPC surface — `zephyrd` does not
 * ship a `get_reserve_info` method. The team-operated scanner at
 * `zephyrprotocol.com` aggregates all of this and exposes it as a small
 * read-only HTTPS API:
 *
 *   GET https://zephyrprotocol.com/api/v1/livestats
 *
 * Cached server-side (~30s TTL) and unauthenticated. Trust assumption is
 * the same as for the centralized oracle — the same team operates both,
 * and decentralization is on the roadmap.
 *
 * Routed through `httpProxyCall` so the request bypasses the Tauri
 * WebView's CORS / origin restrictions. The host
 * `zephyrprotocol.com` is allowlisted in
 * `src-tauri/src/http_proxy.rs::ALLOWED_HOST_SUFFIXES`.
 */

import { proxyGetJson } from "./_proxy";
import type { ZphAssetType } from "./zph-rpc";

const LIVESTATS_URL = "https://zephyrprotocol.com/api/v1/livestats";

/** Raw response from `/api/v1/livestats`. Field names mirror the API
 *  exactly so the relationship to the upstream JSON is obvious in
 *  inspector output. Numbers are decimals (not atomic units): supplies
 *  are whole-coin counts, prices are USD per unit, ratios are
 *  multiplicative (1.0 = 100%). */
export interface ZphLiveStats {
  /** Reserve ratio computed from spot oracle. 1.0 = 100%, 4.0 = 400%. */
  reserve_ratio: number;
  /** Reserve ratio computed from 24h moving-average oracle. */
  reserve_ratio_ma: number;

  /** ZEPH held by the protocol reserve, in whole ZEPH. */
  zeph_in_reserve: number;
  /** USD value of the reserve (zeph_in_reserve × zeph_price). */
  zeph_in_reserve_value: number;
  /** Reserve / max supply (~18.4M ZEPH). */
  zeph_in_reserve_percent: number;

  /** Circulating supplies, in whole units. */
  zeph_circ: number;
  zsd_circ: number;
  zrs_circ: number;
  zys_circ: number;

  /** USD prices per asset. ZSD is fixed at $1 by definition. */
  zeph_price: number;
  zsd_price: number;
  zrs_price: number;
  zys_price: number;

  /** Per-asset USD-equivalent rates the protocol uses internally for
   *  conversions. zeph_rate = zeph_price; zsd_rate is the spot ZEPH/ZSD
   *  rate from the oracle, etc. */
  zeph_rate?: number;
  zsd_rate?: number;
  zrs_rate?: number;
  zys_rate?: number;

  /** ZSD held in the Yield Reserve (the source of ZYS auto-compounding). */
  zsd_in_yield_reserve: number;
  zsd_in_yield_reserve_percent: number;
  zsd_accrued_in_yield_reserve_from_yield_reward?: number;

  /** Current variable APY for ZYS holders, as a percentage (e.g. 8.84). */
  zys_current_variable_apy: number;

  /** 24h supply changes, in whole units. */
  zeph_circ_daily_change?: number;
  zsd_circ_daily_change?: number;
  zrs_circ_daily_change?: number;
  zys_circ_daily_change?: number;
}

/**
 * Reserve-ratio band per the Djed model + Zephyr's published thresholds.
 * Both spot AND MA must satisfy the band — operations gate on the worse
 * of the two.
 *
 *   - "below-yield"   < 200%  → ZYS yield generation halts
 *   - "below-mint"    < 400%  → ZSD minting halted, ZRS redemption halted
 *   - "normal"     400–800%  → all operations available
 *   - "above-cap"    > 800%  → ZRS minting blocked
 */
export type ReserveRatioBand =
  | "below-yield"
  | "below-mint"
  | "normal"
  | "above-cap";

export function classifyReserveRatio(ratio: number): ReserveRatioBand {
  if (ratio < 2) return "below-yield";
  if (ratio < 4) return "below-mint";
  if (ratio > 8) return "above-cap";
  return "normal";
}

/** Worst-of (spot, MA) — what the protocol uses for gate checks. */
export function worstOfRatio(stats: ZphLiveStats): number {
  return Math.min(stats.reserve_ratio, stats.reserve_ratio_ma);
}

/** Single-call live-stats fetch. Throws on non-2xx or invalid JSON. */
export async function fetchZephyrLiveStats(): Promise<ZphLiveStats> {
  return proxyGetJson<ZphLiveStats>(LIVESTATS_URL);
}

/**
 * USD price (per whole unit) for a Zephyr ecosystem asset, read from the
 * live reserve stats. ZPH→`zeph_price`, ZSD→`zsd_price`, ZRS→`zrs_price`,
 * ZYS→`zys_price`. Returns null when stats haven't loaded yet or the field
 * is missing/non-finite, so callers render "—" rather than a bogus $0.
 *
 * These are the protocol's on-chain oracle prices (the same record the
 * Zephyr ecosystem uses): ZSD is the $1 peg, ZRS the reserve-share NAV, ZYS
 * the accrued yield-slip value. They are NOT thin-market exchange quotes —
 * for the protocol assets the oracle is the canonical price, and it's the
 * only source that covers ZRS/ZYS at all. Shared by the portrait
 * `ZephyrAssetsCard` and the landscape wallet view.
 */
export function zphAssetPrice(
  stats: ZphLiveStats | null | undefined,
  asset: ZphAssetType
): number | null {
  if (!stats) return null;
  const p =
    asset === "ZSD"
      ? stats.zsd_price
      : asset === "ZRS"
        ? stats.zrs_price
        : asset === "ZYS"
          ? stats.zys_price
          : stats.zeph_price;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}
