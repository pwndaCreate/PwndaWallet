import { useCallback, useState } from "react";
import { invoke } from "../../../lib/tauri";
import type { DownloadProgress, MinerStatus } from "../../../types/mining";

/**
 * Miner-binary management extracted from `useMiner` 2026-06-16. Owns the
 * presence/download/Defender-exclusion state and the four callbacks that
 * mutate it. `setMinerError` is injected because the error banner is
 * shared across many mining concerns and stays owned by `useMiner`.
 *
 * Behaviour is byte-identical to the inline versions: same state initial
 * values, same `useCallback` dependency arrays, same invoke commands and
 * error strings. The orchestrator spreads the returned object into its
 * own return so consumers (`MinerSetupView`, the Settings gateway, the
 * Mining view's setup banner) see no change. See
 * [[mining-process-management]].
 */
export function useMinerSetup(args: {
  setMinerError: (msg: string) => void;
}) {
  const { setMinerError } = args;

  const [minerStatuses, setMinerStatuses] = useState<MinerStatus[]>([]);
  const [minersReady, setMinersReady] = useState(false);
  const [downloadingMiners, setDownloadingMiners] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null);
  const [defenderExcluded, setDefenderExcluded] = useState<boolean | null>(null);
  const [checkingMiners, setCheckingMiners] = useState(false);

  const checkMinerStatus = useCallback(async () => {
    setCheckingMiners(true);
    setMinerError("");
    try {
      const statuses = await invoke<MinerStatus[]>("check_miners_exist");
      setMinerStatuses(statuses);
      const allReady = statuses.every((s) => s.exists);
      setMinersReady(allReady);
      try {
        const excluded = await invoke<boolean>("check_defender_exclusions");
        setDefenderExcluded(excluded);
      } catch {
        setDefenderExcluded(null);
      }
    } catch (e: any) {
      setMinerError("Failed to check miner status: " + e.message);
    } finally {
      setCheckingMiners(false);
    }
  }, [setMinerError]);

  const downloadMiners = useCallback(async () => {
    setDownloadingMiners(true);
    setMinerError("");
    setDownloadProgress(null);
    try {
      await invoke("download_miners");
    } catch (e: any) {
      setMinerError("Download failed: " + (typeof e === "string" ? e : e.message));
      setDownloadingMiners(false);
    }
  }, [setMinerError]);

  const reinstallMiners = useCallback(async () => {
    setMinerError("");
    setDownloadProgress(null);
    try {
      await invoke("delete_miners");
      await checkMinerStatus();
      await downloadMiners();
    } catch (e: any) {
      setMinerError("Reinstall failed: " + (typeof e === "string" ? e : e.message));
    }
  }, [checkMinerStatus, downloadMiners, setMinerError]);

  const addDefenderExclusions = useCallback(async () => {
    setMinerError("");
    try {
      const success = await invoke<boolean>("add_defender_exclusions");
      if (success) {
        setDefenderExcluded(true);
      } else {
        setMinerError("Failed to add Defender exclusions. Try running as administrator.");
      }
    } catch (e: any) {
      setMinerError(
        "Failed to add Defender exclusions: " +
          (typeof e === "string" ? e : e.message)
      );
    }
  }, [setMinerError]);

  return {
    minerStatuses,
    minersReady,
    downloadingMiners,
    downloadProgress,
    defenderExcluded,
    checkingMiners,
    checkMinerStatus,
    downloadMiners,
    reinstallMiners,
    addDefenderExclusions,
    // Setters needed by the orchestrator's `miner-download-progress` listener.
    setDownloadingMiners,
    setDownloadProgress,
  };
}
