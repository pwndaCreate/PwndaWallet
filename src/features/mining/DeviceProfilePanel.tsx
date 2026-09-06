import { useEffect, useState } from "react";
import { invoke } from "../../lib/tauri";
import { Card } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import type { ChainType } from "../../wallets";
import { getCoinMeta } from "../../wallets/coin-metadata";
import {
  CHAIN_MINING_PROFILES,
  type ChainMiningProfile,
} from "./hardware-benchmarks";
import {
  setCalibratedHashrate,
  useDeviceProfile,
  type DeviceRow,
} from "./useDeviceProfile";
import { CALIBRATION_UPDATED_EVENT } from "./useMiner";
import { useCoinStats } from "./useCoinStats";
import { algorithmHashUnit, formatHashrateParts } from "./pool-stats/format";

/**
 * Kryptex-style device panel — Phase 4b of the device-prediction
 * pass. Mounted on the portrait Miner Setup screen.
 *
 * Each detected device (CPU + each GPU) gets a Card. The card shows:
 *   - Device name + class (CPU vs GPU) + cores/VRAM detail.
 *   - Per-eligible-coin row with predicted H/s + $/day, sortable by
 *     `$/day` desc (best-paying first).
 *   - A confidence pill (`exact` / `class` / `calibrated` / `unknown`)
 *     so the user knows how trustworthy the number is.
 *   - A "Calibrate" CTA per row that runs a 30 s benchmark via the
 *     Rust `run_xmrig_benchmark` / `run_gpu_miner_benchmark` commands,
 *     replaces the prediction with the measured value, and persists
 *     it to localStorage via `setCalibratedHashrate`.
 *
 * The panel is purely informational — picking a coin still happens
 * from the Mining tab. The intent is the same as Kryptex's settings
 * sheet: "here's what your hardware is worth on each coin we
 * support, and here's how to refine the estimate".
 */

type BenchmarkResultWire = {
  hashrate: number;
  algorithm: string;
  raw_summary: string;
};

interface CalibrationState {
  running: boolean;
  error?: string | null;
  /** "deviceId:chain" → status. Lets multiple devices calibrate in
   *  series without losing per-row state. */
  perRow: Record<string, { running: boolean; error?: string | null }>;
}

export function DeviceProfilePanel({
  pricesByTicker,
}: {
  pricesByTicker: Record<string, number>;
}) {
  const [refreshTick, setRefreshTick] = useState(0);
  // Live coin params for every chain we mine — WhatToMine first, with
  // per-chain explorer + hardcoded constants as fallbacks. One hook
  // call per chain; `fetchCoinStats` collapses to a single network
  // round-trip across all four.
  const xmrStats = useCoinStats("monero");
  const zphStats = useCoinStats("zephyr");
  const rvnStats = useCoinStats("ravencoin");
  const cfxStats = useCoinStats("conflux");
  const liveCoinParams = {
    monero: xmrStats,
    zephyr: zphStats,
    ravencoin: rvnStats,
    conflux: cfxStats,
  };
  const profile = useDeviceProfile({
    pricesByTicker,
    liveCoinParams,
    refreshTick,
  });
  const [calibration, setCalibration] = useState<CalibrationState>({
    running: false,
    perRow: {},
  });

  // Refresh whenever the auto-calibration hook in `useMiner` writes a
  // new measured value to localStorage during a live mining session.
  // Without this listener the panel would still show the last-known
  // hashrate until something else (a manual Calibrate click, a
  // remount) rebumped `refreshTick`.
  useEffect(() => {
    const handler = () => setRefreshTick((n) => n + 1);
    window.addEventListener(CALIBRATION_UPDATED_EVENT, handler);
    return () => window.removeEventListener(CALIBRATION_UPDATED_EVENT, handler);
  }, []);

  if (profile.loading) {
    return (
      <Card title="DEVICES">
        <div
          style={{
            padding: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--text-dim)",
          }}
        >
          Detecting hardware…
        </div>
      </Card>
    );
  }

  if (profile.error) {
    return (
      <Card title="DEVICES">
        <div
          style={{
            padding: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--warn)",
          }}
        >
          Detection failed: {profile.error}
        </div>
      </Card>
    );
  }

  const runCalibration = async (
    device: DeviceRow,
    profile: ChainMiningProfile
  ) => {
    const rowKey = `${device.id}:${profile.chain}`;
    setCalibration((prev) => ({
      running: true,
      perRow: {
        ...prev.perRow,
        [rowKey]: { running: true, error: null },
      },
    }));
    try {
      let result: BenchmarkResultWire;
      if (device.kind === "cpu") {
        // xmrig's only fully-offline mode is `--bench=N` (hash count).
        // Size the count from the row's existing prediction so the
        // bench lands at ~30 s of runtime regardless of CPU speed:
        // a slow laptop and a Threadripper finish in roughly the
        // same wall-clock time. Fall back to 5 KH/s when no
        // prediction is available; the Rust side clamps to
        // [100K, 5M] regardless.
        const pred = device.predictions[profile.chain];
        const predHashrate =
          pred && pred.hashrate > 0 ? pred.hashrate : 5_000;
        const targetHashes = Math.max(
          100_000,
          Math.min(Math.round(predHashrate * 30), 5_000_000)
        );
        result = await invoke<BenchmarkResultWire>("run_xmrig_benchmark", {
          algorithm: profile.algo === "randomx" ? "rx/0" : profile.algo,
          durationSecs: 30,
          targetHashes,
        });
      } else {
        // device.id is "gpu-<n>" — parse the index so the bench
        // targets only this card. Without it both miners enumerate
        // every visible GPU and the rate would be mis-attributed.
        const gpuIdxMatch = device.id.match(/^gpu-(\d+)$/);
        const gpuIndex = gpuIdxMatch ? Number(gpuIdxMatch[1]) : undefined;
        result = await invoke<BenchmarkResultWire>(
          "run_gpu_miner_benchmark",
          {
            miner: profile.miner,
            algorithm:
              profile.algo === "octopus"
                ? "OCTOPUS"
                : profile.algo === "kawpow"
                  ? "kawpow"
                  : profile.algo,
            durationSecs: 30,
            gpuIndex,
          }
        );
      }
      setCalibratedHashrate(device.name, profile.algo, result.hashrate);
      // Bump refreshTick so useDeviceProfile re-derives predictions
      // using the new calibrated value.
      setRefreshTick((n) => n + 1);
      setCalibration((prev) => ({
        running: false,
        perRow: {
          ...prev.perRow,
          [rowKey]: { running: false, error: null },
        },
      }));
    } catch (e) {
      const msg =
        typeof e === "string" ? e : (e as Error)?.message ?? "Benchmark failed";
      setCalibration((prev) => ({
        running: false,
        perRow: {
          ...prev.perRow,
          [rowKey]: { running: false, error: msg },
        },
      }));
    }
  };

  return (
    <Card title="DEVICES">
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          letterSpacing: 0.4,
          marginBottom: 10,
          fontFamily: "var(--font-mono)",
        }}
      >
        Detected hardware + predicted earnings per supported coin.
        Calibrate to replace the database estimate with a measured one.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {profile.devices.map((d) => (
          <DeviceCard
            key={d.id}
            device={d}
            calibration={calibration}
            onCalibrate={runCalibration}
            pricesByTicker={pricesByTicker}
          />
        ))}
        {profile.devices.length === 0 && (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--text-dim)",
              padding: 8,
            }}
          >
            No devices detected.
          </div>
        )}
      </div>
    </Card>
  );
}

function DeviceCard({
  device,
  calibration,
  onCalibrate,
  pricesByTicker,
}: {
  device: DeviceRow;
  calibration: CalibrationState;
  onCalibrate: (device: DeviceRow, profile: ChainMiningProfile) => void;
  /** Needed so we can distinguish "real $0 profit" from "USD price
   *  missing" when rendering the per-coin earnings cell — see
   *  UXS-20260516-117. The prediction's `perDayUsd` collapses both
   *  states to 0 since `earnings * 0 = 0`. */
  pricesByTicker: Record<string, number>;
}) {
  // Sort eligible coins by predicted $/day desc.
  const eligibleProfiles = CHAIN_MINING_PROFILES.filter((p) =>
    p.hardware.includes(device.kind)
  );
  const ranked = eligibleProfiles
    .map((p) => ({
      profile: p,
      pred: device.predictions[p.chain],
    }))
    .sort((a, b) => (b.pred?.perDayUsd ?? 0) - (a.pred?.perDayUsd ?? 0));

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border-soft)",
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          flexWrap: "wrap",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 1.2,
            textTransform: "uppercase",
          }}
        >
          {device.kind}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text)",
            fontWeight: 500,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {device.name}
        </span>
        <span
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 0.4,
          }}
        >
          {device.detail}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
        }}
      >
        {ranked.map(({ profile, pred }) => {
          const adapter = getCoinMeta(profile.chain);
          const rowKey = `${device.id}:${profile.chain}`;
          const calRow = calibration.perRow[rowKey];
          const running = calRow?.running ?? false;
          const error = calRow?.error;
          const hashUnit = algorithmHashUnit(
            profile.algo === "randomx"
              ? "randomx"
              : (profile.algo as never)
          );
          // Layout: when the row has been calibrated AND the static DB
          // had a different value for this device, the canonical DB
          // number stays in the hero slot (left, where it lived before
          // calibration) and the measured value moves into a `(measured
          // X.XX KH/s)` paren tail on the right. That keeps the
          // user's eye on the same number across the calibrate
          // transition and frames the measured value as the delta
          // information rather than a replacement.
          const hasCalibrationDelta =
            pred?.confidence === "calibrated" &&
            pred.dbHashrate != null &&
            Math.abs(pred.dbHashrate - pred.hashrate) > 1;
          const heroValue = hasCalibrationDelta
            ? pred!.dbHashrate!
            : pred?.hashrate ?? 0;
          const heroParts = heroValue
            ? formatHashrateParts(heroValue, hashUnit)
            : null;
          const measuredParts = hasCalibrationDelta
            ? formatHashrateParts(pred!.hashrate, hashUnit)
            : null;
          return (
            <div
              key={profile.chain}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
                padding: "10px 14px",
                borderBottom: "1px solid var(--border-soft)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <CoinIcon
                sym={adapter.ticker}
                size={20}
                glow={false}
                accent={adapter.color}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text)",
                  }}
                >
                  {adapter.displayName}{" "}
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-dim)",
                      letterSpacing: 0.4,
                    }}
                  >
                    · {profile.algo}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 3,
                  }}
                >
                  <span
                    className="tnum"
                    style={{
                      fontSize: 10,
                      color: hasCalibrationDelta
                        ? "var(--text-muted)"
                        : pred?.confidence === "calibrated"
                          ? "var(--accent)"
                          : pred?.confidence === "unknown"
                            ? "var(--text-dim)"
                            : "var(--text-muted)",
                    }}
                  >
                    {heroParts
                      ? `${heroParts.value} ${heroParts.unit}`
                      : "— H/s"}
                  </span>
                  {measuredParts && (
                    <span
                      className="tnum"
                      style={{
                        fontSize: 9,
                        color: "var(--accent)",
                        letterSpacing: 0.4,
                      }}
                      title="Measured by running the on-device benchmark"
                    >
                      (measured {measuredParts.value} {measuredParts.unit})
                    </span>
                  )}
                  {pred && (
                    <ConfidencePill
                      confidence={pred.confidence}
                      reason={pred.reason}
                    />
                  )}
                </div>
              </div>
              {(() => {
                // UXS-20260516-117: don't render "$0.0000/day" when the
                // underlying issue is a missing USD price — that
                // value is indistinguishable from a genuine zero
                // earnings prediction. Re-derive the price-presence
                // flag at display time so we can show "— /day · price
                // unavailable" only when there's no price to multiply
                // by, and reserve "$0.00/day" for real-zero cases.
                const tickerUpper = profile.ticker.toUpperCase();
                const priceAvailable =
                  typeof pricesByTicker[tickerUpper] === "number" &&
                  pricesByTicker[tickerUpper] > 0;
                const hasEarnings = !!pred && pred.perDayCoin > 0;
                const showRealUsd = pred && priceAvailable;
                return (
                  <div
                    className="tnum"
                    style={{
                      fontSize: 12,
                      color:
                        showRealUsd && pred && pred.perDayUsd > 0
                          ? "var(--accent)"
                          : "var(--text-dim)",
                      textAlign: "right",
                    }}
                    title={
                      !pred
                        ? "No prediction available for this device + coin yet."
                        : !priceAvailable
                          ? "USD/day estimate needs a live price for this coin's ticker. The price fetch may have rate-limited or failed; coin/day below is still computed."
                          : hasEarnings
                            ? "Estimated USD per day at the predicted hashrate."
                            : "Predicted hashrate is too low (or zero) to expect on-chain credit at this difficulty."
                    }
                  >
                    {showRealUsd && pred ? (
                      <>
                        $
                        {pred.perDayUsd.toFixed(
                          pred.perDayUsd >= 100 ? 0 : pred.perDayUsd >= 1 ? 2 : 4,
                        )}
                      </>
                    ) : (
                      <span style={{ letterSpacing: 0.2 }}>—</span>
                    )}
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--text-dim)",
                        marginLeft: 3,
                        letterSpacing: 0.6,
                      }}
                    >
                      /day
                    </span>
                    {!priceAvailable && pred && (
                      <div
                        style={{
                          fontSize: 8,
                          color: "var(--text-dim)",
                          opacity: 0.85,
                          letterSpacing: 0.4,
                          marginTop: 1,
                        }}
                      >
                        price unavailable
                      </div>
                    )}
                  </div>
                );
              })()}
              <button
                className="qbtn"
                onClick={() => onCalibrate(device, profile)}
                disabled={running}
                title={
                  device.kind === "cpu"
                    ? "Run an offline RandomX benchmark on this CPU. Takes up to ~90 seconds — xmrig pegs the CPU at 100 % during the run."
                    : profile.algo === "kawpow"
                      ? "Run a KawPoW probe on this GPU. Takes up to ~2 minutes (DAG + auto-tune + mining window). Requires internet — SRBMiner has no offline KawPoW bench mode, so we briefly connect to a public Ravencoin pool with a burn address."
                      : "Run an offline Octopus benchmark on this GPU. Takes ~30–60 seconds."
                }
                style={{
                  padding: "4px 10px",
                  fontSize: 9,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  borderColor: running ? "var(--accent-mid)" : undefined,
                  color: running ? "var(--accent)" : undefined,
                }}
              >
                {running ? "running…" : "calibrate"}
              </button>
              {running && (
                <div
                  style={{
                    flexBasis: "100%",
                    fontSize: 9,
                    color: "var(--text-dim)",
                    paddingLeft: 30,
                    lineHeight: 1.4,
                    letterSpacing: 0.3,
                  }}
                >
                  {device.kind === "cpu"
                    ? "Calibrating — may take up to 90 seconds. CPU will run at full load until the benchmark window closes."
                    : profile.algo === "kawpow"
                      ? "Calibrating — may take up to 2 minutes. Briefly connects to a public Ravencoin pool (no offline KawPoW bench exists) using a protocol burn address; shares are unspendable."
                      : "Calibrating — may take ~30–60 seconds while the GPU initialises the DAG. Runs offline."}
                </div>
              )}
              {error && (
                <div
                  style={{
                    flexBasis: "100%",
                    fontSize: 9,
                    color: "var(--warn)",
                    paddingLeft: 30,
                    lineHeight: 1.4,
                    wordBreak: "break-word",
                    whiteSpace: "normal",
                  }}
                  title={error}
                >
                  {error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfidencePill({
  confidence,
  reason,
}: {
  confidence: "exact" | "class" | "calibrated" | "unknown";
  reason?: string;
}) {
  const color =
    confidence === "calibrated"
      ? "var(--accent)"
      : confidence === "exact"
        ? "var(--text-muted)"
        : confidence === "class"
          ? "var(--warn)"
          : "var(--text-dim)";
  const label =
    confidence === "calibrated"
      ? "measured"
      : confidence === "exact"
        ? "db"
        : confidence === "class"
          ? "estimate"
          : "unknown";
  const tooltip =
    confidence === "calibrated"
      ? "Measured by running the on-device benchmark."
      : confidence === "exact"
        ? "Exact match in the benchmark database."
        : confidence === "class"
          ? `Architecture-class estimate${reason ? ` — ${reason}` : ""}.`
          : "No data — run Calibrate to measure.";
  return (
    <span
      title={tooltip}
      style={{
        fontSize: 8,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color,
        border: `1px solid ${color}`,
        padding: "1px 5px",
        opacity: 0.85,
      }}
    >
      {label}
    </span>
  );
}
