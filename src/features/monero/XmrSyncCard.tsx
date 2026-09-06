import { ST } from "../../components/Primitives";
import { Card } from "../../components/PrimitivesV2";
import { supportsDefenderExclusion } from "../../platform/os";

interface BinaryDownloadProgress {
  stage: string;
  percent: number;
  message: string;
}

type SyncState =
  | "idle"
  | "starting"
  | "syncing"
  | "synced"
  | "connection-lost"
  | "error";

/**
 * Dashboard sync-progress card for Monero. Renders only while the
 * sidecar is starting / scanning / connection-lost / errored — once
 * `syncState === "synced"` the parent stops mounting it and the
 * balance display becomes trustworthy.
 *
 * Defender-exclusion / binary-download branches surface only when the
 * sync error contains the relevant markers ("Defender", "virus",
 * "os error 225", or the binary-missing strings emitted by the
 * Rust sidecar).
 *
 * Structurally near-identical to `ZphSyncCard` but kept separate
 * because the copy diverges (Monero's "many hours" first-sync vs
 * Zephyr's "minutes-to-tens-of-minutes") and a future copy or
 * sync-state divergence is easier to add to two clean files than one
 * parametrized one.
 */
export function XmrSyncCard({
  syncState,
  syncPercent,
  syncWalletHeight,
  syncDaemonHeight,
  syncError,
  defenderExcluded,
  binaryReady,
  downloading,
  downloadProgress,
  accentColor,
  onAddDefenderExclusion,
  onDownloadBinary,
  onRetry,
}: {
  syncState: SyncState;
  syncPercent: number;
  syncWalletHeight: number;
  syncDaemonHeight: number;
  syncError: string;
  defenderExcluded: boolean | null;
  binaryReady: boolean | null;
  downloading: boolean;
  downloadProgress: BinaryDownloadProgress | null;
  accentColor: string;
  onAddDefenderExclusion: () => void;
  onDownloadBinary: () => void;
  onRetry: () => void;
}) {
  const errorMentionsDefender =
    syncError.includes("Defender") ||
    syncError.includes("virus") ||
    syncError.includes("os error 225");

  return (
    <Card title="MONERO SYNC" style={{ marginBottom: 14 }}>
      {syncState === "starting" && (
        <p className="no-wallet-msg">
          Starting monero-wallet-rpc sidecar and connecting to a trusted remote
          node…
        </p>
      )}
      {syncState === "syncing" && (
        <>
          <p className="no-wallet-msg">
            Scanning the Monero blockchain for transactions to this wallet.
            This can take many hours on first sync (scanning from genesis). You
            can close the app and resume later — sync state is saved on disk.
          </p>
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                width: "100%",
                height: 10,
                background: "#222",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${syncPercent.toFixed(1)}%`,
                  height: "100%",
                  background: accentColor,
                  transition: "width 0.5s ease",
                }}
              />
            </div>
            <div className="gas-info" style={{ marginTop: 8 }}>
              {syncPercent.toFixed(2)}% — block{" "}
              {syncWalletHeight.toLocaleString()} /{" "}
              {syncDaemonHeight.toLocaleString()}
            </div>
          </div>
        </>
      )}
      {syncState === "connection-lost" && (
        <>
          <p className="no-wallet-msg" style={{ color: "#ffaa33" }}>
            Lost connection to Monero node. Balance and sync are frozen until
            the node responds. Try switching nodes in Settings → Monero Nodes.
          </p>
          <div className="gas-info" style={{ marginTop: 8 }}>
            Last known: block {syncWalletHeight.toLocaleString()} /{" "}
            {syncDaemonHeight.toLocaleString()}
          </div>
        </>
      )}
      {syncState === "error" && (
        <>
          <p className="no-wallet-msg" style={{ color: "#ff6666" }}>
            Monero sync failed: {syncError}
          </p>

          {/* Defender exclusion prompt — Windows-only. Linux has no AV
              exclusion equivalent, so we hide the prompt entirely there
              even if the (mis-detected) error mentions Defender. */}
          {supportsDefenderExclusion() && errorMentionsDefender && defenderExcluded !== true && (
            <div className="defender-warning" style={{ marginTop: 12 }}>
              <div className="defender-warning-text">
                <strong>Windows Defender Exclusion Required</strong>
                <p>
                  Windows Defender flags Monero binaries as false positives.
                  This is a known issue affecting all Monero wallets (Feather,
                  Cake, CLI). Add an exclusion to allow monero-wallet-rpc to
                  run.
                </p>
              </div>
              <button
                className="btn-secondary btn-small"
                onClick={onAddDefenderExclusion}
              >
                Add Exclusion
              </button>
            </div>
          )}

          {supportsDefenderExclusion() && defenderExcluded === true && errorMentionsDefender && (
            <div className="defender-ok" style={{ marginTop: 12 }}>
              <span className="status-check">&#10003;</span> Defender exclusion
              configured
            </div>
          )}

          {/* Download progress */}
          {downloading && downloadProgress && (
            <div className="download-progress" style={{ marginTop: 12 }}>
              <div className="download-progress-text">
                {downloadProgress.message}
              </div>
              {downloadProgress.stage === "downloading" && (
                <div className="download-progress-bar-wrapper">
                  <div
                    className="download-progress-bar"
                    style={{
                      width: `${Math.min(downloadProgress.percent, 100)}%`,
                    }}
                  />
                </div>
              )}
              {downloadProgress.stage === "extracting" && (
                <div className="download-progress-bar-wrapper">
                  <div className="download-progress-bar extracting" />
                </div>
              )}
            </div>
          )}

          {/* Download binary button — shown when binary is missing */}
          {binaryReady === false && !downloading && (
            <button
              className="btn-primary"
              style={{ width: "100%", marginTop: 12 }}
              onClick={onDownloadBinary}
            >
              ► Download monero-wallet-rpc
            </button>
          )}

          <button
            className="btn-primary"
            style={{ width: "100%", marginTop: 12 }}
            onClick={onRetry}
            disabled={downloading}
          >
            ► Retry sync
          </button>
        </>
      )}
    </Card>
  );
}
