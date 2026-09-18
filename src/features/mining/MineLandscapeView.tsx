import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChainType } from "../../wallets";
import { ALL_CHAINS, getCoinMeta } from "../../wallets/coin-metadata";
import { CoinIcon } from "../../components/CoinIcon";
import { Btn } from "../../components/PrimitivesV2";
import { HashrateAreaChart } from "./HashrateAreaChart";
import { ST } from "../../components/Primitives";
import { algorithmHashUnit, formatHashrateParts } from "./pool-stats/format";
import { PoolStatsPanel, getStatsAdapter } from "./pool-stats";
import { poolHostPort, decoratePoolLabel } from "./pools";
import { ProxyModePanel } from "./ProxyModePanel";
import {
  MINING_COINS,
  coinLanes,
  coinMinesOn,
  lanesLabel,
} from "./miningCoins";
import { ALGORITHM_LABEL } from "./algorithms";
import { coinTileLocked, pickMiningCoin } from "./pickCoin";
import { formatUsdPerDay, useMinedAssetView } from "./minedAssetView";
import { useMiningEarnings } from "./useMiningEarnings";
import {
  cpuLaneMiner,
  cpuThreadsLabel,
  laneHasIntensity,
  laneIntensityLabel,
  startBlocker,
} from "./miningLane";
import type { MiningProjection } from "../../types/mining";
import { MineSimpleView } from "./MineSimpleView";
import { readMineViewMode, writeMineViewMode, type MineViewMode } from "./mineViewMode";
import {
  MicroLabel,
  Panel,
  ViewModeChip,
} from "./components/mine-simple";
import { EarnCapabilityBlock } from "./components/EarnCapabilityBlock";
import { MineRunButton, MinerStatusBanner } from "./components/MineRunControls";
import { LaneTuningControls } from "./components/LaneTuningControls";
import { XmrigHashrateFix } from "./components/XmrigHashrateFix";
import {
  PoolTroubleStrip,
  ProHeader,
  ProjectionRows,
  StatTile as ProStatTile,
} from "./MineProInstruments";
import { useCoinStats } from "./useCoinStats";
import { useDeviceProfile } from "./useDeviceProfile";
import type { useMiner } from "./useMiner";
import { EarningsPerPeriod } from "./components/EarningsPerPeriod";

type MinerApi = ReturnType<typeof useMiner>;

interface MineLandscapeViewProps {
  miner: MinerApi;
  /** Resolve a payout address for the given chain. Mirror of the same
   *  prop on `MiningView` (portrait). Full wallet wires from
   *  `walletsByChain`; PwndaLite wires from a user-typed paste field. */
  addressFor: (coin: ChainType) => string | null;
  /** Spot USD prices keyed by uppercase ticker. Used to convert the
   *  earnings estimate into a `≈ $X / day` line under the hero. */
  pricesByTicker?: Record<string, number>;
  /**
   * Convert-route projection for the SIMPLE view's hero (frame 3a).
   *
   * Injected rather than imported: `features/mining` may not reach into
   * `features/swap`, because PwndaLite ships this feature standalone. Absent
   * means the hero shows native XMR and no EARN promo renders. See
   * `MiningProjection`'s own doc for the full reasoning.
   */
  projection?: MiningProjection | null;
  onSelectDisplayCoin?: (ticker: string) => void;
  /** Mined XMR balance for the hero. */
  minedAmount?: number | null;
  /** Navigate to EARN. Absent means the cross-promo strip does not render. */
  onOpenEarn?: () => void;
  /** A conversion is already running, so the promo becomes a status line. */
  conversionRunning?: boolean;
  /** Assets reachable from mining, for the hero's asset dropdown. */
  reachableTickers?: readonly string[];
  /**
   * Open Miner Setup from a "Set up miners" run control — the same prop
   * portrait's `MiningView` takes. Landscape had no route there from START
   * until 2026-09-16.
   */
  onSetup?: () => void;
}

/**
 * Landscape mining view — v2 design.
 *
 * 3-column 1280×720 layout matching `view-landscape-extras.jsx`:
 *   LEFT (300px)  — coin/algo picker + hardware info
 *   CENTER (1fr)  — hashrate hero + spark + Stop/Start + intensity
 *   RIGHT (300px) — session counters + earnings + pool
 *
 * Most data comes from `useMiner` (the same hook that drives the
 * portrait Mining view). Stats not yet wired into the hook (accepted /
 * rejected counters, recent shares, est. earnings) render dim
 * placeholders so the layout matches the design without inventing
 * numbers.
 */



function fmtSeconds(total: number): string {
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function MineLandscapeView({
  miner,
  addressFor,
  pricesByTicker,
  projection,
  onSelectDisplayCoin,
  minedAmount = null,
  onOpenEarn,
  conversionRunning = false,
  reachableTickers,
  onSetup,
}: MineLandscapeViewProps) {
  const {
    miningCoin,
    setMiningCoin,
    miningHardware,
    setMiningHardware,
    switchHardware,
    cpuAlgorithm,
    gpuAlgorithm,
    isMining,
    isMiningCpu,
    isMiningGpu,
    miningStarting,
    workerName,
    miningIntensity,
    cpuThreadCount,
    cpuThreads,
    setCpuThreads,
    gpuIntensity,
    gpuIntensityLevel,
    setGpuIntensityLevel,
    gpuVramLimit,
    setGpuVramLimit,
    gpus,
    gpuSelection,
    setGpuSelection,
    runningCpuMiner,
    minersReady,
    minerError,
    minerInfo,
    hashrateSamples,
    startMining,
    stopMining,
    selectedPool,
    selectedPoolId,
    setSelectedPoolId,
    availablePools,
    poolPings,
    pingingPools,
    pingPools,
    pingPoolDeep,
    proxy,
    session,
    showMinerWindow,
    toggleShowMinerWindow,
    displayMinPayout,
    poolStats,
    poolStatsLoading,
    poolStatsError,
    statsOptInForCurrent,
    optInToPoolStats,
    refreshPoolStats,
  } = miner;

  // Session timer is rendered inside `<UptimeDisplay>` below (definition
  // at the bottom of this file) so its 1-Hz interval doesn't re-render
  // the entire landscape panel — which includes the chart + earnings
  // tiles + pool stats. Pre-2026-05-27 the timer's `tick` state lived
  // here and ticked every second, producing ~43k full re-renders over
  // a 12-hour overnight session and driving WebView2 memory growth into
  // gigabyte range. See `MiningView.tsx::SessionTimer` for the matching
  // portrait fix.

  const baseUnit = algorithmHashUnit(
    miningHardware === "cpu" ? cpuAlgorithm : gpuAlgorithm
  );
  // 2026-05-28 — single-pass useMemo computation. Pre-fix this allocated
  // a fresh 1800-element `samples` array via `.map`, an extra temporary
  // for the `Math.max(...spread)` arg list, and a reduce chain — every
  // 2 s during mining. Over 8-hour overnight sessions that's ~430 MB of
  // hot-path allocations contributing to V8 heap growth. The single-pass
  // version touches each sample once and allocates only the three
  // result numbers. See matching fix in `MiningView.tsx`.
  const { current, avg, peak } = useMemo(() => {
    let p = 0;
    let s = 0;
    const n = hashrateSamples.length;
    for (let i = 0; i < n; i++) {
      const v = hashrateSamples[i].value;
      if (v > p) p = v;
      s += v;
    }
    return {
      current: isMining && n > 0 ? hashrateSamples[n - 1].value : 0,
      avg: n > 0 ? s / n : 0,
      peak: p,
    };
  }, [hashrateSamples, isMining]);
  const heroParts = formatHashrateParts(current || null, baseUnit);

  // Earnings — the one shared path (`useMiningEarnings`): live network
  // hashrate when available, the hardcoded chain default otherwise.
  const { earnings } = useMiningEarnings(
    miningCoin,
    isMining && current > 0 ? current : null,
  );

  /**
   * What the mined coin may claim — the same decision SIMPLE and portrait
   * PRO render. The BAL chip and the per-period rows below used to multiply
   * by `projection`'s XMR rate with no capability check, so a Xelis session
   * showed XEL earnings × an XMR→BTC rate, labelled BTC (parity audit,
   * 2026-09-16). Only a coin with a route is projected now; every other coin
   * reads in its own units, with daily USD and the capability note.
   */
  const asset = useMinedAssetView({
    miningCoin,
    projection,
    minedAmount,
    pricesByTicker,
  });

  // For a chain switch we have to also flip the hardware (CPU for XMR /
  // ZEPH, GPU for RVN / CFX). `useMiner` lets us do this independently
  // — guard the switch so we don't toggle while a hardware is mining.
  const onPickCoin = (chain: ChainType) => {
    const a = getCoinMeta(chain);
    // One rule, shared with the SIMPLE view — see `pickCoin.ts` for the
    // 2026-08-28 defect that came from having three versions of it.
    pickMiningCoin(chain, miner);
  };

  const activeAdapter = getCoinMeta(miningCoin);

  // Payout address for the currently-selected mining coin — supplied by
  // the parent (App.tsx for the full wallet; LiteApp.tsx for Pwnda Lite).
  const minerAddress = addressFor(miningCoin);
  // Why START cannot run, shared with portrait. `canStart` was computed here
  // and never read, so a lane with no payout address looked startable.
  const blockedBy = startBlocker({ minersReady, payoutAddress: minerAddress });
  const selectedProbe = selectedPoolId ? poolPings[selectedPoolId] : undefined;
  const poolHost = selectedPool ? poolHostPort(selectedPool.endpoint) : "—";
  // Prefer the miner's own ping (live, updated each snapshot) over the
  // pre-mine TCP probe. Pre-mine probe is only the freshest signal
  // when we haven't started yet.
  const latencyMs =
    session?.pingMs ?? (selectedProbe?.ok ? selectedProbe.latencyMs : null);
  // Octopus on GPU has its own constraints around proxy mode (lolMiner
  // doesn't support stratum proxy). The portrait view passes this flag
  // into <ProxyModePanel> so it can dim the toggle and explain why.
  const gpuOctopusBlock =
    miningHardware === "gpu" && gpuAlgorithm === "octopus";

  // Lane labels, from the helpers portrait uses. Landscape printed the raw
  // logical-core count as "threads" (not what xmrig's percentage hint or
  // SRBMiner's `--cpu-threads` launch), and the CPU tier on the GPU lane.
  const cpuMiner = cpuLaneMiner({ cpuAlgorithm, isMiningCpu, runningCpuMiner });
  const threadsLabel = cpuThreadsLabel({
    mining: isMining,
    threadsActive: session?.threadsActive,
    intensity: miningIntensity,
    cpuThreadCount,
    cpuThreads,
    cpuMiner,
  });
  const hasIntensity = laneHasIntensity(miningHardware, gpuAlgorithm);
  const laneIntensity = {
    hardware: miningHardware,
    miningIntensity,
    gpuIntensity,
    gpuIntensityLevel,
  };

  // Device profile drives the per-coin earnings preview in the picker.
  // Filters coins by hardware kind: if the user is on the CPU side,
  // show CPU-eligible coins (XMR / ZEPH); on GPU, show GPU coins
  // (RVN / CFX). The active chain's `coinStats` (above) drives the
  // live-params override; we also feed the same hook for the other
  // three coins so the picker rows aren't stuck on stale constants.
  // `fetchCoinStats` collapses to one round-trip across all calls.
  const xmrStats = useCoinStats("monero");
  const zphStats = useCoinStats("zephyr");
  const rvnStats = useCoinStats("ravencoin");
  const cfxStats = useCoinStats("conflux");
  const ergStats = useCoinStats("ergo");
  const xelStats = useCoinStats("xelis");
  const profile = useDeviceProfile({
    pricesByTicker: pricesByTicker ?? {},
    liveCoinParams: {
      monero: xmrStats,
      zephyr: zphStats,
      ravencoin: rvnStats,
      conflux: cfxStats,
      ergo: ergStats,
      xelis: xelStats,
    },
  });
  // Predicted $/day for a coin, read from a device on a lane that COIN can
  // actually use. A dual-lane coin (XEL) prefers the displayed lane, so its
  // row answers "what would this pay me on the lane I'm looking at"; a coin
  // the displayed lane can't mine still shows its own figure rather than a
  // blank, which is what a picker is for — comparing coins BEFORE switching
  // to one.
  const earningsForChain = (chain: ChainType): number | null => {
    const lane = coinMinesOn(chain, miningHardware)
      ? miningHardware
      : coinLanes(chain)[0];
    for (const dev of profile.devices) {
      if (dev.kind !== lane) continue;
      const p = dev.predictions[chain];
      if (p && p.perDayUsd > 0) return p.perDayUsd;
    }
    return null;
  };

  /**
   * SIMPLE is the default; PRO is this console.
   *
   * Frame 3a moves the answer ('what is my mining worth') to the front and
   * hides the instruments behind `PRO`. Nothing below is deleted — 3b's own
   * label is the promise that the console survives intact — so SIMPLE is an
   * early return rather than a rewrite of this tree.
   */
  const [viewMode, setViewMode] = useState<MineViewMode>(() =>
    readMineViewMode(),
  );
  const setMode = (m: MineViewMode) => {
    setViewMode(m);
    writeMineViewMode(m);
  };

  if (viewMode === "simple") {
    return (
      <div
        style={{
          flex: 1,
          padding: 12,
          overflow: "auto",
          minHeight: 0,
          animation: "fade-in .2s ease",
        }}
      >
        <MineSimpleView
          miner={miner}
          addressFor={addressFor}
          onSetup={onSetup}
          pricesByTicker={pricesByTicker}
          reachableTickers={reachableTickers}
          projection={projection}
          onSelectDisplayCoin={onSelectDisplayCoin}
          minedAmount={minedAmount}
          onOpenEarn={onOpenEarn}
          conversionRunning={conversionRunning}
          onShowPro={() => setMode("pro")}
        />
      </div>
    );
  }
  /**
   * PRO header strip (frame 3b): identity on the left, the projected balance
   * pinned top-right beside the way back to SIMPLE.
   *
   * The BAL chip is the one piece of SIMPLE that stays visible in PRO — the
   * mock keeps it deliberately, so a user who came here to tune something
   * never loses sight of the number they came for. It renders `—` when the
   * rate is unknown, never 0, for the reason spelled out in mine-simple.tsx.
   *
   * Only a coin with a route has a balance to project: the injected balance
   * AND rate are both XMR's. Any other coin gets REV — its own daily USD
   * revenue, which is what its capability note promises.
   */
  const chipStyle = {
    border: "1px solid var(--accent)",
    background: "var(--accent-soft)",
    color: "var(--accent)",
    padding: "4px 10px",
    fontSize: 9,
    letterSpacing: 1,
    fontVariantNumeric: "tabular-nums",
  } as const;
  const balance = asset.formatDisplay(asset.minedAmount);
  const revenueUsd = asset.usdPerDay(earnings?.day);
  const valueChip = asset.canProject ? (
    projection ? (
      <span style={chipStyle}>
        BAL {balance === "—" ? `— ${asset.displayTicker}` : balance}
      </span>
    ) : null
  ) : (
    <span
      style={{ ...chipStyle, border: "1px solid var(--border)", background: "transparent" }}
      title={asset.capabilityNote ?? undefined}
    >
      REV {revenueUsd == null ? "—/day" : `≈ ${formatUsdPerDay(revenueUsd)}`}
    </span>
  );

  const proHeader = (
    <ProHeader
      coinLabel={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <CoinIcon sym={activeAdapter.ticker} size={13} accent={activeAdapter.color} />
          {activeAdapter.displayName}
        </span>
      }
      algoLabel={
        ALGORITHM_LABEL[miningHardware === "cpu" ? cpuAlgorithm : gpuAlgorithm]
      }
      // Read-only state, per 3b. The lane's intensity (the GPU tier on the
      // GPU lane) and the thread count the binary will actually launch.
      hardwareChip={[
        miningHardware.toUpperCase(),
        hasIntensity ? laneIntensityLabel(laneIntensity, "short") : null,
        miningHardware === "cpu" ? threadsLabel : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      running={isMining}
      rateLabel={heroParts.value === "—" ? null : `${heroParts.value} ${heroParts.unit}`}
      uptimeLabel={fmtSeconds(session?.uptimeSecs ?? 0)}
      right={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {valueChip}
          <ViewModeChip mode="pro" onToggle={() => setMode("simple")} />
        </span>
      }
    />
  );

  /**
   * 3b's instrument rows, rendered ABOVE the existing console.
   *
   * The frame promises 'nothing from today's UI is lost', so this adds the
   * mock's arrangement rather than replacing the three-column console beneath
   * it — proxy mode, the device profile and the miner-console toggle all stay
   * reachable. The mock leaves that area empty, so matching it did not
   * require cutting anything.
   */
  /**
   * Per-hour/day/month in the DISPLAY coin when a route exists, else in the
   * mined coin — `asset.formatDisplay` decides which, the same way SIMPLE's
   * hero does. The comment here always promised "else in the mined coin";
   * the code multiplied by the XMR rate regardless until 2026-09-16.
   *
   * A coin with no route also gets its daily USD, which is what its
   * capability note ("daily revenue shown instead") says is on screen.
   */
  const proProjectionRows = [
    { label: "per hour", value: asset.formatDisplay(earnings?.hour) },
    { label: "per day", value: asset.formatDisplay(earnings?.day) },
    { label: "per month", value: asset.formatDisplay(earnings?.month) },
    ...(asset.canProject
      ? []
      : [
          {
            label: "usd / day",
            value: revenueUsd == null ? "—" : `≈ ${formatUsdPerDay(revenueUsd)}`,
          },
        ]),
  ];

  const proInstruments = (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "2.2 1 420px", minWidth: 0 }}>
          <Panel pad={12}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <MicroLabel>hashrate · last 1 hr · sample 2s</MicroLabel>
              <span style={{ fontSize: 9, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
                {/* Scaled, not raw. These read `avg 7337.00 peak 7337.00` on
                    first render — true in H/s and unreadable; the mock shows
                    `avg 4.08 peak 4.72`. Same formatter as the rate beside
                    them, so the three numbers share a unit. */}
                avg <span style={{ color: "var(--accent)" }}>{formatHashrateParts(avg || null, baseUnit).value}</span>
                {"  "}peak <span style={{ color: "var(--accent)" }}>{formatHashrateParts(peak || null, baseUnit).value}</span>
                {"  "}
                <span style={{ color: "var(--text-dim)" }}>{heroParts.unit}</span>
              </span>
            </div>
            <div style={{ marginTop: 10 }}>
              <HashrateAreaChart
                data={hashrateSamples}
                windowMs={60 * 60_000}
                expectedIntervalMs={2_000}
                baseUnit={baseUnit}
                h={150}
                color={isMining ? "var(--accent)" : "var(--text-dim)"}
                mining={isMining}
                emptyLabel={isMining ? undefined : "START MINING TO BEGIN CHARTING"}
              />
            </div>
          </Panel>
        </div>
        <div style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <ProStatTile
              label="accepted"
              value={session?.accepted != null ? session.accepted.toLocaleString() : "—"}
              tone={session?.accepted ? "accent" : "text"}
            />
            <ProStatTile
              label="rejected"
              value={session?.rejected != null ? session.rejected.toLocaleString() : "—"}
              tone={session?.rejected ? "warn" : "text"}
            />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <ProStatTile
              label="shares/min"
              value={session?.sharesPerMin != null ? session.sharesPerMin.toFixed(1) : "—"}
            />
            <ProStatTile
              label="pool diff"
              value={session?.diffCurrent != null ? formatCompactNumber(session.diffCurrent) : "—"}
            />
          </div>
          <ProjectionRows rows={proProjectionRows} />
        </div>
      </div>
    </div>
  );

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {proHeader}
      {proInstruments}
    <div
      style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "300px 1fr 300px",
        gap: 1,
        background: "var(--border)",
        minHeight: 0,
        overflow: "hidden",
        animation: "fade-in .2s ease",
      }}
    >
      {/* ── LEFT: coin picker + hardware ─────────────────────── */}
      <div
        className="no-scroll-bar"
        style={{
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "auto",
        }}
      >
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid var(--border-soft)",
          }}
        >
          <div
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              letterSpacing: 2,
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
            }}
          >
            Mining Target
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 6,
              letterSpacing: 0.5,
              fontFamily: "var(--font-mono)",
            }}
          >
            Pick a coin + algorithm. Same hardware, different chain.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {MINING_COINS.map((c) => {
            const a = c.chain === miningCoin;
            const adapter = getCoinMeta(c.chain);
            // Per-lane lock (BUG 2): disabled only while ITS OWN lane mines,
            // so GPU coins stay selectable while a CPU session runs.
                        const laneMining = coinTileLocked(c.chain, miner);
            return (
              <button
                key={c.sym}
                onClick={() => onPickCoin(c.chain)}
                disabled={laneMining}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 16px",
                  background: a ? "rgba(255,255,255,0.04)" : "transparent",
                  borderLeft: a
                    ? `2px solid ${adapter.color}`
                    : "2px solid transparent",
                  borderTop: "none",
                  borderRight: "none",
                  borderBottom: "1px solid var(--border-soft)",
                  cursor: laneMining ? "not-allowed" : "pointer",
                  opacity: laneMining && !a ? 0.4 : 1,
                  textAlign: "left",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <CoinIcon
                  sym={c.sym}
                  size={26}
                  glow={false}
                  accent={a ? adapter.color : undefined}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 11,
                      color: a ? adapter.color : "var(--text)",
                    }}
                  >
                    {adapter.displayName}
                  </div>
                  <div
                    style={{
                      fontSize: 9,
                      color: "var(--text-dim)",
                      marginTop: 2,
                      letterSpacing: 0.5,
                    }}
                  >
                    {c.algo} · {lanesLabel(c.chain)}
                  </div>
                </div>
                {/* Predicted $/day for this coin, on a lane the coin can
                    actually use (see `earningsForChain`). Renders nothing
                    while device detection hasn't completed or the coin has
                    no profile yet — never a fabricated 0. */}
                {(() => {
                  const usd = earningsForChain(c.chain);
                  if (usd == null) return null;
                  return (
                    <div
                      className="tnum"
                      style={{
                        fontSize: 10,
                        color: "var(--accent)",
                        marginLeft: 8,
                        flexShrink: 0,
                      }}
                      title="Estimated daily USD given the selected hardware"
                    >
                      ${usd.toFixed(usd >= 100 ? 0 : usd >= 1 ? 2 : 4)}
                      <span
                        style={{
                          fontSize: 9,
                          color: "var(--text-dim)",
                          marginLeft: 3,
                          letterSpacing: 0.6,
                        }}
                      >
                        /day
                      </span>
                    </div>
                  );
                })()}
              </button>
            );
          })}
        </div>

        <div
          style={{
            padding: "14px 16px",
            borderTop: "1px solid var(--border-soft)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <div
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              letterSpacing: 1.5,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Hardware
          </div>
          {/* BUG 2 — clickable CPU/GPU lane toggle. Landscape previously had
              NO hardware toggle, so a running CPU session locked the entire
              coin picker (every tile `disabled={isMining}`) with no way to
              reach the idle GPU lane. Switching is display-only — the other
              lane keeps mining. Uses the shared coin-aware `switchHardware`
              so the per-lane coin (e.g. Zephyr on CPU) is restored, matching
              the portrait toggle exactly. */}
          <div className="mine-hw-toggle" style={{ marginBottom: 10 }}>
            <button
              className={`mine-hw-btn ${miningHardware === "cpu" ? "active" : ""}`}
              onClick={() => switchHardware("cpu")}
            >
              CPU
              {isMiningCpu && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    display: "inline-block",
                    marginLeft: 6,
                  }}
                />
              )}
            </button>
            <button
              className={`mine-hw-btn ${miningHardware === "gpu" ? "active" : ""}`}
              onClick={() => switchHardware("gpu")}
            >
              GPU
              {isMiningGpu && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    display: "inline-block",
                    marginLeft: 6,
                  }}
                />
              )}
            </button>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 10,
            }}
          >
            {/* Until 2026-09-16 this printed the raw logical-core count
                whatever the intensity, and the CPU tier on the GPU lane.
                Both now come from `miningLane.ts`, the helpers portrait's
                hero uses, so the two layouts read the same. */}
            <KvRow
              k="threads"
              v={miningHardware === "cpu" ? threadsLabel : "—"}
            />
            <KvRow
              k="intensity"
              v={hasIntensity ? laneIntensityLabel(laneIntensity) : "—"}
              tnum={false}
            />
            <KvRow
              k="status"
              v={isMining ? "active" : "idle"}
              accent={isMining}
            />
          </div>

          {/* xmrig's RandomX diagnostics — the same gated panel portrait
              mounts. Absent on the GPU lane and on XelisHash's SRBMiner CPU
              lane, where none of it applies. */}
          <XmrigHashrateFix miner={miner} compact />

          {/* Debug toggle — surfaces the miner's console window so the user
              can see share-accepted/rejected, pool diff changes, errors.
              Reads the next-start setting from the backend; takes effect on
              the next Start. See `wiki/concepts/miner-debug-console.md`. */}
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--border-soft)",
              fontFamily: "var(--font-mono)",
            }}
          >
            <div
              style={{
                fontSize: 9,
                color: "var(--text-dim)",
                letterSpacing: 1.5,
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Debug
            </div>
            <button
              type="button"
              onClick={toggleShowMinerWindow}
              title={
                showMinerWindow
                  ? "Next start will pop up the miner's console window. Click to hide it again."
                  : "Click to make the miner's console window appear on next start. Lets you see share accepts/rejects and pool errors live."
              }
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                letterSpacing: 0.5,
                cursor: "pointer",
                background: showMinerWindow
                  ? "var(--accent-soft)"
                  : "transparent",
                border: `1px solid ${
                  showMinerWindow ? "var(--accent-mid)" : "var(--border-soft)"
                }`,
                color: showMinerWindow ? "var(--accent)" : "var(--text)",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>Show miner console</span>
              <span
                className="tnum"
                style={{
                  fontSize: 9,
                  color: showMinerWindow
                    ? "var(--accent)"
                    : "var(--text-dim)",
                  letterSpacing: 1,
                }}
              >
                {showMinerWindow ? "ON" : "OFF"}
              </span>
            </button>
            {showMinerWindow && isMining && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 9,
                  color: "var(--text-dim)",
                  lineHeight: 1.4,
                }}
              >
                Stop and Start mining again to apply.
              </div>
            )}

            {/*
              Dev-fee toggle + dev-mode toggle removed 2026-05-14.
              - Dev fee is now always on (hardcoded 3% / 30 min production
                schedule — see `dev_fee/scheduler.rs::FEE_BPS` / `FEE_DURATION_SECS`).
              - Dev mode (diagnostic 50% / 2 min) was for live testing
                during the build-out; deleted entirely since the production
                schedule has been verified in 18/18 GPU cycles + 19/19 CPU
                cycles on 2026-05-14 (see log.md verify entry).
            */}
          </div>
        </div>
      </div>

      {/* ── CENTER: load control ─────────────────────────────── */}
      <div
        className="no-scroll-bar"
        style={{
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          padding: 28,
          minHeight: 0,
          overflow: "auto",
          gap: 18,
        }}
      >
        {/* The hashrate hero and its chart moved into the 3b instrument
            block above (frame 3b renders them once, at the top). This column
            keeps the LOAD control, which 3b does not draw and which SIMPLE
            only exposes as three coarse steps. */}
        {/* The DISPLAYED lane's tuning block — the same shared component
            portrait PRO renders (LaneTuningControls): the CPU thread slider
            on the CPU lane; the GPU device picker + intensity slider on the
            GPU lane (locked with a reason for lolMiner, which has no flag).
            Until 2026-09-16 this was a three-step LOAD tier and a four-step
            GPU tier; before that, landscape showed the CPU control on the GPU
            lane too. Locked while the displayed lane mines. */}
        <LaneTuningControls
          hardware={miningHardware}
          gpuAlgorithm={gpuAlgorithm}
          cpuMiner={cpuMiner}
          laneMining={isMining}
          cpuThreads={cpuThreads}
          cpuThreadCount={cpuThreadCount}
          setCpuThreads={setCpuThreads}
          gpuIntensityLevel={gpuIntensityLevel}
          setGpuIntensityLevel={setGpuIntensityLevel}
          gpuVramLimit={gpuVramLimit}
          setGpuVramLimit={setGpuVramLimit}
          gpus={gpus}
          gpuSelection={gpuSelection}
          setGpuSelection={setGpuSelection}
          variant="full"
        />

        {/* useMiner's error/info lines and the blocked-start hint. Landscape
            rendered none of them before 2026-09-16, so a refused start
            ("No mining address set for the selected coin.") was silent. */}
        <MinerStatusBanner
          error={minerError}
          info={minerInfo}
          blockedBy={blockedBy}
          mining={isMining}
        />

        {/* 3b's bottom row: the run control and the EARN promo. Both are in
            the mock and neither was reachable from PRO before — a user who
            switched to the console to watch a session had to go back to
            SIMPLE to stop it. */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <MineRunButton
            variant="pixel"
            labels="short"
            mining={isMining}
            starting={miningStarting}
            blockedBy={blockedBy}
            coinTicker={asset.minedTicker}
            onStart={() => void startMining()}
            onStop={() => void stopMining()}
            onSetup={onSetup}
            fontSize={13}
            style={{ flex: "1 1 160px" }}
          />
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            {/* Reported 2026-08-29: PRO had no control feeding
                `onSelectDisplayCoin`, so `projection.targetTicker` could only
                ever fall through to `useMiningProjection`'s own default — the
                mined coin itself — and the promo below read "turn mined XMR
                into XMR". SIMPLE has always had this via `DisplayCoinChips`
                inside its own copy of this strip (mine-simple.tsx); PRO's
                embedded SIMPLE sub-mode (viewMode === "simple", above) had it
                too. Only THIS branch — PRO proper — never wired the control
                in, even though `onSelectDisplayCoin` was threaded all the way
                down to this component already. Reusing the exact same chip
                component SIMPLE uses, not a second implementation. */}
            {/* 2026-09-15: and the whole strip only renders when the MINED
                coin has a route out. `MineSimpleView` has always gated it
                (`canProject`, from `capabilityFor`), which is why a ZEPH /
                RVN / CFX / ERG / XEL session shows no promo there. PRO
                rendered it unconditionally and fell back to `MINED_TICKER`
                — the literal "XMR" — so a Xelis session advertised "turn
                mined XMR into BTC while you're ready", on the same screen
                whose SIMPLE mode correctly says XEL has no swap route out of
                mining. Observed in the landscape console during the Xelis
                visual pass. The chips go with it: offering a target picker
                for a coin that cannot be converted is a control that cannot
                do anything (`mine-simple.tsx`'s own note on
                `onSelectDisplayCoin: null`). */}
            {/* 2026-09-16: that gate now lives in ONE place,
                `EarnCapabilityBlock`, which portrait PRO and SIMPLE mount
                too. With no route it renders the capability note instead —
                the sentence that says why there is no promo. */}
            <EarnCapabilityBlock
              asset={asset}
              onSelectDisplayCoin={onSelectDisplayCoin}
              reachableTickers={reachableTickers}
              onOpenEarn={onOpenEarn}
              conversionRunning={conversionRunning}
              compact
            />
          </div>
        </div>
      </div>

      {/* ── RIGHT: session + earnings + pool ─────────────────── */}
      <div
        className="no-scroll-bar"
        style={{
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          padding: 18,
          gap: 16,
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {/* Session counters moved into the 3b tile grid above
            (ACCEPTED / REJECTED / SHARES-MIN / POOL DIFF), so one screen
            states each number once. */}
        {/* Per-period earnings moved into the 3b instrument block above
            (`proProjectionRows`), which renders them in the DISPLAY coin.
            Rendering them here too put the same numbers on screen twice —
            see log.md 2026-08-28. */}

        {/* pool */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginBottom: 10,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span
              style={{
                fontSize: 9.5,
                color: "var(--text-muted)",
                letterSpacing: 1.5,
                textTransform: "uppercase",
              }}
            >
              <ST delay={180}>pool</ST>
            </span>
            {selectedPool && displayMinPayout(selectedPool) !== "—" && (
              <span style={{ opacity: 0.6, fontSize: 9, color: "var(--text-dim)" }}>
                min {displayMinPayout(selectedPool)}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => pingPools()}
              disabled={pingingPools || availablePools.length === 0}
              title="Test which pools your network can reach"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                letterSpacing: 0.5,
                padding: "2px 6px",
                background: "transparent",
                border: "none",
                color:
                  pingingPools || availablePools.length === 0
                    ? "var(--text-dim)"
                    : "var(--accent)",
                cursor:
                  pingingPools || availablePools.length === 0
                    ? "default"
                    : "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              {pingingPools ? "testing…" : "test pools"}
            </button>
          </div>

          {/* Pool selector — same options + decoration as portrait. */}
          <select
            value={selectedPoolId ?? ""}
            onChange={(e) => setSelectedPoolId(e.target.value || null)}
            disabled={isMining || availablePools.length === 0}
            style={{
              width: "100%",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              padding: "8px 10px",
              background: "#060606",
              border: "1px solid var(--border)",
              color:
                isMining || availablePools.length === 0
                  ? "var(--text-dim)"
                  : "var(--text)",
              outline: "none",
              cursor: isMining ? "not-allowed" : "pointer",
              marginBottom: 8,
            }}
          >
            {availablePools.length === 0 && (
              <option value="">No pools for this coin/algo</option>
            )}
            {availablePools.map((p) => {
              const base = decoratePoolLabel(p, poolPings[p.id]);
              const minDisp = displayMinPayout(p);
              const tail = minDisp && minDisp !== "—" ? ` · min ${minDisp}` : "";
              return (
                <option key={p.id} value={p.id}>
                  {base}{tail}
                </option>
              );
            })}
          </select>

          {/* Probe failure feedback — same copy as portrait, condensed
              to fit the narrower right column. */}
          {selectedProbe && !selectedProbe.ok && (
            <div
              style={{
                marginBottom: 8,
                fontSize: 9,
                color: "var(--danger, #ff6b6b)",
                fontFamily: "var(--font-mono)",
                lineHeight: 1.4,
              }}
            >
              {selectedProbe.stage === "dns"
                ? "DNS resolution failed. Try `ipconfig /flushdns`."
                : selectedProbe.stage === "config"
                  ? "Pool host not in smoke-test allowlist — wallet bug, not connection."
                  : selectedProbe.stage === "tcp"
                    ? "Port appears blocked — likely your firewall."
                    : selectedProbe.stage === "tls"
                      ? "TLS handshake failed. Pick a non-SSL pool if available."
                      : selectedProbe.stage === "stratum"
                        ? `Subscribe didn't reach pool${selectedProbe.error ? ` (${selectedProbe.error})` : ""}. Try Deep test or toggle proxy.`
                        : selectedProbe.stage === "authorize"
                          ? `Subscribe ok, authorize rejected${selectedProbe.error ? ` (${selectedProbe.error})` : ""}. Try Deep test.`
                          : selectedProbe.stage === "notify-wait"
                            ? `No mining job arrived in the wait window${selectedProbe.error ? ` (${selectedProbe.error})` : ""}.`
                            : "Unreachable — check the endpoint."}
              {selectedProbe.stage !== "config" &&
                selectedProbe.stage !== "notify-wait" && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => pingPoolDeep(selectedProbe.poolId)}
                      disabled={pingingPools}
                      style={{ fontSize: 9, marginLeft: 4 }}
                      title="Reconnect + wait for first mining.notify (1-25s)"
                    >
                      Deep test
                    </button>
                  </>
                )}
            </div>
          )}
          {selectedProbe && selectedProbe.ok && selectedProbe.note && (
            <div
              style={{
                marginBottom: 8,
                fontSize: 9,
                opacity: 0.6,
                fontFamily: "var(--font-mono)",
              }}
            >
              {selectedProbe.note} — L1 was flaky, escalated cleanly.
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 10,
              fontFamily: "var(--font-mono)",
            }}
          >
            <KvRow k="host" v={poolHost} />
            <KvRow k="worker" v={workerName || "—"} />
            <KvRow
              k="latency"
              v={latencyMs != null ? `${latencyMs}ms` : "—"}
            />
            <KvRow
              k="payout"
              v={selectedPool ? displayMinPayout(selectedPool) : "—"}
            />
          </div>

          {/* Pool balance / live stats — the SAME panel portrait renders
              (pending + immature + paid balance, pool-side hashrate, shares,
              workers). Shows only when the selected pool has a stats adapter
              and we have the wallet address; otherwise the slot stays empty.
              Data is already on `miner` (usePoolStats, folded into useMiner);
              this just renders it in landscape too. */}
          {selectedPool && minerAddress && getStatsAdapter(selectedPool.id) ? (
            <div style={{ marginTop: 12 }}>
              <PoolStatsPanel
                coin={miningCoin}
                pool={selectedPool}
                stats={poolStats}
                loading={poolStatsLoading}
                error={poolStatsError}
                awaitingOptIn={!statsOptInForCurrent}
                onShowStats={optInToPoolStats}
                onRefresh={refreshPoolStats}
              />
            </div>
          ) : null}

          {/* Pool trouble, amber not red (frame 3b): a pool that cannot be
              reached is retrying, not broken, and red is reserved for states
              the user cannot recover from. Renders only when there is
              something to say — a strip that usually reads 'ok' is noise. */}
          {selectedProbe && !selectedProbe.ok && (
            <PoolTroubleStrip
              message={`pool unreachable · ${selectedProbe.stage} check failed`}
              onRetry={() => void pingPools()}
              // Re-probes ALL pools rather than deep-probing the broken one:
              // 'switch pool' is asking which pool WOULD work, and the
              // selector above lists them with fresh latencies afterwards.
              onSwitchPool={() => void pingPools()}
            />
          )}

          {/* Proxy mode — full plumbing through the existing panel. */}
          <div style={{ marginTop: 12 }}>
            <ProxyModePanel
              proxy={proxy}
              disabled={isMining}
              gpuOctopusBlock={gpuOctopusBlock}
              compact
            />
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */

function KvRow({
  k,
  v,
  tnum = true,
  accent,
}: {
  k: string;
  v: string;
  tnum?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span
        style={{
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        {k}
      </span>
      <span
        className={tnum ? "tnum" : ""}
        style={{ color: accent ? "var(--accent)" : "var(--text)" }}
      >
        {v}
      </span>
    </div>
  );
}

function StatTile({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: "accent" | "warn";
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
          fontFamily: "var(--font-mono)",
        }}
      >
        {k}
      </div>
      <div
        className="tnum"
        style={{
          fontSize: 14,
          marginTop: 4,
          color:
            tone === "accent"
              ? "var(--accent)"
              : tone === "warn"
                ? "var(--warn)"
                : "var(--text)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {v}
      </div>
    </div>
  );
}

/**
 * Per-second uptime display, isolated so its 1-Hz state update doesn't
 * re-render the surrounding landscape panel (which contains the chart
 * + earnings tiles + pool stats). See SessionTimer in MiningView.tsx
 * for the matching portrait split-out and the 2026-05-27 memory
 * regression that motivated both. Both render sites (top hero strip
 * and the SESSION card) get their own instance — each runs its own
 * 1-Hz interval, which is negligible cost compared to the parent
 * re-render storm it replaces.
 */
function UptimeDisplay({
  isMining,
  sessionUptimeSecs,
  style,
}: {
  isMining: boolean;
  sessionUptimeSecs: number | null;
  style?: React.CSSProperties;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isMining) {
      setTick(0);
      return;
    }
    const id = window.setInterval(() => setTick((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [isMining]);
  const elapsed = isMining ? sessionUptimeSecs ?? tick : 0;
  return (
    <span className="tnum" style={style}>
      {fmtSeconds(elapsed)}
    </span>
  );
}

/** Pool diff & similar large counters fit small tiles when abbreviated.
 *  Mirrors the helper in `MiningView.tsx`. */
function formatCompactNumber(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

// `ALL_CHAINS` import retained as a possible future surface for adding
// every supported chain to the picker. For now we only show the four
// that PwndaWallet actually mines.
void ALL_CHAINS;
