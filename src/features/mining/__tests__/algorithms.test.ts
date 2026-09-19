/**
 * Algorithm tables must agree with the coin roster.
 *
 * `algorithms.ts` replaced three if/else chains whose fallthrough defaults
 * were all wrong for at least one coin (2026-09-15):
 *
 *   - `switchHardware` restored a GPU Zano session's coin as ERGO;
 *   - `useCalibration` saved a Zano session's hashrate as the KawPow number;
 *   - the GPU snapshot poll parsed an Autolykos2/ProgPowZ session as lolMiner.
 *
 * The tables are exhaustive by type. These tests pin that they also say the
 * same thing as `MINING_COINS`, so a coin cannot be added to one and not the
 * other.
 */
import { describe, it, expect } from "vitest";
import {
  ALGORITHM_LABEL,
  BENCH_ALGORITHM,
  CPU_ALGORITHM_DEFAULT_COIN,
  CPU_MINER,
  CPU_SENDS_WORKER,
  GPU_ALGORITHM_COIN,
  GPU_MINER,
  RETIRED_GPU_ALGORITHMS,
} from "../algorithms";
import type { GpuAlgorithm } from "../../../types/mining";
import { MINING_COINS, algorithmFor } from "../miningCoins";
import type { ChainType } from "../../../wallets";

describe("GPU algorithm → coin", () => {
  it("every coin's GPU algorithm maps back to that coin", () => {
    for (const c of MINING_COINS) {
      const gpu = c.algorithms.gpu;
      if (gpu) expect(GPU_ALGORITHM_COIN[gpu]).toBe(c.chain);
    }
  });

  it("every GPU algorithm's coin really mines it on GPU", () => {
    for (const [algo, chain] of Object.entries(GPU_ALGORITHM_COIN)) {
      // Retired algorithms (2026-09-18) stay in the table as archived code but
      // must NOT be minable from any rostered coin.
      if (RETIRED_GPU_ALGORITHMS.has(algo as GpuAlgorithm)) {
        expect(algorithmFor(chain as ChainType, "gpu")).toBeNull();
        continue;
      }
      expect(algorithmFor(chain as ChainType, "gpu")).toBe(algo);
    }
  });

  it("Zano and Xelis restore as themselves — never the old ERGO fallthrough", () => {
    expect(GPU_ALGORITHM_COIN.progpowz).toBe("zano");
    expect(GPU_ALGORITHM_COIN.xelishashv3).toBe("xelis");
  });
});

describe("CPU algorithm → default coin", () => {
  it("every default coin mines that algorithm on CPU", () => {
    for (const [algo, chain] of Object.entries(CPU_ALGORITHM_DEFAULT_COIN)) {
      expect(algorithmFor(chain as ChainType, "cpu")).toBe(algo);
    }
  });
});

describe("which binary mines what", () => {
  it("XelisHash v3 runs on SRBMiner on BOTH lanes; RandomX stays on xmrig", () => {
    expect(CPU_MINER.xelishashv3.miner).toBe("SRBMiner-MULTI");
    expect(GPU_MINER.xelishashv3.miner).toBe("SRBMiner-MULTI");
    expect(CPU_MINER.randomx).toEqual({ miner: "xmrig", algorithm: "rx/0" });
  });

  it("only XELIS stratum sends a separate --worker; other argv is unchanged", () => {
    expect(CPU_SENDS_WORKER).toEqual({ randomx: false, xelishashv3: true });
    for (const [algo, sel] of Object.entries(GPU_MINER)) {
      expect(sel.sendsWorker).toBe(algo === "xelishashv3");
    }
  });

  it("every algorithm on the roster has a label", () => {
    for (const c of MINING_COINS) {
      for (const algo of [c.algorithms.cpu, c.algorithms.gpu]) {
        if (algo) expect(ALGORITHM_LABEL[algo]).toMatch(/\S/);
      }
    }
  });
});

describe("calibration keys", () => {
  it("never files one algorithm's hashrate under another algorithm's key", () => {
    for (const [algo, bench] of Object.entries(BENCH_ALGORITHM)) {
      if (bench !== null) expect(bench).toBe(algo);
    }
  });

  it("algorithms without a benchmark table are skipped, not saved as kawpow", () => {
    // The 2026-09-15 bug: any GPU session that was not Octopus was saved as
    // the KawPow calibration, so mining ZANO overwrote the RVN prediction.
    expect(BENCH_ALGORITHM.progpowz).toBeNull();
    expect(BENCH_ALGORITHM.autolykos).toBeNull();
  });
});
