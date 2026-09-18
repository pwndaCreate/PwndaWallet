import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainType } from "../../wallets";
import { ALL_CHAINS, getCoinMeta } from "../../wallets/coin-metadata";
import { formatCoinAmount } from "./earnings";
import { useCoinStats } from "./useCoinStats";
import { useDeviceProfile } from "./useDeviceProfile";
import { CHAIN_MINING_PREFIX, type CpuAlgorithm, type GpuAlgorithm } from "../../types/mining";
import {
  ALGORITHM_LABEL,
  CPU_ALGORITHM_DEFAULT_COIN,
  GPU_ALGORITHM_COIN,
} from "./algorithms";
import {
  cpuLaneMiner,
  cpuThreadsLabel,
  laneHasIntensity,
  laneIntensityLabel,
  startBlocker,
  type StartBlocker,
} from "./miningLane";
import { formatUsdPerDay, useMinedAssetView } from "./minedAssetView";
import { useMiningEarnings } from "./useMiningEarnings";
import { EarnCapabilityBlock } from "./components/EarnCapabilityBlock";
import { MineRunButton, MinerStatusBanner } from "./components/MineRunControls";
import { LaneTuningControls } from "./components/LaneTuningControls";
import { XmrigHashrateFix } from "./components/XmrigHashrateFix";
import {
  MINING_COINS,
  algorithmFor,
  coinLanes,
  coinMinesOn,
  lanesLabel,
} from "./miningCoins";
import { ST, Dot } from "../../components/Primitives";
import { Btn } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";
import { decoratePoolLabel, poolHostPort } from "./pools";
import { ProxyModePanel } from "./ProxyModePanel";
import { PoolStatsPanel, getStatsAdapter } from "./pool-stats";
import { algorithmHashUnit, formatHashrateParts } from "./pool-stats/format";
import type { useMiner } from "./useMiner";
import { usePersistentHashrate } from "./usePersistentHashrate";
import { HashrateAreaChart } from "./HashrateAreaChart";
import type { HashrateAreaPoint } from "./HashrateAreaChart";
import type { HashrateBucket } from "./hashrateHistoryStore";
import { coinTileLocked, pickMiningCoin } from "./pickCoin";
import { EarningsPerPeriod } from "./components/EarningsPerPeriod";
import type { MiningProjection } from "../../types/mining";
import { MineSimpleView } from "./MineSimpleView";
import { readMineViewMode, writeMineViewMode, type MineViewMode } from "./mineViewMode";
import { ViewModeChip } from "./components/mine-simple";

/**
 * 2026-06-01 (leak Round 9) — how often the live 1 HR hashrate chart is
 * allowed to repaint while mining. Samples are collected every 2 s, but
 * the chart's heavy SVG-path rebuild + WebView2 re-raster (the source of
 * the ~1600 MB/h mining leak) only needs to happen at a human-visible
 * cadence. 12 s is ~360 px/12 s ≈ 0.1 px/s motion on a 1-hour window —
 * imperceptible — while cutting the repaint count (and its leak) ~6×.
 */
const CHART_REPAINT_THROTTLE_MS = 12_000;

/**
 * Return a reference to `value` that only updates at most once per
 * `intervalMs`. Used to decouple a high-frequency source array (hashrate
 * samples, appended every 2 s) from an expensive consumer (the SVG chart)
 * so the consumer re-renders on a slower, human-visible cadence. The
 * latest value is always captured; the throttle only delays *when the
 * consumer sees a new reference*, never drops the final value (a trailing
 * timer flushes the last update). Generic over the value type.
 */
function useThrottledRef<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState<T>(value);
  const lastEmitRef = useRef<number>(Date.now());
  const latestRef = useRef<T>(value);
  latestRef.current = value;

  useEffect(() => {
    const sinceLast = Date.now() - lastEmitRef.current;
    if (sinceLast >= intervalMs) {
      // Enough time has passed — emit immediately.
      lastEmitRef.current = Date.now();
      setThrottled(latestRef.current);
      return;
    }
    // Otherwise schedule a trailing flush so the final value isn't lost.
    const id = window.setTimeout(() => {
      lastEmitRef.current = Date.now();
      setThrottled(latestRef.current);
    }, intervalMs - sinceLast);
    return () => window.clearTimeout(id);
  }, [value, intervalMs]);

  return throttled;
}

/**
 * Chart view-mode for the hero panel:
 *   - "1h" — Tier-1 in-memory sparkline (10-min rolling buffer).
 *   - "24h" — Tier-2 disk-persisted minute-bucket chart + sessions list.
 * Persisted to localStorage so the user's pick survives app restarts.
 */
type ChartMode = "1h" | "24h";
const CHART_MODE_LS_KEY = "pwnda.mining.chartMode";

function loadInitialChartMode(): ChartMode {
  try {
    const raw = localStorage.getItem(CHART_MODE_LS_KEY);
    return raw === "24h" ? "24h" : "1h";
  } catch {
    return "1h";
  }
}

type MinerApi = ReturnType<typeof useMiner>;

export function MiningView({
  miner,
  addressFor,
  onBack,
  pricesByTicker,
  onSetup,
  projection,
  onSelectDisplayCoin,
  minedAmount = null,
  onOpenEarn,
  conversionRunning = false,
  reachableTickers,
}: {
  miner: MinerApi;
  /** Resolve a payout address for the given chain. Full wallet wires
   *  `(c) => walletsByChain[c]?.address ?? null`; mining-only builds
   *  (Pwnda Lite) wire `(c) => userAddressByChain[c] ?? null`. The view
   *  only renders the address — it never needs key material. */
  addressFor: (coin: ChainType) => string | null;
  onBack: () => void;
  /** Spot USD prices keyed by uppercase ticker. Drives the
   *  per-coin `$/day` predictions in the profitability strip. */
  pricesByTicker?: Record<string, number>;
  /** Navigation handler called by the hero CTA when the user can't
   *  start mining yet (no miners installed / no payout address for the
   *  selected coin). Without this the CTA reads "Setup miners to start"
   *  but does nothing on click — UXS-20260516-115. */
  onSetup?: () => void;
  /**
   * SIMPLE-view inputs (canvas frame 3a), identical to the landscape ones.
   *
   * Injected, not imported: `features/mining` cannot reach `features/swap`
   * or `src/state`, because PwndaLite ships this feature standalone. Absent
   * means native XMR in the hero and no EARN promo — which is exactly the
   * Lite case.
   */
  projection?: MiningProjection | null;
  onSelectDisplayCoin?: (ticker: string) => void;
  minedAmount?: number | null;
  onOpenEarn?: () => void;
  conversionRunning?: boolean;
  /** Assets reachable from mining, for the hero's asset dropdown. */
  reachableTickers?: readonly string[];
}) {
  const {
    miningCoin,
    setMiningCoin,
    miningHardware,
    setMiningHardware,
    switchHardware,
    cpuAlgorithm,
    setCpuAlgorithm,
    gpuAlgorithm,
    setGpuAlgorithm,
    isMining,
    isMiningCpu,
    isMiningGpu,
    isAnyMining,
    miningStarting,
    workerName,
    setWorkerName,
    miningIntensity,
    gpuIntensity,
    gpuIntensityLevel,
    setGpuIntensityLevel,
    gpuVramLimit,
    setGpuVramLimit,
    cpuThreadCount,
    cpuThreads,
    setCpuThreads,
    gpus,
    gpuSelection,
    setGpuSelection,
    runningCpuMiner,
    minersReady,
    minerError,
    minerInfo,
    enableMsr,
    setEnableMsr,
    msrStatus,
    showFixMsrDialog,
    setShowFixMsrDialog,
    hashrateSamples,
    session,
    startMining,
    stopMining,
    selectedPoolId,
    setSelectedPoolId,
    selectedPool,
    availablePools,
    poolStats,
    poolStatsLoading,
    poolStatsError,
    statsOptInForCurrent,
    optInToPoolStats,
    refreshPoolStats,
    poolPings,
    pingingPools,
    pingPools,
    pingPoolDeep,
    proxy,
    showMinerWindow,
    toggleShowMinerWindow,
    displayMinPayout,
  } = miner;

  // Resolve the payout address for the currently-selected mining coin
  // exactly once per render. In the full wallet this comes from the
  // decrypted vault; in PwndaLite it comes from the user-typed paste
  // field in LiteSettingsView. The component below treats it as an
  // opaque string-or-null — no key material involved.
  const minerAddress = addressFor(miningCoin);

  // The per-CPU-coin memory (lastCpuCoinRef) + the coin-aware hardware
  // switch now live in `useMiner` as `switchHardware`, so the landscape
  // toggle shares the exact same logic and the memory survives a mem_guard
  // reload (seeded from the persisted descriptor). See useMiner.ts.

  // Chart-mode state. Lazy-init from localStorage so the user's last
  // pick survives app restarts. Persistence on change is a one-line
  // effect — see [[hashrate-history]] §"UI design".
  const [chartMode, setChartMode] = useState<ChartMode>(loadInitialChartMode);
  // F3 (2026-05-25) — Advanced disclosure for ALGO select + MSR
  // optimization checkbox + DEBUG row. P1 doesn't need to see any of
  // these in their first session; power users click once.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(CHART_MODE_LS_KEY, chartMode);
    } catch {
      /* private mode / quota — non-fatal, the in-memory state still works */
    }
  }, [chartMode]);

  // Tier-2 persistent hashrate history. Hook owns its own lifecycle
  // (load on mount, 60s aggregator while mining, 5-min debounced disk
  // writes, force-flush on Stop / unmount). See `usePersistentHashrate.ts`
  // + `hashrateHistoryStore.ts`. We always call the hook — it's cheap
  // when not mining and the 24h chart needs the historical buckets even
  // when the user isn't currently mining (so they can see "I mined at
  // 3 PM yesterday").
  const persistentHashrate = usePersistentHashrate({
    mining: isMining,
    miningCoin,
    miningHardware,
    cpuAlgorithm,
    gpuAlgorithm,
    hashrateSamples,
  });

  const selectedProbe = selectedPoolId ? poolPings[selectedPoolId] : undefined;
  const gpuOctopusBlock =
    miningHardware === "gpu" && gpuAlgorithm === "octopus";
  const algoForDisplay =
    miningHardware === "cpu" ? cpuAlgorithm : gpuAlgorithm;
  // One label table (`algorithms.ts`), not a per-surface if/else chain whose
  // final `else` names a specific algorithm — that shape is why a ZANO
  // session read "Octopus" here until 2026-09-15.
  const algoLabel = ALGORITHM_LABEL[algoForDisplay];
  // Which binary the CPU lane runs (the backend's answer while it mines).
  // Gates the xmrig-only MSR controls below: XelisHash runs on SRBMiner's CPU
  // lane, unelevated, where MSR mod means nothing. The hashrate-fix panel
  // takes the same gate from `XmrigHashrateFix` — until 2026-09-16 it was
  // gated on the CPU lane alone, despite this comment.
  const cpuMinerBinary = cpuLaneMiner({ cpuAlgorithm, isMiningCpu, runningCpuMiner });

  /**
   * What the mined coin may claim, and whether this lane can start — the
   * same two decisions SIMPLE and landscape PRO render. Portrait PRO's own
   * numbers were already native; what it lacked was the capability-gated
   * EARN block (promo + chips + note), which it now mounts below.
   */
  const asset = useMinedAssetView({
    miningCoin,
    projection,
    minedAmount,
    pricesByTicker,
  });
  const blockedBy = startBlocker({ minersReady, payoutAddress: minerAddress });

  // Per-coin profitability tiles — same source-of-truth pipeline the
  // landscape view uses. Five `useCoinStats` calls share one in-memory
  // WhatToMine fetch via fetchCoinStats's inflight Map; the device
  // profile then runs each (device × coin) through estimateEarningsForChain.
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
  // Pick the device row matching the current hardware kind (CPU rows
  // serve XMR + ZEPH; GPU rows serve RVN + CFX). For multi-GPU rigs
  // this picks the first row, which is the highest-priority device
  // surfaced by `useDeviceProfile`.
  const activeDevice =
    profile.devices.find((d) => d.kind === miningHardware) ?? null;
  const profitabilityRows: {
    chain: ChainType;
    ticker: string;
    algoLabel: string;
    lanes: string;
    perDayUsd: number;
  }[] = MINING_COINS.map((c) => {
    // Source each prediction from a device row on a lane the COIN can
    // actually use, not the user's currently-selected one — so a CPU coin
    // still shows a figure while the user is looking at GPU mining. A
    // dual-lane coin (XEL) prefers the DISPLAYED lane, so its tile answers
    // "what would this pay me on the lane I'm looking at".
    //
    // The list is the roster itself. The hardcoded five-coin array that was
    // here is why ZANO never appeared in this strip after it shipped, and
    // the `isCpuCoin = monero || zephyr` test it used could not describe a
    // coin that mines on both lanes at all.
    const lane = coinMinesOn(c.chain, miningHardware)
      ? miningHardware
      : coinLanes(c.chain)[0];
    const dev = profile.devices.find((d) => d.kind === lane);
    return {
      chain: c.chain,
      ticker: c.sym,
      algoLabel: c.algo,
      lanes: lanesLabel(c.chain),
      perDayUsd: dev?.predictions[c.chain]?.perDayUsd ?? 0,
    };
  });
  const onPickCoinFromTile = (chain: ChainType) => {
    const a = getCoinMeta(chain);
    // One rule, shared with the SIMPLE view — see `pickCoin.ts` for the
    // 2026-08-28 defect that came from having three versions of it.
    pickMiningCoin(chain, miner);
  };
  void activeDevice; // surfaced via the row's prediction; keep ref for future expansion

  /**
   * SIMPLE / PRO, the same split as landscape and from the same store.
   *
   * Portrait gets it too because the contributor guide's landscape-first rule is about
   * PARITY, not about landscape being the only surface: a Mine tab that
   * defaults to the console on one layout and to the balance on the other is
   * two products. `MineSimpleView` is the shared component; only the
   * arrangement differs, via `compact`.
   */
  const [viewMode, setViewMode] = useState<MineViewMode>(() => readMineViewMode());
  const setMode = (m: MineViewMode) => {
    setViewMode(m);
    writeMineViewMode(m);
  };

  if (viewMode === "simple") {
    return (
      <div className="mining-view" style={{ animation: "fade-in .2s ease" }}>
        <div className="mine-topbar">
          <button className="btn-icon" onClick={onBack} title="Back to wallet">◄</button>
          <span className="mine-topbar-title"><ST delay={0} speed={22}>MINING</ST></span>
          <span className="mine-topbar-pool">
            <ViewModeChip mode="simple" onToggle={() => setMode("pro")} />
          </span>
        </div>
        <div style={{ padding: 10 }}>
          <MineSimpleView
            miner={miner}
            addressFor={addressFor}
            onSetup={onSetup}
            compact
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
      </div>
    );
  }
  return (
    <div className="mining-view" style={{ animation: "fade-in .2s ease" }}>
      <div className="mine-topbar">
        <button className="btn-icon" onClick={onBack} title="Back to wallet">◄</button>
        <span className="mine-topbar-title"><ST delay={0} speed={22}>MINING</ST></span>
        <span className="mine-topbar-pool" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ST delay={60} speed={18}>
            {selectedPool ? poolHostPort(selectedPool.endpoint) : "—"}
          </ST>
          <ViewModeChip mode="pro" onToggle={() => setMode("simple")} />
        </span>
      </div>

      {/* v2 status hero — mounted in both states. When mining: green
          hashrate, Stop button, session timer + counters. When idle:
          gray "0" placeholder, "Start mining" button, session block
          hidden. The configuration form below is the surface for
          changes; the tiles in this block are read-only mirrors. */}
      <MiningRunningHero
        mining={isMining}
        starting={miningStarting}
        blockedBy={blockedBy}
        onSetup={onSetup}
        session={session}
        hashrateSamples={hashrateSamples}
        baseUnit={algorithmHashUnit(algoForDisplay)}
        coinTicker={getCoinMeta(miningCoin).ticker}
        coinName={getCoinMeta(miningCoin).displayName}
        coinChain={miningCoin}
        algoLabel={algoLabel}
        // The thread count follows the binary that will actually run (xmrig
        // takes a percentage hint, SRBMiner an exact count) — one helper,
        // shared with landscape's header chip and hardware rows.
        hardwareLabel={
          miningHardware === "cpu"
            ? `CPU · ${cpuThreadsLabel({
                mining: isMining,
                threadsActive: session?.threadsActive,
                intensity: miningIntensity,
                cpuThreadCount,
                cpuThreads,
                cpuMiner: cpuMinerBinary,
              })}`
            : "GPU"
        }
        intensityLabel={laneIntensityLabel({
          hardware: miningHardware,
          miningIntensity,
          gpuIntensity,
          gpuIntensityLevel,
        })}
        // Hide the INTENSITY tile where the lane's miner has no intensity
        // surface (lolMiner / Octopus).
        showIntensity={laneHasIntensity(miningHardware, gpuAlgorithm)}
        poolLabel={
          selectedPool ? poolHostPort(selectedPool.endpoint) : "—"
        }
        workerLabel={workerName || "—"}
        // USD price for the mining coin's ticker — needed for the
        // hero kH/s USD-caption (UXS-20260516-002) and the SESSION
        // card EST. EARNINGS USD value (UXS-20260516-001). Passed
        // through unchanged when undefined; the hero falls back to
        // coin-units + "price unavailable" copy in that case.
        pricesByTicker={pricesByTicker}
        // ── Two-tier chart inputs ──────────────────────────────────
        // The hero panel picks one tier to render based on `chartMode`:
        //   "1h"  → in-memory `hashrateSamples` (current behaviour)
        //   "24h" → disk-persisted minute buckets for this (chain, algo)
        // Both tiers are wired in; switching is a single setState.
        chartMode={chartMode}
        setChartMode={setChartMode}
        historyBuckets={persistentHashrate.activeSeries}
        historyLoaded={persistentHashrate.loaded}
        // PoolStatsPanel slot — replaces the "Recent mining sessions"
        // list that previously rendered here. Conditional render: only
        // when the pool has a registered stats adapter (HashVault /
        // HeroMiners / WoolyPooly / Nanopool / Ntminer paths) AND we
        // have a wallet address to look up. Otherwise the slot stays
        // empty rather than showing a "no adapter" stub.
        poolStatsSlot={
          selectedPool && minerAddress && getStatsAdapter(selectedPool.id) ? (
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
          ) : null
        }
        onStart={startMining}
        onStop={stopMining}
      />

      {/* useMiner's error/info lines and the blocked-start hint — the same
          banner landscape PRO and SIMPLE render. The hint used to sit near
          the bottom of this page; it now sits under the control it explains. */}
      <MinerStatusBanner
        error={minerError}
        info={minerInfo}
        blockedBy={blockedBy}
        mining={isMining}
        style={{ marginBottom: 12 }}
      />

      {/* EARN promo + display-coin chips for a coin with a route; the
          capability note for one without. Portrait PRO rendered none of
          these until 2026-09-16, although `onOpenEarn` was wired to it. */}
      <EarnCapabilityBlock
        asset={asset}
        onSelectDisplayCoin={onSelectDisplayCoin}
        reachableTickers={reachableTickers}
        onOpenEarn={onOpenEarn}
        conversionRunning={conversionRunning}
        compact
        style={{ marginBottom: 12 }}
      />

      {/* Per-coin profitability strip — mirrors the landscape coin
          picker's $/day chip but laid out as a 2×2 grid for the 560
          px portrait width. Click a tile to set the coin (and auto-
          flip CPU↔GPU); active tile gets the chain accent border. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          margin: "10px 0 12px",
        }}
      >
        {profitabilityRows.map((r) => {
          const adapter = getCoinMeta(r.chain);
          const active = r.chain === miningCoin;
          const hasPrediction = r.perDayUsd > 0;
          // Per-lane lock (BUG 2): a tile is only locked while ITS OWN lane
          // mines. The idle lane's coins stay switchable so the user can,
          // e.g., select & start a GPU coin while a CPU session runs.
                    const laneMining = coinTileLocked(r.chain, miner);
          return (
            <button
              key={r.chain}
              onClick={() => onPickCoinFromTile(r.chain)}
              disabled={laneMining}
              title={
                laneMining
                  ? "Stop this coin's miner to switch it"
                  : `Switch to ${adapter.displayName}`
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                background: active ? `${adapter.color}14` : "var(--surface)",
                border: `1px solid ${active ? adapter.color : "var(--border)"}`,
                cursor: laneMining ? "not-allowed" : "pointer",
                opacity: laneMining && !active ? 0.5 : 1,
                textAlign: "left",
                fontFamily: "var(--font-mono)",
                transition: "border-color .12s ease",
              }}
            >
              <CoinIcon
                sym={adapter.ticker}
                size={20}
                glow={false}
                accent={active ? adapter.color : undefined}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: active ? adapter.color : "var(--text)",
                    fontWeight: 500,
                  }}
                >
                  {adapter.displayName}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: "var(--text-dim)",
                    letterSpacing: 0.5,
                    marginTop: 1,
                    textTransform: "uppercase",
                  }}
                >
                  {r.algoLabel} · {r.lanes}
                </div>
              </div>
              <div
                className="tnum"
                style={{
                  fontSize: 12,
                  color: hasPrediction ? "var(--accent)" : "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                {hasPrediction
                  ? `$${r.perDayUsd.toFixed(r.perDayUsd >= 100 ? 0 : 2)}`
                  : "—"}
                <span
                  style={{
                    fontSize: 9,
                    color: "var(--text-dim)",
                    marginLeft: 3,
                    letterSpacing: 0.5,
                  }}
                >
                  /day
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/*
        COIN dropdown removed 2026-05-14 — the 5 profitability tiles above
        are now the exclusive way to switch mining coin. Keeps the dropdown
        from drifting out of sync with the supported-coin list (which is
        the tile array), and prevents the user from picking a non-mineable
        chain (BTC, ETH, etc.) that the dropdown previously surfaced via
        the full ALL_CHAINS spread.
      */}
      {/* Pool + worker are a direct, always-visible editor. The T2.3
          collapsed "change ▾" summary that expanded into the dropdown was
          removed 2026-06-13 per user request — a plain dropdown with no
          expand/spawn indirection. */}
      <div className="mine-row">
        <div className="mine-field mine-field-worker" style={{ flex: 1 }}>
          <label className="mine-label"><ST delay={175} speed={22}>WORKER</ST></label>
          <input
            className="mine-input"
            type="text"
            placeholder="worker1"
            value={workerName}
            onChange={(e) => setWorkerName(e.target.value)}
            disabled={isMining}
          />
        </div>
      </div>

      <div className="mine-row">
        <div className="mine-field" style={{ flex: 1 }}>
          <label className="mine-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ST delay={200} speed={22}>POOL</ST>
            {selectedPool && displayMinPayout(selectedPool) !== "—" && (
              <span style={{ opacity: 0.6, fontSize: 9 }}>
                min {displayMinPayout(selectedPool)}
              </span>
            )}
            <button
              type="button"
              className="btn-link"
              onClick={() => pingPools()}
              disabled={pingingPools || availablePools.length === 0}
              style={{ marginLeft: "auto", fontSize: 9 }}
              title="Test which pools your network can actually reach"
            >
              {pingingPools ? "testing…" : "test pools"}
            </button>
          </label>
          <select
            id="mining-pool-select"
            className="mine-select"
            value={selectedPoolId ?? ""}
            onChange={(e) => setSelectedPoolId(e.target.value || null)}
            disabled={isMining || availablePools.length === 0}
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
          {selectedProbe && !selectedProbe.ok && (
            <div
              style={{
                marginTop: 6,
                fontSize: 9,
                color: "var(--danger, #ff6b6b)",
                fontFamily: "var(--mono)",
              }}
            >
              {selectedProbe.stage === "dns"
                ? "DNS resolution failed. Try `ipconfig /flushdns` — stale state from a recent VPN session is the most common cause."
                : selectedProbe.stage === "config"
                ? "Pool host not recognized by smoke test — this is a wallet bug, not a connection issue. Mining itself may still work. Please report."
                : selectedProbe.stage === "tcp"
                ? "Port appears blocked — likely your firewall. Try another pool, or `netsh winsock reset` (admin) if you recently used a VPN."
                : selectedProbe.stage === "tls"
                ? "TLS handshake failed. Network may be inspecting traffic; pick a non-SSL pool if available."
                : selectedProbe.stage === "stratum"
                ? `Subscribe didn't reach the pool's stratum service${selectedProbe.error ? ` (${selectedProbe.error})` : ""}. Click Deep test for a longer wait, or toggle proxy mode if you're using one.`
                : selectedProbe.stage === "authorize"
                ? `Pool ack'd subscribe but rejected authorize${selectedProbe.error ? ` (${selectedProbe.error})` : ""}. Pool may have changed its auth protocol; try Deep test.`
                : selectedProbe.stage === "notify-wait"
                ? `Handshake clean, but no mining job arrived within the wait window${selectedProbe.error ? ` (${selectedProbe.error})` : ""}. Pool's job backend may be lagging.`
                : "Unreachable — check the endpoint and try again."}
              {/* Deep test affordance — only meaningful for stages where
                  more probing can disambiguate. Hidden on `config` (a
                  bug, not a connection issue) and `notify-wait` (already
                  was L3). */}
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
                      title="Reconnect and wait for the pool's first mining.notify push (1-25s by algo)"
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
                marginTop: 6,
                fontSize: 9,
                opacity: 0.6,
                fontFamily: "var(--mono)",
              }}
            >
              {selectedProbe.note} — first probe attempt was flaky, the
              follow-up reached the pool cleanly.
            </div>
          )}
          <ProxyModePanel
            proxy={proxy}
            disabled={isMining}
            gpuOctopusBlock={gpuOctopusBlock}
            compact
          />
        </div>
      </div>

      {/* Hardware toggle is always clickable. Switching while a hardware is
          mining only changes the displayed configuration — the inactive
          hardware keeps mining in the background. A small live dot on each
          button signals which hardware is currently mining so the user
          knows it's still running when they switch away. */}
      {/* B1 (2026-05-26) — hardware toggle now always syncs `miningCoin`
          to whatever's valid for the selected hardware. Before this fix,
          `setMiningCoin(...)` was guarded by `!isMiningCpu` / `!isMiningGpu`
          so when a user switched back to a hardware that was still
          mining, the coin stayed at the OTHER hardware's coin — leaving
          the panel in an impossible state (e.g. `miningCoin="monero"`
          while `gpuAlgorithm="autolykos"`). That made the earnings card
          render Monero stats off the GPU hashrate, inflating the
          $/day figure massively (~$4,519/day vs actual ~$0.50/day in
          the reported 2026-05-26 incident). */}
      <div className="mine-hw-toggle">
        <button
          className={`mine-hw-btn ${miningHardware === "cpu" ? "active" : ""}`}
          onClick={() => switchHardware("cpu")}
        >
          <ST delay={230} speed={22}>CPU</ST>
          {isMiningCpu && <RunningDot />}
        </button>
        <button
          className={`mine-hw-btn ${miningHardware === "gpu" ? "active" : ""}`}
          onClick={() => switchHardware("gpu")}
        >
          <ST delay={285} speed={22}>GPU</ST>
          {isMiningGpu && <RunningDot />}
        </button>
      </div>

      <div className="mine-config">
        {miningHardware === "cpu" ? (
          <>
            {/* CPU thread slider — the shared lane block landscape PRO
                mounts too (LaneTuningControls). Replaced the three-step
                LOAD tier 2026-09-16. */}
            <LaneTuningControls
              hardware="cpu"
              gpuAlgorithm={gpuAlgorithm}
              cpuMiner={cpuMinerBinary}
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
              variant="compact"
              delayBase={450}
            />
            {advancedOpen && (
              <>
                <div className="mine-config-row">
                  <span className="mine-label"><ST delay={340} speed={22}>ALGO</ST></span>
                  <select
                    className="mine-select mine-select-sm"
                    value={cpuAlgorithm}
                    onChange={(e) => {
                      const next = e.target.value as CpuAlgorithm;
                      setCpuAlgorithm(next);
                      // Move the coin with the algorithm. Leaving Monero
                      // selected under XelisHash would describe a pairing
                      // that cannot start — and the GPU select had exactly
                      // that defect until 2026-09-15. Routed through the
                      // shared picker, the same one the tiles use.
                      const fits =
                        coinMinesOn(miningCoin, "cpu") &&
                        algorithmFor(miningCoin, "cpu") === next;
                      if (!fits) {
                        pickMiningCoin(CPU_ALGORITHM_DEFAULT_COIN[next], miner);
                      }
                    }}
                    disabled={isMining}
                  >
                    <option value="randomx">RandomX (XMR/ZEPH)</option>
                    <option value="xelishashv3">XelisHash v3 (XEL)</option>
                  </select>
                </div>
                {/* MSR mod is an xmrig/RandomX feature: it needs elevation
                    and rewrites model-specific registers to speed up the
                    RandomX dataset. SRBMiner's CPU lane (XelisHash) runs
                    unelevated and ignores all of it, so the checkbox and its
                    status line would be dead controls there. */}
                {cpuMinerBinary === "xmrig" && (
                  <>
                    <div className="mine-config-row mine-msr-row">
                      <label className="mine-msr-label">
                        <input
                          type="checkbox"
                          checked={enableMsr}
                          onChange={(e) => setEnableMsr(e.target.checked)}
                          disabled={isMining}
                        />
                        <ST delay={615} speed={20}>MSR optimization</ST>
                      </label>
                      <button type="button" className="btn-link" onClick={() => setShowFixMsrDialog(true)}>
                        <ST delay={670} speed={22}>fix msr</ST>
                      </button>
                    </div>
                    {isMining && msrStatus !== "unknown" && msrStatus !== "disabled" && (
                      <div className="mine-msr-status">
                        MSR: {msrStatus === "ok" ? "Applied" : "Not applied"}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="mine-config-row">
              <span className="mine-label"><ST delay={340} speed={22}>ALGO</ST></span>
              <select
                className="mine-select mine-select-sm"
                value={gpuAlgorithm}
                onChange={(e) => {
                  const next = e.target.value as GpuAlgorithm;
                  setGpuAlgorithm(next);
                  // Each GPU algorithm belongs to exactly one coin, so the
                  // coin follows the pick. Until 2026-09-15 this select
                  // changed ONLY the algorithm: choosing Autolykos2 while
                  // Ravencoin was selected left the panel claiming to mine
                  // RVN with Ergo's algorithm. ZANO was also missing from
                  // the list entirely, so it was unreachable here.
                  pickMiningCoin(GPU_ALGORITHM_COIN[next], miner);
                }}
                disabled={isMining}
              >
                <option value="kawpow">KawPow (RVN)</option>
                <option value="octopus">Octopus (CFX)</option>
                <option value="autolykos">Autolykos2 (ERG)</option>
                <option value="progpowz">ProgPowZ (ZANO)</option>
                <option value="xelishashv3">XelisHash v3 (XEL)</option>
              </select>
            </div>
            {/* GPU device picker + intensity slider — the shared lane block
                landscape PRO mounts too. The intensity slider covers AUTO (no
                flag) and SRBMiner's documented 1-31; on lolMiner's lane
                (Octopus / CFX, no `--gpu-intensity`) it renders locked with
                the reason. See `wiki/concepts/srbminer-flags.md`. */}
            <LaneTuningControls
              hardware="gpu"
              gpuAlgorithm={gpuAlgorithm}
              cpuMiner={cpuMinerBinary}
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
              variant="compact"
              delayBase={420}
            />
          </>
        )}
      </div>

      {minerAddress && (
        <div className="mine-payout-info">
          <span className="mine-label"><ST delay={725} speed={22}>PAYOUT</ST></span>
          <code className="mine-payout-addr">
            <ST delay={780} speed={16}>
              {`${CHAIN_MINING_PREFIX[miningCoin]}:${minerAddress.slice(0, 12)}...${minerAddress.slice(-6)}`}
            </ST>
          </code>
        </div>
      )}

      {/* F3 — Advanced disclosure toggle. Sits at the top of the
          advanced cluster so users can find it without scrolling. */}
      <div style={{ marginTop: 10, textAlign: "right" }}>
        <button
          type="button"
          className="btn-link"
          onClick={() => setAdvancedOpen((v) => !v)}
          style={{ fontSize: 10, letterSpacing: 0.5 }}
          title={
            advancedOpen
              ? "Hide algorithm, MSR, and debug controls"
              : "Show algorithm, MSR, and debug controls"
          }
        >
          {advancedOpen ? "▴ hide advanced" : "▸ advanced"}
        </button>
      </div>

      {/* Debug toggle — pops up the miner console window on next start so
          the user can see share accept/reject lines and pool errors live.
          Same plumbing as the landscape view. Gated behind the Advanced
          disclosure per F3. */}
      {advancedOpen && (
        <div className="mine-config-row" style={{ marginTop: 10 }}>
          <span className="mine-label"><ST delay={820} speed={22}>DEBUG</ST></span>
          <button
            type="button"
            className="btn-link"
            onClick={toggleShowMinerWindow}
            title={
              showMinerWindow
                ? "Hide the miner console window on next start."
                : "Show the miner console window on next start so you can see live share/diff output."
            }
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: 0.5,
              color: showMinerWindow ? "var(--accent)" : "var(--text-dim)",
            }}
          >
            show miner console: {showMinerWindow ? "ON" : "OFF"}
          </button>
        </div>
      )}


      {/* Bottom-of-page HashrateChart removed 2026-05-15.
          The MiningRunningHero above now carries:
            - the headline current-hashrate readout (38px)
            - the MiniSpark sparkline
            - the CUR / PEAK / AVG / n stats strip (was the
              HashrateChart's footer; ported up)
            - the SESSION counters panel
          Keeping a second chart down here was duplicative. */}

      {/* F4 — "MINING ACTIVE · XMR · RandomX · 32 threads" banner dropped.
          The hero above already shows hashrate + coin ticker + hardware
          and the SESSION card has uptime + shares. The banner was pure
          duplication. The concurrent-mining hint (CPU also mining /
          GPU also mining) survives as a small inline pill so users with
          both hardwares running still know. */}
      {isMining && isAnyMining && isMiningCpu && isMiningGpu && (
        <div
          className="mine-status-line"
          style={{ fontSize: 9, color: "var(--text-dim)" }}
        >
          <Dot color="green" />
          <ST speed={18}>
            {miningHardware === "cpu" ? "GPU also mining" : "CPU also mining"}
          </ST>
        </div>
      )}

      {/* DAG-warming hint (GPU only).
       *
       * 2026-05-18 — Prevents the "user stops mining at 15s thinking it's
       * broken" pattern from 2026-05-17 night sessions (WoolyPooly ERG +
       * NTMiner CFX both ended with session_ended `user stopped GPU
       * mining` 13–15s after handshake, before either miner had even
       * finished its DAG load). The proxy was working fine; the UI just
       * gave no feedback that the first 30–90 seconds of a GPU session
       * are DAG load + first-share-search, not bugs.
       *
       * Visibility window: shown ONLY when
       *   - GPU is currently mining
       *   - Session has started (snapshot has been polled at least once)
       *   - Uptime < 90s
       *   - No non-zero hashrate sample has arrived yet
       *
       * Auto-hides on either first non-zero hashrate sample OR 90s
       * elapsed — whichever comes first.
       */}
      {isMining && miningHardware === "gpu" && session &&
        session.uptimeSecs < 90 &&
        !hashrateSamples.some((s) => s.value > 0) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            margin: "6px 0",
            border: "1px solid var(--border-soft)",
            background: "var(--surface)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          <span style={{ color: "var(--accent)" }}>⟳</span>
          <ST speed={20}>
            GPU warming up · DAG load + first share usually 30–90s. Don't worry
            if hashrate is 0 for a moment.
          </ST>
        </div>
      )}

      {/* The setup hint that lived here (can't start: miners missing / no
          address; hidden while mining, F4 2026-05-25) moved into the shared
          <MinerStatusBanner> under the hero on 2026-09-16, so landscape and
          SIMPLE show the same words. */}

      {/* Bottom-of-page <PoolStatsPanel> removed 2026-05-15. The same
          panel is now rendered inside <MiningRunningHero> in the slot
          where the "Recent mining sessions" list used to live — see
          `poolStatsSlot` plumbing below. Keeping the panel up near the
          hashrate readout puts Pending / Hashrate / Shares in the
          user's eyeline without scrolling. */}

      {/* xmrig-only diagnostics. Gated on the CPU lane running XMRIG, not
          just on the CPU lane — see `XmrigHashrateFix`. */}
      <XmrigHashrateFix miner={miner} />

      {showFixMsrDialog && (
        <div className="modal-overlay" onClick={() => setShowFixMsrDialog(false)}>
          <div className="modal-dialog fix-msr-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Fix MSR optimization</h3>
            <p>If you see &quot;FAILED TO APPLY MSR MOD&quot; or low hashrate:</p>
            <ol>
              <li>Close AIDA64, HWiNFO, RGB/fan control apps.</li>
              <li>Run PwndaWallet as Administrator.</li>
              <li>Add miner folder to Defender exclusions.</li>
              <li>If still failing, disable MSR and mine without it.</li>
            </ol>
            <p className="fix-msr-note">
              On Windows 11 with Secure Boot, the MSR driver may be blocked.
            </p>
            <button type="button" className="btn-primary" onClick={() => setShowFixMsrDialog(false)}>OK</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   MiningRunningHero — v2 design's focal block. Renders in both
   states. When `mining`, the hashrate is live + accent green, spark
   is the recent sample window, the button is "Stop mining" (danger),
   and the SESSION block is shown. When idle, the hashrate is a dim
   "0" placeholder, the spark is a flat zero line, the button is
   "Start mining" (accent), and SESSION is hidden. The 2×3 tiles are
   read-only mirrors of the configuration form below in both states.
   ────────────────────────────────────────────────────────────────── */
function MiningRunningHero({
  mining,
  starting,
  blockedBy,
  onSetup,
  session,
  hashrateSamples,
  baseUnit,
  coinTicker,
  coinName,
  coinChain,
  algoLabel,
  hardwareLabel,
  intensityLabel,
  showIntensity,
  poolLabel,
  workerLabel,
  onStart,
  onStop,
  chartMode,
  setChartMode,
  historyBuckets,
  historyLoaded,
  poolStatsSlot,
  pricesByTicker,
}: {
  mining: boolean;
  starting: boolean;
  /** Which precondition is missing, or `null` when the lane can start. Drives
   *  the CTA label so it names the thing that's actually wrong. Before
   *  2026-08-12 the button read "Set up miners" for BOTH causes, which sent
   *  users to reinstall already-working miners when the real blocker was a
   *  missing payout address for the selected coin. */
  blockedBy: StartBlocker;
  /** Click handler for the disabled-state CTA. When `canStart` is
   *  false the green "Setup miners to start" button used to be inert
   *  (UXS-20260516-115). It now navigates to Miner Setup via this
   *  callback so the action verb in the button text matches the
   *  actual outcome of clicking. Optional so callers that haven't
   *  wired it yet keep the legacy inert behaviour. */
  onSetup?: () => void;
  session: import("./useMiner").MinerSession | null;
  hashrateSamples: { t: number; value: number }[];
  baseUnit: string;
  coinTicker: string;
  coinName: string;
  coinChain: ChainType;
  algoLabel: string;
  hardwareLabel: string;
  intensityLabel: string;
  /**
   * Whether to render the INTENSITY tile. Only xmrig (CPU) and
   * SRBMiner-MULTI (KawPow/Autolykos2) expose an intensity / threads
   * control surface; lolMiner (Octopus/CFX) does not. Caller decides
   * based on (miningHardware, gpuAlgorithm).
   */
  showIntensity: boolean;
  poolLabel: string;
  workerLabel: string;
  onStart: () => void;
  onStop: () => void;
  /**
   * Two-tier hashrate history view selector. "1h" = `<HashrateAreaChart>`
   * over the in-memory `hashrateSamples` buffer (1-hour rolling window).
   * "24h" = the same chart fed by the disk-persisted minute buckets.
   * Persisted to localStorage by the caller.
   */
  chartMode: ChartMode;
  setChartMode: (m: ChartMode) => void;
  /**
   * Disk-persisted 1-minute buckets for the currently active
   * `(miningCoin, algorithm)` series. Empty when no data yet for this
   * pair (the 24h chart shows an empty-state message in that case).
   */
  historyBuckets: HashrateBucket[];
  /** Whether the disk-hydrate has resolved. Used to suppress a flash of
   *  empty-state during initial load. */
  historyLoaded: boolean;
  /**
   * Optional slot rendered right below the CUR/PEAK/AVG strip — owned by
   * the parent so the hero panel doesn't need to know about pool-stats
   * plumbing. Replaces the "Recent mining sessions" list that previously
   * sat in this position (2026-05-15). Pass `null` when the selected
   * pool has no stats adapter wired up.
   */
  poolStatsSlot?: import("react").ReactNode;
  /** Spot USD prices keyed by uppercase ticker. Optional — when
   *  present, the hashrate hero gains a `≈ $X.XX/day` caption and the
   *  SESSION card's EST. EARNINGS cell renders a USD/day value. When
   *  absent, both fall back to coin-units with explanatory copy. */
  pricesByTicker?: Record<string, number>;
}) {
  // Session timer rendered as a sibling component (see <SessionTimer>
  // below) so its 1-second `tick` interval doesn't re-render the entire
  // hero panel — including the HashrateAreaChart, which has to recompute
  // its bridged path + SVG path strings on every render. Pre-2026-05-27
  // the timer lived here and the hero re-rendered every second, which
  // over a 12-hour overnight session was ~43k re-renders and produced
  // multi-gigabyte WebView2 memory growth from V8 churn on the chart's
  // ~1500 SVG path commands per render.

  const current =
    mining && hashrateSamples.length > 0
      ? hashrateSamples[hashrateSamples.length - 1].value
      : null;
  const heroParts = formatHashrateParts(current, baseUnit);

  // ── Tier-1 stats (CUR / PEAK / AVG over the 1-hour sample buffer) ─
  // Sourced from the same sample buffer the 1 HR area chart renders.
  // `statsCapacity` mirrors `MAX_HASHRATE_SAMPLES` in useMiner.ts (1800 =
  // 1 hour at 2-s polling, bumped from 300 on 2026-05-15 to honour the
  // "1 HR" toggle label). If you change one, change the other.
  //
  // 2026-05-28 — wrapped in `useMemo` over `hashrateSamples` and computed
  // with a single-pass loop instead of `.map(...)` + `Math.max(...spread)`.
  // Pre-fix every 2-Hz render allocated:
  //   - a fresh 1800-element `statsValues` array via `.map`
  //   - another temporary array via the 1800-arg `...` spread to Math.max
  //   - a reduce accumulator chain over 1800 elements
  // Over an 8-hour overnight session that's ~14k renders × ~30 KB =
  // ~430 MB of allocations, which became the dominant residual GC
  // pressure source after the 2026-05-27 SessionTimer extraction. The
  // single-pass loop allocates only the three result numbers; useMemo
  // skips recomputation when the parent re-renders for unrelated reasons.
  const { statsPeak, statsAvg, statsN } = useMemo(() => {
    let peak = 0;
    let sum = 0;
    const n = hashrateSamples.length;
    for (const s of hashrateSamples) {
      if (s.value > peak) peak = s.value;
      sum += s.value;
    }
    return {
      statsPeak: peak,
      statsAvg: n > 0 ? sum / n : 0,
      statsN: n,
    };
  }, [hashrateSamples]);
  const statsCapacity = 1800;

  // ── Tier-2 stats (CUR / 24h PEAK / 24h AVG over persistent buckets) ─
  // Buckets carry per-minute (avg, n) so the 24h-AVG below is the
  // sample-count-weighted average across the window. PEAK is the max
  // single-bucket avg, which is itself already a 60-sample average
  // (smoothed). CUR in 24h mode is still the live last-second value
  // when mining; falls back to the most-recent bucket's avg otherwise
  // so the cell isn't dim while idle.
  // 2026-05-28 — wrapped in `useMemo` over `historyBuckets`. Pre-fix the
  // IIFE re-ran on every parent re-render (which is every 2 s during
  // mining). historyBuckets is normally stable across hashrate-sample
  // updates (it only changes when a new minute-bucket lands, ~once/min),
  // so memoizing skips ~30 redundant 1440-element loops per minute.
  const bucketStats = useMemo(() => {
    if (!historyBuckets || historyBuckets.length === 0) {
      return { peak: 0, avg: 0, weightedN: 0, lastBucketAvg: 0 };
    }
    let peak = 0;
    let weightedSum = 0;
    let weightedN = 0;
    for (const b of historyBuckets) {
      if (b.avg > peak) peak = b.avg;
      weightedSum += b.avg * b.n;
      weightedN += b.n;
    }
    const avg = weightedN > 0 ? weightedSum / weightedN : 0;
    const lastBucketAvg = historyBuckets[historyBuckets.length - 1].avg;
    return { peak, avg, weightedN, lastBucketAvg };
  }, [historyBuckets]);
  const dayPeak = bucketStats.peak;
  const dayAvg = bucketStats.avg;
  // `lastBucketAvg` was the per-minute CUR fallback for the 24H mode of
  // the dropped CUR cell (T1.4). The 1H mode's `current` is also live
  // in 24H mode for the hero number, so no fallback is needed there.
  void bucketStats.lastBucketAvg;
  // While the buffer is still filling (first ~10 minutes of a session)
  // we surface an `n/300` "warming up" cell so the user can see why
  // CUR/PEAK/AVG might still be moving. Once full, the cell disappears
  // and the strip collapses to a tidy 3-cell CUR/PEAK/AVG.
  const statsWarmingUp = mining && statsN > 0 && statsN < statsCapacity;
  const formatHr = (v: number): string => {
    const p = formatHashrateParts(v, baseUnit);
    return `${p.value} ${p.unit || baseUnit}`;
  };

  // Earnings estimate: needs my hashrate + the chain's volatile params
  // (network hashrate / block reward / block time), layered WhatToMine →
  // per-chain explorer → hardcoded `NETWORK_PARAMS_DEFAULT`. The shared
  // `useMiningEarnings` is the one path every Mine surface prices through.
  const { earnings, coinStats } = useMiningEarnings(
    coinChain,
    mining && current != null && current > 0 ? current : null,
  );

  // USD conversion for the hero caption (UXS-20260516-002) and the
  // SESSION-card EST. EARNINGS cell (UXS-20260516-001). Three states
  // the consumers care about:
  //   - earningsDayUsd === null  → not mining, or chain isn't in
  //     `NETWORK_PARAMS_DEFAULT` (e.g. ethereum) — show "—".
  //   - earningsDayUsd === 0     → mining but price data missing —
  //     show coin-units + "price unavailable" copy.
  //   - earningsDayUsd > 0       → render `$X.XX/day`.
  // The `pricePresent` flag distinguishes (0 from missing) cleanly
  // since `earnings.day * undefined` is NaN otherwise.
  const coinUsdPrice =
    pricesByTicker && coinTicker ? pricesByTicker[coinTicker.toUpperCase()] : undefined;
  const pricePresent =
    typeof coinUsdPrice === "number" && Number.isFinite(coinUsdPrice) && coinUsdPrice > 0;
  const earningsDayUsd =
    earnings && pricePresent ? earnings.day * coinUsdPrice : null;
  // `formatUsdPerDay` is the shared formatter (`minedAssetView.ts`), the one
  // landscape PRO's REV chip and USD row use.

  // 1 HR area-chart input. Pass the raw `{t, value}` samples — the
  // chart bridges idle gaps to zero internally so we don't have to
  // pre-pad anything. When `hashrateSamples` is empty, the chart still
  // renders the wall-clock axis + a flat zero baseline.
  //
  // 2026-06-01 (leak Round 9) — THROTTLE the chart's data reference to at
  // most once per CHART_REPAINT_THROTTLE_MS. `hashrateSamples` gets a new
  // sample (and a new array reference) every 2 s while mining; handing that
  // straight to the chart made it rebuild its full SVG path + repaint every
  // 2 s, and WebView2 leaks renderer-native memory per repaint — the
  // *mining* leak measured at ~1600 MB/h (session T234106Z: 7.7 GB in
  // 4.6 h). On a 1-hour window a 2 s update is sub-pixel and invisible to
  // the user, so we only refresh the chart's source array every ~12 s,
  // cutting repaint-driven leak ~6×. Data is still COLLECTED at 2 s (the
  // stats grid, hero kH/s, etc. read `hashrateSamples` directly and stay
  // live); only the chart's heavy redraw is throttled.
  const throttledSamples = useThrottledRef(hashrateSamples, CHART_REPAINT_THROTTLE_MS);
  const liveAreaData: HashrateAreaPoint[] = throttledSamples;

  // 24 HR area-chart input. Each persisted minute bucket becomes one
  // chart point at the bucket's start time, value = its weighted
  // average. The chart applies the same drop-to-zero gap-bridging on
  // top so multi-hour idle windows render as flat baseline rather
  // than misleading interpolation.
  //
  // Open-bucket extension (reported 2026-05-16: "missing data on
  // right edge after switching to 24 HR"): the most recent fully-
  // closed bucket is up to 60 s old, but the user is still actively
  // mining right now. Append a synthetic "live current" data point
  // anchored at `Date.now()`, valued at the running average of the
  // most recent ~15 raw samples (last 30 s). This carries the line
  // visually all the way to the right edge instead of letting it
  // stop ~60 s short.
  // Memoized so the chart's `data` prop is reference-stable across
  // renders that don't actually change the underlying source. Without
  // this, every parent re-render (every 1-2 s during mining) handed
  // HashrateAreaChart a fresh array reference, invalidating its
  // `useMemo` over `bridgeWithZeros` + the SVG path strings — see the
  // SessionTimer split-out comment above for the leak this contributed
  // to. `hashrateSamples` is intentionally excluded from the deps; the
  // synthetic open-bucket point reads its most recent ~30 s tail, but
  // those values change so slowly that recomputing once per minute
  // (when historyBuckets changes) is plenty accurate for a 24h chart.
  const historyAreaData: HashrateAreaPoint[] = useMemo(() => {
    const buckets: HashrateAreaPoint[] = historyBuckets.map((b) => ({
      t: b.t,
      value: b.avg,
    }));
    if (!mining) return buckets;
    if (hashrateSamples.length === 0) return buckets;
    // Average the last 15 raw samples (~30 s @ 2-s polling) so the
    // open-bucket value matches what a closed bucket would look like
    // — single most-recent sample would be too jittery and produce a
    // visible spike at the right edge.
    const tail = hashrateSamples.slice(-15);
    const avg = tail.reduce((acc, s) => acc + s.value, 0) / tail.length;
    if (!Number.isFinite(avg) || avg <= 0) return buckets;
    // Only append the synthetic point if it lies AFTER the most
    // recent persisted bucket — otherwise we'd backfill into the
    // existing series and the chart would draw a fake spike.
    const lastBucketT = buckets.length > 0 ? buckets[buckets.length - 1].t : 0;
    const now = Date.now();
    if (now <= lastBucketT) return buckets;
    return [...buckets, { t: now, value: Math.round(avg) }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyBuckets, mining]);

  const tile = (k: string, v: React.ReactNode) => (
    <div
      key={k}
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
          letterSpacing: 1.5,
          textTransform: "uppercase",
          fontFamily: "var(--font-mono)",
        }}
      >
        {k}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text)",
          marginTop: 4,
          fontFamily: "var(--font-mono)",
        }}
      >
        {v}
      </div>
    </div>
  );

  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 2,
          textTransform: "uppercase",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>Hashrate</span>

        {/* Spacer pushes the chart-mode toggle to the right edge. */}
        <span style={{ flex: 1 }} />

        {/* [1 HR] / [24 HR] view toggle. 1 HR reads the in-memory
            sparkline (Tier 1). 24 HR reads the disk-persisted buckets
            (Tier 2) and renders idle gaps as flat baseline. The user's
            pick persists across app restarts via localStorage. */}
        {(["1h", "24h"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setChartMode(mode)}
            title={
              mode === "1h"
                ? "Live 10-minute sparkline from the in-memory sample buffer"
                : "Last 24 hours of mining, persisted to disk — survives app restarts"
            }
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              letterSpacing: 1.5,
              padding: "2px 6px",
              border: `1px solid ${chartMode === mode ? "var(--accent-mid)" : "rgba(255,255,255,0.15)"}`,
              background:
                chartMode === mode ? "var(--accent-soft)" : "transparent",
              color:
                chartMode === mode ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              textTransform: "uppercase",
              fontWeight: chartMode === mode ? 600 : 400,
            }}
          >
            {mode === "1h" ? "1 hr" : "24 hr"}
          </button>
        ))}
      </div>
      <div
        className="tnum"
        style={{
          fontSize: 38,
          color: mining ? "var(--accent)" : "var(--text-dim)",
          fontWeight: 600,
          marginTop: 4,
          lineHeight: 1.05,
          textShadow: mining ? "0 0 20px rgba(0,255,102,0.4)" : "none",
          fontFamily: "var(--font-mono)",
        }}
      >
        {mining ? (current === null ? "---" : heroParts.value) : "0"}
        <span
          style={{
            fontSize: 12,
            color: "var(--text-dim)",
            marginLeft: 8,
          }}
        >
          {heroParts.unit || baseUnit}
        </span>
      </div>

      {/* UXS-20260516-002: plain-language USD anchor under the kH/s
          hero so first-time miners get a real-world number they can
          act on. Only shown while mining — idle state already reads
          as "no session", so a misleading "$0/day" caption would be
          worse than nothing. When mining but the chain has no
          earnings model OR the USD price is missing, the caption
          flips to an explanatory hint instead of a fake value. */}
      {mining && earnings && earningsDayUsd !== null && (
        <div
          className="tnum"
          style={{
            marginTop: 2,
            fontSize: 12,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            letterSpacing: 0.3,
          }}
          title="Estimated USD per day at the current hashrate. Real payouts depend on luck, pool fees, and chain difficulty."
        >
          ≈ {formatUsdPerDay(earningsDayUsd)} at current rate
        </div>
      )}
      {mining && earnings && earningsDayUsd === null && (
        <div
          style={{
            marginTop: 2,
            fontSize: 11,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            opacity: 0.85,
          }}
          title="A USD/day estimate needs a live price for this coin's ticker. The price fetch may have failed or rate-limited."
        >
          ≈ {formatCoinAmount(earnings.day, coinTicker)}/day · price unavailable
        </div>
      )}

      {/* Unified area chart — same component drives both views, the only
          difference is `windowMs` + the data source. Renders an area
          fill anchored to a 0 baseline, drops the line to 0 across idle
          windows (rather than leaving a gap), and surfaces a hover
          crosshair with a wall-clock-time + hashrate tooltip. The 24 HR
          mode renders even when not mining — that's its whole point
          ("I mined at 3 PM yesterday"). See `HashrateAreaChart.tsx`
          and `wiki/concepts/hashrate-history.md` § "Chart rendering". */}
      <div style={{ marginTop: 10, marginBottom: 10 }}>
        {chartMode === "1h" ? (
          <HashrateAreaChart
            data={liveAreaData}
            windowMs={60 * 60_000}
            expectedIntervalMs={2_000}
            baseUnit={baseUnit}
            h={110}
            color={mining ? "var(--accent)" : "var(--text-dim)"}
            mining={mining}
            emptyLabel={mining ? undefined : "START MINING TO BEGIN CHARTING"}
          />
        ) : (
          <HashrateAreaChart
            data={historyLoaded ? historyAreaData : []}
            windowMs={24 * 60 * 60_000}
            expectedIntervalMs={60_000}
            baseUnit={baseUnit}
            h={110}
            color={mining ? "var(--accent)" : "var(--text-dim)"}
            mining={mining}
            emptyLabel="NO MINING IN THE LAST 24 HR"
          />
        )}
      </div>

      {/* PEAK / AVG strip — labels + values switch based on chart mode.
          CUR was dropped per ease-of-use-improvement-plan T1.4 since the
          hashrate hero above already displays the current value; CUR
          duplicated it and made the strip noisier without adding info.
          In 1 HR mode this is the 10-min in-memory window with the
          optional `n` warming-up cell. In 24 HR mode it's the disk-
          persisted full 24-hour aggregate (labels prefixed "24H"). */}
      {(() => {
        const cells: [string, string, string, boolean][] =
          chartMode === "1h"
            ? [
                ["PEAK", formatHr(statsPeak), "rgba(242,242,242,0.85)", false],
                ["AVG", formatHr(statsAvg), "rgba(242,242,242,0.70)", false],
              ]
            : [
                ["24H PEAK", formatHr(dayPeak), "rgba(242,242,242,0.85)", false],
                ["24H AVG", formatHr(dayAvg), "rgba(242,242,242,0.70)", false],
              ];
        // `n/300` warming-up cell is only meaningful in 1h mode (the
        // 24h mode has its own much larger window where this signal
        // would mean something different).
        if (chartMode === "1h" && statsWarmingUp) {
          cells.push(["n", `${statsN}/${statsCapacity}`, "rgba(242,242,242,0.55)", false]);
        }
        return (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${cells.length}, 1fr)`,
              marginBottom: 14,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "#0a0a0a",
              fontFamily: "var(--font-mono)",
            }}
          >
            {cells.map(([k, v, c, glow], i) => (
              <div
                key={k}
                style={{
                  padding: "6px 6px 5px",
                  borderRight:
                    i < cells.length - 1
                      ? "1px solid rgba(255,255,255,0.08)"
                      : "none",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 8,
                    letterSpacing: 1,
                    color: "rgba(242,242,242,0.4)",
                    textTransform: "uppercase",
                    marginBottom: 2,
                  }}
                  title={k === "n" ? `Hashrate-buffer sample count (${statsCapacity} samples = ~${Math.round(statsCapacity * 2 / 60)} min of history at 2-second polling). This cell disappears once the buffer fills.` : undefined}
                >
                  {k}
                </div>
                <div
                  className="tnum"
                  style={{
                    fontSize: 11,
                    letterSpacing: 0.5,
                    color: c,
                    textShadow: glow && mining ? "0 0 4px rgba(0,255,102,0.45)" : "none",
                  }}
                >
                  {v}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Pool stats panel slot (Pending / Hashrate / Shares / Last share /
          Workers — pool-specific values from the active pool's public API).
          Replaces the "Recent mining sessions" list that previously rendered
          here (2026-05-15). The list got moved out because the user couldn't
          see their per-pool Pending balance for ERG without scrolling — and
          the panel they care about every session lives here now.
          [[hashrate-history]] § Phase 3 sessions-list is retired. */}
      {poolStatsSlot && (
        <div style={{ marginTop: 8, marginBottom: 14 }}>
          {poolStatsSlot}
        </div>
      )}

      {/* Stop / Start / blocked, from the shared run control. The blocked
          state (UXS-20260516-115: a ghost that names what is missing and,
          for missing miners, navigates to Miner Setup) was portrait-only
          until 2026-09-16; SIMPLE and landscape PRO now render the same
          state machine with the pixel look. */}
      <MineRunButton
        variant="hero"
        mining={mining}
        starting={starting}
        blockedBy={blockedBy}
        coinTicker={coinTicker}
        onStart={onStart}
        onStop={onStop}
        onSetup={onSetup}
        style={{ marginBottom: 14 }}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginBottom: 14,
        }}
      >
        {tile(
          "coin",
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <CoinIcon sym={coinTicker} size={14} glow={false} />
            {coinName}
          </span>
        )}
        {tile("algorithm", algoLabel)}
        {tile("hardware", hardwareLabel)}
        {showIntensity && tile("intensity", intensityLabel)}
        {tile("pool", poolLabel)}
        {tile("worker", workerLabel)}
      </div>

      {mining && (
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
              fontSize: 9.5,
              color: "var(--text-muted)",
              letterSpacing: 1.5,
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>session</span>
            <SessionTimer mining={mining} sessionUptimeSecs={session?.uptimeSecs ?? null} />
          </div>
          <div
            style={{
              padding: 14,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              rowGap: 10,
              columnGap: 14,
              fontFamily: "var(--font-mono)",
            }}
          >
            {/* Counters come from `session` (the miner's HTTP-API
                snapshot, polled every 2s). Phase 2 wires the
                `est. earnings` cell — see <EarningsTile /> below.
                Plain-language tooltips on each label per
                UXS-20260516-005: P1 users land here looking for "is
                this working?" and the field names are all
                pool-operator jargon. Hover-help bridges the gap
                without restructuring the layout for P2 power users. */}
            {/* T3.3 — field labels dropped from ALL-CAPS to Title Case
                per the ease-of-use plan. Source strings live in
                src/design/copy.ts. */}
            {([
              [
                "accepted",
                "Accepted shares",
                session?.accepted != null
                  ? session.accepted.toLocaleString()
                  : "—",
                "Shares the pool credited to you. Higher is better; this number should keep growing.",
              ],
              [
                "rejected",
                "Rejected shares",
                session?.rejected != null
                  ? session.rejected.toLocaleString()
                  : "—",
                "Shares the pool refused (usually stale — submitted just after the round ended). Lower is better; a few per session is normal.",
              ],
              [
                "shares",
                "Shares per minute",
                session?.sharesPerMin != null
                  ? session.sharesPerMin.toFixed(1)
                  : "—",
                "How fast you're submitting valid work. Higher is better; depends on your hashrate and the pool's difficulty.",
              ],
              [
                "est",
                "Est. earnings",
                earnings
                  ? earningsDayUsd !== null
                    ? `${formatUsdPerDay(earningsDayUsd)} · ${formatCoinAmount(earnings.day, coinTicker)}/day`
                    : `${formatCoinAmount(earnings.day, coinTicker)}/day · price unavailable`
                  : "—",
                "Estimated payout if you keep mining at the current rate for a full day. Updates as price and hashrate move.",
              ],
              [
                "latency",
                "Pool latency",
                session?.pingMs != null ? `${session.pingMs}ms` : "—",
                "Round-trip time to the pool's stratum server. Lower is better; under 100ms is healthy.",
              ],
              [
                "diff",
                "Pool difficulty",
                session?.diffCurrent != null
                  ? formatCompactNumber(session.diffCurrent)
                  : "—",
                "The pool's current target difficulty for your worker. Higher means each share you submit represents more work.",
              ],
            ] as Array<[string, string, string, string]>).map(([key, label, v, tooltip]) => (
              <div key={key} title={tooltip}>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-dim)",
                    letterSpacing: 0.3,
                    cursor: "help",
                  }}
                >
                  {label}
                </div>
                <div
                  className="tnum"
                  style={{
                    fontSize: 12,
                    marginTop: 2,
                    color:
                      key === "rejected" && session?.rejected
                        ? "var(--warn)"
                        : key === "accepted" && session?.accepted
                          ? "var(--accent)"
                          : "var(--text)",
                  }}
                >
                  {v}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-period earnings — same primitive landscape renders in the
          right rail. Portrait gets it here so the P1 "is this making me
          money?" question gets answered at time horizons (per hour /
          per day / per week / per month) the user thinks in.
          Added per ease-of-use-improvement-plan T2.1. */}
      {mining && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            padding: 14,
            marginTop: 12,
          }}
        >
          <EarningsPerPeriod
            earnings={earnings}
            ticker={coinTicker}
            priceUsd={coinUsdPrice && coinUsdPrice > 0 ? coinUsdPrice : undefined}
            coinStatsSource={coinStats.source}
            coinStatsStale={coinStats.stale}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Per-second session-timer display, isolated so its 1-Hz state update
 * doesn't trigger a re-render of the surrounding hero panel (which
 * contains the HashrateAreaChart — re-rendering that every second on a
 * long overnight session is what produced the WebView2 memory growth
 * reported 2026-05-27). Prefers the miner's own `uptime_secs` from the
 * snapshot poll (so the timer survives tab switches and page re-renders);
 * falls back to a local React-state clock for the first ~2 s before the
 * first snapshot lands.
 */
function SessionTimer({
  mining,
  sessionUptimeSecs,
}: {
  mining: boolean;
  sessionUptimeSecs: number | null;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!mining) {
      setTick(0);
      return;
    }
    const id = window.setInterval(() => setTick((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [mining]);
  const elapsed = mining ? sessionUptimeSecs ?? tick : 0;
  const hh = Math.floor(elapsed / 3600);
  const mm = Math.floor((elapsed % 3600) / 60);
  const ss = elapsed % 60;
  const timer = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return (
    <span className="tnum" style={{ color: "var(--accent)" }}>
      {timer}
    </span>
  );
}

/** Compact thousands/millions formatter — pool difficulty is typically
 *  five-to-seven digits ("120k", "1.2M") and we want it to fit in the
 *  small SESSION tiles without wrapping. Below 10k we keep the full
 *  number with thousand separators; above we abbreviate. */
function formatCompactNumber(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** Tiny pulsing indicator next to the CPU/GPU toggle when that hardware
 *  is actively mining — lets the user see "yep, still going" when they
 *  switch the toggle to look at the other hardware. */
function RunningDot() {
  return (
    <span
      title="Mining"
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "var(--accent, #00cc66)",
        boxShadow: "0 0 6px var(--accent, #00cc66)",
        marginLeft: 6,
        verticalAlign: "middle",
        animation: "fade-in 1.4s ease-in-out infinite alternate",
      }}
    />
  );
}
