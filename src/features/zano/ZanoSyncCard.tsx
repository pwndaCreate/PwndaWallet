import { Card } from "../../components/PrimitivesV2";

interface BinaryDownloadProgress {
  stage: string;
  percent: number;
  message: string;
}

type SyncState = "idle" | "starting" | "ready" | "error";

/**
 * Dashboard sync-status card for Zano. Structural parallel to `ZphSyncCard`,
 * with real differences rather than copied-over ones:
 *
 *  - **No progress bar / block-height display.** `useZanoSession`'s header
 *    explains why: no wallet-height-vs-daemon-height RPC pair was verified
 *    against the real binary, unlike Monero/Zephyr. `starting` just says
 *    "connecting" rather than faking a percentage.
 *  - **No Defender-exclusion branch.** No interference was observed running
 *    `simplewallet.exe` directly during this integration (see the plan's
 *    Phase 0 §3 findings) and no `zano_check_defender_exclusion` /
 *    `zano_add_defender_exclusion` commands were built — porting the
 *    Monero/Zephyr Defender UI onto an unverified assumption would be
 *    exactly the kind of guess this integration has repeatedly had to walk
 *    back elsewhere.
 *  - **A VC++ Redistributable branch instead**, because that IS a verified
 *    real failure mode: the release ZIP bundles 2016-era runtime DLLs and
 *    is missing `VCRUNTIME140_1.dll` outright (Phase 0 §3 §0.8). The Rust
 *    spawn error carries a distinguishable message for this case.
 *  - **Three-way download-error branching**, matching
 *    `zano_download_wallet_rpc`'s deliberate error taxonomy: a network
 *    block (real, observed firsthand against `build.zano.org` on the dev
 *    network), a stale SHA256 pin, or a generic failure. Collapsing these
 *    into one message was explicitly ruled out — see the plan's Phase 3
 *    status and the JWT-bug log entry for why that discipline matters here.
 */
export function ZanoSyncCard({
  syncState,
  syncError,
  binaryReady,
  downloading,
  downloadProgress,
  accentColor,
  onDownloadBinary,
  onRetry,
}: {
  syncState: SyncState;
  syncError: string;
  binaryReady: boolean | null;
  downloading: boolean;
  downloadProgress: BinaryDownloadProgress | null;
  accentColor: string;
  onDownloadBinary: () => void;
  onRetry: () => void;
}) {
  const errorIsMissingBinary =
    binaryReady === false ||
    syncError.includes("binary is missing") ||
    syncError.includes("not found");
  const errorIsMissingRuntime = syncError.includes("Visual C++ Redistributable");
  const errorIsBlockedDownload = syncError.includes("Download blocked:");
  const errorIsHashMismatch = syncError.includes("SHA256 mismatch");

  return (
    <Card title="ZANO SYNC" style={{ marginBottom: 14 }}>
      {syncState === "starting" && (
        <p className="no-wallet-msg">
          Starting the Zano wallet and connecting to a remote node…
        </p>
      )}
      {syncState === "ready" && (
        <p className="no-wallet-msg" style={{ color: accentColor }}>
          Connected.
        </p>
      )}
      {syncState === "error" && (
        <>
          <p className="no-wallet-msg" style={{ color: "#ff6666" }}>
            Zano wallet error: {syncError}
          </p>

          {errorIsMissingRuntime && (
            <p className="hint" style={{ marginTop: 8 }}>
              Install the{" "}
              <a
                href="https://aka.ms/vs/17/release/vc_redist.x64.exe"
                target="_blank"
                rel="noreferrer"
              >
                Microsoft Visual C++ Redistributable (x64)
              </a>{" "}
              and retry.
            </p>
          )}

          {errorIsBlockedDownload && (
            <p className="hint" style={{ marginTop: 8 }}>
              The download connection itself failed rather than timing out or
              erroring at the server — this has been observed as a
              network-level block on some connections. Try a different
              network, or download the ZIP manually from{" "}
              <a href="https://zano.org" target="_blank" rel="noreferrer">
                zano.org
              </a>
              , verify its checksum, and place it as instructed above.
            </p>
          )}

          {errorIsHashMismatch && (
            <p className="hint" style={{ marginTop: 8, color: "#ffaa33" }}>
              The downloaded file's checksum didn't match what this build
              expects. Do not retry blindly — this could mean a newer Zano
              release shipped, or the download was corrupted in transit.
            </p>
          )}

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

          {errorIsMissingBinary && !downloading && (
            <button
              className="btn-primary"
              style={{ width: "100%", marginTop: 12 }}
              onClick={onDownloadBinary}
            >
              ► Download simplewallet.exe
            </button>
          )}

          <button
            className="btn-primary"
            style={{ width: "100%", marginTop: 12 }}
            onClick={onRetry}
            disabled={downloading}
          >
            ► Retry
          </button>
        </>
      )}
    </Card>
  );
}
