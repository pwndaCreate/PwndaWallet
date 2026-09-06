/**
 * Pure proxy-selection helpers for SOCKS5 Proxy Mode — kept free of React /
 * tauri imports so they're unit-testable. The Rust validator
 * (`proxy_pool.rs`) already returns `validated` sorted working-first by
 * latency + a stability score; this layer adds the "don't pick a clearly
 * dead proxy" gate that was missing on 2026-06-30 (an 11.2s proxy got
 * selected and stalled mining with `connect timeout`).
 */

export type ProxyHealth = {
  hostPort: string;
  latencyMs: number;
  ok: boolean;
  validatedAt: number;
  stage: "tcp" | "socks" | "connect" | "tls" | "ok";
};

/**
 * Upper bound on validation latency for a proxy to be *selectable*. The
 * backend already ranks by latency, so the fastest working proxy is picked
 * first — this just drops the unusable tail. 8 s is a "clearly dead" cutoff,
 * NOT a performance target: it removes proxies like the 11.2 s one that
 * dead-ended mining on 2026-06-30, where surfacing "no usable proxy" (→
 * refresh / Tor / direct) beats silently stalling on a hop that can't
 * sustain stratum. Generous on purpose — the pwnda pool is TLS-via-Pinggy,
 * which inflates validation latency, so a tight cap would over-reject.
 */
export const MAX_USABLE_LATENCY_MS = 8000;

/** Validated proxies that are OK *and* fast enough to actually use. Drives
 *  the low-pool auto-refresh trigger so N dead-slow proxies don't read as
 *  "healthy" and suppress a refresh. */
export function usableProxies(
  validated: ProxyHealth[],
  maxLatencyMs = MAX_USABLE_LATENCY_MS
): ProxyHealth[] {
  return validated.filter((p) => p.ok && p.latencyMs <= maxLatencyMs);
}

/**
 * Pick the proxy to use right now: the pinned one if it's still usable, else
 * the top-ranked usable proxy not in this session's failed set. Returns null
 * when nothing is usable — the caller then surfaces "no usable proxy"
 * (prompting a refresh) instead of selecting a dead hop.
 */
export function pickUsableProxy(
  validated: ProxyHealth[],
  failed: Set<string>,
  pinned: string | null,
  maxLatencyMs = MAX_USABLE_LATENCY_MS
): ProxyHealth | null {
  const usable = usableProxies(validated, maxLatencyMs);
  if (pinned) {
    const pin = usable.find((p) => p.hostPort === pinned);
    if (pin) return pin;
  }
  return usable.find((p) => !failed.has(p.hostPort)) ?? null;
}

// ── Tor transport ────────────────────────────────────────────────────────
// Opt-in "maximum privacy" transport. Routes the miner through a local Tor
// SOCKS5 instead of a scraped public proxy (`--proxy=socks5://127.0.0.1:9050`),
// which gives anonymity to the pool and — with a `.onion` pool — a
// self-authenticating (MITM-proof, no cert-pin) endpoint. See
// [[tor-mining-transport-plan]]. NOTE: requires a Tor daemon listening on
// 9050 (a managed sidecar is the documented next step; today it works with a
// `tor` daemon / Tor Browser running).

/** Local SOCKS5 a standalone `tor` daemon exposes by default (Tor Browser
 *  uses 9150). We target 9050 — the standalone / managed-sidecar default. */
export const TOR_SOCKS5_HOSTPORT = "127.0.0.1:9050";

/** Synthetic proxy entry for the local Tor SOCKS5. Always "selected" in Tor
 *  mode (never validated/rotated like the public pool); `latencyMs: 0` keeps
 *  it above the usable-latency gate. */
export function torProxy(): ProxyHealth {
  return {
    hostPort: TOR_SOCKS5_HOSTPORT,
    latencyMs: 0,
    ok: true,
    validatedAt: 0,
    stage: "ok",
  };
}
