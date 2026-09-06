import type { PoolDef, PoolId } from "../pools";

/** Raw probe result from the Rust backend (`ping_pool` / `ping_pools`).
 *  `stage` is the furthest stage reached, useful for explaining *why* a
 *  pool failed (firewall vs TLS-MITM vs unreachable host). */
export type RawPingResult = {
  poolId: PoolId;
  ok: boolean;
  latencyMs: number;
  /** Furthest stage reached. v9 (2026-05-23) split `config` out of `dns`
   *  for allowlist misses, and added `authorize` / `notify-wait` for L2 /
   *  L3 escalation failures. See `pool_ping.rs` module docs for the full
   *  taxonomy. */
  stage:
    | "dns"
    | "config"
    | "tcp"
    | "tls"
    | "stratum"
    | "authorize"
    | "notify-wait"
    | "ok";
  error: string | null;
  /** Diagnostic note populated when ok was reached by escalation rather
   *  than at L1 — e.g. `"recovered at L2"`. `null` for clean L1 passes
   *  and for failures. */
  note?: string | null;
};

/** Stored ping result. Same shape as `RawPingResult` plus a frontend-side
 *  `fetchedAt` Date.now() stamp so the auto-ping effect can detect stale
 *  cached entries on tab re-entry. */
export type PoolPingResult = RawPingResult & { fetchedAt: number };

/** How old a cached ping result can be before the auto-ping effect on
 *  mining-tab entry will refresh it. Tuned to avoid spamming the network
 *  on fast tab toggles while still re-checking when the user has likely
 *  changed networks (e.g. switched VPN, moved). */
export const AUTO_PING_STALENESS_MS = 60_000;

/** Stratum-probe request shape sent to the Rust `ping_pool(s)` commands.
 *  `algorithm` drives the per-algo subscribe/login dialect on the Rust
 *  side. `level` (deep test only) opts into the full L1→L2→L3 escalation. */
export interface PingReq {
  poolId: PoolId;
  endpoint: string;
  ssl: boolean;
  algorithm: string;
  level?: number;
}

/** Build the L1 batch-probe request for a single pool. */
export function buildPingReq(pool: PoolDef): PingReq {
  return {
    poolId: pool.id,
    endpoint: pool.endpoint,
    ssl: pool.ssl,
    // Drives the per-algo stratum subscribe/login dialect on the
    // Rust side. RandomX → cryptonote `login`; KawPow & Octopus →
    // ethereum-stratum `mining.subscribe`. See `pool_ping.rs`.
    algorithm: pool.algorithm,
  };
}

/** Build the deep (level-3) probe request for a single pool. */
export function buildDeepPingReq(pool: PoolDef): PingReq {
  return { ...buildPingReq(pool), level: 3 };
}

/** Normalize an unknown thrown value into a human-readable message. */
export function pingErrorMessage(e: unknown): string {
  return typeof e === "string" ? e : (e as any)?.message ?? String(e);
}

/** Synthesize a failed (`stage: "dns"`) result for one pool — used when
 *  the whole probe batch throws before any per-pool result arrives. */
export function failedPingResult(
  poolId: PoolId,
  message: string,
  fetchedAt: number
): PoolPingResult {
  return {
    poolId,
    ok: false,
    latencyMs: 0,
    stage: "dns",
    error: message,
    fetchedAt,
  };
}

/** Synthesize a "✓ active session" result (latency 0) for a pool a miner
 *  is currently bound to — re-probing such a pool risks tripping its
 *  anti-abuse, so we assert connectivity from the live session instead. */
export function activeSessionPingResult(
  poolId: PoolId,
  fetchedAt: number
): PoolPingResult {
  return {
    poolId,
    ok: true,
    latencyMs: 0,
    stage: "ok",
    error: null,
    fetchedAt,
  };
}
