import { ST } from "../../src/components/Primitives";
import { Card, Btn } from "../../src/components/PrimitivesV2";
import type { useMiner } from "../../src/features/mining/useMiner";
import { DeviceProfilePanel } from "../../src/features/mining/DeviceProfilePanel";
import { MemoryTraceCard } from "../../src/features/mining/MemoryTraceCard";
import { useAppStateLite, LITE_SUPPORTED_CHAINS } from "../state/AppStateLite";
import { LiteAddressInputCard } from "./LiteAddressInputCard";

type MinerApi = ReturnType<typeof useMiner>;

/**
 * PwndaLite Settings tab body. Three sections, matching the user's intent
 * from the design conversation:
 *
 *   1. Mining address inputs (one per supported chain)
 *   2. Admin / Windows Defender exclusions
 *   3. Miner binaries download
 *
 * Sections 2 and 3 reuse the same Tauri commands the full wallet's
 * `MinerSetupView` calls — they were already wallet-free (the
 * modularization plan confirmed M6 "MinerSetupView's walletsByChain
 * was unused"). We inline the relevant bits here instead of embedding
 * the full `MinerSetupView` because that view has its own "Back"
 * header that conflicts with lite's tab-based navigation.
 */
export function LiteSettingsView({
  miner,
  pricesByTicker,
}: {
  miner: MinerApi;
  pricesByTicker?: Record<string, number>;
}) {
  const { userAddressByChain, setAddressFor } = useAppStateLite();
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
    <div
      className="miner-setup-view"
      style={{ animation: "fade-in .2s ease", padding: 12 }}
    >
      <div className="mining-header" style={{ marginBottom: 10 }}>
        <h2>
          <ST delay={0} speed={22}>
            SETTINGS
          </ST>
        </h2>
      </div>

      {/* ── 1. Mining address inputs ───────────────────────────── */}
      <Card title="MINING ADDRESSES" style={{ marginBottom: 14 }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--text-dim)",
            letterSpacing: 0.4,
            marginBottom: 10,
            lineHeight: 1.5,
          }}
        >
          Paste a payout address for each coin you plan to mine. The address is
          sent to the pool over stratum on every share submission. PwndaLite
          stores it only in this app's local data — never transmitted anywhere
          else.
        </div>
        {LITE_SUPPORTED_CHAINS.map((chain) => (
          <LiteAddressInputCard
            key={chain}
            chain={chain}
            storedAddress={userAddressByChain[chain] ?? null}
            onSave={(addr) => setAddressFor(chain, addr)}
            onClear={() => setAddressFor(chain, "")}
          />
        ))}
      </Card>

      {/* ── 2. Windows Defender exclusions ─────────────────────── */}
      {minerError && (
        <div className="miner-error" style={{ marginBottom: 10 }}>
          {minerError}
        </div>
      )}

      {defenderExcluded === false && (
        <div className="defender-warning" style={{ marginBottom: 10 }}>
          <div className="defender-warning-text">
            <strong>Windows Defender Exclusion</strong>
            <p>
              Mining executables may be flagged by Windows Defender. Add
              exclusions to prevent quarantine.
            </p>
          </div>
          <button
            className="btn-secondary btn-small"
            onClick={addDefenderExclusions}
          >
            Add Exclusions
          </button>
        </div>
      )}
      {defenderExcluded === true && (
        <div className="defender-ok" style={{ marginBottom: 10 }}>
          <span className="status-check">&#10003;</span> Windows Defender
          exclusions configured
        </div>
      )}

      {/* ── 3. Miner binaries ──────────────────────────────────── */}
      <Card title="MINER STATUS" style={{ marginBottom: 14 }}>
        {checkingMiners ? (
          <div className="miner-checking">Checking miner status…</div>
        ) : (
          <div className="miner-status-list">
            {minerStatuses.map((s) => (
              <div
                key={s.name}
                className={`miner-status-item ${
                  s.exists ? "ready" : "missing"
                }`}
              >
                <span className="miner-status-icon">{s.exists ? "✓" : "✗"}</span>
                <span className="miner-status-name">{s.name}</span>
                <span className="miner-status-label">
                  {s.exists ? "Ready" : "Not found"}
                </span>
              </div>
            ))}
          </div>
        )}

        {downloadingMiners && downloadProgress && (
          <div className="download-progress" style={{ marginTop: 10 }}>
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

        {!minersReady && !downloadingMiners && (
          <div style={{ marginTop: 12 }}>
            <Btn onClick={downloadMiners} variant="primary" full>
              Download Mining Software
            </Btn>
          </div>
        )}

        {minersReady && (
          <div className="miners-all-ready" style={{ marginTop: 8 }}>
            <span className="status-check">&#10003;</span> All miners installed
            and ready
            <button
              className="btn-link"
              onClick={reinstallMiners}
              disabled={downloadingMiners}
              style={{ marginLeft: 12, fontSize: "0.8em" }}
              title="Delete and re-download all miners (fixes missing DLLs)"
            >
              Reinstall All
            </button>
          </div>
        )}
      </Card>

      {/* ── 4. Hardware profile (inherited Kryptex-style panel) ── */}
      <DeviceProfilePanel pricesByTicker={pricesByTicker ?? {}} />

      {/* ── 5. DEV-only memory-trace card — V8 heap growth time series
              persisted in localStorage. Added 2026-05-28 to hunt the
              residual WebView2 memory growth that survived the two
              prior rounds of memory-leak fixes. Pass the active view
              so growth-slope inflections can be correlated with which
              panel was on screen. ── */}
      <MemoryTraceCard view="lite-settings" />
    </div>
  );
}
