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
 * Dashboard sync-progress card for Zephyr. Structural mirror of
 * `XmrSyncCard` — same Defender / binary-download / retry branches —
 * with copy tuned to Zephyr's faster first-sync (genesis 2023-06, so
 * minutes-to-tens-of-minutes rather than the many hours Monero
 * requires) and the `zephyr-wallet-rpc.exe` binary name.
 *
 * The "wasn't found" / "is missing" sub-string match on the error
 * matches what the Rust sidecar emits when the binary is absent
 * — that mirrors the binary-download branch in `useZphSession`.
 */
export function ZphSyncCard({
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
  const errorIsMissingBinary =
    binaryReady === false ||
    // "wasn't found" is the stable marker; the old `.exe`-specific match was
    // dropped 2026-08-12 along with the Windows-only error text it keyed off
    // (that string could never appear on Linux, where the binary has no
    // extension — so the Download button never surfaced there).
    syncError.includes("wasn't found");

  return (
    <Card title="ZEPHYR SYNC" style={{ marginBottom: 14 }}>
      {syncState === "starting" && (
        <p className="no-wallet-msg">
          Starting zephyr-wallet-rpc sidecar and connecting to a trusted remote
          node…
        </p>
      )}
      {syncState === "syncing" && (
        <>
          <p className="no-wallet-msg">
            Scanning the Zephyr blockchain for transactions to this wallet.
            Zephyr's chain is young (genesis 2023-06) so first sync is
            minutes-to-tens-of-minutes, not the many-hours scan Monero
            requires. You can close the app and resume later — sync state is
            saved on disk.
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
            Lost connection to Zephyr node. Balance and sync are frozen until
            the node responds. Try switching nodes in Settings → Zephyr Nodes.
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
            Zephyr sync failed: {syncError}
          </p>

          {/* Defender exclusion prompt — Zephyr variant of the Monero
              branch. Windows-only; Linux has no AV exclusion equivalent. */}
          {supportsDefenderExclusion() && errorMentionsDefender && defenderExcluded !== true && (
            <div className="defender-warning" style={{ marginTop: 12 }}>
              <div className="defender-warning-text">
                <strong>Windows Defender Exclusion Required</strong>
                <p>
                  Windows Defender flags Monero-lineage binaries (including
                  Zephyr's wallet-rpc) as false positives. Add an exclusion to
                  allow zephyr-wallet-rpc to run.
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

          {/* Download progress — reuses the same CSS classes as the Monero
              download. */}
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

          {/* Download-binary button — shown when the error is clearly a
              missing-binary one. */}
          {errorIsMissingBinary && !downloading && (
            <button
              className="btn-primary"
              style={{ width: "100%", marginTop: 12 }}
              onClick={onDownloadBinary}
            >
              ► Download zephyr-wallet-rpc
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
