/**
 * Coin selection: per-lane gating and the hardware flip.
 *
 * Both defects here were reported on 2026-08-28 as one symptom — "the zano
 * mine button in the simple miner page was un-usable despite lighting up and
 * then when I went to pro it gave me a 'set-up miners' prompt on top" — and
 * both came from the SIMPLE view having its own simpler version of a rule the
 * PRO view already had right.
 *
 * The dual-lane block at the bottom (2026-09-15) covers XEL, the first coin
 * that mines on BOTH lanes.
 */
import { describe, it, expect, vi } from "vitest";
import {
  coinTileLocked,
  laneForPick,
  pickMiningCoin,
  type CoinPickerMiner,
} from "../pickCoin";
import { MINING_COINS, coinLanes } from "../miningCoins";

function miner(over: Partial<CoinPickerMiner> = {}): CoinPickerMiner {
  return {
    miningHardware: "cpu",
    setMiningHardware: vi.fn(),
    setMiningCoin: vi.fn(),
    isMiningCpu: false,
    isMiningGpu: false,
    ...over,
  };
}

describe("the lane a coin mines on", () => {
  it("is declared per coin, not inferred from a ticker list", () => {
    // Four call sites used to hardcode `RVN || CFX || ERG`, so ZANO — added
    // later — fell outside all of them at once.
    expect(coinLanes("zano")).toEqual(["gpu"]);
    expect(coinLanes("ravencoin")).toEqual(["gpu"]);
    expect(coinLanes("conflux")).toEqual(["gpu"]);
    expect(coinLanes("ergo")).toEqual(["gpu"]);
    expect(coinLanes("monero")).toEqual(["cpu"]);
    expect(coinLanes("zephyr")).toEqual(["cpu"]);
    expect(coinLanes("xelis")).toEqual(["cpu", "gpu"]);
  });

  it("every rostered coin declares at least one lane, each a real lane", () => {
    for (const c of MINING_COINS) {
      const lanes = coinLanes(c.chain);
      expect(lanes.length).toBeGreaterThan(0);
      for (const lane of lanes) expect(["cpu", "gpu"]).toContain(lane);
    }
  });
});

describe("picking a coin", () => {
  it("moves the displayed hardware to the lane that can mine it", () => {
    // The whole ZANO bug: without this, hardware stays on CPU, the pool
    // lookup asks for `zano/randomx`, and the console says "No pools for this
    // coin/algo" over "Setup miners first".
    const m = miner({ miningHardware: "cpu" });
    pickMiningCoin("zano", m);
    expect(m.setMiningHardware).toHaveBeenCalledWith("gpu");
    expect(m.setMiningCoin).toHaveBeenCalledWith("zano");
  });

  it("leaves the hardware alone when it is already right", () => {
    const m = miner({ miningHardware: "gpu" });
    pickMiningCoin("ravencoin", m);
    expect(m.setMiningHardware).not.toHaveBeenCalled();
    expect(m.setMiningCoin).toHaveBeenCalledWith("ravencoin");
  });

  it("switches back to CPU for a CPU coin", () => {
    const m = miner({ miningHardware: "gpu" });
    pickMiningCoin("monero", m);
    expect(m.setMiningHardware).toHaveBeenCalledWith("cpu");
  });
});

describe("per-lane gating", () => {
  /**
   * The other half of the report. CPU and GPU are independent backend
   * processes, so a CPU session must not lock the GPU coins — SIMPLE used
   * `disabled={isMining}` and locked everything.
   */
  it("a CPU session does not lock GPU coins", () => {
    const m = miner({ isMiningCpu: true });
    expect(coinTileLocked("monero", m)).toBe(true);
    expect(coinTileLocked("zano", m)).toBe(false);
    expect(coinTileLocked("ravencoin", m)).toBe(false);
  });

  it("a GPU session does not lock CPU coins", () => {
    const m = miner({ isMiningGpu: true });
    expect(coinTileLocked("zano", m)).toBe(true);
    expect(coinTileLocked("monero", m)).toBe(false);
  });

  it("refuses to select a coin whose own lane is busy", () => {
    const m = miner({ isMiningGpu: true });
    pickMiningCoin("zano", m);
    expect(m.setMiningCoin).not.toHaveBeenCalled();
    expect(m.setMiningHardware).not.toHaveBeenCalled();
  });
});

describe("dual-lane coins (XEL, 2026-09-15)", () => {
  it("a pick stays on the displayed lane when that lane can take it", () => {
    for (const lane of ["cpu", "gpu"] as const) {
      const m = miner({ miningHardware: lane });
      pickMiningCoin("xelis", m);
      expect(m.setMiningHardware).not.toHaveBeenCalled();
      expect(m.setMiningCoin).toHaveBeenCalledWith("xelis");
    }
  });

  it("with XEL mining on CPU, picking XEL moves the display to the idle GPU", () => {
    // How the second XEL session (CPU + GPU = two SRBMiner processes) gets
    // started from a coin tile.
    const m = miner({ miningHardware: "cpu", isMiningCpu: true });
    expect(laneForPick("xelis", m)).toBe("gpu");
    pickMiningCoin("xelis", m);
    expect(m.setMiningHardware).toHaveBeenCalledWith("gpu");
    expect(m.setMiningCoin).toHaveBeenCalledWith("xelis");
  });

  it("is locked only when BOTH lanes are busy", () => {
    expect(coinTileLocked("xelis", miner({ isMiningCpu: true }))).toBe(false);
    expect(coinTileLocked("xelis", miner({ isMiningGpu: true }))).toBe(false);
    expect(
      coinTileLocked("xelis", miner({ isMiningCpu: true, isMiningGpu: true }))
    ).toBe(true);
  });

  it("refuses when both lanes are busy", () => {
    const m = miner({ isMiningCpu: true, isMiningGpu: true });
    expect(laneForPick("xelis", m)).toBeNull();
    pickMiningCoin("xelis", m);
    expect(m.setMiningCoin).not.toHaveBeenCalled();
    expect(m.setMiningHardware).not.toHaveBeenCalled();
  });

  it("an XEL session on one lane still locks the single-lane coins of that lane", () => {
    const m = miner({ isMiningCpu: true });
    expect(coinTileLocked("monero", m)).toBe(true);
    expect(coinTileLocked("zephyr", m)).toBe(true);
    expect(coinTileLocked("ergo", m)).toBe(false);
  });
});
