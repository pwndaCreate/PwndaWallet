import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GPU_INTENSITY_MAX,
  GPU_INTENSITY_MIN,
  clampCpuThreads,
  clampGpuIntensity,
  cpuThreadsForPreset,
  cpuThreadsLowPriority,
  cpuTierForThreads,
  dedicatedGpus,
  effectiveCpuThreads,
  gpuIntensityForPreset,
  gpuTierForIntensity,
  isDedicatedGpu,
  presetForCpuThreads,
  presetForGpuIntensity,
  readCpuThreads,
  readGpuIntensitySetting,
  reconcileGpuSelection,
  writeCpuThreads,
  writeGpuIntensitySetting,
  xmrigThreadArgs,
  type GpuLike,
} from "./miningTuning";
import { cpuThreadsLabel, laneIntensityLabel } from "./miningLane";
import { cpuThreadsFlagLabel } from "./components/CpuThreadsControl";
import { gpuIntensityFlagText } from "./components/GpuIntensityControl";
import { shortGpuName } from "./components/GpuDevicePicker";

/**
 * The 2026-09-16 thread / intensity sliders and dedicated-GPU picker.
 * Rust pins the argv side (`miners.rs`: `cpu_thread_args_tests`,
 * `srbminer_cpu_tests`, `gpu_device_selection_tests`); this pins what a slider
 * position means before it gets there.
 */

const GIB = 1024 ** 3;
const gpu = (name: string, vendor: string, vramGiB: number): GpuLike => ({
  name,
  vendor,
  vram_bytes: vramGiB * GIB,
});

describe("CPU thread slider", () => {
  it("all threads (or more) is null — the old MAX, no xmrig thread flag", () => {
    expect(clampCpuThreads(null, 32)).toBeNull();
    expect(clampCpuThreads(32, 32)).toBeNull();
    expect(clampCpuThreads(64, 32)).toBeNull();
    expect(xmrigThreadArgs(null, 32)).toEqual({ threads: null, cpuMaxThreadsHint: null, cpuPriority: null });
  });

  it("an exact count below all is sent as --threads=N", () => {
    expect(xmrigThreadArgs(12, 32)).toEqual({ threads: 12, cpuMaxThreadsHint: null, cpuPriority: null });
    expect(clampCpuThreads(0, 32)).toBe(1);
    expect(clampCpuThreads(3.6, 32)).toBe(4);
    expect(clampCpuThreads(Number.NaN, 32)).toBeNull();
  });

  it("keeps a count while the core count is unknown (Rust clamps it)", () => {
    expect(clampCpuThreads(48, 0)).toBe(48);
    expect(effectiveCpuThreads(null, 0)).toBeNull();
    expect(effectiveCpuThreads(null, 16)).toBe(16);
  });

  it("the LOW preset is byte-identical to the old LOW tier for xmrig", () => {
    const low = cpuThreadsForPreset("low", 32);
    expect(low).toBe(2);
    expect(xmrigThreadArgs(low, 32)).toEqual({ threads: 2, cpuMaxThreadsHint: null, cpuPriority: 1 });
  });

  it("presets: MED is half, MAX is all, and a preset reads back as itself", () => {
    expect(cpuThreadsForPreset("medium", 32)).toBe(16);
    expect(cpuThreadsForPreset("high", 32)).toBeNull();
    for (const t of ["low", "medium", "high"] as const) {
      expect(presetForCpuThreads(cpuThreadsForPreset(t, 32), 32)).toBe(t);
    }
    expect(presetForCpuThreads(12, 32)).toBeNull();
  });

  it("presets stay sane on tiny CPUs", () => {
    // 2 logical: LOW (2) is all threads, so LOW and MAX coincide.
    expect(cpuThreadsForPreset("low", 2)).toBeNull();
    expect(cpuThreadsForPreset("medium", 2)).toBe(1);
    expect(cpuThreadsForPreset("medium", 1)).toBeNull();
  });

  it("mirrors miners.rs::cpu_threads_low_priority", () => {
    expect(cpuThreadsLowPriority(2, 32)).toBe(true);
    expect(cpuThreadsLowPriority(8, 32)).toBe(true);
    expect(cpuThreadsLowPriority(9, 32)).toBe(false);
    expect(cpuThreadsLowPriority(2, 4)).toBe(true);
    expect(cpuThreadsLowPriority(null, 32)).toBe(false);
    expect(cpuThreadsLowPriority(2, 0)).toBe(true);
    expect(cpuThreadsLowPriority(3, 0)).toBe(false);
  });

  it("derives the coarse tier the labels and the Rust fallback use", () => {
    expect(cpuTierForThreads(null, 32)).toBe("high");
    expect(cpuTierForThreads(4, 32)).toBe("low");
    expect(cpuTierForThreads(20, 32)).toBe("medium");
  });

  it("captions name the exact flag of the binary that will run", () => {
    expect(cpuThreadsFlagLabel(12, 32, "xmrig")).toBe("--threads=12");
    expect(cpuThreadsFlagLabel(null, 32, "xmrig")).toMatch(/no thread flag/);
    expect(cpuThreadsFlagLabel(12, 32, "SRBMiner-MULTI")).toBe("--cpu-threads 12");
    expect(cpuThreadsFlagLabel(null, 32, "SRBMiner-MULTI")).toBe("--cpu-threads 32");
  });

  it("the lane label reports the slider's count, not the tier estimate", () => {
    const base = { mining: false, intensity: "medium" as const, cpuThreadCount: 32 };
    expect(cpuThreadsLabel({ ...base, cpuThreads: 12, cpuMiner: "xmrig" })).toBe("12 threads");
    expect(cpuThreadsLabel({ ...base, cpuThreads: null, cpuMiner: "xmrig" })).toBe("32 threads");
    expect(cpuThreadsLabel({ ...base, cpuThreads: 1, cpuMiner: "xmrig" })).toBe("1 thread");
    // While mining, the miner's own count still wins.
    expect(
      cpuThreadsLabel({ ...base, mining: true, threadsActive: 11, cpuThreads: 12, cpuMiner: "xmrig" }),
    ).toBe("11 threads");
  });
});

describe("GPU intensity slider", () => {
  it("covers SRBMiner's documented 1-31 and nothing else", () => {
    expect(GPU_INTENSITY_MIN).toBe(1);
    expect(GPU_INTENSITY_MAX).toBe(31);
    expect(clampGpuIntensity(0)).toBe(1);
    expect(clampGpuIntensity(40)).toBe(31);
    expect(clampGpuIntensity(20.4)).toBe(20);
    expect(clampGpuIntensity(null)).toBeNull();
    expect(clampGpuIntensity(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("AUTO is null and sends no flag; presets keep the old 16/22/28", () => {
    expect(gpuIntensityForPreset("auto")).toBeNull();
    expect(gpuIntensityForPreset("low")).toBe(16);
    expect(gpuIntensityForPreset("medium")).toBe(22);
    expect(gpuIntensityForPreset("high")).toBe(28);
    expect(gpuIntensityFlagText(null)).toMatch(/no --gpu-intensity flag/);
    expect(gpuIntensityFlagText(20)).toBe("--gpu-intensity 20");
  });

  it("reads presets back exactly, and tiers by nearest preset", () => {
    expect(presetForGpuIntensity(null)).toBe("auto");
    expect(presetForGpuIntensity(22)).toBe("medium");
    expect(presetForGpuIntensity(20)).toBeNull();
    expect(gpuTierForIntensity(19)).toBe("low");
    expect(gpuTierForIntensity(20)).toBe("medium");
    expect(gpuTierForIntensity(26)).toBe("high");
    expect(gpuTierForIntensity(null)).toBe("auto");
  });

  it("the GPU lane label shows the number", () => {
    const args = { hardware: "gpu" as const, miningIntensity: "low" as const, gpuIntensity: "medium" as const };
    expect(laneIntensityLabel({ ...args, gpuIntensityLevel: 20 })).toBe("20 / 31");
    expect(laneIntensityLabel({ ...args, gpuIntensityLevel: 20 }, "short")).toBe("I20");
    expect(laneIntensityLabel({ ...args, gpuIntensity: "auto", gpuIntensityLevel: null })).toBe("Auto");
  });
});

describe("dedicated GPU detection", () => {
  it("keeps discrete NVIDIA / AMD / Intel Arc cards", () => {
    expect(isDedicatedGpu(gpu("NVIDIA GeForce RTX 4080", "nvidia", 16))).toBe(true);
    expect(isDedicatedGpu(gpu("AMD Radeon RX 6800", "amd", 16))).toBe(true);
    expect(isDedicatedGpu(gpu("AMD Radeon Pro W6800", "amd", 32))).toBe(true);
    expect(isDedicatedGpu(gpu("Intel(R) Arc(TM) A770 Graphics", "intel", 16))).toBe(true);
    // Unknown VRAM (0) does not exclude a card.
    expect(isDedicatedGpu(gpu("NVIDIA GeForce GTX 1080", "nvidia", 0))).toBe(true);
  });

  it("drops integrated and basic display adapters", () => {
    expect(isDedicatedGpu(gpu("AMD Radeon(TM) Graphics", "amd", 0))).toBe(false);
    expect(isDedicatedGpu(gpu("AMD Radeon 780M Graphics", "amd", 0))).toBe(false);
    expect(isDedicatedGpu(gpu("AMD Radeon(TM) Vega 8 Graphics", "amd", 2))).toBe(false);
    expect(isDedicatedGpu(gpu("Intel(R) UHD Graphics 630", "intel", 0))).toBe(false);
    expect(isDedicatedGpu(gpu("Intel(R) Iris(R) Xe Graphics", "intel", 0))).toBe(false);
    expect(isDedicatedGpu(gpu("Microsoft Basic Display Adapter", "other", 0))).toBe(false);
    expect(isDedicatedGpu({ name: "Some iGPU", vendor: "other", vram_bytes: 512 * 1024 ** 2 })).toBe(false);
    expect(isDedicatedGpu(gpu("", "nvidia", 8))).toBe(false);
  });

  it("keeps each card's index into the FULL detected list", () => {
    const list = [
      gpu("AMD Radeon(TM) Graphics", "amd", 0),
      gpu("NVIDIA GeForce RTX 4080", "nvidia", 16),
      gpu("NVIDIA GeForce RTX 3090", "nvidia", 24),
    ];
    expect(dedicatedGpus(list)).toEqual([
      { index: 1, name: "NVIDIA GeForce RTX 4080" },
      { index: 2, name: "NVIDIA GeForce RTX 3090" },
    ]);
  });

  it("reconciles a stored selection against today's dedicated GPUs", () => {
    const two = [gpu("NVIDIA GeForce RTX 4080", "nvidia", 16), gpu("NVIDIA GeForce RTX 3090", "nvidia", 24)];
    expect(reconcileGpuSelection([1], two)).toEqual([1]);
    // Every dedicated GPU selected is "all" = no device flag.
    expect(reconcileGpuSelection([0, 1], two)).toBeNull();
    expect(reconcileGpuSelection([1, 1], [...two, gpu("AMD Radeon RX 6800", "amd", 16)])).toEqual([1]);
    // One dedicated GPU (plus an APU): nothing to choose.
    expect(reconcileGpuSelection([1], [gpu("AMD Radeon(TM) Graphics", "amd", 0), two[0]])).toBeNull();
    // An index that is not a dedicated GPU is dropped.
    expect(reconcileGpuSelection([0], [gpu("AMD Radeon(TM) Graphics", "amd", 0), ...two])).toBeNull();
    expect(reconcileGpuSelection(null, two)).toBeNull();
  });

  it("shortens model names for buttons", () => {
    expect(shortGpuName("NVIDIA GeForce RTX 4080")).toBe("RTX 4080");
    expect(shortGpuName("AMD Radeon RX 6800")).toBe("RX 6800");
    expect(shortGpuName("Intel(R) Arc(TM) A770 Graphics")).toBe("Arc A770");
  });
});

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: makeMemoryStorage() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to all threads and AUTO — what every install launched before", () => {
    expect(readCpuThreads()).toBeNull();
    expect(readGpuIntensitySetting()).toBeNull();
  });

  it("round-trips both values and clears on null", () => {
    writeCpuThreads(12);
    writeGpuIntensitySetting(20);
    expect(readCpuThreads()).toBe(12);
    expect(readGpuIntensitySetting()).toBe(20);
    writeCpuThreads(null);
    writeGpuIntensitySetting(null);
    expect(readCpuThreads()).toBeNull();
    expect(readGpuIntensitySetting()).toBeNull();
  });

  it("rejects corrupted values instead of launching them", () => {
    window.localStorage.setItem("pwnda.mine.cpuThreads", "-4");
    window.localStorage.setItem("pwnda.mine.gpuIntensity", "999");
    expect(readCpuThreads()).toBeNull();
    // Out of range is clamped, never forwarded as a raw intensity.
    expect(readGpuIntensitySetting()).toBe(31);
    window.localStorage.setItem("pwnda.mine.cpuThreads", "abc");
    expect(readCpuThreads()).toBeNull();
  });

  it("does not throw without a window", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("window", undefined);
    expect(readCpuThreads()).toBeNull();
    expect(() => writeGpuIntensitySetting(5)).not.toThrow();
  });
});
