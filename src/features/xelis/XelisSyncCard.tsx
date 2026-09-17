import { Card } from "../../components/PrimitivesV2";
import type { XelisBalanceDetail } from "../../wallets/xelis-wallet";
import type { XelisSyncStatus } from "../../wallets/xelis-rpc";
import type { XelisDownloadProgressPayload, XelisSyncState } from "./useXelisSession";
import { describeXelisSync } from "./xelisDisplay";

/**
 * Xelis connection, sync and balance status. Counterpart of `ZanoSyncCard`,
 * shared by portrait `DashboardView` and landscape `LandscapeRoot`
 * (`xelisCenterSlot`).
 *
 * Unlike Zano's it stays visible once synced, because it carries what the
 * account card cannot: how far the wallet has scanned, and how much of the
 * balance can be sent now. Everything it prints is something the wallet
 * reported; a missing reading is labelled as missing, never shown as zero.
 */
export function XelisSyncCard({
  syncState,
  syncError,
  syncStatus,
  syncStatusError,
  balance,
  balanceError,
  binaryReady,
  downloading,
  downloadProgress,
  accentColor,
  onDownloadBinary,
  onRetry,
}: {
  syncState: XelisSyncState;
  syncError: string;
  syncStatus: XelisSyncStatus | null;
  syncStatusError: string | null;
  balance: XelisBalanceDetail | null;
  balanceError: string | null;
  binaryReady: boolean | null;
  downloading: boolean;
  downloadProgress: XelisDownloadProgressPayload | null;
  accentColor: string;
  onDownloadBinary: () => void;
  onRetry: () => void;
}) {
  const lower = syncError.toLowerCase();
  // `binaryReady` is the real signal; the words are a fallback for an error
  // raised before the binary check ran.
  const errorIsMissingBinary =
    binaryReady === false || (lower.includes("binary") && /missing|not found/.test(lower));
  const errorIsBlockedDownload = lower.includes("download failed") && lower.includes("blocked");
  const errorIsHashMismatch = lower.includes("sha256") || lower.includes("hash mismatch");
  /**
   * The SAVED seed failed the codec, so no wallet was opened.
   *
   * Worth a branch of its own because the remedy is the opposite of every
   * other error here: `onRetry` re-reads the same vault entry and fails
   * identically, so offering Retry is offering a control that cannot work.
   * The words come from `xelis-wallet.ts::initXelisSession`, which validates
   * before it spawns anything — that check is also what surfaces a bad
   * FIXTURE (a sandbox demo entry once held the seed "demo", and this card
   * reported it as if the user had typed it; 2026-09-15).
   */
  const errorIsBadSeed =
    lower.includes("not a valid xelis seed") ||
    lower.includes("invalid xelis seed") ||
    lower.includes("usable xelis key");

  const view = syncStatus ? describeXelisSync(syncStatus) : null;
  const toneColor =
    view?.tone === "ok" ? accentColor : view?.tone === "warn" ? "var(--warn)" : undefined;

  return (
    <Card title="XELIS SYNC" style={{ marginBottom: 14 }}>
      {syncState === "starting" && (
        <p className="no-wallet-msg" data-xelis-sync="starting">
          Starting the Xelis wallet and connecting to a node…
        </p>
      )}

      {(syncState === "syncing" || syncState === "synced") && (
        <>
          {view ? (
            <>
              <p className="no-wallet-msg" style={{ color: toneColor }} data-xelis-sync={view.tone}>
                {view.headline}
              </p>
              <p className="gas-info" style={{ marginTop: 2 }}>
                {view.detail}
              </p>
              {syncStatusError && (
                <p className="gas-info" style={{ marginTop: 4, color: "var(--warn)" }}>
                  The last status read failed: {syncStatusError}
                </p>
              )}
            </>
          ) : (
            <p className="no-wallet-msg" data-xelis-sync="unknown">
              {syncStatusError
                ? `Sync status unavailable: ${syncStatusError}`
                : "Reading sync status…"}
            </p>
          )}

          {syncState === "synced" && (
            <p className="gas-info" style={{ marginTop: 8 }} data-xelis-balance>
              {balance
                ? balance.hasLocked
                  ? `Balance ${balance.total} XEL, of which ${balance.unlocked} XEL can be sent now.`
                  : `Balance ${balance.total} XEL.`
                : balanceError
                  ? `Balance unknown: ${balanceError}`
                  : "Reading balance…"}
            </p>
          )}
        </>
      )}

      {syncState === "error" && (
        <>
          <p className="no-wallet-msg" style={{ color: "#ff6666" }} data-xelis-sync="error">
            Xelis wallet error: {syncError}
          </p>

          {errorIsBlockedDownload && (
            <p className="hint" style={{ marginTop: 8 }}>
              The download could not reach the release host. Some networks block
              it; try a different network.
            </p>
          )}

          {errorIsHashMismatch && (
            <p className="hint" style={{ marginTop: 8, color: "#ffaa33" }}>
              The downloaded file's checksum did not match what this build
              expects. Do not retry blindly: a newer Xelis release may have
              shipped, or the file was damaged in transit.
            </p>
          )}

          {errorIsBadSeed && (
            <p className="hint" style={{ marginTop: 8, color: "#ffaa33" }}>
              The seed saved for this wallet is not a valid Xelis seed, so no
              wallet was opened. Retrying reads the same saved words and fails
              the same way — re-import the wallet from Settings ▸ Wallets with
              its 25 words. Nothing was deleted.
            </p>
          )}

          {downloading && downloadProgress && (
            <div className="download-progress" style={{ marginTop: 12 }}>
              <div className="download-progress-text">{downloadProgress.message}</div>
              {downloadProgress.stage === "downloading" && (
                <div className="download-progress-bar-wrapper">
                  <div
                    className="download-progress-bar"
                    style={{ width: `${Math.min(downloadProgress.percent, 100)}%` }}
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
              ► Download xelis_wallet
            </button>
          )}

          {/* Not offered for a bad saved seed: `onRetry` re-reads the same
              vault entry, so the button would fail identically every time it
              was pressed. The hint above says what actually fixes it. */}
          {!errorIsBadSeed && (
            <button
              className="btn-primary"
              style={{ width: "100%", marginTop: 12 }}
              onClick={onRetry}
              disabled={downloading}
            >
              ► Retry
            </button>
          )}
        </>
      )}
    </Card>
  );
}
