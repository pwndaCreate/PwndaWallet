/**
 * Zephyr Protocol remote-node pool + selection / health / hot-swap.
 *
 * Structural mirror of `xmr-nodes.ts`. Differences:
 *   - No Feather-equivalent runtime source (see `zph-nodes-default.ts`
 *     header for the rationale). The pool is the hand-curated default
 *     list only, plus a user pin if set.
 *   - Probe routes through `zph_probe_node` Tauri command (Rust reqwest)
 *     so CORS can't silently eliminate most of the pool the way it did
 *     for the Monero case before the Rust-probe fix.
 *
 * As with Monero: we only contact these nodes when Zephyr is the active
 * chain AND the user has a loaded Zephyr seed — never on app startup.
 */

import { invoke } from "../lib/tauri";
import { getStore } from "../store";
import { ZPH_DEFAULT_NODES } from "./zph-nodes-default";

export interface ZphNode {
  url: string;
  operator: string;
}

/** Re-export of the baked-in pool for the Settings UI. */
export const TRUSTED_ZPH_NODES: ReadonlyArray<ZphNode> = ZPH_DEFAULT_NODES;

/** Store key holding the user-pinned daemon URL ("" = auto). */
const SELECTED_NODE_KEY = "zph_selected_node";

/** Session-level cache: URL of the last known-good node. */
let cachedNodeUrl: string | null = null;

export function clearNodeCache(): void {
  cachedNodeUrl = null;
  stopHealthLoop();
  healthByUrl.clear();
}

// =========================================================================
// User pin
// =========================================================================

export async function getSelectedNode(): Promise<string | null> {
  try {
    const store = await getStore();
    const v = await store.get<string>(SELECTED_NODE_KEY);
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    return null;
  } catch {
    return null;
  }
}

export async function setSelectedNode(url: string | null): Promise<void> {
  const store = await getStore();
  if (url == null || url.trim().length === 0) {
    await store.delete(SELECTED_NODE_KEY);
  } else {
    await store.set(SELECTED_NODE_KEY, url.trim());
  }
  await store.save();
  cachedNodeUrl = null;
}

// =========================================================================
// Rust-backed probe (bypasses webview CORS)
// =========================================================================

interface RustProbeResult {
  url: string;
  ok: boolean;
  latency_ms: number | null;
  height: number | null;
  error: string | null;
}

async function probeNodeRust(
  url: string,
  timeoutMs: number
): Promise<RustProbeResult> {
  return invoke<RustProbeResult>("zph_probe_node", {
    url,
    timeoutMs,
  });
}

// =========================================================================
// Single-node probe (thin wrapper around the Tauri command)
// =========================================================================

export interface NodeTestResult {
  url: string;
  ok: boolean;
  latencyMs?: number;
  height?: number;
  error?: string;
}

export async function testNode(
  url: string,
  timeoutMs: number = 6000
): Promise<NodeTestResult> {
  try {
    const r = await probeNodeRust(url, timeoutMs);
    return {
      url,
      ok: r.ok,
      latencyMs: r.latency_ms ?? undefined,
      height: r.height ?? undefined,
      error: r.error ?? undefined,
    };
  } catch (e: any) {
    return {
      url,
      ok: false,
      error: e?.message ?? String(e),
    };
  }
}

/** Test every trusted node in parallel and record health. */
export async function testAllTrustedNodes(): Promise<NodeTestResult[]> {
  const pool = await getActivePool();
  const results = await Promise.all(pool.map((n) => testNode(n.url)));
  const now = Date.now();
  for (const r of results) recordHealth(r, now);
  return results;
}

// =========================================================================
// Pool assembly
// =========================================================================

/**
 * Merged active pool. Currently just the baked-in list — no runtime
 * community fallback for Zephyr v1. Reserved as an async function so we
 * can add a `zeph.network/api/nodes` fetch later without touching every
 * call site.
 */
export async function getActivePool(): Promise<ZphNode[]> {
  return [...TRUSTED_ZPH_NODES];
}

// =========================================================================
// Health cache
// =========================================================================

interface HealthEntry {
  url: string;
  ok: boolean;
  latencyMs: number;
  height: number;
  lastChecked: number;
  error?: string;
}

const healthByUrl = new Map<string, HealthEntry>();
const HEALTH_FRESH_MS = 5 * 60 * 1000;

/**
 * Hot-swap threshold (same rationale as Monero's): only swap to a new
 * node if it's at least 1.75× faster than the current one. `set_daemon`
 * briefly stalls refresh so we don't flap on small variance.
 */
export const HOT_SWAP_SPEEDUP_THRESHOLD = 1.75;

function recordHealth(r: NodeTestResult, now: number): void {
  healthByUrl.set(r.url, {
    url: r.url,
    ok: r.ok,
    latencyMs: r.latencyMs ?? Number.POSITIVE_INFINITY,
    height: r.height ?? 0,
    lastChecked: now,
    error: r.error,
  });
}

export function getHealthSnapshot(): HealthEntry[] {
  const cutoff = Date.now() - HEALTH_FRESH_MS;
  const fresh: HealthEntry[] = [];
  for (const h of healthByUrl.values()) {
    if (h.lastChecked >= cutoff) fresh.push(h);
  }
  fresh.sort((a, b) => a.latencyMs - b.latencyMs);
  return fresh;
}

/**
 * Lowest-latency healthy node URL. "Healthy" = `ok` AND height within 10
 * blocks of the max seen. The height filter prevents picking a stuck node
 * whose latency is low only because it's serving stale data.
 */
export function getBestNodeUrl(): string | null {
  const fresh = getHealthSnapshot().filter((h) => h.ok);
  if (fresh.length === 0) return null;
  const maxHeight = Math.max(0, ...fresh.map((h) => h.height));
  const caughtUp = fresh.filter((h) => h.height === 0 || h.height >= maxHeight - 10);
  const pool = caughtUp.length > 0 ? caughtUp : fresh;
  return pool[0]?.url ?? null;
}

// =========================================================================
// Background health loop
// =========================================================================

let healthTimer: ReturnType<typeof setInterval> | null = null;
type HealthListener = () => void;
const healthListeners = new Set<HealthListener>();

export function onHealthUpdate(listener: HealthListener): () => void {
  healthListeners.add(listener);
  return () => healthListeners.delete(listener);
}

function fireHealthUpdate(): void {
  for (const l of healthListeners) {
    try {
      l();
    } catch {
      /* listener errors mustn't break the loop */
    }
  }
}

async function runHealthProbe(): Promise<void> {
  const pool = await getActivePool();
  const results = await Promise.all(pool.map((n) => testNode(n.url, 5000)));
  const now = Date.now();
  for (const r of results) recordHealth(r, now);
  fireHealthUpdate();
}

export function startHealthLoop(intervalMs: number = 60_000): void {
  if (healthTimer) return;
  void runHealthProbe();
  healthTimer = setInterval(() => {
    void runHealthProbe();
  }, intervalMs);
}

export function stopHealthLoop(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

// =========================================================================
// Selection helpers
// =========================================================================

/**
 * Try `fn` against: user pin → cached best → full pool in declared order.
 * Throws if everything fails, with combined error message.
 */
export async function tryNodes<T>(
  fn: (url: string) => Promise<T>
): Promise<T> {
  const pinned = await getSelectedNode();
  if (pinned) return fn(pinned);

  if (cachedNodeUrl) {
    try {
      return await fn(cachedNodeUrl);
    } catch {
      cachedNodeUrl = null;
    }
  }

  const best = getBestNodeUrl();
  if (best) {
    try {
      const out = await fn(best);
      cachedNodeUrl = best;
      return out;
    } catch {
      /* fall through */
    }
  }

  const errors: string[] = [];
  const pool = await getActivePool();
  for (const node of pool) {
    try {
      const result = await fn(node.url);
      cachedNodeUrl = node.url;
      return result;
    } catch (e: any) {
      errors.push(`${node.operator} (${node.url}): ${e?.message ?? e}`);
    }
  }

  throw new Error(
    `All Zephyr remote nodes failed:\n${errors.slice(0, 20).join("\n")}`
  );
}

/**
 * Race the merged pool in parallel via `probeNodeRust` and return the URL
 * of the first node to answer `/get_info` with OK status. Cached in
 * `cachedNodeUrl`. If the health cache has a fresh best node, return it
 * without re-probing.
 */
export async function raceBestNode(
  timeoutMs: number = 5000
): Promise<string> {
  const pinned = await getSelectedNode();
  if (pinned) return pinned;

  const best = getBestNodeUrl();
  if (best) {
    cachedNodeUrl = best;
    return best;
  }

  const pool = await getActivePool();
  if (pool.length === 0) {
    throw new Error("Zephyr node pool is empty.");
  }

  const probes = pool.map((node) =>
    probeNodeRust(node.url, timeoutMs).then((r) => {
      if (!r.ok) throw new Error(r.error ?? "probe failed");
      recordHealth(
        {
          url: node.url,
          ok: true,
          height: r.height ?? 0,
          latencyMs: r.latency_ms ?? undefined,
        },
        Date.now()
      );
      return node.url;
    })
  );

  try {
    const url = await Promise.any(probes);
    cachedNodeUrl = url;
    return url;
  } catch {
    throw new Error(
      `No Zephyr node reachable (tried ${pool.length} default nodes).`
    );
  }
}
