/**
 * Which lanes offer a GPU intensity control, and why the rest do not.
 *
 * 2026-09-17: XelisHash joined lolMiner in "no intensity here". Its threads
 * each own a 531 KiB scratchpad, so the number is a VRAM request, and
 * SRBMiner documents no mapping from its 0-31 scale to a thread count.
 */
import { describe, expect, it } from "vitest";
import {
  LOLMINER_NO_INTENSITY,
  gpuIntensityUnsupportedReason,
  laneHasIntensity,
} from "./miningLane";

describe("gpuIntensityUnsupportedReason (2026-09-17)", () => {
  it("locks the slider for XelisHash, whose intensity is a VRAM request", () => {
    // Every thread in flight owns a 531 KiB scratchpad
    // (xelis-hash/src/v3.rs: MEMORY_SIZE = 531 * 128 u64), and SRBMiner
    // publishes no mapping from its 0-31 scale to a thread count. Setting 20
    // on a 12 GB and a 16 GB card filled both, printed "not enough memory"
    // and froze the machine.
    const reason = gpuIntensityUnsupportedReason("xelishashv3");
    expect(reason).toMatch(/scratchpad/i);
    expect(laneHasIntensity("gpu", "xelishashv3")).toBe(false);
  });

  it("leaves the DAG algorithms alone", () => {
    for (const algo of ["kawpow", "autolykos", "progpowz"] as const) {
      expect(gpuIntensityUnsupportedReason(algo)).toBeNull();
      expect(laneHasIntensity("gpu", algo)).toBe(true);
    }
  });

  it("still explains lolMiner's missing flag", () => {
    expect(gpuIntensityUnsupportedReason("octopus")).toBe(LOLMINER_NO_INTENSITY);
    expect(laneHasIntensity("gpu", "octopus")).toBe(false);
  });

  it("the CPU lane is unaffected", () => {
    expect(laneHasIntensity("cpu", "xelishashv3")).toBe(true);
  });
});
