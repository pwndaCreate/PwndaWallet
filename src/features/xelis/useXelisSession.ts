import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ChainType } from "../../wallets";
import type { FeatureFocus } from "../../state/featureFocus";
import { errorText } from "../../lib/errorText";
import {
  initXelisSession,
  closeXelisWallet,
  lockXelisWallet,
  getXelisReceiveAddress,
  getXelisBalanceDetailed,
  getXelisSyncStatus,
  getXelisTransactionHistory,
  isXelisSessionActive,
  type XelisBalanceDetail,
} from "../../wallets/xelis-wallet";
import {
  XELIS_DOWNLOAD_PROGRESS_EVENT,
  checkXelisBinaryExists,
  downloadXelisWalletRpc,
  isXelisRpcRunning,
  type XelisSyncStatus,
  type XelisTransferEntry,
} from "../../wallets/xelis-rpc";

export type XelisSyncState = "idle" | "starting" | "syncing" | "synced" | "error";

export interface XelisDownloadProgressPayload {
  stage: string;
  percent: number;
  message: string;
}

/** Status poll while the wallet scans. XELIS blocks arrive about every 5 s. */
export const XELIS_SYNC_POLL_MS = 5_000;
/** Status, balance and history poll once the wallet has synced. */
export const XELIS_READY_POLL_MS = 30_000;

/**
 * Xelis wallet session state. Counterpart of `useZanoSession`, with three
 * deliberate differences:
 *
 *  1. Real sync state. `getXelisSyncStatus` reports the wallet's and the
 *     daemon's topoheights, so `syncState` runs starting → syncing → synced and
 *     the card shows heights. No percentage is computed from them.
 *  2. `retry` reopens the SAME wallet directory `start` was given. Zano's
 *     `retry` used to call `start` without its file, reopening Zano's legacy
 *     fixed filename instead of the entry's own; fixed 2026-09-15 (4a15812 for
 *     the retry path, 6c6669b for the import panel). The ref is kept here
 *     because the hazard is structural, not Zano's alone: a retry that forgets
 *     which wallet it was opening is a retry that can open someone else's.
 *  3. Unknown stays unknown. A thrown balance leaves `balance` null with
 *     `balanceError` set, never "0"; a failed history read sets `txError`, and
 *     `txHistory` is null until a read succeeds, so "not read" never renders as
 *     "no transactions".
 *
 * `start` is caller-triggered, as for every sidecar chain: unlock, add, switch
 * (`useVault`) and the import panel decide when a session starts.
 */
export function useXelisSession(args: {
  activeChain: ChainType;
  focus: FeatureFocus;
  seedLoaded: string | null;
  sessionPassword: string | null;
  /** App's balance refresh for the ACTIVE chain; called only while that is Xelis. */
  refreshBalance: () => void;
  /**
   * Receives the address the running wallet reports once it opens. The
   * in-memory wallet may have been created with "" because the contract lets
   * offline derivation return null.
   */
  onAddress?: (address: string) => void;
}) {
  const { activeChain, focus, seedLoaded, sessionPassword, refreshBalance, onAddress } = args;

  const [syncState, setSyncState] = useState<XelisSyncState>("idle");
  const [syncError, setSyncError] = useState("");
  const [syncStatus, setSyncStatus] = useState<XelisSyncStatus | null>(null);
  const [syncStatusError, setSyncStatusError] = useState<string | null>(null);

  const [binaryReady, setBinaryReady] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<XelisDownloadProgressPayload | null>(null);

  const [balance, setBalance] = useState<XelisBalanceDetail | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [txHistory, setTxHistory] = useState<XelisTransferEntry[] | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  /** The wallet directory the current session was started with. */
  const walletFileRef = useRef<string | undefined>(undefined);
  /** Bumped by every start, forget and lock. A read that finishes under an
   *  older generation belongs to a session the user has already left. */
  const generationRef = useRef(0);

  const refreshBalanceRef = useRef(refreshBalance);
  const onAddressRef = useRef(onAddress);
  const activeChainRef = useRef(activeChain);
  useEffect(() => {
    refreshBalanceRef.current = refreshBalance;
    onAddressRef.current = onAddress;
    activeChainRef.current = activeChain;
  });

  const refreshActiveBalance = useCallback(() => {
    if (activeChainRef.current === "xelis") refreshBalanceRef.current();
  }, []);

  const readBalance = useCallback(async (gen: number) => {
    try {
      const detail = await getXelisBalanceDetailed();
      if (gen !== generationRef.current) return;
      setBalance(detail);
      setBalanceError(null);
    } catch (e) {
      if (gen !== generationRef.current) return;
      setBalance(null);
      setBalanceError(errorText(e, "The wallet did not report a balance."));
    }
  }, []);

  const readHistory = useCallback(async (gen: number) => {
    setTxLoading(true);
    try {
      const history = await getXelisTransactionHistory();
      if (gen !== generationRef.current) return;
      setTxHistory(history);
      setTxError(null);
    } catch (e) {
      if (gen !== generationRef.current) return;
      setTxError(errorText(e, "The wallet did not return its transaction history."));
    } finally {
      if (gen === generationRef.current) setTxLoading(false);
    }
  }, []);

  /** One status read; null when it could not be read. */
  const readStatus = useCallback(async (gen: number): Promise<XelisSyncStatus | null> => {
    const alive = await isXelisRpcRunning().catch(() => false);
    if (gen !== generationRef.current) return null;
    if (!alive) {
      setSyncState("error");
      setSyncError("The Xelis wallet stopped responding.");
      return null;
    }
    try {
      const status = await getXelisSyncStatus();
      if (gen !== generationRef.current) return null;
      setSyncStatus(status);
      setSyncStatusError(null);
      setSyncState(status.synced ? "synced" : "syncing");
      return status;
    } catch (e) {
      if (gen !== generationRef.current) return null;
      setSyncStatusError(errorText(e, "The wallet did not report its sync status."));
      return null;
    }
  }, []);

  const clearSessionData = useCallback(() => {
    setSyncError("");
    setSyncStatus(null);
    setSyncStatusError(null);
    setBalance(null);
    setBalanceError(null);
    setTxHistory(null);
    setTxError(null);
    setTxLoading(false);
  }, []);

  const start = useCallback(
    (seed: string, masterPassword: string, walletFile?: string) => {
      const gen = ++generationRef.current;
      walletFileRef.current = walletFile;
      clearSessionData();
      setSyncState("starting");
      void (async () => {
        try {
          await initXelisSession(seed, masterPassword, walletFile);
          if (gen !== generationRef.current) return;
          const address = getXelisReceiveAddress();
          if (address) onAddressRef.current?.(address);
          setSyncState("syncing");
          await readStatus(gen);
        } catch (e) {
          if (gen !== generationRef.current) return;
          console.error("[useXelisSession] init failed:", errorText(e));
          setSyncState("error");
          setSyncError(errorText(e, "The Xelis wallet could not be opened."));
        }
      })();
    },
    [clearSessionData, readStatus]
  );

  const retry = useCallback(() => {
    if (seedLoaded && sessionPassword) {
      start(seedLoaded, sessionPassword, walletFileRef.current);
    }
  }, [seedLoaded, sessionPassword, start]);

  const checkBinaryStatus = useCallback(async () => {
    try {
      setBinaryReady(await checkXelisBinaryExists());
    } catch {
      setBinaryReady(null);
    }
  }, []);

  const downloadBinary = useCallback(async () => {
    setDownloading(true);
    setDownloadProgress(null);
    try {
      await downloadXelisWalletRpc();
    } catch (e) {
      // Verbatim. The Rust command words a blocked host, a hash mismatch and a
      // network or extraction failure differently, and XelisSyncCard branches
      // on those words.
      setSyncError("Download failed: " + errorText(e));
      setSyncState("error");
    } finally {
      setDownloading(false);
      void checkBinaryStatus();
    }
  }, [checkBinaryStatus]);

  /** Wallet switch and removal: save and stop (`closeXelisWallet`). */
  const forget = useCallback(async () => {
    generationRef.current++;
    walletFileRef.current = undefined;
    try {
      await closeXelisWallet();
    } catch (e) {
      console.warn("[useXelisSession] close failed:", errorText(e));
    }
    clearSessionData();
    setSyncState("idle");
  }, [clearSessionData]);

  /** Lock (`lockXelisWallet`). Xelis has no swap engine to keep the wallet for. */
  const lock = useCallback(async () => {
    generationRef.current++;
    walletFileRef.current = undefined;
    try {
      await lockXelisWallet();
    } catch (e) {
      console.warn("[useXelisSession] lock failed:", errorText(e));
    }
    clearSessionData();
    setSyncState("idle");
  }, [clearSessionData]);

  const refreshTxHistory = useCallback(
    () => readHistory(generationRef.current),
    [readHistory]
  );

  useEffect(() => {
    if (activeChain === "xelis" && focus === "dashboard") {
      void checkBinaryStatus();
    }
  }, [activeChain, focus, checkBinaryStatus]);

  // Reaching "synced" reads the balance and history once; the poll below keeps
  // them fresh after that.
  const previousStateRef = useRef<XelisSyncState>("idle");
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = syncState;
    if (syncState === "synced" && previous !== "synced") {
      const gen = generationRef.current;
      refreshActiveBalance();
      void readBalance(gen);
      void readHistory(gen);
    }
  }, [syncState, refreshActiveBalance, readBalance, readHistory]);

  useEffect(() => {
    if (syncState !== "syncing" && syncState !== "synced") return;
    const gen = generationRef.current;
    const synced = syncState === "synced";
    const id = setInterval(
      () => {
        void (async () => {
          const status = await readStatus(gen);
          if (synced && status?.synced) {
            refreshActiveBalance();
            void readBalance(gen);
            void readHistory(gen);
          }
        })();
      },
      synced ? XELIS_READY_POLL_MS : XELIS_SYNC_POLL_MS
    );
    return () => clearInterval(id);
  }, [syncState, readStatus, refreshActiveBalance, readBalance, readHistory]);

  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    listen<XelisDownloadProgressPayload>(XELIS_DOWNLOAD_PROGRESS_EVENT, (event) => {
      setDownloadProgress(event.payload);
      if (event.payload.stage === "complete") {
        setDownloading(false);
        void checkBinaryStatus();
      }
    })
      .then((unlisten) => {
        if (disposed) {
          try {
            unlisten();
          } catch {
            /* no event bus to detach from (browser sandbox) */
          }
        } else {
          off = unlisten;
        }
      })
      .catch(() => {
        /* no event bus (browser sandbox): progress simply never arrives */
      });
    return () => {
      disposed = true;
      if (off) {
        try {
          off();
        } catch {
          /* see above */
        }
      }
    };
  }, [checkBinaryStatus]);

  return {
    syncState,
    syncError,
    syncStatus,
    syncStatusError,
    binaryReady,
    downloading,
    downloadProgress,
    balance,
    balanceError,
    txHistory,
    txLoading,
    txError,
    isSessionActive: isXelisSessionActive,
    start,
    retry,
    forget,
    lock,
    downloadBinary,
    checkBinaryStatus,
    refreshTxHistory,
  };
}

export type XelisSessionApi = ReturnType<typeof useXelisSession>;
