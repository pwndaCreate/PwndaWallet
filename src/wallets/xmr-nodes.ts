/**
 * Trusted public Monero remote nodes + connection-test / selection helpers.
 *
 * Pool assembly (in priority order):
 *   1. User pin  — `getSelectedNode()` returns a URL and it's always honored.
 *   2. Baked-in Feather nodes (`FEATHER_NODES` in `xmr-nodes-feather.ts`,
 *      regenerated at build time via `scripts/sync-feather-nodes.mjs` from
 *      `feather-wallet/feather-nodes`). Ship-time snapshot — reproducible.
 *   3. Runtime Feather refresh — we re-fetch the same YAML on demand and
 *      merge newer entries into the session pool. Network-dependent, so
 *      always treated as a bonus on top of (2).
 *   4. Community fallback — `xmr.ditatompel.com` list, filtered to
 *      clearnet / mainnet / non-spy / CORS-enabled / uptime >= 90%.
 *      Only consulted when every curated node in (2)+(3) is unreachable.
 *
 * Selection (in priority order):
 *   1. Pinned node (always, never auto-replaced)
 *   2. Cached best node (lowest-latency healthy node from the most recent
 *      probe cycle — populated by `startHealthLoop()` or `testAllTrustedNodes()`)
 *   3. Parallel race — fetch `/get_info` from every pool member at once,
 *      the first non-zero-height response wins.
 *
 * Health loop:
 *   `startHealthLoop()` kicks a 60-second probe cycle that records
 *   latency + height for every pool member. The session's `pickDaemon` uses
 *   this cache to choose a low-latency daemon, and can hot-swap mid-sync
 *   if a sufficiently-faster node appears (see `maybeHotSwap()` in xmr-wallet.ts).
 *
 * Nodes are ONLY contacted when Monero is the active chain and the user
 * has a loaded XMR seed — never on app startup.
 */

import { invoke } from "../lib/tauri";
import { getStore } from "../store";
import { FEATHER_NODES } from "./xmr-nodes-feather";

/**
 * Rust-side `/get_info` probe. Mirrors the Tauri command in
 * `src-tauri/src/xmr_rpc.rs::xmr_probe_node`.
 *
 * We go through the Rust backend (reqwest) instead of a renderer-side
 * `fetch()` to sidestep CORS. The webview origin is `tauri://localhost`
 * and most public Monero nodes don't send `Access-Control-Allow-Origin`,
 * so a renderer fetch fails on the majority of the pool with
 * `TypeError: Failed to fetch`. Rust-side reqwest isn't subject to CORS,
 * so this probe reaches every curated node the same way wallet-rpc
 * reaches them when picked as the daemon.
 */
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
  return invoke<RustProbeResult>("xmr_probe_node", {
    url,
    timeoutMs,
  });
}

export interface XmrNode {
  url: string;
  operator: string;
}

/**
 * Baked-in trusted pool. Sourced from `FEATHER_NODES` (generated from
 * Feather Wallet's `nodes.yaml`). Re-exported as a named constant so the
 * Settings UI can render the full list without a network round-trip.
 *
 * If the generator hasn't been run (e.g. offline first checkout), this
 * will be whatever the last committed snapshot holds.
 */
export const TRUSTED_XMR_NODES: ReadonlyArray<XmrNode> = FEATHER_NODES;

/** Tauri-plugin-store key holding the user-pinned daemon URL ("" = auto). */
const SELECTED_NODE_KEY = "xmr_selected_node";

/**
 * Store key recording the node AUTO mode last actually used.
 *
 * Written for exactly one consumer: the swap sidecar
 * (`swap_sidecar.rs::pinned_node_from_store_json`), which needs a Monero node
 * to pin the swap node's chainclient to. It reads `SELECTED_NODE_KEY` first —
 * but that key only exists when the user hand-pins a node, and auto is the
 * default, so on most installs the sidecar found nothing and prepare fell back
 * to a LOCAL monerod (~80 GB, silently). This key is the auto half: whichever
 * node a real RPC last succeeded against.
 */
const LAST_ACTIVE_NODE_KEY = "xmr_last_active_node";

/**
 * Store key holding recently-healthy node URLs, best first.
 *
 * The swap sidecar's candidate POOL. It bakes ONE node into `basicswap.json`
 * and `run.py` reads that file once at startup, so a node that is down at that
 * moment gives a swap node whose Monero wallet errors for the entire session
 * with no recovery. One remembered node cannot be redundant; this list can.
 *
 * The wallet is the right owner: it already does discovery, health-ranking and
 * fallback over the Feather pool. Rather than duplicate that table in Rust —
 * where the two layers would develop separate opinions about which nodes
 * exist — the wallet publishes what it has actually found working.
 */
const RECENT_NODES_KEY = "xmr_recent_nodes";

/** How many to keep. Enough to survive an outage, short enough that the
 *  sidecar's sequential probe cannot stall a start for long. */
const RECENT_NODES_MAX = 5;

/** Session-level cache: URL of the last known-good node. */
let cachedNodeUrl: string | null = null;

/** Last URL persisted to {@link LAST_ACTIVE_NODE_KEY}, to write only changes. */
let lastPersistedActiveUrl: string | null = null;

/**
 * Record a node a real RPC just succeeded against: session cache plus the
 * store key the swap sidecar reads.
 *
 * Fire-and-forget by design — a preference write must never fail (or even
 * delay) the RPC that already succeeded. Deduplicated so the store is not
 * rewritten on every call with the same winner.
 */
function noteKnownGoodNode(url: string): void {
  cachedNodeUrl = url;
  if (lastPersistedActiveUrl === url) return;
  lastPersistedActiveUrl = url;
  void (async () => {
    try {
      const store = await getStore();
      await store.set(LAST_ACTIVE_NODE_KEY, url);
      // Move-to-front, bounded. Read-modify-write rather than append: the
      // ORDER is the signal the sidecar probes in, so the node that just
      // proved itself has to lead. Dedup by URL so one busy node cannot
      // crowd the others out of the list it is supposed to back up.
      const prev = await store.get<unknown>(RECENT_NODES_KEY);
      const kept = Array.isArray(prev)
        ? prev.filter((u): u is string => typeof u === "string" && u !== url)
        : [];
      // Fill any remaining slots from the curated pool, so the list is a
      // usable candidate set from the FIRST successful RPC rather than after
      // enough sessions to accumulate five proven nodes. Unproven entries sit
      // behind proven ones and the sidecar probes before using any of them —
      // an unreachable filler costs one 4s probe, whereas an empty list costs
      // the whole feature (a single candidate cannot be redundant).
      const fill = TRUSTED_XMR_NODES.map((n) => n.url).filter(
        (u) => u !== url && !kept.includes(u),
      );
      await store.set(
        RECENT_NODES_KEY,
        [url, ...kept, ...fill].slice(0, RECENT_NODES_MAX),
      );
      await store.save();
    } catch {
      // Next successful RPC retries; the sidecar just keeps its previous pin.
      lastPersistedActiveUrl = null;
    }
  })();
}

/**
 * Recently-healthy nodes, best first — the list the swap sidecar probes.
 *
 * Exported for test and for any surface that wants to show what the sidecar
 * would fall back to. Defensive about the stored shape: this file is the only
 * writer, but the store is plain JSON on disk and a hand-edited or
 * partially-written value must not throw on the start path.
 */
export async function getRecentNodes(): Promise<string[]> {
  try {
    const store = await getStore();
    const raw = await store.get<unknown>(RECENT_NODES_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((u): u is string => typeof u === "string" && u.length > 0);
  } catch {
    return [];
  }
}

/**
 * Runtime-refreshed Feather nodes. Merged with baked-in `TRUSTED_XMR_NODES`
 * when building the active pool. Populated by `fetchFeatherNodesRuntime`
 * and cleared on logout via `clearNodeCache`.
 */
let runtimeFeatherCache: XmrNode[] | null = null;

/**
 * Session-level cache of community-discovered fallback nodes.
 * Kept session-scoped — ditatompel's list updates frequently enough that we
 * don't want to pin a snapshot for the life of the app install.
 */
let communityFallbackCache: XmrNode[] | null = null;

/** Clear all session-level node caches (e.g. after logout). */
export function clearNodeCache(): void {
  cachedNodeUrl = null;
  runtimeFeatherCache = null;
  communityFallbackCache = null;
  stopHealthLoop();
  healthByUrl.clear();
}

// =========================================================================
// Runtime Feather refresh
// =========================================================================

const FEATHER_YAML_URL =
  "https://raw.githubusercontent.com/feather-wallet/feather-nodes/master/nodes.yaml";

/**
 * Minimal YAML parser targeted at `feather-wallet/feather-nodes`'s known
 * shape: `mainnet: clearnet: <operator>: [host:port, ...]`. We intentionally
 * do NOT pull in a full YAML parser — the document is small, predictable, and
 * the risk of format drift is managed by also re-running the sync script.
 */
function parseFeatherYamlClearnet(text: string): XmrNode[] {
  const rows: XmrNode[] = [];
  let curNet: string | null = null;
  let curTransport: string | null = null;
  let curOperator: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const hashIdx = rawLine.indexOf("#");
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).replace(
      /\s+$/,
      ""
    );
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();

    if (body.startsWith("- ")) {
      if (curNet !== "mainnet" || curTransport !== "clearnet" || !curOperator) {
        continue;
      }
      const value = body.slice(2).trim().replace(/^['"]|['"]$/g, "");
      if (!value) continue;
      const url = /^https?:\/\//i.test(value)
        ? value.replace(/\/$/, "")
        : `http://${value}`;
      rows.push({ url, operator: curOperator });
      continue;
    }

    const colon = body.indexOf(":");
    if (colon < 0) continue;
    const key = body.slice(0, colon).trim();

    if (indent === 0) {
      curNet = key;
      curTransport = null;
      curOperator = null;
    } else if (indent === 2) {
      curTransport = key;
      curOperator = null;
    } else if (indent === 4) {
      curOperator = key;
    }
  }
  return rows;
}

/**
 * Re-fetch Feather's `nodes.yaml` at runtime and return the parsed mainnet
 * clearnet entries. Cached for the session. Safe to call repeatedly; the
 * second call returns the cached list.
 *
 * We treat the fetched list as additive only — the baked-in list still wins
 * if the fetch fails. Users on a censored network (no GitHub) degrade
 * gracefully to the build-time snapshot.
 */
export async function fetchFeatherNodesRuntime(
  timeoutMs: number = 8000
): Promise<XmrNode[]> {
  if (runtimeFeatherCache) return runtimeFeatherCache;
  try {
    const resp = await fetch(FEATHER_YAML_URL, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return [];
    const text = await resp.text();
    const rows = parseFeatherYamlClearnet(text);
    runtimeFeatherCache = rows;
    return rows;
  } catch {
    return [];
  }
}

/**
 * Union of baked-in + runtime Feather entries, deduped by URL.
 * Runtime entries are appended after baked-in so operator-level ordering
 * from the generated snapshot is preserved (matters for deterministic
 * probe order in the race when the health cache is cold).
 */
export async function getActivePool(): Promise<XmrNode[]> {
  const runtime = await fetchFeatherNodesRuntime().catch(() => []);
  const seen = new Set<string>();
  const merged: XmrNode[] = [];
  for (const n of [...TRUSTED_XMR_NODES, ...runtime]) {
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    merged.push(n);
  }
  return merged;
}

// =========================================================================
// Community fallback: xmr.ditatompel.com
// =========================================================================

interface DitatompelNode {
  hostname: string;
  port: number;
  protocol: "http" | "https" | string;
  is_available: boolean;
  is_tor: boolean;
  is_i2p: boolean;
  ipv6_only: boolean;
  cors: boolean;
  is_spy_node: number;
  nettype: string;
  uptime: number;
}

interface DitatompelResponse {
  data?: {
    items?: DitatompelNode[];
  };
}

/**
 * Fetch the current Monero mainnet remote-node list from xmr.ditatompel.com
 * and return it as a filtered list of `XmrNode` suitable for `tryNodes`.
 *
 * Filters: mainnet, clearnet, IPv4-or-dual, available, non-spy, CORS on,
 * uptime >= 90%. Malicious operators on the list are still possible, so
 * curated entries always win in selection order.
 */
export async function fetchCommunityNodes(
  timeoutMs: number = 8000
): Promise<XmrNode[]> {
  if (communityFallbackCache) return communityFallbackCache;

  const url =
    "https://xmr.ditatompel.com/api/v1/nodes" +
    "?nettype=mainnet&protocol=any&cc=any&status=1&cors=1" +
    "&limit=100&page=1&sort_by=last_checked&sort_direction=desc";

  let body: DitatompelResponse;
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return [];
    body = (await resp.json()) as DitatompelResponse;
  } catch {
    return [];
  }

  const items = body?.data?.items;
  if (!Array.isArray(items)) return [];

  const nodes: XmrNode[] = [];
  for (const n of items) {
    if (!n || typeof n !== "object") continue;
    if (n.nettype !== "mainnet") continue;
    if (!n.is_available) continue;
    if (n.is_tor || n.is_i2p) continue;
    if (n.ipv6_only) continue;
    if (!n.cors) continue;
    if (n.is_spy_node !== 0) continue;
    if (typeof n.uptime === "number" && n.uptime < 90) continue;
    if (n.protocol !== "http" && n.protocol !== "https") continue;
    if (!n.hostname || typeof n.hostname !== "string") continue;
    if (typeof n.port !== "number" || n.port <= 0) continue;

    nodes.push({
      url: `${n.protocol}://${n.hostname}:${n.port}`,
      operator: `community (${n.hostname})`,
    });
  }

  communityFallbackCache = nodes;
  return nodes;
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
// Probing
// =========================================================================

export interface NodeTestResult {
  url: string;
  ok: boolean;
  latencyMs?: number;
  height?: number;
  error?: string;
}

/**
 * Probe a single Monero node by hitting `/get_info` via the Rust backend
 * (reqwest), not a renderer `fetch()`. This bypasses CORS — most public
 * Monero nodes don't set `Access-Control-Allow-Origin`, so a renderer
 * fetch would fail on the majority of the pool and the Settings → Monero
 * Nodes test table would show data for only the 1-2 CORS-friendly nodes
 * (cakewallet, sethforprivacy). Returns within `timeoutMs` (default 6s).
 * Never throws.
 */
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
    // invoke() can only reject if the Tauri command itself errors before
    // producing a result — the command is designed to always return a
    // result value, so this branch is defensive.
    return {
      url,
      ok: false,
      error: e?.message ?? String(e),
    };
  }
}

/**
 * Test every trusted node in parallel. Returns one result per node, in
 * the same order as `TRUSTED_XMR_NODES`. Side effect: updates `healthByUrl`
 * so the best-node cache stays fresh whenever the settings view probes.
 */
export async function testAllTrustedNodes(): Promise<NodeTestResult[]> {
  const pool = await getActivePool();
  const results = await Promise.all(pool.map((n) => testNode(n.url)));
  const now = Date.now();
  for (const r of results) {
    recordHealth(r, now);
  }
  return results;
}

// =========================================================================
// Health-check cache + background loop
// =========================================================================

interface HealthEntry {
  url: string;
  ok: boolean;
  latencyMs: number;
  height: number;
  lastChecked: number; // epoch ms
  error?: string;
}

const healthByUrl = new Map<string, HealthEntry>();

/** Max age (ms) after which a cached health entry is considered stale. */
const HEALTH_FRESH_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Minimum speed-up (multiplier) for an auto hot-swap to kick in. If a
 * newly-probed node is NOT at least this many times faster than the one the
 * session is bound to, we stay put — hot-swapping costs one `set_daemon`
 * RPC which briefly stalls refresh, so we only do it when the win is real.
 */
export const HOT_SWAP_SPEEDUP_THRESHOLD = 1.75;

/** Record the outcome of a probe into the health cache. */
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

/**
 * Return a snapshot of the health cache, sorted by latency ascending.
 * Filters out entries older than `HEALTH_FRESH_MS`.
 */
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
 * Return the lowest-latency healthy node URL from the cache. A node counts
 * as "healthy" if `ok && height within 10 blocks of the max height seen`.
 * The height check prevents picking a stuck node whose latency is low only
 * because it's serving stale data.
 */
export function getBestNodeUrl(): string | null {
  const fresh = getHealthSnapshot().filter((h) => h.ok);
  if (fresh.length === 0) return null;
  const maxHeight = Math.max(0, ...fresh.map((h) => h.height));
  // Allow 10-block slack — remote nodes can lag the tip briefly during
  // block propagation without being "stuck".
  const caughtUp = fresh.filter((h) => h.height === 0 || h.height >= maxHeight - 10);
  const pool = caughtUp.length > 0 ? caughtUp : fresh;
  return pool[0]?.url ?? null;
}

let healthTimer: ReturnType<typeof setInterval> | null = null;
type HealthListener = () => void;
const healthListeners = new Set<HealthListener>();

/**
 * Subscribe to be notified each time the health cache refreshes. Returns
 * an unsubscribe function. Used by the Settings UI to auto-update and by
 * `xmr-wallet.ts` to consider a hot-swap.
 */
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

/** One probe cycle — used by both the initial kick and the timer. */
async function runHealthProbe(): Promise<void> {
  const pool = await getActivePool();
  const results = await Promise.all(pool.map((n) => testNode(n.url, 5000)));
  const now = Date.now();
  for (const r of results) recordHealth(r, now);
  fireHealthUpdate();
}

/**
 * Kick off a background probe loop that refreshes the health cache every
 * `intervalMs` (default 60s). First cycle runs immediately. Safe to call
 * twice — the second call is a no-op.
 */
export function startHealthLoop(intervalMs: number = 60_000): void {
  if (healthTimer) return;
  // Fire once right away so a fresh session doesn't have to wait a full
  // interval before `getBestNodeUrl()` returns anything useful.
  void runHealthProbe();
  healthTimer = setInterval(() => {
    void runHealthProbe();
  }, intervalMs);
}

/** Stop the background health loop and release the timer. */
export function stopHealthLoop(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

// =========================================================================
// Selection helpers (used by xmr-wallet.ts)
// =========================================================================

/**
 * Try `fn` against: user pin → cached best node → parallel race → community
 * fallback. Returns the result of the first successful call. Throws if every
 * layer fails, with a combined error message.
 */
export async function tryNodes<T>(
  fn: (url: string) => Promise<T>
): Promise<T> {
  // 1. User pin always wins, no fallback.
  const pinned = await getSelectedNode();
  if (pinned) {
    return fn(pinned);
  }

  // 2. Session cache (last known-good).
  if (cachedNodeUrl) {
    try {
      return await fn(cachedNodeUrl);
    } catch {
      cachedNodeUrl = null;
    }
  }

  // 3. Prefer whatever the health loop has flagged as lowest-latency.
  const best = getBestNodeUrl();
  if (best) {
    try {
      const out = await fn(best);
      noteKnownGoodNode(best);
      return out;
    } catch {
      /* fall through to full probe */
    }
  }

  // 4. Full probe in declared order over the merged (baked + runtime) pool.
  const errors: string[] = [];
  const pool = await getActivePool();
  for (const node of pool) {
    try {
      const result = await fn(node.url);
      noteKnownGoodNode(node.url);
      return result;
    } catch (e: any) {
      errors.push(`${node.operator} (${node.url}): ${e?.message ?? e}`);
    }
  }

  // 5. Community fallback — only if every curated node failed.
  console.warn(
    "[xmr-nodes] All trusted nodes unreachable; falling back to community pool."
  );
  let fallback: XmrNode[] = [];
  try {
    fallback = await fetchCommunityNodes();
  } catch (e: any) {
    errors.push(`community fallback fetch: ${e?.message ?? e}`);
  }
  for (const node of fallback) {
    try {
      const result = await fn(node.url);
      noteKnownGoodNode(node.url);
      console.warn(`[xmr-nodes] Using community fallback node: ${node.url}`);
      return result;
    } catch (e: any) {
      errors.push(`${node.operator} (${node.url}): ${e?.message ?? e}`);
    }
  }

  throw new Error(
    `All Monero remote nodes failed (curated + community fallback):\n${errors.slice(0, 20).join("\n")}`
  );
}

/**
 * Race the merged pool in parallel via `probeNodeRust` and return the URL
 * of the first node to answer `/get_info` with an OK status. Caches the
 * winner in `cachedNodeUrl`. If the health cache already has a fresh best
 * node we return that immediately (no probes sent).
 *
 * Probes go through the Rust backend (reqwest) to bypass the webview's
 * CORS enforcement — see `probeNodeRust` for the rationale. Previously
 * this used `fetch()` and silently eliminated ~80% of the pool because
 * most public Monero nodes omit `Access-Control-Allow-Origin`; sync
 * would bind to whichever CORS-friendly node (typically cakewallet)
 * happened to respond first rather than the actually-fastest node.
 */
export async function raceBestNode(
  timeoutMs: number = 5000
): Promise<string> {
  const pinned = await getSelectedNode();
  if (pinned) return pinned;

  const best = getBestNodeUrl();
  if (best) {
    noteKnownGoodNode(best);
    return best;
  }

  const pool = await getActivePool();
  if (pool.length === 0) {
    throw new Error("Monero node pool is empty (build-time sync may have failed).");
  }

  const raceOk = async (nodes: XmrNode[]): Promise<string> => {
    const probes = nodes.map((node) =>
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
    return Promise.any(probes);
  };

  try {
    const url = await raceOk(pool);
    noteKnownGoodNode(url);
    return url;
  } catch {
    // Curated + runtime pool exhausted — try community fallback.
    const community = await fetchCommunityNodes().catch(() => []);
    if (community.length === 0) {
      throw new Error(
        `No Monero node reachable (tried ${pool.length} curated, community list empty).`
      );
    }
    try {
      const url = await raceOk(community);
      noteKnownGoodNode(url);
      console.warn(`[xmr-nodes] Using community fallback node: ${url}`);
      return url;
    } catch {
      throw new Error(
        `No Monero node reachable (tried ${pool.length} curated + ${community.length} community).`
      );
    }
  }
}
