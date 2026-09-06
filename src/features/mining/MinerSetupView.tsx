import { ST } from "../../components/Primitives";
import { Card } from "../../components/PrimitivesV2";
import type { useMiner } from "./useMiner";
import { DeviceProfilePanel } from "./DeviceProfilePanel";
import { needsLinuxPerfSetup, supportsDefenderExclusion } from "../../platform/os";

type MinerApi = ReturnType<typeof useMiner>;

export function MinerSetupView({
  miner,
  onBack,
  pricesByTicker,
  onDisableMining,
}: {
  miner: MinerApi;
  onBack: () => void;
  pricesByTicker?: Record<string, number>;
  /** Opt-out handler (full wallet only). Stops any live session, clears the
   *  mining opt-in flag, and returns the wallet to its pure, dormant state.
   *  Omitted in PwndaLite (mining is always-on there). See `miningOptIn.ts`. */
  onDisableMining?: () => void | Promise<void>;
}) {
  const {
    minerError,
    defenderExcluded,
    checkingMiners,
    minerStatuses,
    downloadingMiners,
    downloadProgress,
    minersReady,
    addDefenderExclusions,
    downloadMiners,
    reinstallMiners,
  } = miner;

  return (
    <div className="miner-setup-view" style={{ animation: "fade-in .2s ease" }}>
      <div className="mining-header">
        <button
          className="btn-icon"
          onClick={onBack}
          title="Back"
        >
          ► Back
        </button>
        <h2><ST delay={0} speed={22}>MINER SETUP</ST></h2>
      </div>

      {minerError && <div className="miner-error">{minerError}</div>}

      {supportsDefenderExclusion() && defenderExcluded === false && (
        <div className="defender-warning">
          <div className="defender-warning-text">
            <strong>Windows Defender Exclusion</strong>
            <p>Mining executables may be flagged by Windows Defender. Add exclusions to prevent quarantine.</p>
          </div>
          <button className="btn-secondary btn-small" onClick={addDefenderExclusions}>
            Add Exclusions
          </button>
        </div>
      )}

      {supportsDefenderExclusion() && defenderExcluded === true && (
        <div className="defender-ok">
          <span className="status-check">&#10003;</span> Windows Defender exclusions configured
        </div>
      )}

      {needsLinuxPerfSetup() && (
        <div className="defender-warning">
          <div className="defender-warning-text">
            <strong>Linux performance setup (optional)</strong>
            <p>
              For full RandomX hashrate, run <code>sudo modprobe msr</code> and{" "}
              <code>sudo sysctl -w vm.nr_hugepages=1280</code> before mining. Without these,
              XMRig runs unprivileged with a small (~5%) hashrate hit — mining still works.
            </p>
          </div>
          <a
            className="btn-secondary btn-small"
            href="https://xmrig.com/docs/miner/randomx-optimization-guide/msr"
            target="_blank"
            rel="noreferrer"
          >
            Setup guide
          </a>
        </div>
      )}

      <Card title="MINER STATUS">
        {checkingMiners ? (
          <div className="miner-checking">Checking miner status...</div>
        ) : (
          <div className="miner-status-list">
            {minerStatuses.map((s) => (
              <div key={s.name} className={`miner-status-item ${s.exists ? "ready" : "missing"}`}>
                <span className="miner-status-icon">{s.exists ? "✓" : "✗"}</span>
                <span className="miner-status-name">{s.name}</span>
                <span className="miner-status-label">{s.exists ? "Ready" : "Not found"}</span>
              </div>
            ))}
          </div>
        )}

        {downloadingMiners && downloadProgress && (
          <div className="download-progress">
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

        {!minersReady && !downloadingMiners && (
          <button
            className="btn-primary"
            onClick={downloadMiners}
            style={{ width: "100%", marginTop: "12px" }}
          >
            ► Download Mining Software
          </button>
        )}

        {minersReady && (
          <div className="miners-all-ready">
            <span className="status-check">&#10003;</span> All miners installed and ready
            <button
              className="btn-link"
              onClick={reinstallMiners}
              disabled={downloadingMiners}
              style={{ marginLeft: "12px", fontSize: "0.8em" }}
              title="Delete and re-download all miners (fixes missing DLLs)"
            >
              Reinstall All
            </button>
          </div>
        )}
      </Card>

      {/* Kryptex-style per-device prediction panel — shows the user's
          actual hardware + per-coin earnings + Calibrate button. */}
      <div style={{ marginTop: 12 }}>
        <DeviceProfilePanel pricesByTicker={pricesByTicker ?? {}} />
      </div>

      {/* Opt-out — returns the full wallet to its pure, dormant state.
          Stops any live session first (App handler), then clears the
          mining opt-in flag. Absent in PwndaLite (always-on mining). */}
      {onDisableMining && (
        <Card title="MINING IS ON" style={{ marginTop: 12 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.55,
              color: "var(--text-muted)",
            }}
          >
            <p style={{ marginTop: 0, marginBottom: 10 }}>
              Turning mining off stops any running session and returns the
              wallet to its pure, dormant state — no mining code runs until you
              set it up again. Your downloaded miners stay on disk.
            </p>
            <button
              className="btn-secondary btn-small"
              onClick={() => void onDisableMining()}
            >
              Turn off mining
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
