import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ChainType } from "../../wallets";
import type { FeatureFocus } from "../../state/featureFocus";
import {
  initZanoSession,
  closeZanoWallet,
  isZanoSessionActive,
  getZanoAllAssetBalances,
  getZanoTransactionHistory,
} from "../../wallets/zano-wallet";
import {
  isZanoRpcRunning,
  checkZanoBinaryExists,
  downloadZanoWalletRpc,
  type ZanoAssetBalance,
  type ZanoTransferEntry,
} from "../../wallets/zano-rpc";

export type ZanoSyncState =
  | "idle"
  | "starting"
  | "ready"
  | "error";

export interface ZanoDownloadProgressPayload {
  stage: string;
  percent: number;
  message: string;
}

/**
 * Zano counterpart to `useZphSession`. One structural difference, stated
 * plainly rather than silently copied over: there is no height-based sync
 * poller (no wallet-height-vs-daemon-height percent/ETA estimator, the way
 * Monero and Zephyr have). That machinery depends on a verified
 * sync-progress RPC pair, and none was confirmed against the real Zano
 * binary during this integration — `getbalance`/`getaddress`/`store` were
 * verified live, a wallet-vs-daemon height comparison was not. Rather than
 * port Monero's ETA UI onto an unverified assumption, `syncState` here is
 * binary: `starting` while the sidecar spawns and self-heals, `ready` once
 * an authenticated call succeeds. Add the percent/ETA machinery once a real
 * sync-progress shape is confirmed against a live daemon connection.
 */
export function useZanoSession(args: {
  activeChain: ChainType;
  focus: FeatureFocus;
  seedLoaded: string | null;
  seedPassphrase?: string | null;
  sessionPassword: string | null;
  refreshBalance: () => void;
}) {
  const { activeChain, focus, seedLoaded, seedPassphrase, sessionPassword, refreshBalance } =
    args;

  const [syncState, setSyncState] = useState<ZanoSyncState>("idle");
  const [syncError, setSyncError] = useState("");

  const [binaryReady, setBinaryReady] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<ZanoDownloadProgressPayload | null>(null);

  const [assetBalances, setAssetBalances] = useState<ZanoAssetBalance[] | null>(
    null
  );
  const [txHistory, setTxHistory] = useState<ZanoTransferEntry[]>([]);
  const [txLoading, setTxLoading] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshAssetBalances = useCallback(async () => {
    try {
      const balances = await getZanoAllAssetBalances();
      setAssetBalances(balances);
    } catch (e) {
      console.warn("[useZanoSession] getZanoAllAssetBalances failed:", e);
    }
  }, []);

  const refreshTxHistory = useCallback(async () => {
    setTxLoading(true);
    try {
      const history = await getZanoTransactionHistory();
      setTxHistory(history);
    } catch (e) {
      console.warn("[useZanoSession] getZanoTransactionHistory failed:", e);
    } finally {
      setTxLoading(false);
    }
  }, []);

  const start = useCallback(
    (
      seed: string,
      masterPassword: string,
      passphrase = "",
      // Per-wallet sidecar file, from the `zano` WalletEntry. Undefined keeps
      // Zano's original single fixed filename (the migrated primary wallet).
      walletFile?: string,
    ) => {
      setSyncState("starting");
      setSyncError("");
      (async () => {
        try {
          await initZanoSession(seed, masterPassword, passphrase, walletFile);
          setSyncState("ready");
          refreshBalance();
          void refreshAssetBalances();
          void refreshTxHistory();
        } catch (e: any) {
          console.error("[useZanoSession] init failed:", e);
          setSyncState("error");
          setSyncError(e?.message ?? String(e));
        }
      })();
    },
    [refreshBalance, refreshAssetBalances, refreshTxHistory]
  );

  const retry = useCallback(() => {
    if (seedLoaded && sessionPassword) {
      start(seedLoaded, sessionPassword, seedPassphrase ?? "");
    }
  }, [seedLoaded, sessionPassword, seedPassphrase, start]);

  const checkBinaryStatus = useCallback(async () => {
    try {
      const exists = await checkZanoBinaryExists();
      setBinaryReady(exists);
    } catch {
      setBinaryReady(null);
    }
  }, []);

  const downloadBinary = useCallback(async () => {
    setDownloading(true);
    setDownloadProgress(null);
    try {
      await downloadZanoWalletRpc();
    } catch (e: any) {
      // Deliberately surfaced verbatim, not summarized: `zano_download_wallet_rpc`
      // produces three DISTINCT messages ("Download blocked:", "SHA256
      // mismatch", or a generic HTTP/extraction failure) precisely so the UI
      // (or at minimum this console line, until ZanoSyncCard branches on it)
      // can tell a network block apart from a stale pin apart from a bad
      // transfer — collapsing them into one generic string was explicitly
      // ruled out after the 2026-08-27 network-filter incident.
      setSyncError("Download failed: " + (typeof e === "string" ? e : e.message));
      setSyncState("error");
    } finally {
      setDownloading(false);
      checkBinaryStatus();
    }
  }, [checkBinaryStatus]);

  const resetState = useCallback(() => {
    setSyncState("idle");
    setSyncError("");
    setAssetBalances(null);
    setTxHistory([]);
  }, []);

  const forget = useCallback(async () => {
    try {
      await closeZanoWallet();
    } catch (e) {
      console.warn("[useZanoSession] forget cleanup failed:", e);
    }
    resetState();
  }, [resetState]);

  // `start()` is CALLER-triggered, matching `useZphSession`'s convention —
  // not an internal auto-effect. Real trigger points (mirroring ZEPH's
  // `useVault.ts::handleUnlock` / `ZphImportPanel.tsx` / `ViewRouter.tsx`
  // resume-on-view-switch call sites): vault unlock with a stored Zano
  // seed, the import/generate panel's submit handler, and resuming an
  // already-loaded seed when the user switches back to the Zano view. This
  // hook only owns lifecycle STATE, not the decision of *when* a session
  // should start — grep this codebase's `startZphSync(` call sites before
  // assuming this hook self-triggers.
  useEffect(() => {
    if (activeChain === "zano" && focus === "dashboard") {
      void checkBinaryStatus();
    }
  }, [activeChain, focus, checkBinaryStatus]);

  // Lightweight liveness poll while "ready" — no height/percent, just
  // confirms the sidecar is still responding and keeps balances/history
  // fresh. 30s cadence: cheap enough to run continuously, frequent enough
  // that a balance change from an incoming transfer shows up promptly.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (syncState !== "ready") return;

    const tick = async () => {
      const alive = await isZanoRpcRunning().catch(() => false);
      if (!alive) {
        setSyncState("error");
        setSyncError("Zano wallet-rpc stopped responding.");
        return;
      }
      refreshBalance();
      void refreshAssetBalances();
    };
    pollRef.current = setInterval(() => void tick(), 30_000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [syncState, refreshBalance, refreshAssetBalances]);

  useEffect(() => {
    let off: (() => void) | null = null;
    listen<ZanoDownloadProgressPayload>("zano-download-progress", (event) => {
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
    syncError,
    binaryReady,
    downloading,
    downloadProgress,
    assetBalances,
    txHistory,
    txLoading,
    isSessionActive: isZanoSessionActive,
    start,
    retry,
    forget,
    downloadBinary,
    checkBinaryStatus,
    refreshAssetBalances,
    refreshTxHistory,
  };
}
