/**
 * Xelis remote-daemon pool: user pin, health cache, selection.
 *
 * Structural mirror of `zano-nodes.ts` (user pin, then a hand-curated default
 * list; no runtime community tier). The probe is the Rust command
 * `xelis_probe_node`, which POSTs XELIS's JSON-RPC `get_info` to
 * `<url>/json_rpc`. Do not route it through the Monero-shaped
 * `wallet_rpc_common::probe_node`: Zano's first probe did exactly that and got
 * a 404 from a healthy node.
 *
 * Nodes are contacted only while a Xelis wallet session is being established
 * or the node settings are open, never at app start.
 */

import { invoke } from "../lib/tauri";
import { getStore } from "../store";
import { XELIS_DEFAULT_NODES } from "./xelis-nodes-default";

export interface XelisNode {
  url: string;
  operator: string;
}

/** The baked-in pool, for the node settings view. */
export const TRUSTED_XELIS_NODES: ReadonlyArray<XelisNode> = XELIS_DEFAULT_NODES;

/** Store key holding the user-pinned daemon URL (absent = automatic). */
const SELECTED_NODE_KEY = "xelis_selected_node";

/** Last known-good node for this session. */
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
// Probe (Rust side, so the webview's CORS rules never apply)
// =========================================================================

interface RustProbeResult {
  url: string;
  ok: boolean;
  latency_ms: number | null;
  /** The daemon's topoheight. */
  height: number | null;
  error: string | null;
}

async function probeNodeRust(url: string, timeoutMs: number): Promise<RustProbeResult> {
  return invoke<RustProbeResult>("xelis_probe_node", { url, timeoutMs });
}

export interface NodeTestResult {
  url: string;
  ok: boolean;
  latencyMs?: number;
  height?: number;
  error?: string;
}

export async function testNode(url: string, timeoutMs: number = 6000): Promise<NodeTestResult> {
  try {
    const r = await probeNodeRust(url, timeoutMs);
    if (!r || typeof r.ok !== "boolean") {
      return { url, ok: false, error: "The node probe returned no result." };
    }
    return {
      url,
      ok: r.ok,
      latencyMs: r.latency_ms ?? undefined,
      height: r.height ?? undefined,
      error: r.error ?? undefined,
    };
  } catch (e: any) {
    return { url, ok: false, error: e?.message ?? String(e) };
  }
}

/** Test every node in the pool in parallel and record health. */
export async function testAllTrustedNodes(): Promise<NodeTestResult[]> {
  const pool = await getActivePool();
  const results = await Promise.all(pool.map((n) => testNode(n.url)));
  const now = Date.now();
  for (const r of results) recordHealth(r, now);
  fireHealthUpdate();
  return results;
}

/** The pool to choose from. Async so a runtime source can be added later. */
export async function getActivePool(): Promise<XelisNode[]> {
  return [...TRUSTED_XELIS_NODES];
}

// =========================================================================
// Health cache
// =========================================================================

export interface HealthEntry {
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
 * Swap to a different node only when it is at least this much faster, so
 * ordinary latency noise never flaps the connection.
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
 * Lowest-latency healthy node. Healthy means `ok` and within 100 topoheights
 * of the highest seen: at 5 s blocks that is under ten minutes, and it keeps a
 * fast but stalled node from winning.
 */
export function getBestNodeUrl(): string | null {
  const fresh = getHealthSnapshot().filter((h) => h.ok);
  if (fresh.length === 0) return null;
  const maxHeight = Math.max(0, ...fresh.map((h) => h.height));
  const caughtUp = fresh.filter((h) => h.height === 0 || h.height >= maxHeight - 100);
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
      /* a listener's error must not stop the loop */
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
// Selection
// =========================================================================

/**
 * The daemon a new session connects to: the user's pin; else a fresh healthy
 * node from the cache; else the first node in the pool to answer `get_info`.
 */
export async function pickXelisDaemon(timeoutMs: number = 5000): Promise<string> {
  const pinned = await getSelectedNode();
  if (pinned) return pinned;

  const best = getBestNodeUrl();
  if (best) {
    cachedNodeUrl = best;
    return best;
  }
  if (cachedNodeUrl) return cachedNodeUrl;

  const pool = await getActivePool();
  if (pool.length === 0) {
    throw new Error("The Xelis node list is empty.");
  }

  const probes = pool.map((node) =>
    probeNodeRust(node.url, timeoutMs).then((r) => {
      if (!r?.ok) throw new Error(r?.error ?? "probe failed");
      recordHealth(
        { url: node.url, ok: true, height: r.height ?? 0, latencyMs: r.latency_ms ?? undefined },
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
    throw new Error(`No Xelis node answered (tried ${pool.length}).`);
  }
}
