import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ChainType } from "../../wallets";
import type { FeatureFocus } from "../../state/featureFocus";
import {
  initZphSession,
  closeZphWallet,
  getZphSyncProgress,
  checkZphWalletRpcExists,
  downloadZphWalletRpc,
  checkZphDefenderExclusion,
  addZphDefenderExclusion,
} from "../../wallets/zph-wallet";
import {
  storeWallet as storeZphWallet,
  getAllBalances,
  type ZphAssetBalance,
} from "../../wallets/zph-rpc";

export type ZphSyncState =
  | "idle"
  | "starting"
  | "syncing"
  | "synced"
  | "error"
  | "connection-lost";

export interface ZphDownloadProgressPayload {
  stage: string;
  percent: number;
  message: string;
}

/**
 * Zephyr counterpart to `useXmrSession`. Structurally identical minus
 * the transaction-history polling path — ZPH's `get_transfers` is wired
 * at the adapter level but not surfaced in the UI yet, so no history
 * poller here.
 */
export function useZphSession(args: {
  activeChain: ChainType;
  /** Layout-agnostic focus from `deriveFeatureFocus`. */
  focus: FeatureFocus;
  seedLoaded: string | null;
  sessionPassword: string | null;
  refreshBalance: () => void;
}) {
  const { activeChain, focus, seedLoaded, sessionPassword, refreshBalance } = args;

  const [syncState, setSyncState] = useState<ZphSyncState>("idle");
  const [syncPercent, setSyncPercent] = useState(0);
  const [syncWalletHeight, setSyncWalletHeight] = useState(0);
  const [syncDaemonHeight, setSyncDaemonHeight] = useState(0);
  const [syncError, setSyncError] = useState("");
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync-rate estimator — see useXmrSession for the long version.
  const syncSamplesRef = useRef<Array<{ t: number; h: number }>>([]);
  const [syncBlocksPerSec, setSyncBlocksPerSec] = useState<number | null>(null);
  const [syncEtaSeconds, setSyncEtaSeconds] = useState<number | null>(null);

  const [binaryReady, setBinaryReady] = useState<boolean | null>(null);
  const [defenderExcluded, setDefenderExcluded] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<ZphDownloadProgressPayload | null>(null);

  // Multi-asset balances (ZPH + ZSD + ZRS + ZYS). Fetched whenever the
  // session is sync'd or syncing. Drives the multi-asset card on the
  // Zephyr dashboard and the swap modal's "Available" labels. `null`
  // means "not yet fetched"; an empty array means "RPC returned no
  // balances" (vanishingly rare — the wallet always carries at least
  // a zero ZPH entry).
  const [assetBalances, setAssetBalances] = useState<ZphAssetBalance[] | null>(
    null
  );

  const refreshAssetBalances = useCallback(async () => {
    try {
      const balances = await getAllBalances();
      setAssetBalances(balances);
    } catch (e) {
      console.warn("[useZphSession] getAllBalances failed:", e);
    }
  }, []);

  const start = useCallback(
    (seed: string, masterPassword: string, restoreHeight: number = 0, walletFilename?: string) => {
      setSyncState("starting");
      setSyncPercent(0);
      setSyncWalletHeight(0);
      setSyncDaemonHeight(0);
      setSyncError("");
      (async () => {
        try {
          await initZphSession(seed, masterPassword, restoreHeight, walletFilename);
          setSyncState("syncing");
        } catch (e: any) {
          console.error("[useZphSession] init failed:", e);
          setSyncState("error");
          setSyncError(e?.message ?? String(e));
        }
      })();
    },
    []
  );

  const retry = useCallback(() => {
    if (seedLoaded && sessionPassword) {
      start(seedLoaded, sessionPassword);
    }
  }, [seedLoaded, sessionPassword, start]);

  const checkBinaryStatus = useCallback(async () => {
    try {
      const exists = await checkZphWalletRpcExists();
      setBinaryReady(exists);
    } catch {
      setBinaryReady(null);
    }
    try {
      const excluded = await checkZphDefenderExclusion();
      setDefenderExcluded(excluded);
    } catch {
      setDefenderExcluded(null);
    }
  }, []);

  const downloadBinary = useCallback(async () => {
    setDownloading(true);
    setDownloadProgress(null);
    try {
      await downloadZphWalletRpc();
    } catch (e: any) {
      setSyncError("Download failed: " + (typeof e === "string" ? e : e.message));
      setSyncState("error");
    } finally {
      setDownloading(false);
      checkBinaryStatus();
    }
  }, [checkBinaryStatus]);

  const addDefender = useCallback(async () => {
    try {
      const success = await addZphDefenderExclusion();
      setDefenderExcluded(success);
    } catch (e: any) {
      console.error("[useZphSession] add Defender exclusion failed:", e);
    }
  }, []);

  const resetState = useCallback(() => {
    setSyncState("idle");
    setSyncPercent(0);
    setSyncWalletHeight(0);
    setSyncDaemonHeight(0);
    setSyncError("");
    syncSamplesRef.current = [];
    setSyncBlocksPerSec(null);
    setSyncEtaSeconds(null);
  }, []);

  const forget = useCallback(async () => {
    try {
      await closeZphWallet();
    } catch (e) {
      console.warn("[useZphSession] forget cleanup failed:", e);
    }
    resetState();
  }, [resetState]);

  useEffect(() => {
    if (syncPollRef.current) {
      clearInterval(syncPollRef.current);
      syncPollRef.current = null;
    }
    if (
      syncState !== "syncing" &&
      syncState !== "synced" &&
      syncState !== "connection-lost"
    ) {
      return;
    }
    let daemonFailStreak = 0;
    let lastDaemonHeight = 0;
    let lastDaemonProgressAt = Date.now();
    const DAEMON_FAIL_LIMIT = 3;
    const DAEMON_STALL_MS = 5 * 60_000;

    const tick = async () => {
      try {
        const status = await getZphSyncProgress();
        if (!status) return;
        setSyncWalletHeight(status.walletHeight);
        setSyncDaemonHeight(status.daemonHeight);
        setSyncPercent(status.percent);

        const now = Date.now();
        const samples = syncSamplesRef.current;
        if (samples.length === 0 || samples[samples.length - 1].h !== status.walletHeight) {
          samples.push({ t: now, h: status.walletHeight });
        }
        const cutoff = now - 6 * 60_000;
        while (samples.length > 1 && samples[0].t < cutoff) {
          samples.shift();
        }
        if (samples.length >= 2) {
          const first = samples[0];
          const last = samples[samples.length - 1];
          const dtSec = Math.max(0.001, (last.t - first.t) / 1000);
          const dh = last.h - first.h;
          if (dh > 0 && dtSec > 5) {
            const rate = dh / dtSec;
            setSyncBlocksPerSec(rate);
            const remaining = Math.max(0, status.daemonHeight - status.walletHeight);
            setSyncEtaSeconds(remaining / rate);
          } else if (dh <= 0 && dtSec > 30) {
            setSyncBlocksPerSec(0);
            setSyncEtaSeconds(null);
          }
        }

        if (status.daemonOk) {
          daemonFailStreak = 0;
          if (status.daemonHeight !== lastDaemonHeight) {
            lastDaemonHeight = status.daemonHeight;
            lastDaemonProgressAt = Date.now();
          }
        } else {
          daemonFailStreak += 1;
        }

        if (status.synced) {
          setSyncState("synced");
          if (activeChain === "zephyr") refreshBalance();
          return;
        }

        if (daemonFailStreak >= DAEMON_FAIL_LIMIT) {
          setSyncState("connection-lost");
        } else if (
          !status.synced &&
          Date.now() - lastDaemonProgressAt > DAEMON_STALL_MS
        ) {
          setSyncState("connection-lost");
        } else if (syncState === "connection-lost" && status.daemonOk) {
          setSyncState("syncing");
        }
      } catch (e: any) {
        console.error("[useZphSession] sync poll failed:", e);
        daemonFailStreak += 1;
        if (daemonFailStreak >= DAEMON_FAIL_LIMIT) {
          setSyncState("connection-lost");
        }
      }
    };

    tick();
    syncPollRef.current = setInterval(tick, 3000);
    return () => {
      if (syncPollRef.current) {
        clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncState]);

  // 2026-06-13 — auto-recover from a transient init failure. `error` is
  // otherwise a LATCHING state: the sync poll above skips it (it only runs
  // for syncing/synced/connection-lost), so the only exit is a manual
  // retry() on the per-chain panel — nothing on the titlebar clears it. A
  // hiccup during the heavy wallet-rpc re-init that runs after a mem_guard
  // WebView2 reload (daemon probe / wallet-open racing the CPU+GPU miners
  // for CPU & IO) would therefore pin the titlebar red "error" forever even
  // though the backend sidecar self-heals (zph_rpc.rs reclaims the orphan
  // port/child). Schedule a bounded, backed-off retry so a transient
  // failure clears itself; a genuinely broken setup (missing binary, bad
  // seed) still latches after the cap so we never loop. The budget resets
  // only on a REAL recovery (syncing/synced) — not on the intermediate
  // "starting" — so an error→starting→error cycle can't refill it.
  const errorAutoRetryRef = useRef(0);
  useEffect(() => {
    const MAX = 3;
    const BASE_MS = 8000;
    if (syncState === "syncing" || syncState === "synced") {
      errorAutoRetryRef.current = 0;
      return;
    }
    if (syncState !== "error") return;
    if (!seedLoaded || !sessionPassword || downloading) return;
    if (errorAutoRetryRef.current >= MAX) return;
    const attempt = errorAutoRetryRef.current + 1;
    const id = setTimeout(() => {
      errorAutoRetryRef.current = attempt;
      console.warn(`[useZphSession] auto-retry ${attempt}/${MAX} after sync error`);
      retry();
    }, BASE_MS * attempt);
    return () => clearTimeout(id);
  }, [syncState, seedLoaded, sessionPassword, downloading, retry]);

  useEffect(() => {
    if (
      syncState !== "syncing" &&
      syncState !== "synced" &&
      syncState !== "connection-lost"
    ) {
      return;
    }
    const tick = () => {
      void storeZphWallet().catch((e) => {
        console.warn("[useZphSession] store() tick failed (will retry):", e);
      });
    };
    // Immediate fire, then 60s interval — see useXmrSession for rationale.
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [syncState]);

  useEffect(() => {
    if (activeChain === "zephyr" && focus === "dashboard") {
      checkBinaryStatus();
    }
  }, [activeChain, focus, checkBinaryStatus]);

  // Fire `getAllBalances` once when sync transitions to "synced" — gives the
  // swap modal + multi-asset dashboard card a fresh snapshot. Held out of
  // the sync-poll body so it doesn't run every 3-second tick (which would
  // contend with other wallet-rpc calls and risk starving the sync poll
  // itself). Subsequent refreshes happen on swap-success and on explicit
  // user refresh.
  useEffect(() => {
    if (syncState !== "synced") return;
    void refreshAssetBalances();
  }, [syncState, refreshAssetBalances]);

  useEffect(() => {
    let off: (() => void) | null = null;
    listen<ZphDownloadProgressPayload>("zph-download-progress", (event) => {
      setDownloadProgress(event.payload);
      if (event.payload.stage === "complete") {
        setDownloading(false);
        checkBinaryStatus();
      }
    }).then((fn) => {
      off = fn;
    });
    return () => {
      if (off) off();
    };
  }, [checkBinaryStatus]);

  return {
    syncState,
    syncPercent,
    syncWalletHeight,
    syncDaemonHeight,
    syncError,
    syncBlocksPerSec,
    syncEtaSeconds,
    binaryReady,
    defenderExcluded,
    downloading,
    downloadProgress,
    assetBalances,
    refreshAssetBalances,
    start,
    retry,
    downloadBinary,
    addDefender,
    resetState,
    forget,
    setSyncState,
    setSyncError,
  };
}
