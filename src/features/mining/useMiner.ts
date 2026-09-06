import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { listen } from "@tauri-apps/api/event";
import type { ChainType } from "../../wallets";
import {
  CHAIN_MINING_PREFIX,
  type MiningHardware,
  type CpuAlgorithm,
  type GpuAlgorithm,
  type GpuIntensity,
  type MiningIntensity,
  type DownloadProgress,
  type HashrateFixPlan,
  type HashrateFixStatus,
} from "../../types/mining";
import type { MiningFocus } from "./featureFocus";
import {
  buildCredentials,
  getDefaultPoolId,
  getPoolById,
  getPoolsForCoin,
  parseMinPayoutValue,
  resolveDefaultPool,
  type PoolDef,
  type PoolId,
} from "./pools";
import {
  loadPoolPreferences,
  mostUsedPoolFor,
  recordPoolUse,
  type PoolUseCounts,
} from "./poolPreferenceStore";
import {
  clearActiveSession,
  loadActiveSessions,
  saveActiveSession,
} from "./activeSessionStore";
import { useProxyPool } from "./useProxyPool";
import { supportsDefenderExclusion } from "../../platform/os";
import { useCalibration } from "./hooks/useCalibration";
import { useMinerSetup } from "./hooks/useMinerSetup";
import {
  optInKey,
  saveOptIn,
  usePoolStats,
} from "./hooks/usePoolStats";
// Re-exported so `DeviceProfilePanel` keeps importing the event name from
// this module; the canonical definition now lives in `hooks/useCalibration.ts`.
export { CALIBRATION_UPDATED_EVENT } from "./hooks/useCalibration";
import { gpuIntensityValue, cpuThreadArgsForIntensity } from "./utils/devicePower";
import type { GpuInfo } from "./useDeviceProfile";
import {
  readGpuSelection,
  writeGpuSelection,
  type GpuSelection,
} from "./gpuSelection";
import {
  AUTO_PING_STALENESS_MS,
  activeSessionPingResult,
  buildDeepPingReq,
  buildPingReq,
  failedPingResult,
  pingErrorMessage,
  type PoolPingResult,
  type RawPingResult,
} from "./utils/poolPing";
// Re-exported so existing consumers keep importing `PoolPingResult` from
// this module; the canonical definition now lives in `utils/poolPing.ts`.
export type { PoolPingResult } from "./utils/poolPing";

/**
 * Per-hardware session snapshot — derived from the miner's own HTTP
 * API every poll tick. `null` when the hardware isn't mining or the
 * API hasn't been reached yet.
 *
 * `pingMs` is None on GPU (SRBMiner / lolMiner don't expose stratum
 * ping); the views fall back to the pre-mine TCP probe latency for
 * GPU sessions. `sharesPerMin` is computed locally from
 * `accepted / (uptimeSecs / 60)` once we have ≥30s of uptime.
 */
export interface MinerSession {
  accepted: number;
  rejected: number;
  diffCurrent: number | null;
  pingMs: number | null;
  uptimeSecs: number;
  sharesPerMin: number | null;
  /** Real resolved CPU thread count from xmrig's own `/1/summary` poll
   *  (`XmrigSnapshot::threads_active` in Rust) — the production-safe
   *  source, unlike the debug-only log-tail `HashrateFixStatus.ready`
   *  path. GPU sessions never populate this (`GpuMinerSnapshotWire` has
   *  no equivalent field); `null` until the first successful CPU poll. */
  threadsActive: number | null;
}

/** Wire shapes returned by the Rust snapshot commands. Mirror the
 *  serde structs in `src-tauri/src/miners.rs::XmrigSnapshot` /
 *  `GpuMinerSnapshot`. */
interface XmrigSnapshotWire {
  hashrate: number | null;
  accepted: number;
  rejected: number;
  diff_current: number | null;
  ping_ms: number | null;
  uptime_secs: number;
  threads_active: number | null;
}

interface GpuMinerSnapshotWire {
  hashrate: number | null;
  accepted: number;
  rejected: number;
  diff_current: number | null;
  uptime_secs: number;
}

function toSession(
  wire: XmrigSnapshotWire | GpuMinerSnapshotWire,
  pingMs: number | null
): MinerSession {
  // Don't surface a junk shares-per-minute reading from the first few
  // seconds of mining (one accept in the first 5s would read as 12
  // shares/min). 30s is a reasonable "honest signal" floor.
  const uptime = wire.uptime_secs;
  const sharesPerMin =
    uptime >= 30 ? wire.accepted / (uptime / 60) : null;
  return {
    accepted: wire.accepted,
    rejected: wire.rejected,
    diffCurrent: wire.diff_current,
    pingMs,
    uptimeSecs: uptime,
    sharesPerMin,
    threadsActive: "threads_active" in wire ? wire.threads_active : null,
  };
}

// Rolling hashrate sample buffer cap. At 2-second polling cadence:
//   120 samples  =  4 min  (old default)
//   300 samples  = 10 min  (current — bumped 2026-05-15 per user
//                            request for more visible history in
//                            the hero panel's chart + stats strip)
// Larger values are fine memory-wise (300 × ~32 bytes = 9.6 KB per
// hardware) but the MiniSpark visualization compresses heavily past
// ~300 sample widths — individual variations get washed out.
// 2026-05-15: bumped from 300 to 1800 to honour the "1 HR" toggle label
// in MiningRunningHero. 1800 samples × 2-second polling = exactly 1 hour
// of high-resolution data feeding `<HashrateAreaChart>` in 1 HR mode.
// Memory cost is ~30 KB per session (two {t, value} numbers per sample);
// React's `slice(-1800)` keeps the array bounded and re-renders are
// throttled by the 2-second poll cadence, so cost is negligible.
const MAX_HASHRATE_SAMPLES = 1800;

/**
 * Owns all mining state + lifecycle: miner binary presence, Defender
 * exclusions, start/stop, MSR status, hashrate polling.
 *
 * Consumes cross-feature context via the `addressFor` + `focus` args so
 * the hook can gate its pollers (no hashrate poll when the user isn't on
 * the mining view, etc.) without coupling to the full wallet's vault
 * shape — the same hook serves PwndaWallet and PwndaLite.
 */
export function useMiner(args: {
  /** Layout-agnostic focus value. `"mining"` and `"miner-setup"` enable
   *  the corresponding pollers; anything else (`"other"`) idles them.
   *  Defined locally in `./featureFocus.ts` so the mining hook doesn't
   *  reach into the full wallet's broader `FeatureFocus` union. */
  focus: MiningFocus;
  /** Resolve a payout address for the given chain. The full wallet passes
   *  `(c) => walletsByChain[c]?.address ?? null`; mining-only builds
   *  (Pwnda Lite) pass `(c) => userAddressByChain[c] ?? null`. The hook
   *  never needs the mnemonic or private key — the previous
   *  `wallets: Partial<Record<ChainType, WalletInfo>>` input leaked the
   *  full wallet's key-material plumbing into mining's public API. */
  addressFor: (coin: ChainType) => string | null;
  /** Mining opt-in gate (full wallet only). When `false`, the once-per-load
   *  session-rehydration effect — the one lifecycle effect NOT gated on
   *  `focus` — is suppressed too, so a dormant full wallet fires **zero**
   *  mining `invoke`s. The app layer additionally forces `focus:"other"`
   *  when disabled, which idles every focus-gated poller. Defaults to
   *  `true` so PwndaLite (always-on mining) is unaffected — Lite omits it.
   *  See `./miningOptIn.ts`. */
  enabled?: boolean;
}) {
  const { focus, addressFor } = args;
  const enabled = args.enabled ?? true;

  // Default to monero — RandomX (the default `cpuAlgorithm` just below)
  // is monero/zephyr's algorithm, not ethereum's. Defaulting to
  // ethereum produced a COIN=Ethereum + ALGORITHM=RandomX + POOL=— tile
  // grid on first load, an internally-contradictory state that
  // distrust-poisoned the rest of the panel for first-time users
  // (UXS-20260516-003).
  const [miningCoin, setMiningCoin] = useState<ChainType>("monero");
  const [miningHardware, setMiningHardware] = useState<MiningHardware>("cpu");
  const [cpuAlgorithm, setCpuAlgorithm] = useState<CpuAlgorithm>("randomx");
  const [gpuAlgorithm, setGpuAlgorithm] = useState<GpuAlgorithm>("kawpow");
  const [selectedPoolId, setSelectedPoolId] = useState<PoolId | null>(null);

  // Which physical GPU(s) to mine on — a niche control, shown only when the
  // rig has 2+ real discrete GPUs (see [[gpuSelection]] / [[srbminer-flags]]).
  // Fetched once, the same `get_gpu_info` command `useDeviceProfile` already
  // calls — NOT via that hook, which also needs `pricesByTicker` for its
  // earnings estimator and would couple a simple device-count question to
  // that machinery for no reason.
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [gpuSelection, setGpuSelectionState] = useState<GpuSelection>(null);
  useEffect(() => {
    let cancelled = false;
    void invoke<GpuInfo[]>("get_gpu_info")
      .then((list) => {
        if (cancelled) return;
        setGpus(list);
        // Reconcile against the CURRENT count now that we know it — a
        // selection saved against a since-changed rig must not survive as an
        // out-of-range or wrong-card index. See gpuSelection.ts's header.
        setGpuSelectionState(readGpuSelection(list.length));
      })
      .catch((e: unknown) => {
        // Absence means "assume one GPU" — the picker simply won't show,
        // which is the same outcome as every install today.
        console.warn("[useMiner] GPU detect failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const setGpuSelection = useCallback((next: GpuSelection) => {
    setGpuSelectionState(next);
    writeGpuSelection(next);
  }, []);

  // Per-hardware coin memory. RandomX maps to TWO CPU coins (monero OR
  // zephyr), so the single displayed `miningCoin` can't by itself remember
  // which CPU coin the user was on once they toggle to the GPU lane (which
  // overwrites `miningCoin`) and back. `lastCpuCoinRef` tracks it; the GPU
  // coin is instead derived 1:1 from `gpuAlgorithm` (its own persisted
  // state). Seeded on rehydration from the CPU descriptor so a Zephyr CPU
  // session survives a mem_guard reload instead of falling back to Monero.
  // (Centralized here 2026-06-13 — was MiningView-local — so the landscape
  // hardware toggle shares the same logic via `switchHardware`.)
  const lastCpuCoinRef = useRef<ChainType>("monero");
  useEffect(() => {
    if (miningCoin === "monero" || miningCoin === "zephyr") {
      lastCpuCoinRef.current = miningCoin;
    }
  }, [miningCoin]);

  // Switch the DISPLAYED hardware lane, restoring that lane's coin so the
  // earnings card / payout / active-coin tile match what that lane mines.
  // CPU restores the remembered monero/zephyr; GPU derives its coin from
  // the current `gpuAlgorithm` (each GPU algo maps 1:1 to a coin). This
  // NEVER stops or alters the other lane's miner — it's purely a display
  // switch (CPU and GPU are independent backend processes). Both the
  // portrait and landscape hardware toggles call this so they behave
  // identically (landscape previously had no toggle at all — BUG 2).
  const switchHardware = useCallback(
    (hw: MiningHardware) => {
      if (hw === miningHardware) return;
      setMiningHardware(hw);
      if (hw === "cpu") {
        setMiningCoin(lastCpuCoinRef.current);
      } else {
        const gpuCoin: ChainType =
          gpuAlgorithm === "kawpow"
            ? "ravencoin"
            : gpuAlgorithm === "octopus"
              ? "conflux"
              : "ergo";
        setMiningCoin(gpuCoin);
      }
    },
    [miningHardware, gpuAlgorithm]
  );

  // Per-(coin/algo) pool-usage history. Drives auto-selection of the
  // user's most-used pool when entering the mining tab so they don't
  // have to re-pick their preferred pool every launch (e.g. WoolyPooly
  // for ERG instead of HeroMiners). Hydrated once on mount; mutated
  // by `recordPoolUse` after each successful start. `poolPrefsLoaded`
  // gates the default-pool effect to avoid a momentary flash of the
  // sort-order default before the persisted preference snaps in.
  // See [[pool-preference-store]].
  const [poolPrefs, setPoolPrefs] = useState<PoolUseCounts>({});
  const [poolPrefsLoaded, setPoolPrefsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const prefs = await loadPoolPreferences();
      if (cancelled) return;
      setPoolPrefs(prefs);
      setPoolPrefsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-hardware mining state. CPU (xmrig) and GPU (SRBMiner / lolMiner)
  // run as independent OS processes (`MinerProcess` and `GpuMinerProcess`
  // in `miners.rs` are separate Mutex slots), so the user can run both
  // concurrently. Older code that just wants "is the currently displayed
  // hardware mining" reads `isMining` (derived below).
  const [isMiningCpu, setIsMiningCpu] = useState(false);
  const [isMiningGpu, setIsMiningGpu] = useState(false);
  const [cpuStarting, setCpuStarting] = useState(false);
  const [gpuStarting, setGpuStarting] = useState(false);
  /** Tracks which GPU miner is currently running so the hashrate poll knows
   *  which JSON shape to parse — `gpuAlgorithm` would lie if the user
   *  flipped the algorithm dropdown after launching. */
  const [runningGpuMiner, setRunningGpuMiner] =
    useState<"SRBMiner-MULTI" | "lolMiner" | null>(null);
  /** Pool IDs that are *currently* held open by a running miner process,
   *  one slot per hardware. Captured at `startMining` time so we know
   *  which pool xmrig/SRBMiner is talking to even after the user changes
   *  the dropdown. The auto-ping effect uses these to skip its probe of
   *  the active pool — re-opening a second TLS+stratum session against
   *  a small pool while the first is already mining can trip the pool's
   *  anti-abuse and produce false-negative `no reply` results. */
  const [activeCpuPoolId, setActiveCpuPoolId] = useState<PoolId | null>(null);
  const [activeGpuPoolId, setActiveGpuPoolId] = useState<PoolId | null>(null);

  const [workerName, setWorkerName] = useState("worker1");
  const [miningIntensity, setMiningIntensity] = useState<MiningIntensity>("high");
  // SRBMiner GPU intensity tier. `auto` is the safe default (no
  // `--gpu-intensity` flag → SRBMiner self-tunes). Low/Medium/High map
  // to numeric intensities below. Only used for SRBMiner paths
  // (KawPow / Autolykos2); lolMiner Octopus ignores it. See
  // `wiki/concepts/srbminer-flags.md`.
  const [gpuIntensity, setGpuIntensity] = useState<GpuIntensity>("auto");
  const [cpuThreadCount, setCpuThreadCount] = useState<number>(0);

  const [minerError, setMinerError] = useState("");

  // Miner-binary management (presence / download / Defender exclusions)
  // lives in its own sub-hook. It shares the `minerError` banner via the
  // injected setter; everything else is self-contained. The setters
  // surfaced here are consumed by the `miner-download-progress` listener
  // effect below, which stays in the orchestrator.
  const {
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
    setDownloadingMiners,
    setDownloadProgress,
  } = useMinerSetup({ setMinerError });
  /**
   * Non-error informational notice shown in the mining view (different
   * styling from `minerError`). Used by the SOCKS5 auto-rotation flow:
   * when a dead SOCKS5 proxy triggers a re-launch of the miner against
   * the next-best proxy mid-session, we want the user to see a brief
   * confirmation rather than nothing — but it's not an error so it
   * shouldn't share the red error banner. Auto-clears 6 s after being set.
   */
  const [minerInfo, setMinerInfo] = useState("");
  const minerInfoClearTimerRef = useRef<number | null>(null);
  const setMinerInfoWithAutoClear = useCallback((msg: string, durationMs = 6000) => {
    setMinerInfo(msg);
    if (minerInfoClearTimerRef.current !== null) {
      window.clearTimeout(minerInfoClearTimerRef.current);
    }
    minerInfoClearTimerRef.current = window.setTimeout(() => {
      setMinerInfo("");
      minerInfoClearTimerRef.current = null;
    }, durationMs);
  }, []);

  const [enableMsr, setEnableMsr] = useState(true);
  const [msrStatus, setMsrStatus] =
    useState<"unknown" | "ok" | "failed" | "disabled">("unknown");
  const [showFixMsrDialog, setShowFixMsrDialog] = useState(false);

  // Sprint 2 — MSR environment scan + log-tail status
  const [hashrateFixPlan, setHashrateFixPlan] =
    useState<HashrateFixPlan | null>(null);
  const [scanningEnv, setScanningEnv] = useState(false);
  const [hashrateFixStatus, setHashrateFixStatus] =
    useState<HashrateFixStatus>({});

  // Sprint 3 — Hard Reset state
  const [hardResetting, setHardResetting] = useState(false);
  const [hardResetMessage, setHardResetMessage] = useState<string | null>(null);

  // Independent hashrate sample buffers per hardware so switching the
  // displayed hardware doesn't lose the chart history of either.
  const [cpuHashrateSamples, setCpuHashrateSamples] =
    useState<{ t: number; value: number }[]>([]);
  const [gpuHashrateSamples, setGpuHashrateSamples] =
    useState<{ t: number; value: number }[]>([]);

  // Session snapshots from the miner's own HTTP API. Populated by the
  // same poll that drives `*HashrateSamples` (now via the new
  // `get_*_snapshot` Rust commands). Reset to null when the underlying
  // hardware stops mining so the SESSION block in the UI doesn't show
  // stale counters from the previous run.
  const [cpuSession, setCpuSession] = useState<MinerSession | null>(null);
  const [gpuSession, setGpuSession] = useState<MinerSession | null>(null);

  // Debug toggle: show the miner's console window on the next start so the
  // user can see live share/diff output. Persisted to the backend's
  // `MinerWindowVisible` state, NOT localStorage — the backend reads the
  // flag at miner-spawn time. Initial value is loaded from the backend.
  const [showMinerWindow, setShowMinerWindowState] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await invoke<boolean>("get_miner_window_visible");
        if (!cancelled) setShowMinerWindowState(v);
      } catch {
        /* ignore — leave at default false */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleShowMinerWindow = useCallback(async () => {
    try {
      const next = await invoke<boolean>("set_miner_window_visible", {
        visible: !showMinerWindow,
      });
      setShowMinerWindowState(next);
    } catch (e: any) {
      setMinerError(
        "Couldn't toggle miner debug window: " +
          (typeof e === "string" ? e : e?.message ?? String(e))
      );
    }
  }, [showMinerWindow]);

  // Derived "currently displayed hardware" flags — kept under the same
  // names many call-sites already use so the views barely had to change.
  const isMining = miningHardware === "cpu" ? isMiningCpu : isMiningGpu;
  const isAnyMining = isMiningCpu || isMiningGpu;
  const miningStarting = miningHardware === "cpu" ? cpuStarting : gpuStarting;
  const hashrateSamples =
    miningHardware === "cpu" ? cpuHashrateSamples : gpuHashrateSamples;
  const setHashrateSamples =
    miningHardware === "cpu" ? setCpuHashrateSamples : setGpuHashrateSamples;
  const session = miningHardware === "cpu" ? cpuSession : gpuSession;

  // ── Pool connectivity smoke test ───────────────────────────────────
  // Map of pool-id → result for the most recent probe. `null` means the
  // pool was included in the batch and is still in flight; missing key
  // means the pool hasn't been tested. Cleared whenever the user changes
  // (coin, hardware/algo) — last probe is only meaningful for the
  // currently-displayed list.
  const [poolPings, setPoolPings] = useState<Record<PoolId, PoolPingResult | null>>({});
  const [pingingPools, setPingingPools] = useState(false);

  // ── Live pool min-payouts ──────────────────────────────────────────
  // Map of pool-id → live "X COIN" display string. Populated lazily for
  // the pools in the current `availablePools` list when the user enters
  // the Mining tab. The display sites (pool dropdown, KvRow, portrait
  // POOL header) prefer the live value when present and fall back to
  // the static `pool.minPayout` from `pools.ts` otherwise.
  //
  // Why this is its own poller (not bundled with `poolStats`): the
  // pool-stats fetch sends the user's wallet address to the pool and is
  // privacy-gated. Min-payout is pool-wide config — no wallet address
  // sent, no privacy gate, no opt-in required. We fire it eagerly so
  // users with NTMiner / Nanopool dashboards configured to higher
  // thresholds see the real number rather than the marketing-page
  // default.
  const [livePoolPayouts, setLivePoolPayouts] = useState<Record<PoolId, string>>({});

  const getCpuThreadArgsForIntensity = useCallback(
    (intensity: MiningIntensity) =>
      cpuThreadArgsForIntensity(intensity, cpuThreadCount),
    [cpuThreadCount]
  );

  // GPU intensity-tier → numeric `--gpu-intensity` mapping (pure; see
  // `utils/devicePower.ts`). Kept as a stable `useCallback` so the
  // return-object reference is identity-stable for consumers.
  const getGpuIntensityValue = useCallback(
    (level: GpuIntensity): number | null => gpuIntensityValue(level),
    []
  );

  /**
   * Internal: launch xmrig via ShellExecuteEx("runas"). UAC prompt every
   * launch — same path the user has explicitly accepted as the only
   * mining elevation strategy.
   *
   * `pool` is the full stratum URL (host:port or stratum+ssl://host:port);
   * `enableTls` controls the `--tls` flag; `pass` is the pool password.
   */
  /**
   * Most recent CPU mining start args, captured at every successful
   * `launchXmrig` call. Used by the `mining-error` auto-rotation
   * handler to re-launch with a new SOCKS5 proxy when the current one
   * dies. Reset to `null` on `stop_xmrig` so a stopped mining session
   * doesn't accidentally auto-restart later.
   */
  const lastCpuStartArgsRef = useRef<{
    pool: string;
    userString: string;
    pass: string;
    enableTls: boolean;
    threads: number | null;
    cpuMaxThreadsHint: number | null;
    cpuPriority: number | null;
  } | null>(null);

  /**
   * Auto-rotation cycle counter for SOCKS5_DEAD_TRY_ROTATE events.
   * Capped to `AUTO_ROTATION_MAX` per logical user-start to prevent
   * infinite-loop if every validated proxy is also dead. Reset to 0
   * whenever the user manually clicks Start (in `startMining` below).
   */
  const autoRotationCountRef = useRef(0);
  const AUTO_ROTATION_MAX = 5;

  /**
   * Trigger-counter for the auto-rotation restart effect. Bumped by the
   * `mining-error` listener AFTER `markFailed` so the effect runs on the
   * next render — by which time `proxy.selectedProxy` reflects the
   * updated failed-proxies set and the next-best SOCKS5 is selected.
   */
  const [autoRotateRestart, setAutoRotateRestart] = useState(0);

  const launchXmrig = useCallback(
    async (opts: {
      pool: string;
      userString: string;
      pass: string;
      enableTls: boolean;
      threads: number | null;
      cpuMaxThreadsHint: number | null;
      cpuPriority: number | null;
      /** Optional SOCKS5 proxy `host:port`. When set, xmrig is launched
       *  with `--proxy=socks5://host:port`. */
      proxy?: string | null;
    }) => {
      const {
        pool, userString, pass, enableTls,
        threads, cpuMaxThreadsHint, cpuPriority,
        proxy: proxyHostPort,
      } = opts;
      // Capture args BEFORE invoke so even if the call throws partway
      // through (UAC declined, etc.) we still have something to retry
      // on later auto-rotation events.
      lastCpuStartArgsRef.current = {
        pool,
        userString,
        pass,
        enableTls,
        threads,
        cpuMaxThreadsHint,
        cpuPriority,
      };
      await invoke("start_xmrig", {
        pool,
        userString,
        algorithm: "rx/0",
        threads,
        cpuMaxThreadsHint,
        cpuPriority,
        enableMsr,
        pass,
        enableTls,
        proxy: proxyHostPort ?? null,
      });
    },
    [enableMsr]
  );

  // Each GPU-mineable coin has exactly one PoW algorithm — RVN is
  // KawPow, CFX is Octopus. If the user switches the mining coin while
  // the algorithm dropdown is on a value that doesn't apply to the new
  // coin (e.g. they had RVN/kawpow and switch to CFX), the pool list
  // would silently empty out (filtered by both coin AND algorithm). Map
  // the coin to its required GPU algo and snap the dropdown so the pool
  // list always has matches.
  useEffect(() => {
    let nextAlgo: GpuAlgorithm | null = null;
    if (miningCoin === "ravencoin") nextAlgo = "kawpow";
    else if (miningCoin === "conflux") nextAlgo = "octopus";
    else if (miningCoin === "ergo") nextAlgo = "autolykos";
    else if (miningCoin === "zano") nextAlgo = "progpowz";
    if (nextAlgo && nextAlgo !== gpuAlgorithm && !isMiningGpu) {
      setGpuAlgorithm(nextAlgo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miningCoin]);

  const activeAlgorithm: CpuAlgorithm | GpuAlgorithm =
    miningHardware === "cpu" ? cpuAlgorithm : gpuAlgorithm;

  // Raw pool list filtered by coin/algorithm — order is the static
  // `ALL_POOLS` order (PWNDA first).
  const rawPools = useMemo(
    () => getPoolsForCoin(miningCoin, activeAlgorithm),
    [miningCoin, activeAlgorithm]
  );

  // User-facing pool order: ascending minimum-payout (lowest threshold
  // first). Within the per-coin filter all entries are denominated in
  // the same coin so the bare numeric sort is meaningful. Entries with
  // an unknown / placeholder payout (`"—"`) sink to the bottom in their
  // registry order. Stable wrt registry order for ties.
  const availablePools = useMemo(() => {
    const indexed = rawPools.map((pool, idx) => ({
      pool,
      payout: parseMinPayoutValue(pool.minPayout),
      idx,
    }));
    indexed.sort((a, b) => {
      // Both known → ascending payout
      if (a.payout != null && b.payout != null) {
        if (a.payout !== b.payout) return a.payout - b.payout;
        return a.idx - b.idx;
      }
      // Only A known → A first (B's payout is placeholder)
      if (a.payout != null) return -1;
      if (b.payout != null) return 1;
      // Both placeholder — preserve registry order
      return a.idx - b.idx;
    });
    return indexed.map((x) => x.pool);
  }, [rawPools]);

  // Remembered per-(coin,algo) pool selection. `selectedPoolId` is a SINGLE
  // value — it can't hold both lanes' picks, so toggling CPU↔GPU (which
  // changes `miningCoin`/`activeAlgorithm` → `availablePools`) overwrites it.
  // Without this, a hardware-toggle round-trip reverted the dropdown to the
  // woolypooly default while the live miner kept running herominers (the
  // user-reported landscape bug). Mirrors `lastCpuCoinRef`.
  const lastSelectedPoolByLaneRef = useRef<Record<string, PoolId>>({});

  // Keep selectedPoolId valid as the user changes coin / hardware / algo.
  // When the current pick is STILL valid for the lane we keep it AND remember
  // it for this (coin,algo). When it's no longer valid (the lane/coin/algo
  // just changed), restore by priority:
  //   1. The pool the DISPLAYED lane's miner is ACTUALLY running
  //      (`activeCpuPoolId`/`activeGpuPoolId`) — so the dropdown can never
  //      disagree with the live session / pop-up terminal (the exact bug:
  //      terminal on herominers, UI showing woolypooly).
  //   2. The user's last explicit selection for this (coin, algo) — restores
  //      their pick across a hardware round-trip even when not mining.
  //   3. The user's most-used pool for this (coin, algo) from `poolPrefs`
  //      (recorded by `recordPoolUse` on every successful start).
  //   4. `availablePools[0]` — the lowest-min-payout fallback (fresh installs).
  //
  // Waits for `poolPrefsLoaded` so the first render lands on the real
  // preferred pool, not a one-frame default flash. See [[pool-preference-store]].
  useEffect(() => {
    if (!poolPrefsLoaded) return;
    const laneKey = `${miningCoin}/${activeAlgorithm}`;
    if (selectedPoolId && availablePools.some((p) => p.id === selectedPoolId)) {
      lastSelectedPoolByLaneRef.current[laneKey] = selectedPoolId;
      return;
    }
    const inList = (id: PoolId | null | undefined): PoolId | null =>
      id && availablePools.some((p) => p.id === id) ? id : null;
    const liveLanePool = inList(
      miningHardware === "cpu" ? activeCpuPoolId : activeGpuPoolId
    );
    const remembered = inList(lastSelectedPoolByLaneRef.current[laneKey]);
    const mostUsed = inList(
      mostUsedPoolFor(poolPrefs, miningCoin, activeAlgorithm)
    );
    // Priority order (incl. why house default sits AHEAD of `mostUsed`, and
    // the 2026-08-29 correction that put it there) is documented once, at
    // `resolveDefaultPool` in pools.ts — this call must not re-inline the
    // chain, or the two can silently drift out of agreement again the way
    // the first version of the house-default fix did.
    const next = inList(
      resolveDefaultPool({
        coin: miningCoin,
        algorithm: activeAlgorithm,
        liveLanePool,
        remembered,
        mostUsed,
      })
    );
    setSelectedPoolId(next);
    if (next) lastSelectedPoolByLaneRef.current[laneKey] = next;
  }, [
    miningCoin,
    activeAlgorithm,
    availablePools,
    selectedPoolId,
    poolPrefs,
    poolPrefsLoaded,
    miningHardware,
    activeCpuPoolId,
    activeGpuPoolId,
  ]);

  // Live-fetch min payouts for every pool in the current visible list.
  // Pool-wide endpoints (HeroMiners, WoolyPooly) ignore the address;
  // per-user endpoints (Nanopool) use it to pull the user's actual
  // configured `minpayout` rather than the pool default. Pools with
  // neither (NTMiner, HashVault, PWNDA) silently return null and the
  // display falls back to `pool.minPayout`. Fires once per
  // (coin, algo, wallet-address) change.
  const walletForPayoutFetch = addressFor(miningCoin);
  useEffect(() => {
    if (focus !== "mining" && focus !== "miner-setup") return;
    if (availablePools.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        availablePools.map(async (p) => {
          try {
            const info = await invoke<{ poolId: string; display: string } | null>(
              "fetch_pool_min_payout",
              { poolId: p.id, address: walletForPayoutFetch ?? null }
            );
            return info && info.display ? ([p.id, info.display] as const) : null;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      const merged: Record<PoolId, string> = {};
      for (const r of results) if (r) merged[r[0]] = r[1];
      setLivePoolPayouts((prev) => ({ ...prev, ...merged }));
    })();
    return () => {
      cancelled = true;
    };
  }, [focus, availablePools, walletForPayoutFetch]);

  // Helper: best display string for a pool's minimum payout. Live value
  // wins; static fallback when live not available or fetch failed.
  const displayMinPayout = useCallback(
    (pool: PoolDef): string => livePoolPayouts[pool.id] ?? pool.minPayout,
    [livePoolPayouts]
  );

  const selectedPool = useMemo(
    () => (selectedPoolId ? getPoolById(selectedPoolId) ?? null : null),
    [selectedPoolId]
  );

  // Proxy mode lives in its own hook (`useProxyPool`); we hand it the
  // current pool so it can validate against the actual target host:port,
  // and we read `proxy.selectedProxy` when launching xmrig / SRBMiner.
  const proxy = useProxyPool({ selectedPool });

  // Pool public-stats polling lives in its own sub-hook. It owns the
  // privacy-gated opt-in Set; `statsOptIns` + `setStatsOptIns` are
  // surfaced so `startMining` (below) can auto-opt-in when the user
  // starts a session (the address goes to the pool over stratum then).
  const statsAddress = addressFor(miningCoin);
  const {
    poolStats,
    poolStatsLoading,
    poolStatsError,
    statsOptIns,
    setStatsOptIns,
    statsOptInForCurrent,
    optInToPoolStats,
    refreshPoolStats,
  } = usePoolStats({ focus, selectedPoolId, statsAddress });

  const startMining = useCallback(async () => {
    setMinerError("");

    // Manual user-start resets the auto-rotation budget. Subsequent
    // SOCKS5_DEAD_TRY_ROTATE events get a fresh AUTO_ROTATION_MAX
    // budget before giving up.
    autoRotationCountRef.current = 0;

    // Operate strictly on the currently-displayed hardware. Each branch
    // updates its own *Starting / isMining* slot so the other hardware's
    // state is never touched — that's what makes concurrent CPU+GPU work.
    const target = miningHardware;

    // Reset only the displayed hardware's hashrate samples + session
    // counters — the other one's chart history and counters must survive.
    if (target === "cpu") {
      setCpuHashrateSamples([]);
      setCpuSession(null);
    } else {
      setGpuHashrateSamples([]);
      setGpuSession(null);
    }

    const miningAddress = addressFor(miningCoin);
    if (!miningAddress) {
      setMinerError("No mining address set for the selected coin.");
      return;
    }

    // Proxy mode pre-flight: lolMiner has no SOCKS5 flag, so block
    // GPU+Octopus when proxy mode is on. CPU, GPU+KawPoW (SRBMiner), and
    // GPU+Autolykos2 (SRBMiner — lolMiner disabled for ERG 2026-05-15)
    // are all fine.
    const proxyActive = (proxy.proxyMode || proxy.torMode) && !!proxy.selectedProxy;
    if (
      (proxy.proxyMode || proxy.torMode) &&
      target === "gpu" &&
      gpuAlgorithm === "octopus"
    ) {
      setMinerError(
        "Proxy mode doesn't support Octopus mining (lolMiner has no SOCKS5 flag). Switch to a different coin or use CPU mining."
      );
      return;
    }
    if (proxy.proxyMode && !proxy.selectedProxy) {
      setMinerError(
        "Proxy mode is on but no working proxy is available. Wait for the validator or click Refresh."
      );
      return;
    }

    // Maximum privacy (Tor) preflight. The transport routes the miner through
    // a local Tor SOCKS5, but the wallet doesn't run Tor itself yet — detect a
    // live daemon on 9050 (standalone tor) or 9150 (Tor Browser) and route
    // through that exact port. Without this, a missing Tor surfaces as the
    // miner's cryptic "connection refused" (2026-06-30 report).
    let torHostPort: string | null = null;
    if (proxy.torMode) {
      let torPort: number | null = null;
      try {
        torPort = await invoke<number | null>("probe_tor_socks");
      } catch {
        torPort = null;
      }
      if (torPort == null) {
        setMinerError(
          "Maximum privacy (Tor) is on, but no Tor is running. Open Tor Browser (it provides Tor on port 9150) or start a tor service on 9050, then start mining again."
        );
        return;
      }
      torHostPort = `127.0.0.1:${torPort}`;
    }

    const pool =
      (selectedPoolId ? getPoolById(selectedPoolId) : undefined) ??
      (() => {
        const fallbackId = getDefaultPoolId(miningCoin, activeAlgorithm);
        return fallbackId ? getPoolById(fallbackId) : undefined;
      })();
    if (!pool) {
      setMinerError(
        `No mining pool configured for ${miningCoin} (${activeAlgorithm}).`
      );
      return;
    }

    const prefix = CHAIN_MINING_PREFIX[miningCoin];
    const { user: userString, pass } = buildCredentials({
      pool,
      address: miningAddress,
      worker: workerName,
      coinPrefix: prefix,
    });

    // First-poll gate: starting mining counts as the opt-in for this
    // (pool, address) — the address is about to be sent to the pool over
    // stratum anyway, so the privacy concern is moot from this point on.
    {
      const key = optInKey(pool.id, miningAddress);
      if (!statsOptIns.has(key)) {
        const next = new Set(statsOptIns);
        next.add(key);
        setStatsOptIns(next);
        saveOptIn(next);
      }
    }

    if (target === "cpu") setCpuStarting(true); else setGpuStarting(true);
    try {
      // Windows Defender flags every miner binary (XMRig, SRBMiner, lolMiner)
      // as a PUA/coin-miner heuristic. The MSI installer pre-adds exclusions
      // at install time, but a `tauri dev` / portable run never goes through
      // that step, and `defenderExcluded` has been sitting unread here since
      // the day it was added — this is the ONLY caller of `startMining`, and
      // it never checked it. The result: the elevated launch below succeeds
      // (the UAC prompt IS approved), and Defender's real-time protection
      // then silently kills or quarantines the freshly-elevated process a
      // moment later, which reads as "the approval dialog appeared and then
      // nothing happened" — reported 2026-08-21. `checkMinerStatus()` (fired
      // on Mine-tab focus, see the `focus === "mining"` effect above) has
      // already populated `defenderExcluded` from the real, disk-persisted
      // Defender policy by the time a user reaches this button, so a `true`
      // here is a genuine "already excluded, nothing to do".
      //
      // Best-effort and silent: swallow failure and attempt to mine anyway
      // rather than blocking the primary action on a second UAC prompt the
      // user might decline — the existing "stopped unexpectedly" death-watch
      // error below still fires if Defender blocks it regardless.
      if (supportsDefenderExclusion() && defenderExcluded !== true) {
        try {
          await invoke<boolean>("add_defender_exclusions");
        } catch {
          /* best-effort — see comment above */
        }
      }
      if (target === "cpu") {
        const cpuArgs = getCpuThreadArgsForIntensity(miningIntensity);

        await launchXmrig({
          pool: pool.endpoint,
          userString,
          pass,
          enableTls: pool.ssl,
          threads: cpuArgs.threads,
          cpuMaxThreadsHint: cpuArgs.cpuMaxThreadsHint,
          cpuPriority: cpuArgs.cpuPriority,
          proxy: proxyActive ? (torHostPort ?? proxy.selectedProxy!.hostPort) : null,
        });
        setMsrStatus(enableMsr ? "unknown" : "disabled");
        setIsMiningCpu(true);
        setActiveCpuPoolId(pool.id);
        // Persist the running-session descriptor so the Mining view can
        // rehydrate (correct hardware lane, coin, algo, pool) if the
        // WebView2 renderer reloads mid-session — e.g. the `mem_guard`
        // memory circuit-breaker. See [[webview2-memory-management]]
        // Round 13 + `activeSessionStore.ts`.
        void saveActiveSession("cpu", {
          hardware: "cpu",
          coin: miningCoin,
          cpuAlgorithm,
          poolId: pool.id,
        });
        // Bump the persisted pool-usage counter so the next session
        // for this (coin, algo) defaults to whichever pool the user
        // is actually using. Fire-and-forget — a write failure here
        // just means the auto-select falls through to the sort-order
        // default on next launch. See [[pool-preference-store]].
        void recordPoolUse(miningCoin, activeAlgorithm, pool.id).then(
          (updated) => setPoolPrefs(updated),
        );
      } else {
        // GPU miner selection. Mapping per algorithm:
        //   - kawpow    → SRBMiner-MULTI (proven path; lolMiner KawPow
        //                                  underperforms on AMD).
        //   - octopus   → lolMiner       (proven path; SRBMiner Octopus
        //                                  needs AMD-specific tuning).
        //   - autolykos → SRBMiner-MULTI (lolMiner disabled for ERG on
        //                                  2026-05-15 per user request —
        //                                  SRBMiner is now the sole ERG
        //                                  miner, regardless of proxy mode.
        //                                  Lower binary dev fee (1.0% vs
        //                                  1.5%) and works with SOCKS5.)
        //
        // Per-miner algorithm-flag casing:
        //   lolMiner wants UPPER (`AUTOLYKOS2`/`OCTOPUS`/`KAWPOW`);
        //   SRBMiner wants lower (`autolykos2`/`kawpow`).
        // The Rust `build_gpu_miner_args` passes the algorithm string
        // verbatim — frontend picks the right casing here.
        // Exhaustive by construction, and deliberately not an if/else chain
        // ending in `else { lolMiner OCTOPUS }`. That shape was here until
        // 2026-08-28 and it meant ANY new GPU algorithm silently became
        // Octopus on lolMiner — type-checking cleanly the whole way, because
        // a fallthrough else cannot be exhaustiveness-checked. Adding
        // `progpowz` for Zano is exactly the change that would have hit it.
        // A Record keyed on GpuAlgorithm makes a missing entry a COMPILE
        // error instead of a wrong miner.
        const GPU_MINER: Record<GpuAlgorithm, { miner: "SRBMiner-MULTI" | "lolMiner"; algorithm: string }> = {
          // Per-miner casing: lolMiner wants UPPER, SRBMiner wants lower.
          kawpow: { miner: "SRBMiner-MULTI", algorithm: "kawpow" },
          autolykos: { miner: "SRBMiner-MULTI", algorithm: "autolykos2" },
          octopus: { miner: "lolMiner", algorithm: "OCTOPUS" },
          // Zano. WoolyPooly names SRBMiner (AMD) and T-Rex (Nvidia) as the
          // supported miners; SRBMiner is the one this wallet ships, and it
          // takes the algorithm as lowercase `progpowz`.
          progpowz: { miner: "SRBMiner-MULTI", algorithm: "progpowz" },
        };
        const sel = GPU_MINER[gpuAlgorithm];
        const miner = sel.miner;
        const algorithm = sel.algorithm;
        // SRBMiner gets the user-picked intensity numeric (16/22/28);
        // lolMiner doesn't have a `--gpu-intensity` flag, so we send
        // null on that branch — the Rust side drops it silently.
        const gpuIntensityValue =
          miner === "SRBMiner-MULTI"
            ? getGpuIntensityValue(gpuIntensity)
            : null;
        await invoke("start_gpu_miner", {
          miner,
          pool: pool.endpoint,
          userString,
          algorithm,
          pass,
          proxy: proxyActive ? (torHostPort ?? proxy.selectedProxy!.hostPort) : null,
          gpuIntensity: gpuIntensityValue,
          gpuIndices: gpuSelection,
        });
        setRunningGpuMiner(miner);
        setIsMiningGpu(true);
        setActiveGpuPoolId(pool.id);
        // Persist the running-session descriptor for post-reload
        // rehydration (see the CPU branch + `activeSessionStore.ts`).
        // `miner` is captured so the snapshot poll parses the right JSON
        // shape without guessing from a reset `gpuAlgorithm`.
        void saveActiveSession("gpu", {
          hardware: "gpu",
          coin: miningCoin,
          gpuAlgorithm,
          miner,
          poolId: pool.id,
        });
        // Same pool-usage bump as the CPU branch — see comment above.
        void recordPoolUse(miningCoin, activeAlgorithm, pool.id).then(
          (updated) => setPoolPrefs(updated),
        );
      }
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e.message;
      setMinerError("Failed to start mining: " + msg);
    } finally {
      if (target === "cpu") setCpuStarting(false); else setGpuStarting(false);
    }
  }, [
    addressFor,
    miningCoin,
    workerName,
    miningHardware,
    miningIntensity,
    enableMsr,
    defenderExcluded,
    gpuAlgorithm,
    launchXmrig,
    getCpuThreadArgsForIntensity,
    selectedPoolId,
    activeAlgorithm,
    statsOptIns,
    proxy.proxyMode,
    proxy.selectedProxy?.hostPort,
  ]);

  const stopMining = useCallback(async () => {
    setMinerError("");
    // Stops only the currently-displayed hardware. To stop the other one
    // the user must switch the hardware toggle and click stop again — the
    // hardware toggle stays clickable while either is mining.
    try {
      if (miningHardware === "cpu") {
        await invoke("stop_xmrig");
        setIsMiningCpu(false);
        setCpuHashrateSamples([]);
        setCpuSession(null);
        setActiveCpuPoolId(null);
        void clearActiveSession("cpu");
        // Clear the auto-rotation cache so a stale `mining-error` event
        // arriving after stop doesn't accidentally re-launch.
        lastCpuStartArgsRef.current = null;
        autoRotationCountRef.current = 0;
      } else {
        await invoke("stop_gpu_miner");
        setIsMiningGpu(false);
        setGpuHashrateSamples([]);
        setGpuSession(null);
        setRunningGpuMiner(null);
        setActiveGpuPoolId(null);
        void clearActiveSession("gpu");
      }
    } catch (e: any) {
      setMinerError(
        "Failed to stop mining: " + (typeof e === "string" ? e : e.message)
      );
    }
  }, [miningHardware]);

  /**
   * Stop BOTH mining lanes unconditionally (unlike `stopMining`, which only
   * stops the displayed hardware). Best-effort per lane — a lane that isn't
   * running just no-ops on the backend. Used by the "Turn off mining" opt-out
   * so flipping the wallet back to dormant can never leave an orphaned miner
   * hashing in the background. See `miningOptIn.ts`.
   */
  const stopAllMining = useCallback(async () => {
    setMinerError("");
    try { await invoke("stop_xmrig"); } catch { /* not running */ }
    try { await invoke("stop_gpu_miner"); } catch { /* not running */ }
    setIsMiningCpu(false);
    setIsMiningGpu(false);
    setCpuSession(null);
    setGpuSession(null);
    setRunningGpuMiner(null);
    setActiveCpuPoolId(null);
    setActiveGpuPoolId(null);
    lastCpuStartArgsRef.current = null;
    autoRotationCountRef.current = 0;
    void clearActiveSession("cpu");
    void clearActiveSession("gpu");
  }, []);

  useEffect(() => {
    let unlistenDownload: (() => void) | null = null;
    let unlistenMsr: (() => void) | null = null;
    listen<{ status: string; message?: string }>("msr-status", (event) => {
      const s = event.payload?.status;
      if (s === "ok" || s === "failed" || s === "disabled" || s === "unknown") {
        setMsrStatus(s);
      }
    }).then((fn) => {
      unlistenMsr = fn;
    });
    listen<DownloadProgress>("miner-download-progress", (event) => {
      setDownloadProgress(event.payload);
      if (event.payload.miner === "all" && event.payload.stage === "complete") {
        setDownloadingMiners(false);
        checkMinerStatus();
      }
    }).then((fn) => {
      unlistenDownload = fn;
    });

    // Sprint 2 Phase 7 — live xmrig.log status from the Rust tail task.
    // Each emit carries one of: msr, hugePages, ready, plus the rawLine.
    let unlistenStatus: (() => void) | null = null;
    listen<HashrateFixStatus>("hashrate-fix-status", (event) => {
      const payload = event.payload;
      setHashrateFixStatus((prev) => ({
        ...prev,
        ...(payload.msr !== undefined ? { msr: payload.msr } : {}),
        ...(payload.hugePages !== undefined ? { hugePages: payload.hugePages } : {}),
        ...(payload.ready !== undefined ? { ready: payload.ready } : {}),
        rawLine: payload.rawLine ?? prev.rawLine,
      }));
      // Mirror MSR success/failure into the legacy msrStatus state so existing
      // UI (the small "applied/failed" pill in MineLandscapeView) keeps working.
      if (payload.msr) {
        if (payload.msr.kind === "Ok") setMsrStatus("ok");
        else if (payload.msr.kind === "Failed") setMsrStatus("failed");
      }
    }).then((fn) => {
      unlistenStatus = fn;
    });

    // Sprint 2 Phase 3 — env scan results pushed by scan_msr_environment
    let unlistenEnv: (() => void) | null = null;
    listen<HashrateFixPlan>("msr-env-scan", (event) => {
      setHashrateFixPlan(event.payload);
    }).then((fn) => {
      unlistenEnv = fn;
    });

    // 2026-05-13 — `mining-error` events fired by the Rust backend. Two
    // codes today:
    //   - `DEV_FEE_PROXY_STALL` — watchdog gave up (5 min both-down).
    //     Surface to the user; let them retry manually.
    //   - `SOCKS5_DEAD_TRY_ROTATE` — listener-level circuit breaker
    //     after 5 consecutive session-end-with-upstream-failure events.
    //     **Auto-rotate**: mark the current SOCKS5 as failed, stop xmrig,
    //     bump `autoRotateRestart` to trigger the restart effect.
    let unlistenMiningError: (() => void) | null = null;
    listen<{
      code: string;
      message?: string;
      consecutive_failures?: number;
      kind?: "cpu" | "gpu";
    }>(
      "mining-error",
      (event) => {
        const code = event.payload?.code ?? "UNKNOWN";
        const message = event.payload?.message ?? `Mining error: ${code}`;
        if (code === "SOCKS5_DEAD_TRY_ROTATE") {
          if (autoRotationCountRef.current >= AUTO_ROTATION_MAX) {
            setMinerError(
              `SOCKS5 auto-rotation gave up after ${AUTO_ROTATION_MAX} attempts. Disable proxy mode or refresh the proxy list and start mining again.`
            );
            // Make sure the UI reflects "not mining" since the backend
            // has already torn the proxy down.
            invoke("stop_xmrig", {
              reason: "stopped: SOCKS5 proxies exhausted (auto-rotation gave up)",
            }).catch(() => {});
            setIsMiningCpu(false);
            return;
          }
          autoRotationCountRef.current += 1;
          // NOTE: the `SOCKS5_DEAD_TRY_ROTATE` event that reaches this
          // branch was emitted by the dev-fee stratum proxy, removed
          // 2026-07-06 (pure-wallet cutover). xmrig now dials the SOCKS5
          // proxy directly and retries on its own, so this auto-rotation
          // path is currently inert. Kept for when a backend miner/proxy
          // watcher re-emits the signal. Stop xmrig cleanly on rotate.
          invoke("stop_xmrig", {
            reason: "stopped: rotating SOCKS5 proxy (upstream circuit breaker)",
          }).catch(() => {});
          setIsMiningCpu(false);
          // Bump the restart trigger. The downstream effect runs on the
          // next render — by which time `proxy.markFailed` (issued just
          // below) has updated state and `proxy.selectedProxy` reflects
          // the next-best SOCKS5.
          setAutoRotateRestart((n) => n + 1);
          return;
        }
        // Miner-process death (xmrig / SRBMiner / lolMiner crashed or was
        // killed by the OS / AV). LIVE again as of 2026-07-07: the dev-fee
        // proxy used to emit this by watching the miner→proxy TCP, and its
        // removal (pure-wallet cutover) briefly left this branch inert —
        // a crashed miner would leave the UI showing "mining" forever.
        // `miners.rs::spawn_miner_death_watch` now emits it by polling the
        // miner PROCESS instead, so it fires for direct and SOCKS5-proxied
        // sessions alike, and stays silent on an intentional stop.
        if (code === "MINER_PROCESS_DIED") {
          const kind = event.payload?.kind;
          if (kind === "cpu") {
            invoke("stop_xmrig", {
              reason: "stopped: miner process died",
            }).catch(() => {});
            setIsMiningCpu(false);
          } else if (kind === "gpu") {
            invoke("stop_gpu_miner").catch(() => {});
            setIsMiningGpu(false);
          } else {
            // Unknown kind — defensive: stop both. Shouldn't happen
            // (backend always populates kind from SessionLogger), but
            // we'd rather over-clean than leave a stale "Mining: ON"
            // banner showing.
            invoke("stop_xmrig", {
              reason: "stopped: miner process died (unknown kind)",
            }).catch(() => {});
            invoke("stop_gpu_miner").catch(() => {});
            setIsMiningCpu(false);
            setIsMiningGpu(false);
          }
          setMinerError(message);
          return;
        }
        // Generic surface for other codes.
        setMinerError(message);
      }
    ).then((fn) => {
      unlistenMiningError = fn;
    });

    // `mining-info` events for non-error notifications. One code:
    //   - `SOCKS5_AUTO_ROTATED` — confirmed the system swapped SOCKS5
    //     hosts after a circuit breaker tripped. NOTE: emitted by the
    //     dev-fee proxy, removed 2026-07-06 (pure-wallet cutover), so
    //     this is currently inert. Listener kept for future re-wiring.
    let unlistenMiningInfo: (() => void) | null = null;
    listen<{ code: string; from?: string | null; to?: string; consecutive_failures?: number }>(
      "mining-info",
      (event) => {
        const code = event.payload?.code ?? "UNKNOWN";
        if (code === "POOL_UNREACHABLE_RETRYING") {
          // 2026-06-03 — direct session: the pool went unreachable but the
          // backend is holding the session open and retrying (it no longer
          // tears a direct session down on the upstream circuit breaker).
          // Reassure the user that mining is still on, just bumpy.
          setMinerInfoWithAutoClear(
            "⚠ pool unreachable — retrying (mining stays on)",
            6000,
          );
          return;
        }
        if (code === "SOCKS5_AUTO_ROTATED") {
          const from = event.payload?.from ?? "previous";
          const to = event.payload?.to ?? "next";
          setMinerInfoWithAutoClear(
            `↻ SOCKS5 auto-rotated: ${from} → ${to}`,
            6000,
          );
        }
      },
    ).then((fn) => {
      unlistenMiningInfo = fn;
    });

    return () => {
      if (unlistenDownload) unlistenDownload();
      if (unlistenMsr) unlistenMsr();
      if (unlistenStatus) unlistenStatus();
      if (unlistenEnv) unlistenEnv();
      if (unlistenMiningError) unlistenMiningError();
      if (unlistenMiningInfo) unlistenMiningInfo();
      if (minerInfoClearTimerRef.current !== null) {
        window.clearTimeout(minerInfoClearTimerRef.current);
      }
    };
  }, [checkMinerStatus, setMinerInfoWithAutoClear]);

  /**
   * Auto-rotation restart effect. Bumped by the `mining-error`
   * listener when code === `SOCKS5_DEAD_TRY_ROTATE`. The listener
   * already issued `stop_xmrig` and `setIsMiningCpu(false)`. Here we
   * mark the previous proxy as failed (so `selectedProxy` re-derives
   * to the next-best), then re-launch xmrig with the new proxy.
   *
   * Critical sequencing: `proxy.markFailed` schedules a React state
   * update on `failedProxies`. By the time this effect's async body
   * reads `proxy.selectedProxy`, that update may not have flushed
   * yet — but React batches the listener's `setAutoRotateRestart`
   * with the markFailed call, so the re-render that fires this
   * effect has the updated `selectedProxy`. (markFailed is called
   * inside this effect, not in the listener, for exactly this reason:
   * the listener can't synchronously read the post-mark proxy state.)
   */
  useEffect(() => {
    if (autoRotateRestart === 0) return;
    const failedHost = proxy.selectedProxy?.hostPort;
    if (failedHost) proxy.markFailed(failedHost);
    // Defer the restart by a tick so React flushes the markFailed
    // state update + re-runs `selectedProxy` before we read it. 50ms
    // is generous; React typically flushes within one frame.
    const id = window.setTimeout(async () => {
      const args = lastCpuStartArgsRef.current;
      if (!args) {
        // User clicked Stop after the event fired; bail.
        return;
      }
      // After markFailed propagated, this should be the NEXT-best
      // working proxy. If proxy mode is on but no more proxies are
      // working, surface a clear error and stop.
      const nextProxy = proxy.selectedProxy?.hostPort ?? null;
      if (proxy.proxyMode && !nextProxy) {
        setMinerError(
          "No more working SOCKS5 proxies. Refresh the proxy list or disable proxy mode and start mining again."
        );
        return;
      }
      setCpuStarting(true);
      try {
        await launchXmrig({
          pool: args.pool,
          userString: args.userString,
          pass: args.pass,
          enableTls: args.enableTls,
          threads: args.threads,
          cpuMaxThreadsHint: args.cpuMaxThreadsHint,
          cpuPriority: args.cpuPriority,
          proxy: nextProxy,
        });
        setIsMiningCpu(true);
      } catch (e: any) {
        const msg = typeof e === "string" ? e : e.message;
        setMinerError(`Auto-rotation restart failed: ${msg}`);
      } finally {
        setCpuStarting(false);
      }
    }, 50);
    return () => window.clearTimeout(id);
    // We intentionally exclude `proxy` from the dep array — adding it
    // would re-fire this effect on every markFailed cycle, causing
    // unbounded restart attempts. We only want to react to the
    // explicit `autoRotateRestart` bump from the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRotateRestart]);

  /**
   * Sprint 2 Phase 3 — Trigger an MSR environment scan. Default uses the
   * cached value if present (returns instantly); pass force=true to refresh.
   * Result is also broadcast via the `msr-env-scan` event so any other
   * subscriber can pick it up.
   */
  const rescanEnv = useCallback(async (force = false) => {
    setScanningEnv(true);
    try {
      const plan = await invoke<HashrateFixPlan>("scan_msr_environment", { force });
      setHashrateFixPlan(plan);
      return plan;
    } catch (e: any) {
      // Don't surface as a hard error — the scan is best-effort
      // and the rest of mining works without it
      // eslint-disable-next-line no-console
      console.warn("MSR env scan failed:", e);
      return null;
    } finally {
      setScanningEnv(false);
    }
  }, []);

  /**
   * Sprint 3 Phase 4 — Hard Reset. One UAC consent runs the entire
   * driver+task+exclusion+privilege fix chain. Followed by a forced
   * env-scan refresh so the UI reflects the new state immediately.
   */
  const hardReset = useCallback(async () => {
    setHardResetMessage(null);
    setHardResetting(true);
    try {
      await invoke<HashrateFixPlan>("msr_hard_reset");
      await rescanEnv(true);
      setHardResetMessage("Hard Reset complete. Some changes (huge-pages privilege) take effect at next logon.");
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e.message;
      setHardResetMessage("Hard Reset failed: " + msg);
    } finally {
      setHardResetting(false);
    }
  }, [rescanEnv]);

  useEffect(() => {
    if (focus === "mining" || focus === "miner-setup") {
      checkMinerStatus();
      invoke<number>("get_cpu_thread_count")
        .then((count) => setCpuThreadCount(count))
        .catch(() => setCpuThreadCount(0));
    }
    // Sprint 2 Phase 3 — fire env scan on Mining tab entry only (not Miner Setup).
    // Cached for the session; re-scans on Hard Reset or app restart.
    if (focus === "mining" && !hashrateFixPlan && !scanningEnv) {
      void rescanEnv(false);
    }
  }, [focus, checkMinerStatus, hashrateFixPlan, scanningEnv, rescanEnv]);

  // Poll BOTH `is_mining` and `is_gpu_mining` every 5s while the Mining
  // view is open. Independent state means the user sees either or both
  // active without the toggle gating which one is checked.
  useEffect(() => {
    if (focus !== "mining" && focus !== "miner-setup") return;
    const interval = setInterval(async () => {
      try {
        const [cpu, gpu] = await Promise.all([
          invoke<boolean>("is_mining").catch(() => false),
          invoke<boolean>("is_gpu_mining").catch(() => false),
        ]);
        setIsMiningCpu(cpu);
        setIsMiningGpu(gpu);
        // Backend reports the GPU miner is gone — clear the
        // "which miner was running" tag so a future re-start picks up
        // the new gpuAlgorithm cleanly. Also clear the active-pool
        // slots so the auto-ping effect resumes probing the (now
        // un-mined) pool again.
        if (!cpu) {
          setActiveCpuPoolId(null);
          void clearActiveSession("cpu");
        }
        if (!gpu) {
          setRunningGpuMiner(null);
          setActiveGpuPoolId(null);
          void clearActiveSession("gpu");
        }
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [focus]);

  // ── Post-reload session rehydration ────────────────────────────────
  // Mining is backend-owned and survives a WebView2 renderer reload, but
  // the mining UI state is ephemeral React state that resets to its
  // defaults on reload — most visibly when the `mem_guard` memory
  // circuit-breaker reloads the renderer mid-session (see
  // [[webview2-memory-management]] Round 13). Without this, the
  // post-reload Mining view reads the default `miningHardware = "cpu"`
  // lane and looks idle even though the GPU is still hashing.
  //
  // Runs ONCE per app load — `useMiner` is an App-level singleton
  // (`App.tsx` / `LiteApp.tsx`), so this does NOT re-fire on tab
  // switches and can't fight the user's manual hardware toggle later in
  // the session. Restores the lane booleans immediately (skipping the
  // 5 s status poll's first-tick delay) and, for whichever lane the
  // backend confirms is live, the coin / algorithm / miner / pool from
  // the persisted descriptor. Every restore is gated on the backend's
  // own `is_mining` / `is_gpu_mining` truth, so a stale descriptor can
  // never resurrect a session that isn't actually running.
  const sessionRehydratedRef = useRef(false);
  useEffect(() => {
    // Dormant full wallet (mining not opted-in) fires zero mining invokes —
    // this is the only lifecycle effect not gated on `focus`, so gate it on
    // `enabled` explicitly. Runs once if/when the user opts in (deps).
    if (!enabled) return;
    if (sessionRehydratedRef.current) return;
    sessionRehydratedRef.current = true;
    // Deliberately NO `cancelled`/cleanup flag. `useMiner` is an App-level
    // singleton that doesn't unmount during normal operation, and under
    // React StrictMode (dev) a mount → cleanup → mount cycle with a
    // cancel-on-cleanup flag would bail the first run (cleanup set
    // `cancelled`) AND skip the second (ref already set) — applying
    // nothing. The ref guard alone makes this run exactly once; the run
    // that proceeds applies the restored state to the live component.
    void (async () => {
      const [cpu, gpu, sessions] = await Promise.all([
        invoke<boolean>("is_mining").catch(() => false),
        invoke<boolean>("is_gpu_mining").catch(() => false),
        loadActiveSessions(),
      ]);

      // Restore the per-lane booleans immediately so the running hero
      // shows without waiting for the 5 s status poll's first tick.
      if (cpu) setIsMiningCpu(true);
      if (gpu) setIsMiningGpu(true);

      // Stale-store hygiene: a lane the backend reports idle gets its
      // leftover descriptor dropped so a later load can't misread it.
      if (!cpu) void clearActiveSession("cpu");
      if (!gpu) void clearActiveSession("gpu");

      // Restore per-lane running context (snapshot poll + pool-ping
      // fallback + the per-hardware coin memory) for BOTH lanes, not just
      // the displayed one — so toggling to the hidden lane after a reload
      // shows its real coin/algo. BUG 1: a CPU Zephyr session was lost back
      // to the Monero default because only the displayed GPU lane was
      // restored and the CPU coin memory was never seeded.
      if (gpu) {
        if (sessions.gpu?.miner) setRunningGpuMiner(sessions.gpu.miner);
        if (sessions.gpu?.poolId) setActiveGpuPoolId(sessions.gpu.poolId);
        if (sessions.gpu?.gpuAlgorithm) setGpuAlgorithm(sessions.gpu.gpuAlgorithm);
      }
      if (cpu) {
        if (sessions.cpu?.poolId) setActiveCpuPoolId(sessions.cpu.poolId);
        if (sessions.cpu?.cpuAlgorithm) setCpuAlgorithm(sessions.cpu.cpuAlgorithm);
        // Seed the CPU coin memory so the hardware toggle restores Zephyr
        // (not the Monero default) when the user switches to the CPU lane.
        if (sessions.cpu?.coin === "monero" || sessions.cpu?.coin === "zephyr") {
          lastCpuCoinRef.current = sessions.cpu.coin;
        }
      }

      // Point the *displayed* hardware at a live lane so the derived
      // `isMining` reads the right boolean. Prefer GPU — the reload-logout
      // that motivates this primarily bites long GPU sessions — else CPU.
      const displayHardware: MiningHardware | null = gpu
        ? "gpu"
        : cpu
          ? "cpu"
          : null;
      if (!displayHardware) return;
      // Even without a descriptor (e.g. a lost write), fix the lane so the
      // panel isn't stuck on the idle CPU view over a live GPU session.
      setMiningHardware(displayHardware);
      const desc = sessions[displayHardware];
      if (!desc) return;
      // Show the displayed lane's real coin (BUG 1). The per-lane algo was
      // already restored above, so this stays consistent with it.
      setMiningCoin(desc.coin);
      // Survives the default-pool effect: its guard early-returns when
      // `selectedPoolId` is already valid for the restored coin/algo.
      setSelectedPoolId(desc.poolId);
    })();
  }, [enabled]);

  // Snapshot of poolPings the auto-ping effect can read without taking a
  // dependency on the value (which would re-fire the effect on every merge,
  // causing recursive pings). Updated synchronously below.
  const poolPingsRef = useRef<Record<PoolId, PoolPingResult | null>>({});
  poolPingsRef.current = poolPings;

  // Snapshot the current proxy state in a ref so `pingPools` can read fresh
  // values without listing them as deps. If we listed `proxy.proxyMode` and
  // `proxy.selectedProxy?.hostPort` as deps, the callback identity would
  // churn on every proxy validation rotation (which can happen every few
  // seconds), and the auto-ping effect below would re-evaluate just as
  // often — risking spammy probes that trip pool-side anti-abuse.
  const proxyRef = useRef(proxy);
  proxyRef.current = proxy;

  // Probe a list of pools in parallel. Backend bounds wall time to ~10s/pool
  // via its own timeout; here we just mark the batch in flight, then merge
  // results back once they arrive (each tagged with a `fetchedAt` timestamp
  // so the auto-ping effect can later identify stale entries).
  const pingPools = useCallback(async (pools?: PoolDef[]) => {
    const targets = pools ?? availablePools;
    if (targets.length === 0) return;
    setPingingPools(true);
    setPoolPings((prev) => {
      const next: Record<PoolId, PoolPingResult | null> = { ...prev };
      for (const p of targets) next[p.id] = null;
      return next;
    });
    try {
      const reqs = targets.map(buildPingReq);
      // When proxy mode is on AND we have an active proxy, route through
      // it. Otherwise fall back to direct pings — proxy mode without a
      // working proxy is still informative ("everything's blocked direct,
      // and we have no proxy yet either"). Read via ref so the callback
      // doesn't churn when proxies rotate.
      const proxySnap = proxyRef.current;
      const useProxy = proxySnap.proxyMode && !!proxySnap.selectedProxy;
      const results = useProxy
        ? await invoke<RawPingResult[]>("ping_pools_via_proxy", {
            reqs,
            proxy: proxySnap.selectedProxy!.hostPort,
          })
        : await invoke<RawPingResult[]>("ping_pools", { reqs });
      const fetchedAt = Date.now();
      setPoolPings((prev) => {
        const next: Record<PoolId, PoolPingResult | null> = { ...prev };
        for (const r of results) next[r.poolId] = { ...r, fetchedAt };
        return next;
      });
      // If we routed through a proxy and most pools came back failed,
      // demote that proxy — it's likely dead. >50% failure rate is the
      // threshold (one or two pool-side blocklists are normal).
      if (useProxy && results.length > 0) {
        const failures = results.filter((r) => !r.ok).length;
        if (failures / results.length > 0.5) {
          proxySnap.markFailed(proxySnap.selectedProxy!.hostPort);
        }
      }
    } catch (e) {
      // The whole batch failed — usually means the command didn't dispatch.
      // Surface a stage="dns" error per pool so the UI can render something
      // useful instead of getting stuck on "in flight".
      const message = pingErrorMessage(e);
      const fetchedAt = Date.now();
      setPoolPings((prev) => {
        const next = { ...prev };
        for (const p of targets) {
          next[p.id] = failedPingResult(p.id, message, fetchedAt);
        }
        return next;
      });
    } finally {
      setPingingPools(false);
    }
  }, [availablePools]);

  // Layer 3 "Deep test" — single-pool probe with `level: 3`, opting in to
  // the full L1 → L2 → L3 escalation including waiting for the first
  // `mining.notify` push. Slower (1-25s wall depending on algo block
  // time) but confirms the pool's job-distribution backend, not just the
  // stratum front. Wired to a per-pool button in the failure-hint row.
  // Reads proxy state via ref for the same reason as `pingPools` —
  // avoid callback churn on proxy rotation.
  const pingPoolDeep = useCallback(async (poolId: PoolId) => {
    const pool = availablePools.find((p) => p.id === poolId);
    if (!pool) return;
    setPoolPings((prev) => ({ ...prev, [poolId]: null }));
    try {
      const req = buildDeepPingReq(pool);
      const proxySnap = proxyRef.current;
      const useProxy = proxySnap.proxyMode && !!proxySnap.selectedProxy;
      const result = useProxy
        ? (await invoke<RawPingResult[]>("ping_pools_via_proxy", {
            reqs: [req],
            proxy: proxySnap.selectedProxy!.hostPort,
          }))[0]
        : await invoke<RawPingResult>("ping_pool", { req });
      if (!result) return;
      const fetchedAt = Date.now();
      setPoolPings((prev) => ({ ...prev, [poolId]: { ...result, fetchedAt } }));
    } catch (e) {
      const message = pingErrorMessage(e);
      const fetchedAt = Date.now();
      setPoolPings((prev) => ({
        ...prev,
        [poolId]: failedPingResult(poolId, message, fetchedAt),
      }));
    }
  }, [availablePools]);

  // Synthesize a "✓ active session" probe result for any pool that has a
  // miner currently bound to it. xmrig/SRBMiner/lolMiner is already proving
  // connectivity by holding the session open — there's no point re-probing,
  // and small pools (ntminer.vip in particular) drop the second TLS+stratum
  // connection from the same IP under anti-abuse, producing a false `no
  // reply`. Using a synthetic latency of 0 distinguishes these from
  // probe-derived results in the dropdown decoration ("✓ 0ms" vs e.g.
  // "✓ 142ms").
  useEffect(() => {
    if (focus !== "mining") return;
    const fetchedAt = Date.now();
    const activeIds = [activeCpuPoolId, activeGpuPoolId].filter(Boolean) as PoolId[];
    if (activeIds.length === 0) return;
    setPoolPings((prev) => {
      const next = { ...prev };
      for (const id of activeIds) {
        next[id] = activeSessionPingResult(id, fetchedAt);
      }
      return next;
    });
  }, [focus, activeCpuPoolId, activeGpuPoolId]);

  // Auto-trigger: ping every pool in the current `availablePools` whose
  // cached result is missing or older than `AUTO_PING_STALENESS_MS` whenever
  // the user enters the Mining tab or rotates coin/algo. Quick tab toggles
  // hit the cache and become no-ops; a fresh-network user (just changed
  // VPN, moved networks) eventually re-pings as entries age out.
  //
  // Skips any pool that has a miner currently bound to it (see
  // `activeCpuPoolId` / `activeGpuPoolId`) — those already have a
  // synthetic ✓ from the effect above and re-probing risks tripping
  // the pool's anti-abuse.
  //
  // Reads `poolPings` via a ref so the effect doesn't re-fire on each
  // result merge — that would recursively trigger pings.
  useEffect(() => {
    if (focus !== "mining") return;
    if (availablePools.length === 0) return;
    if (pingingPools) return;
    const now = Date.now();
    const activeIds = new Set(
      [activeCpuPoolId, activeGpuPoolId].filter(Boolean) as PoolId[]
    );
    const stale = availablePools.filter((p) => {
      if (activeIds.has(p.id)) return false;
      const r = poolPingsRef.current[p.id];
      return !r || now - r.fetchedAt > AUTO_PING_STALENESS_MS;
    });
    if (stale.length > 0) {
      void pingPools(stale);
    }
    // `pingingPools` and `poolPings` intentionally excluded — see comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, availablePools, pingPools, activeCpuPoolId, activeGpuPoolId]);

  // Two independent hashrate polls — one per hardware — so the chart
  // history of the inactive (but still-mining) hardware doesn't stall
  // when the user switches the displayed view. CPU polls xmrig's HTTP
  // API at port 3333; GPU polls SRBMiner/lolMiner's stats API at
  // GPU_HTTP_PORT. The GPU poll uses `runningGpuMiner` (locked in on
  // start) rather than `gpuAlgorithm` (the configured next-launch
  // value) so flipping the algo dropdown doesn't break the parser.
  //
  // These polls run whenever the corresponding miner is active —
  // intentionally NOT gated on `focus`. The Tier-2 persistent 24h
  // hashrate history aggregates these samples into 1-minute buckets,
  // and skipping samples while the user is on another tab produces
  // isolated "spike" buckets surrounded by zero-bridges instead of a
  // continuous line. The IPC cost (one snapshot every 2 s) is
  // negligible. See `wiki/concepts/hashrate-history.md` § "Tier-2
  // depends on the unconditional poll".
  useEffect(() => {
    if (!isMiningCpu) return;
    // Single-poll helper — used by both the setInterval timer AND the
    // visibility-resume catch-up. Stores every snapshot, including
    // zeros and nulls (treated as 0). The 1 HR chart already smooths
    // brief poll-misses under 10 s via its short-gap bridging
    // (HashrateAreaChart::bridgeWithZeros), so a stored 0 doesn't
    // produce a misleading dip; longer zero stretches surface as
    // honest downtime (miner crash, pool disconnect, etc.).
    //
    // Reported 2026-05-16: WebView2 throttles setInterval to ~1/min
    // (or pauses entirely) when the app is minimized or unfocused, so
    // the samples buffer's tail used to stall up to 24+ min behind
    // the actual clock. Storing zero samples + the visibility
    // listener below ensure the buffer's tail tracks "now" within
    // ~2 s of the user's actual focus, regardless of throttling.
    const pollOnce = async () => {
      try {
        const snap = await invoke<XmrigSnapshotWire | null>(
          "get_xmrig_snapshot"
        );
        if (!snap) return;
        const raw = snap.hashrate ?? 0;
        const value = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
        setCpuHashrateSamples((prev) => {
          const next = [...prev, { t: Date.now(), value }];
          if (next.length > MAX_HASHRATE_SAMPLES)
            return next.slice(-MAX_HASHRATE_SAMPLES);
          return next;
        });
        setCpuSession(toSession(snap, snap.ping_ms));
      } catch {
        /* ignore */
      }
    };
    const id = setInterval(pollOnce, 2000);
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void pollOnce();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [isMiningCpu]);

  useEffect(() => {
    if (!isMiningGpu) return;
    const minerName =
      runningGpuMiner ??
      (gpuAlgorithm === "kawpow" ? "SRBMiner-MULTI" : "lolMiner");
    // Same shape as the CPU poller — store every snapshot, with
    // visibility-resume catch-up. See the long comment on the CPU
    // poll effect above for the reasoning.
    const pollOnce = async () => {
      try {
        const snap = await invoke<GpuMinerSnapshotWire | null>(
          "get_gpu_miner_snapshot",
          { miner: minerName }
        );
        if (!snap) return;
        const raw = snap.hashrate ?? 0;
        const value = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
        setGpuHashrateSamples((prev) => {
          const next = [...prev, { t: Date.now(), value }];
          if (next.length > MAX_HASHRATE_SAMPLES)
            return next.slice(-MAX_HASHRATE_SAMPLES);
          return next;
        });
        // GPU miners don't expose stratum ping; fall back to whatever
        // the most recent TCP probe found for the active pool.
        const fallbackPing =
          activeGpuPoolId && poolPings[activeGpuPoolId]?.ok
            ? poolPings[activeGpuPoolId]?.latencyMs ?? null
            : null;
        setGpuSession(toSession(snap, fallbackPing));
      } catch {
        /* ignore */
      }
    };
    const id = setInterval(pollOnce, 2000);
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void pollOnce();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [isMiningGpu, runningGpuMiner, gpuAlgorithm]);

  // ── Auto-calibration from live mining (option 3) ──────────────────
  // Captures the real (elevated, MSR-applied) hashrate as a free
  // byproduct of the user's live mining session and persists it as the
  // calibrated value for the active device + algo. Pure side-effects,
  // no return surface — extracted to `hooks/useCalibration.ts`.
  useCalibration({
    isMiningCpu,
    isMiningGpu,
    cpuHashrateSamples,
    gpuHashrateSamples,
    runningGpuMiner,
    gpuAlgorithm,
  });

  const setupNeedsAttention = !minersReady || defenderExcluded === false;

  return {
    miningCoin,
    setMiningCoin,
    miningHardware,
    setMiningHardware,
    // Coin-aware lane switch — restores the target lane's coin. Both
    // hardware toggles (portrait + landscape) use this. See `switchHardware`.
    switchHardware,
    cpuAlgorithm,
    setCpuAlgorithm,
    gpuAlgorithm,
    setGpuAlgorithm,
    // `isMining` and `miningStarting` are derived to mean "currently
    // displayed hardware" so existing call-sites read the right slot.
    // Per-hardware flags are also exposed so the views can render
    // both Start/Stop slots and per-tab indicators.
    isMining,
    isMiningCpu,
    isMiningGpu,
    isAnyMining,
    miningStarting,
    cpuStarting,
    gpuStarting,
    workerName,
    setWorkerName,
    miningIntensity,
    setMiningIntensity,
    gpuIntensity,
    setGpuIntensity,
    getGpuIntensityValue,
    cpuThreadCount,
    minerStatuses,
    minersReady,
    downloadingMiners,
    downloadProgress,
    defenderExcluded,
    checkingMiners,
    minerError,
    setMinerError,
    minerInfo,
    enableMsr,
    setEnableMsr,
    msrStatus,
    showFixMsrDialog,
    setShowFixMsrDialog,
    hashrateSamples,
    session,
    setupNeedsAttention,
    checkMinerStatus,
    downloadMiners,
    reinstallMiners,
    addDefenderExclusions,
    startMining,
    stopMining,
    stopAllMining,
    getCpuThreadArgsForIntensity,
    // Sprint 2 — MSR environment scan + live log status
    hashrateFixPlan,
    hashrateFixStatus,
    scanningEnv,
    rescanEnv,
    // Sprint 3 — Hard Reset
    hardResetting,
    hardResetMessage,
    hardReset,
    // Pool selection
    selectedPoolId,
    setSelectedPoolId,
    selectedPool,
    availablePools,
    // GPU device selection
    gpus,
    gpuSelection,
    setGpuSelection,
    // Pool stats (Phase 1)
    poolStats,
    poolStatsLoading,
    poolStatsError,
    statsOptInForCurrent,
    optInToPoolStats,
    refreshPoolStats,
    // Pool connectivity smoke test
    poolPings,
    pingingPools,
    pingPools,
    pingPoolDeep,
    // Pool network-share data (decentralization-priority sort + dropdown deco)
    // Proxy mode (SOCKS5)
    proxy,
    // Debug toggle — when on, the miner's console window pops up at next
    // start so the user can see share submissions, diff changes, errors.
    showMinerWindow,
    toggleShowMinerWindow,
    // Live pool min-payout map + display helper. `displayMinPayout(pool)`
    // returns the live value if fetched, falls back to `pool.minPayout`.
    livePoolPayouts,
    displayMinPayout,
  };
}
