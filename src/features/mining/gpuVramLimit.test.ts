import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GPU_VRAM_LIMIT_FALLBACK_MAX_GB,
  clampGpuVramLimit,
  gpuVramLimitMaxGb,
  gpuVramLimitMb,
  readGpuVramLimit,
  writeGpuVramLimit,
  type GpuLike,
} from "./miningTuning";
import { threadsForVramGb } from "./components/GpuVramLimitControl";

/**
 * The XelisHash GPU lane's optional VRAM limit (2026-09-17). AUTO (null) is
 * the default and sends nothing; a limit is whole GB per card, sent to Rust as
 * MB, which turns it into SRBMiner's raw thread count
 * (`srb_vram_limit_arg`, pinned by
 * `gpu_device_selection_tests::a_vram_limit_becomes_a_raw_thread_count_per_card`).
 */
const GB = 1024 ** 3;
const rx6700xt: GpuLike = { name: "AMD Radeon RX 6700 XT", vendor: "amd", vram_bytes: 12 * GB };
const rtx5060ti: GpuLike = { name: "NVIDIA GeForce RTX 5060 Ti", vendor: "nvidia", vram_bytes: 16 * GB };
const igpu: GpuLike = { name: "Intel(R) UHD Graphics 770", vendor: "intel", vram_bytes: 64 * GB };

describe("GPU VRAM limit", () => {
  // Node has no window; the same in-memory stub miningTuning.test.ts uses.
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AUTO is the default and sends nothing", () => {
    expect(readGpuVramLimit()).toBeNull();
    expect(gpuVramLimitMb(null)).toBeNull();
  });

  it("a limit is whole GB, sent as MB", () => {
    expect(gpuVramLimitMb(4)).toBe(4096);
    expect(clampGpuVramLimit(4.7)).toBe(4);
    for (const bad of [0, -2, 0.5, Number.NaN]) expect(clampGpuVramLimit(bad)).toBeNull();
  });

  it("the slider tops out at the biggest dedicated card, ignoring an iGPU", () => {
    expect(gpuVramLimitMaxGb([rx6700xt, rtx5060ti, igpu])).toBe(16);
    expect(gpuVramLimitMaxGb([rx6700xt])).toBe(12);
    expect(gpuVramLimitMaxGb([])).toBe(GPU_VRAM_LIMIT_FALLBACK_MAX_GB);
  });

  it("persists, and AUTO clears the key", () => {
    writeGpuVramLimit(6);
    expect(readGpuVramLimit()).toBe(6);
    writeGpuVramLimit(null);
    expect(window.localStorage.getItem("pwnda.mine.xelisVramGb")).toBeNull();
  });

  it("the caption's thread estimate matches Rust's rounding", () => {
    // 4 GB / 531 KiB = 7899 threads, down to a multiple of 256.
    expect(threadsForVramGb(4)).toBe(7680);
  });
});
