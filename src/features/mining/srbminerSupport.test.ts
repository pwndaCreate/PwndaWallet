/**
 * Every algorithm routed to SRBMiner-MULTI must be one it mines on the
 * hardware we send it to: CPU for the CPU lane, BOTH AMD and NVIDIA for the
 * GPU lane.
 *
 * The table is verbatim from the pinned binary (SRBMiner-MULTI 3.6.2,
 * `--list-algorithms`, 2026-09-16), legend `C : CPU  A : AMD GPU
 * N : NVIDIA GPU  I : INTEL GPU`. The binary accepts `progpowz` as an alias of
 * `progpow_zano` (an unknown name exits with `Unknown algorithm '<name>'`;
 * `progpowz` does not), so the alias table below maps it.
 *
 * Octopus is not in SRBMiner 3.6.2 at all, which is why it stays on lolMiner.
 */
import { describe, expect, it } from "vitest";
import { CPU_MINER, GPU_MINER } from "./algorithms";

const SRBMINER_3_6_2_LIST_ALGORITHMS = `
[1.00%]   [ -  A  N  I ]   autolykos2
[0.85%]   [ -  A  N  I ]   evrprogpow
[0.85%]   [ -  A  N  I ]   kawpow
[0.85%]   [ -  A  N  I ]   progpow_epic
[0.85%]   [ -  A  N  I ]   progpow_zano
[1.50%]   [ C  A  N  I ]   xelishashv3
`;

/** Names the binary accepts that are not how it lists them. */
const ALIASES: Record<string, string> = { progpowz: "progpow_zano" };

function support(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of SRBMINER_3_6_2_LIST_ALGORITHMS.split("\n")) {
    const m = line.match(/\[\s*([-C])\s+([-A])\s+([-N])\s+([-I])\s*\]\s+(\S+)/);
    if (!m) continue;
    out.set(m[5], new Set(m.slice(1, 5).filter((c) => c !== "-")));
  }
  return out;
}

const canonical = (algo: string) => ALIASES[algo] ?? algo;

describe("SRBMiner-MULTI mines what we route to it", () => {
  it("every SRBMiner GPU algorithm runs on AMD and NVIDIA", () => {
    const table = support();
    const routed = Object.values(GPU_MINER).filter((g) => g.miner === "SRBMiner-MULTI");
    expect(routed.length).toBeGreaterThan(0);
    for (const g of routed) {
      const caps = table.get(canonical(g.algorithm));
      expect(caps, `${g.algorithm} is not an SRBMiner 3.6.2 algorithm`).toBeDefined();
      expect([...caps!].sort(), g.algorithm).toEqual(expect.arrayContaining(["A", "N"]));
    }
  });

  it("every SRBMiner CPU algorithm runs on the CPU", () => {
    const table = support();
    const routed = Object.values(CPU_MINER).filter((c) => c.miner === "SRBMiner-MULTI");
    expect(routed.length).toBeGreaterThan(0);
    for (const c of routed) {
      expect(table.get(canonical(c.algorithm))?.has("C"), c.algorithm).toBe(true);
    }
  });

  it("Octopus stays on lolMiner, because SRBMiner 3.6.2 does not have it", () => {
    expect(support().has("octopus")).toBe(false);
    expect(GPU_MINER.octopus.miner).toBe("lolMiner");
  });
});
