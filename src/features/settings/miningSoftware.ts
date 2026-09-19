/**
 * The miner binaries the app runs, which lane each serves, and for which
 * algorithms and coins — DERIVED from the tables `useMiner` actually launches
 * from (`CPU_MINER`, `GPU_MINER`, `MINING_COINS`).
 *
 * Settings ▸ Mining Software used to be a hand-written list of three lines
 * (XMRig/RandomX, SRBMiner/KawPow, lolMiner/Octopus). By 2026-09-16 it had
 * missed Autolykos2 and ProgPowZ on SRBMiner's GPU lane, and the whole of
 * SRBMiner's CPU lane (XelisHash v3), which the Xelis work added the day
 * before. A copy of a table goes stale the day the table changes; a view of it
 * cannot.
 */
import { ALGORITHM_LABEL, CPU_MINER, GPU_MINER, RETIRED_GPU_ALGORITHMS } from "../mining/algorithms";
import { MINING_COINS } from "../mining/miningCoins";
import type { CpuAlgorithm, GpuAlgorithm } from "../../types/mining";

export interface MinerLane {
  lane: "CPU" | "GPU";
  /** "RandomX (XMR, ZEPH)" — the algorithm and the coins it mines here. */
  algorithms: string[];
}

export interface MinerSoftware {
  name: string;
  lanes: MinerLane[];
}

/** How each binary is written for people; the tables key it as the launcher does. */
const DISPLAY_NAME: Record<string, string> = {
  xmrig: "XMRig",
  "SRBMiner-MULTI": "SRBMiner-MULTI",
  lolMiner: "lolMiner",
};

function coinsFor(lane: "cpu" | "gpu", algorithm: CpuAlgorithm | GpuAlgorithm): string[] {
  return MINING_COINS.filter((c) => c.algorithms[lane] === algorithm).map((c) => c.sym);
}

function label(lane: "cpu" | "gpu", algorithm: CpuAlgorithm | GpuAlgorithm): string {
  const coins = coinsFor(lane, algorithm);
  return coins.length > 0
    ? `${ALGORITHM_LABEL[algorithm]} (${coins.join(", ")})`
    : ALGORITHM_LABEL[algorithm];
}

export function miningSoftwareLineup(): MinerSoftware[] {
  const byMiner = new Map<string, MinerSoftware>();
  const add = (miner: string, lane: "cpu" | "gpu", algorithm: CpuAlgorithm | GpuAlgorithm) => {
    const name = DISPLAY_NAME[miner] ?? miner;
    let entry = byMiner.get(name);
    if (!entry) {
      entry = { name, lanes: [] };
      byMiner.set(name, entry);
    }
    const laneName = lane === "cpu" ? "CPU" : "GPU";
    let l = entry.lanes.find((x) => x.lane === laneName);
    if (!l) {
      l = { lane: laneName, algorithms: [] };
      entry.lanes.push(l);
    }
    l.algorithms.push(label(lane, algorithm));
  };

  // CPU first, then GPU, each in table order, so the list reads the way the
  // Mine tab's lanes do.
  for (const [algorithm, sel] of Object.entries(CPU_MINER) as [CpuAlgorithm, (typeof CPU_MINER)[CpuAlgorithm]][]) {
    add(sel.miner, "cpu", algorithm);
  }
  for (const [algorithm, sel] of Object.entries(GPU_MINER) as [GpuAlgorithm, (typeof GPU_MINER)[GpuAlgorithm]][]) {
    // Retired 2026-09-18 (RVN/CFX/ERG): not mined, so not listed — this is
    // also what drops lolMiner from the list, its only algorithm was Octopus.
    if (RETIRED_GPU_ALGORITHMS.has(algorithm)) continue;
    add(sel.miner, "gpu", algorithm);
  }
  return [...byMiner.values()];
}
