import { describe, it, expect } from "vitest";
import {
  cpuThreadArgsForIntensity,
  cpuThreadsPreLaunchLabel,
  gpuIntensityValue,
} from "./devicePower";

describe("cpuThreadArgsForIntensity", () => {
  it("low: literal 2 threads, no hint, priority 1 — agnostic of cpuThreadCount", () => {
    expect(cpuThreadArgsForIntensity("low", 32)).toEqual({
      threads: 2,
      cpuMaxThreadsHint: null,
      cpuPriority: 1,
    });
    // Same result on a wildly different core count — Low must NOT scale.
    expect(cpuThreadArgsForIntensity("low", 4)).toEqual({
      threads: 2,
      cpuMaxThreadsHint: null,
      cpuPriority: 1,
    });
    expect(cpuThreadArgsForIntensity("low", 0)).toEqual({
      threads: 2,
      cpuMaxThreadsHint: null,
      cpuPriority: 1,
    });
  });

  it("medium: hint=50, no literal threads, priority 2 — agnostic of cpuThreadCount", () => {
    expect(cpuThreadArgsForIntensity("medium", 32)).toEqual({
      threads: null,
      cpuMaxThreadsHint: 50,
      cpuPriority: 2,
    });
    expect(cpuThreadArgsForIntensity("medium", 4)).toEqual({
      threads: null,
      cpuMaxThreadsHint: 50,
      cpuPriority: 2,
    });
  });

  it("high: everything null (auto, default priority)", () => {
    expect(cpuThreadArgsForIntensity("high", 32)).toEqual({
      threads: null,
      cpuMaxThreadsHint: null,
      cpuPriority: null,
    });
  });
});

describe("cpuThreadsPreLaunchLabel", () => {
  it("low always reads '2 threads'", () => {
    expect(cpuThreadsPreLaunchLabel("low", 32)).toBe("2 threads");
    expect(cpuThreadsPreLaunchLabel("low", 0)).toBe("2 threads");
  });

  it("medium shows an approximate half-count when detection has run", () => {
    expect(cpuThreadsPreLaunchLabel("medium", 32)).toBe("~16 threads (auto)");
  });

  it("medium falls back to a percentage label before detection completes", () => {
    expect(cpuThreadsPreLaunchLabel("medium", 0)).toBe("~50% (auto)");
  });

  it("high shows the full detected count, or a generic fallback", () => {
    expect(cpuThreadsPreLaunchLabel("high", 32)).toBe("32 threads");
    expect(cpuThreadsPreLaunchLabel("high", 0)).toBe("all threads");
  });
});

// Regression lock: gpuIntensityValue must be untouched by this change.
describe("gpuIntensityValue (unchanged — regression guard)", () => {
  it("maps low/medium/high to 16/22/28, auto to null", () => {
    expect(gpuIntensityValue("auto")).toBeNull();
    expect(gpuIntensityValue("low")).toBe(16);
    expect(gpuIntensityValue("medium")).toBe(22);
    expect(gpuIntensityValue("high")).toBe(28);
  });
});
