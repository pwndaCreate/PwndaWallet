import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import type { PoolDef } from "./pools";
import { pickUsableProxy, usableProxies, torProxy, type ProxyHealth } from "./proxy-select";

/**
 * SOCKS5 Proxy Mode — opt-in escape hatch for users behind aggressive
 * firewalls that block every direct stratum port we ship. Backend module
 * is `src-tauri/src/proxy_pool.rs`; see also
 * `wiki/concepts/socks5-proxy-mode.md`.
 *
 * The hook owns:
 *
 * - `proxyMode` — main toggle. Persisted in localStorage. Off by default.
 * - `proxyState` — last `RefreshResult` from the Rust validator.
 * - `selectedProxy` — currently active proxy (auto = top-of-rank, or
 *   manually pinned). What `useMiner` reads to thread through to
 *   `start_xmrig_v2` / `start_gpu_miner` / `ping_pools_via_proxy`.
 * - `failedProxies` — set of host:ports the user has marked as failed
 *   during this session, demoted out of auto-selection.
 * - `acceptedRisk` — whether the user has dismissed the one-time warning
 *   modal. Persisted so it doesn't show every launch.
 *
 * Lifecycle: refresh fires automatically when the user toggles ON, when
 * the cached target differs from the current pool, or when the working
 * set drops below 3 entries during use. Manual refresh is also exposed.
 */

const PROXY_MODE_LS_KEY = "pwnda.proxyMode.enabled";
const PROXY_RISK_LS_KEY = "pwnda.proxyMode.riskAccepted";
const PROXY_PIN_LS_KEY = "pwnda.proxyMode.pinnedProxy";
/** "Maximum privacy (Tor)" transport toggle. Mutually exclusive with the
 *  public-SOCKS5 proxy mode — they're alternative transports. */
const PROXY_TOR_LS_KEY = "pwnda.proxyMode.tor";
/** A refresh older than this is treated as stale; auto-refresh will then
 *  fire on the next proxy-mode toggle or `target` change. Bumped from
 *  30 → 60 min when the auto-revalidate-on-pool-change effect was retired
 *  (see Auto-trigger #1 below) — once we stopped re-validating per pool,
 *  the cached working set is the *only* thing keeping selectedProxy fresh,
 *  so the staleness ceiling sets the minimum proxy churn cadence. */
const STALENESS_MS = 60 * 60 * 1000;
/** Minimum number of working proxies to consider the pool healthy. Below
 *  this and the auto-rotation logic kicks off a background refresh. */
const HEALTH_THRESHOLD = 3;

// ProxyHealth + the selection helpers now live in ./proxy-select (pure +
// testable). Re-exported here so existing consumers (useMiner, MiningView)
// keep importing ProxyHealth from useProxyPool unchanged.
export type { ProxyHealth };

export type ProxyTarget = {
  host: string;
  port: number;
  ssl: boolean;
};

export type ProxyState = {
  validated: ProxyHealth[];
  candidatesFetched: number;
  candidatesValidated: number;
  workingCount: number;
  lastRefreshAtMs: number;
  target: ProxyTarget;
  sources: string[];
  error: string | null;
};

function loadFlag(key: string, def = false): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === "1";
  } catch {
    return def;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* localStorage disabled — non-fatal */
  }
}

function loadString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveString(key: string, val: string | null) {
  try {
    if (val === null) localStorage.removeItem(key);
    else localStorage.setItem(key, val);
  } catch {
    /* non-fatal */
  }
}

/** Parse a stratum URL into the (host, port, ssl) shape the Rust validator
 *  expects. Returns null if the input is malformed. */
function parseTarget(pool: PoolDef): ProxyTarget | null {
  const stripped = pool.endpoint
    .replace(/^stratum\+ssl:\/\//, "")
    .replace(/^stratum\+tcp:\/\//, "")
    .replace(/^ssl:\/\//, "")
    .replace(/^tcp:\/\//, "");
  const idx = stripped.lastIndexOf(":");
  if (idx < 0) return null;
  const host = stripped.slice(0, idx);
  const port = parseInt(stripped.slice(idx + 1), 10);
  if (!host || !Number.isFinite(port)) return null;
  return { host, port, ssl: pool.ssl };
}

export function useProxyPool(opts: { selectedPool: PoolDef | null }) {
  const { selectedPool } = opts;

  const [proxyMode, setProxyModeState] = useState<boolean>(() =>
    loadFlag(PROXY_MODE_LS_KEY)
  );
  const [torMode, setTorModeState] = useState<boolean>(() =>
    loadFlag(PROXY_TOR_LS_KEY)
  );
  const [acceptedRisk, setAcceptedRiskState] = useState<boolean>(() =>
    loadFlag(PROXY_RISK_LS_KEY)
  );
  const [proxyState, setProxyState] = useState<ProxyState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [failedProxies, setFailedProxies] = useState<Set<string>>(new Set());
  const [pinnedProxy, setPinnedProxyState] = useState<string | null>(() =>
    loadString(PROXY_PIN_LS_KEY)
  );

  // Sequence number for in-flight refreshes. Each new refresh bumps it;
  // a refresh's result is discarded if a newer one started while it was
  // running. Prevents a slow stale refresh from overwriting fresh state
  // when the user toggles proxy mode rapidly or switches pools mid-validate.
  const refreshSeqRef = useRef(0);

  const setTorMode = useCallback((on: boolean) => {
    setTorModeState(on);
    saveFlag(PROXY_TOR_LS_KEY, on);
    // Tor and the public-SOCKS5 pool are alternative transports — turning Tor
    // on turns the public pool off (and vice versa, in setProxyMode).
    if (on) {
      setProxyModeState(false);
      saveFlag(PROXY_MODE_LS_KEY, false);
    }
  }, []);

  const setProxyMode = useCallback((on: boolean) => {
    setProxyModeState(on);
    saveFlag(PROXY_MODE_LS_KEY, on);
    if (on) {
      setTorModeState(false);
      saveFlag(PROXY_TOR_LS_KEY, false);
    }
    if (!on) {
      // Clear active failures and abandon any in-flight refresh — bumping
      // refreshSeqRef makes the running validation discard its result on
      // completion, and resetting refreshing unblocks the next on-toggle
      // refresh from being skipped by the `if (refreshing) return` guard.
      setFailedProxies(new Set());
      refreshSeqRef.current += 1;
      setRefreshing(false);
    }
  }, []);

  const acceptRisk = useCallback(() => {
    setAcceptedRiskState(true);
    saveFlag(PROXY_RISK_LS_KEY, true);
  }, []);

  const setPinnedProxy = useCallback((hostPort: string | null) => {
    setPinnedProxyState(hostPort);
    saveString(PROXY_PIN_LS_KEY, hostPort);
  }, []);

  const target = useMemo(
    () => (selectedPool ? parseTarget(selectedPool) : null),
    [selectedPool]
  );

  // Single source of truth for "what proxy do we use right now". Pinned
  // override wins; otherwise top-of-rank that hasn't been marked failed.
  const selectedProxy: ProxyHealth | null = useMemo(() => {
    // Tor mode → always route through the local Tor SOCKS5 (no validation /
    // rotation; it isn't part of the scraped public pool).
    if (torMode) return torProxy();
    if (!proxyState) return null;
    // Latency-gated (2026-06-30): never auto-select a proxy too slow to
    // sustain stratum — the stall that day was an 11.2s "working" proxy. The
    // backend already sorts working-first by latency, so this returns the
    // fastest USABLE one (pinned if still usable); null → "no usable proxy",
    // which prompts a refresh instead of silently dead-ending on a dead hop.
    return pickUsableProxy(proxyState.validated, failedProxies, pinnedProxy);
  }, [torMode, proxyState, pinnedProxy, failedProxies]);

  /** Trigger a full fetch+validate cycle. Always validates against the
   *  current `selectedPool` so a passing proxy means "this proxy works
   *  for THIS pool". Force=true bypasses the refreshing guard.
   *
   *  Uses a sequence-number ref so a stale in-flight refresh can't
   *  overwrite the state set by a newer refresh. Important when the
   *  user toggles proxy mode off and on rapidly — the older refresh's
   *  ~15 s validation continues running but its result is now ignored. */
  const refresh = useCallback(
    async (force = false) => {
      if (!target) {
        setRefreshError("Select a pool first");
        return;
      }
      if (refreshing && !force) return;
      const mySeq = ++refreshSeqRef.current;
      setRefreshing(true);
      setRefreshError(null);
      try {
        const result = await invoke<ProxyState>("proxy_refresh", {
          targetHost: target.host,
          targetPort: target.port,
          ssl: target.ssl,
        });
        if (mySeq !== refreshSeqRef.current) {
          // Newer refresh has run since we started — drop our result.
          return;
        }
        setProxyState(result);
        setFailedProxies(new Set());
      } catch (e) {
        if (mySeq !== refreshSeqRef.current) return;
        const msg = typeof e === "string" ? e : (e as any)?.message ?? String(e);
        setRefreshError(msg);
      } finally {
        if (mySeq === refreshSeqRef.current) {
          setRefreshing(false);
        }
      }
    },
    [target, refreshing]
  );

  /** Demote a proxy that failed during use (mining-side reconnect storm,
   *  smoke test stage='tcp'/'tls' through the proxy). Auto-selection
   *  picks the next working entry. */
  const markFailed = useCallback((hostPort: string) => {
    setFailedProxies((prev) => {
      if (prev.has(hostPort)) return prev;
      const next = new Set(prev);
      next.add(hostPort);
      return next;
    });
  }, []);

  // ── Auto-trigger #1: fetch+validate the proxy list once per session
  //    (or after `STALENESS_MS` elapses). Fires when the user enables
  //    proxy mode AND we have no validated set yet OR the cached one
  //    has aged out. Does NOT re-fire on `target` change — a SOCKS5
  //    proxy that works for one stratum endpoint almost always works
  //    for any other (the rare per-pool blocklist is handled at runtime
  //    via `markFailed`). The cache is treated as "this session's
  //    working set" rather than "this pool's working set". User can
  //    force a re-validation against the current pool via the manual
  //    `Refresh` button.
  useEffect(() => {
    if (!proxyMode) return;
    if (!target) return;
    const aged = proxyState
      ? Date.now() - proxyState.lastRefreshAtMs > STALENESS_MS
      : false;
    if (proxyState && !aged) return;
    if (refreshing) return;
    void refresh();
    // Intentionally NOT depending on target.host/port/ssl — see comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyMode]);

  // ── Auto-trigger #2: working set thinned out. When `selectedProxy` is
  //    null AND proxy mode is on AND we're not already refreshing, fire
  //    a background refresh so the user isn't stuck with no proxy.
  const lastBackgroundRefreshRef = useRef(0);
  useEffect(() => {
    if (!proxyMode) return;
    if (!proxyState) return;
    if (refreshing) return;
    // Count only USABLE (ok + fast-enough) proxies — N dead-slow ones must
    // not read as "healthy" and suppress the refresh that would find better.
    const working = usableProxies(proxyState.validated).filter(
      (p) => !failedProxies.has(p.hostPort)
    ).length;
    if (working >= HEALTH_THRESHOLD) return;
    // Throttle: at most one background refresh every 30s.
    const now = Date.now();
    if (now - lastBackgroundRefreshRef.current < 30_000) return;
    lastBackgroundRefreshRef.current = now;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyMode, proxyState, refreshing, failedProxies]);

  return {
    proxyMode,
    setProxyMode,
    torMode,
    setTorMode,
    acceptedRisk,
    acceptRisk,
    proxyState,
    refreshing,
    refreshError,
    selectedProxy,
    pinnedProxy,
    setPinnedProxy,
    failedProxies,
    markFailed,
    refresh,
    target,
  };
}

export type ProxyApi = ReturnType<typeof useProxyPool>;
