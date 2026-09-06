import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ChainType } from "../../wallets";
import type { FeatureFocus } from "../../state/featureFocus";
import {
  initXmrSession,
  closeXmrWallet,
  getActiveXmrWalletFilename,
  getXmrSyncProgress,
  getXmrReceiveAddress,
  refreshXmrReceiveAddress,
  getXmrTransactionHistory,
  checkWalletRpcExists,
  downloadWalletRpc,
  checkXmrDefenderExclusion,
  addXmrDefenderExclusion,
  type XmrTransfer,
} from "../../wallets/xmr-wallet";
import { storeWallet as storeXmrWallet, deleteXmrWalletFiles } from "../../wallets/xmr-rpc";

export type XmrSyncState =
  | "idle"
  | "starting"
  | "syncing"
  | "synced"
  | "error"
  | "connection-lost";

export interface XmrDownloadProgressPayload {
  stage: string;
  percent: number;
  message: string;
}

/**
 * Owns the full lifecycle of the Monero sidecar + sync state + receive
 * address + transaction history + binary+Defender check. App-level
 * callers supply identity + shared context (active chain, current view,
 * session password, balance-refresh callback) and read the returned
 * state slice.
 */
export function useXmrSession(args: {
  activeChain: ChainType;
  /** Layout-agnostic focus from `deriveFeatureFocus`. Replaces the old
   *  `view` arg so landscape mode triggers session lifecycle correctly. */
  focus: FeatureFocus;
  seedLoaded: string | null;
  sessionPassword: string | null;
  refreshBalance: () => void;
}) {
  const { activeChain, focus, seedLoaded, sessionPassword, refreshBalance } = args;

  const [syncState, setSyncState] = useState<XmrSyncState>("idle");
  const [syncPercent, setSyncPercent] = useState(0);
  const [syncWalletHeight, setSyncWalletHeight] = useState(0);
  const [syncDaemonHeight, setSyncDaemonHeight] = useState(0);
  const [syncError, setSyncError] = useState("");
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Rolling-window sync-rate estimator. Each sample is (timestamp_ms,
  // walletHeight). `syncBlocksPerSec` comes from the oldest vs newest sample
  // in the window — a longer window smooths over the stop-and-go behavior
  // wallet-rpc has when scanning in batches. `syncEtaSeconds` is
  // (daemonHeight - walletHeight) / rate. Both are `null` until we have
  // enough samples + forward progress to make a meaningful estimate.
  const syncSamplesRef = useRef<Array<{ t: number; h: number }>>([]);
  const [syncBlocksPerSec, setSyncBlocksPerSec] = useState<number | null>(null);
  const [syncEtaSeconds, setSyncEtaSeconds] = useState<number | null>(null);

  const [txHistory, setTxHistory] = useState<XmrTransfer[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const txPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [receiveAddress, setReceiveAddress] = useState<string | null>(null);
  // Default to showing the primary "4..." address; the subaddress "8..." is
  // available on demand. Subaddresses are privacy-preferable for per-payment
  // links, but most users expect their primary address to be visible first
  // (what block explorers and most wallet UIs show), so we flipped the
  // default here and left the explicit "Show subaddress" toggle in the UI.
  const [showPrimary, setShowPrimary] = useState(true);

  const [binaryReady, setBinaryReady] = useState<boolean | null>(null);
  const [defenderExcluded, setDefenderExcluded] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<XmrDownloadProgressPayload | null>(null);

  const start = useCallback(
    (seed: string, masterPassword: string, restoreHeight: number = 0, walletFilename?: string) => {
      setSyncState("starting");
      setSyncPercent(0);
      setSyncWalletHeight(0);
      setSyncDaemonHeight(0);
      setSyncError("");
      (async () => {
        try {
          await initXmrSession(seed, masterPassword, restoreHeight, walletFilename);
          setSyncState("syncing");
        } catch (e: any) {
          console.error("[useXmrSession] init failed:", e);
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
      const exists = await checkWalletRpcExists();
      setBinaryReady(exists);
    } catch {
      setBinaryReady(null);
    }
    try {
      const excluded = await checkXmrDefenderExclusion();
      setDefenderExcluded(excluded);
    } catch {
      setDefenderExcluded(null);
    }
  }, []);

  const downloadBinary = useCallback(async () => {
    setDownloading(true);
    setDownloadProgress(null);
    try {
      await downloadWalletRpc();
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
      const success = await addXmrDefenderExclusion();
      setDefenderExcluded(success);
    } catch (e: any) {
      console.error("[useXmrSession] add Defender exclusion failed:", e);
    }
  }, []);

  const refreshReceiveAddress = useCallback(async () => {
    try {
      const addr = await refreshXmrReceiveAddress();
      setReceiveAddress(addr);
      return addr;
    } catch (e: any) {
      console.error("[useXmrSession] refresh receive address failed:", e);
      throw e;
    }
  }, []);

  const resetState = useCallback(() => {
    setSyncState("idle");
    setSyncPercent(0);
    setSyncWalletHeight(0);
    setSyncDaemonHeight(0);
    setSyncError("");
    setTxHistory([]);
    setReceiveAddress(null);
    syncSamplesRef.current = [];
    setSyncBlocksPerSec(null);
    setSyncEtaSeconds(null);
  }, []);

  /**
   * Lock: close the wallet and release this caller's claim on the
   * wallet-rpc sidecar (see {@link XmrLease} — under C9 the process itself
   * may stay up for the swap engine even though this releases "session").
   * Files stay on disk. This is what "Settings > Lock" and switching to a
   * wallet context with no Monero entry should call — NOT `forget`.
   *
   * Split out 2026-08-21: both call sites used to go through `forget`,
   * which deletes the wallet file. Locking is not forgetting — every lock
   * was silently discarding scan state and forcing a full rescan on the
   * next unlock, and switching wallet context was deleting the PREVIOUS
   * context's Monero wallet outright. See PwndaWalletVault/log.md.
   */
  const lock = useCallback(async () => {
    try {
      await closeXmrWallet();
    } catch (e) {
      console.warn("[useXmrSession] lock cleanup failed:", e);
    }
    resetState();
  }, [resetState]);

  /**
   * Forget: close the wallet AND delete its files. Destructive — only for
   * an explicit "remove this wallet" action (Settings > Wallets' remove
   * button; see `useVault.removeWallet`'s primary-XMR branch), never for
   * Lock or a context switch.
   *
   * Reads the filename BEFORE closing: `closeXmrWallet()` nulls the active
   * session, so `getActiveXmrWalletFilename()` must run first or it always
   * sees `null` and the delete call falls back to the primary wallet's
   * name — deleting the wrong file for a non-primary (Phase-2 multi-wallet)
   * XMR entry.
   */
  const forget = useCallback(async () => {
    const filename = getActiveXmrWalletFilename() ?? undefined;
    try {
      await closeXmrWallet();
      await deleteXmrWalletFiles(filename);
    } catch (e) {
      console.warn("[useXmrSession] forget cleanup failed:", e);
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
        const status = await getXmrSyncProgress();
        if (!status) return;
        setSyncWalletHeight(status.walletHeight);
        setSyncDaemonHeight(status.daemonHeight);
        setSyncPercent(status.percent);

        // Rolling sync-rate window — keep last 6 min of samples, compute
        // blocks/sec from the oldest vs newest to smooth out wallet-rpc's
        // burst/idle scan rhythm.
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
            // No progress for 30+ seconds — signal "stalled" by clearing ETA.
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
          if (activeChain === "monero") refreshBalance();
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
        console.error("[useXmrSession] sync poll failed:", e);
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

  // 2026-06-13 — auto-recover from a transient init failure. Mirrors
  // useZphSession: `error` is a LATCHING state (the sync poll above skips
  // it), so a hiccup during the heavy wallet-rpc re-init after a mem_guard
  // WebView2 reload would pin the titlebar red "error" forever even though
  // the backend sidecar self-heals. Bounded, backed-off retry; budget
  // resets only on a real recovery (syncing/synced), never on "starting".
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
      console.warn(`[useXmrSession] auto-retry ${attempt}/${MAX} after sync error`);
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
      void storeXmrWallet().catch((e) => {
        console.warn("[useXmrSession] store() tick failed (will retry):", e);
      });
    };
    // Fire immediately on entering a store-worthy state so the first minute
    // of scan progress isn't lost on an early hard-kill. Then keep ticking
    // every 60s to bound worst-case loss.
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [syncState]);

  useEffect(() => {
    if (activeChain !== "monero" || !seedLoaded) {
      setReceiveAddress(null);
      return;
    }
    if (syncState === "idle" || syncState === "error") {
      return;
    }
    let cancelled = false;
    const tryFetch = () => {
      if (cancelled) return;
      const addr = getXmrReceiveAddress();
      if (addr) setReceiveAddress(addr);
    };
    tryFetch();
    const t = setInterval(tryFetch, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activeChain, seedLoaded, syncState]);

  useEffect(() => {
    if (txPollRef.current) {
      clearInterval(txPollRef.current);
      txPollRef.current = null;
    }
    if (
      activeChain !== "monero" ||
      focus !== "dashboard" ||
      !seedLoaded ||
      (syncState !== "synced" && syncState !== "syncing")
    ) {
      return;
    }
    const tick = async () => {
      try {
        setTxLoading(true);
        const history = await getXmrTransactionHistory();
        setTxHistory(history);
      } catch (e) {
        console.error("[useXmrSession] tx history fetch failed:", e);
      } finally {
        setTxLoading(false);
      }
    };
    tick();
    txPollRef.current = setInterval(tick, 15_000);
    return () => {
      if (txPollRef.current) {
        clearInterval(txPollRef.current);
        txPollRef.current = null;
      }
    };
  }, [activeChain, focus, seedLoaded, syncState]);

  useEffect(() => {
    if (activeChain === "monero" && focus === "dashboard") {
      checkBinaryStatus();
    }
  }, [activeChain, focus, checkBinaryStatus]);

  useEffect(() => {
    let off: (() => void) | null = null;
    listen<XmrDownloadProgressPayload>("xmr-download-progress", (event) => {
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
    txHistory,
    txLoading,
    receiveAddress,
    showPrimary,
    setShowPrimary,
    binaryReady,
    defenderExcluded,
    downloading,
    downloadProgress,
    start,
    retry,
    downloadBinary,
    addDefender,
    refreshReceiveAddress,
    resetState,
    lock,
    forget,
    setSyncState,
    setSyncError,
  };
}
