/**
 * Coin selection: per-lane gating and the hardware flip.
 *
 * Both defects here were reported on 2026-08-28 as one symptom — "the zano
 * mine button in the simple miner page was un-usable despite lighting up and
 * then when I went to pro it gave me a 'set-up miners' prompt on top" — and
 * both came from the SIMPLE view having its own simpler version of a rule the
 * PRO view already had right.
 */
import { describe, it, expect, vi } from "vitest";
import { coinTileLocked, pickMiningCoin, type CoinPickerMiner } from "../pickCoin";
import { MINING_COINS, isGpuCoin } from "../miningCoins";

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
    expect(isGpuCoin("zano")).toBe(true);
    expect(isGpuCoin("ravencoin")).toBe(true);
    expect(isGpuCoin("conflux")).toBe(true);
    expect(isGpuCoin("ergo")).toBe(true);
    expect(isGpuCoin("monero")).toBe(false);
    expect(isGpuCoin("zephyr")).toBe(false);
  });

  it("every rostered coin declares one", () => {
    for (const c of MINING_COINS) {
      expect(["cpu", "gpu"]).toContain(c.hardware);
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
