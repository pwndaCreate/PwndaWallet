/**
 * src/features/mining/miningLane.ts
 *
 * Facts about the DISPLAYED mining lane that more than one Mine surface
 * renders: which binary it runs, how its thread count and intensity read,
 * whether it can be started, and whether the xmrig-only diagnostics apply.
 *
 * Every function here is pure, and every one replaced a copy that had
 * drifted between portrait and landscape (parity audit, 2026-09-16):
 *
 *   - landscape PRO printed the raw logical-core count as the thread count;
 *     portrait printed what the binary would actually launch;
 *   - landscape PRO showed the CPU intensity on the GPU lane;
 *   - landscape PRO and SIMPLE let START be pressed with no payout address,
 *     and `useMiner` then set an error nothing on those screens rendered;
 *   - portrait gated the xmrig-only hashrate-fix panel on the CPU lane
 *     alone, so a XelisHash (SRBMiner) CPU session could be offered xmrig
 *     MSR fixes.
 */
import type {
  CpuAlgorithm,
  GpuAlgorithm,
  GpuIntensity,
  MiningHardware,
  MiningIntensity,
} from "../../types/mining";
import { CPU_MINER, GPU_MINER } from "./algorithms";
import {
  GPU_INTENSITY_MAX,
  clampGpuIntensity,
  effectiveCpuThreads,
  type CpuThreads,
  type GpuIntensitySetting,
} from "./miningTuning";
import {
  cpuThreadsPreLaunchLabel,
  gpuIntensityValue,
  srbCpuThreadsPreLaunchLabel,
} from "./utils/devicePower";

export type CpuMinerBinary = (typeof CPU_MINER)[CpuAlgorithm]["miner"];

/**
 * The binary holding (or about to hold) the CPU lane.
 *
 * While the lane mines, the backend's own answer (`runningCpuMiner`) wins: a
 * renderer reload can lose the descriptor, and the algorithm state is then a
 * guess about a process that is already running.
 */
export function cpuLaneMiner(args: {
  cpuAlgorithm: CpuAlgorithm;
  isMiningCpu?: boolean;
  runningCpuMiner?: CpuMinerBinary | null;
}): CpuMinerBinary {
  if (args.isMiningCpu && args.runningCpuMiner) return args.runningCpuMiner;
  return CPU_MINER[args.cpuAlgorithm].miner;
}

/**
 * `16 threads`, `~16 threads (auto)`, …
 *
 * While mining, the count the miner reported. Before that, the estimate for
 * the binary that will run: xmrig takes a PERCENTAGE hint it rounds itself,
 * SRBMiner takes an exact `--cpu-threads`, so one formula cannot describe both.
 */
export function cpuThreadsLabel(args: {
  mining: boolean;
  threadsActive?: number | null;
  intensity: MiningIntensity;
  cpuThreadCount: number;
  /** The thread slider's value (`null` = all). When given, it is what
   *  launches, so it replaces the tier estimate. */
  cpuThreads?: CpuThreads;
  cpuMiner: CpuMinerBinary;
}): string {
  if (args.mining && args.threadsActive != null) {
    return `${args.threadsActive} threads`;
  }
  if (args.cpuThreads !== undefined) {
    const n = effectiveCpuThreads(args.cpuThreads, args.cpuThreadCount);
    return n == null ? "all threads" : `${n} ${n === 1 ? "thread" : "threads"}`;
  }
  return args.cpuMiner === "SRBMiner-MULTI"
    ? srbCpuThreadsPreLaunchLabel(args.intensity, args.cpuThreadCount)
    : cpuThreadsPreLaunchLabel(args.intensity, args.cpuThreadCount);
}

/** Whether the displayed lane's miner has an intensity control at all. */
export function laneHasIntensity(
  hardware: MiningHardware,
  gpuAlgorithm: GpuAlgorithm,
): boolean {
  // lolMiner (Octopus / CFX) has no `--gpu-intensity`; SRBMiner does.
  return hardware === "cpu" || GPU_MINER[gpuAlgorithm].miner === "SRBMiner-MULTI";
}

const INTENSITY_LONG: Record<MiningIntensity | GpuIntensity, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "Max",
};
const INTENSITY_SHORT: Record<MiningIntensity | GpuIntensity, string> = {
  auto: "AUTO",
  low: "LOW",
  medium: "MED",
  high: "MAX",
};

/** The DISPLAYED lane's intensity: the CPU tier on CPU, the GPU tier on GPU. */
export function laneIntensityLabel(
  args: {
    hardware: MiningHardware;
    miningIntensity: MiningIntensity;
    gpuIntensity: GpuIntensity;
    /** The GPU slider's exact value (`null` = AUTO). When given, the GPU
     *  lane reports the number rather than the nearest tier. */
    gpuIntensityLevel?: GpuIntensitySetting;
  },
  form: "long" | "short" = "long",
): string {
  if (args.hardware === "gpu" && args.gpuIntensityLevel !== undefined) {
    const v = clampGpuIntensity(args.gpuIntensityLevel);
    if (v != null) return form === "long" ? `${v} / ${GPU_INTENSITY_MAX}` : `I${v}`;
  }
  const level = args.hardware === "cpu" ? args.miningIntensity : args.gpuIntensity;
  return (form === "long" ? INTENSITY_LONG : INTENSITY_SHORT)[level];
}

/** What `--gpu-intensity` a GPU tier sends, for tooltips and captions. */
export function gpuIntensityFlagLabel(level: GpuIntensity): string {
  const v = gpuIntensityValue(level);
  return v == null ? "no --gpu-intensity flag (SRBMiner self-tunes)" : `--gpu-intensity ${v}`;
}

/** Why START cannot run yet, or `null` when it can. */
export type StartBlocker = "miners" | "address" | null;

export function startBlocker(args: {
  minersReady: boolean;
  payoutAddress: string | null | undefined;
}): StartBlocker {
  if (!args.minersReady) return "miners";
  if (!args.payoutAddress) return "address";
  return null;
}

export type RunButtonKind =
  | "stop"
  | "start"
  | "starting"
  | "blocked-miners"
  | "blocked-address";

export interface RunButtonState {
  kind: RunButtonKind;
  disabled: boolean;
  /** What a click does. `null` when a click does nothing. */
  action: "start" | "stop" | "setup" | null;
  /** The blocked-state label, shared by every surface. `null` otherwise. */
  blockedLabel: string | null;
}

/**
 * The run control's state, for every Mine surface.
 *
 * A running lane can always be stopped, whatever else is missing — the
 * address being removed mid-session must not strand a miner. A blocked lane
 * names the thing that is missing (before 2026-08-12 portrait said "Set up
 * miners" for a missing address too, and sent users to reinstall working
 * miners). "Set up miners" is only a live control when the host supplied a
 * way to get there.
 */
export function runButtonState(args: {
  mining: boolean;
  starting: boolean;
  blockedBy: StartBlocker;
  coinTicker: string;
  canOpenSetup: boolean;
}): RunButtonState {
  if (args.mining) {
    return { kind: "stop", disabled: false, action: "stop", blockedLabel: null };
  }
  if (args.blockedBy === "address") {
    return {
      kind: "blocked-address",
      disabled: true,
      action: null,
      blockedLabel: `► No ${args.coinTicker} payout address`,
    };
  }
  if (args.blockedBy === "miners") {
    const live = args.canOpenSetup && !args.starting;
    return {
      kind: "blocked-miners",
      disabled: !live,
      action: live ? "setup" : null,
      blockedLabel: "► Set up miners",
    };
  }
  if (args.starting) {
    return { kind: "starting", disabled: true, action: null, blockedLabel: null };
  }
  return { kind: "start", disabled: false, action: "start", blockedLabel: null };
}

/** The hint under a blocked run control. Same words on every surface. */
export function startBlockerHint(blockedBy: StartBlocker): string | null {
  if (blockedBy === "miners") return "Set up miners in Miner Setup to start";
  if (blockedBy === "address") return "No mining address set for selected coin";
  return null;
}

/**
 * Whether the xmrig-only hashrate diagnostics (MSR mod, huge pages, Hard
 * Reset) describe the DISPLAYED lane.
 *
 * They are facts about xmrig's RandomX dataset. SRBMiner's CPU lane
 * (XelisHash) runs unelevated and ignores all of it, and the GPU lanes never
 * touch it.
 */
export function showsXmrigDiagnostics(args: {
  hardware: MiningHardware;
  cpuMiner: CpuMinerBinary;
}): boolean {
  return args.hardware === "cpu" && args.cpuMiner === "xmrig";
}
