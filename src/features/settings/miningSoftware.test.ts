/**
 * Settings ▸ Mining Software is derived from the launcher's tables.
 *
 * Until 2026-09-16 it was three hand-written lines (XMRig/RandomX,
 * SRBMiner/KawPow, lolMiner/Octopus) and had missed SRBMiner's whole CPU lane
 * (XelisHash v3, added the day before) and its Autolykos2 and ProgPowZ GPU
 * algorithms. Found by the portrait-vs-landscape parity audit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MINING_COINS } from "../mining/miningCoins";
import { miningSoftwareLineup } from "./miningSoftware";

const lineup = miningSoftwareLineup();
const laneText = (miner: string, lane: "CPU" | "GPU") =>
  lineup
    .find((m) => m.name === miner)
    ?.lanes.find((l) => l.lane === lane)
    ?.algorithms.join(" · ") ?? "";

describe("mining software lineup", () => {
  // lolMiner left 2026-09-18 with CFX, its only coin.
  it("names the two binaries the launcher runs", () => {
    expect(lineup.map((m) => m.name)).toEqual(["XMRig", "SRBMiner-MULTI"]);
  });

  it("lists SRBMiner's CPU lane, which the old copy left out", () => {
    expect(laneText("SRBMiner-MULTI", "CPU")).toContain("XelisHash v3 (XEL)");
  });

  it("lists exactly SRBMiner's GPU algorithms still mined — no retired ones", () => {
    const gpu = laneText("SRBMiner-MULTI", "GPU");
    expect(gpu).toBe("ProgPowZ (ZANO) · XelisHash v3 (XEL)");
    for (const s of ["KawPow", "Autolykos2", "Octopus"]) expect(gpu).not.toContain(s);
  });

  it("keeps XMRig on RandomX", () => {
    expect(laneText("XMRig", "CPU")).toBe("RandomX (XMR, ZEPH)");
  });

  it("covers every coin on the Mine tab's roster, on every lane it mines on", () => {
    for (const coin of MINING_COINS) {
      for (const lane of ["cpu", "gpu"] as const) {
        if (!coin.algorithms[lane]) continue;
        const LANE = lane === "cpu" ? "CPU" : "GPU";
        const listed = lineup.some((m) =>
          m.lanes.some(
            (l) => l.lane === LANE && l.algorithms.some((a) => a.includes(coin.sym)),
          ),
        );
        expect(listed, `${coin.sym} on ${LANE}`).toBe(true);
      }
    }
  });

  it("is what the landscape panel renders, not a hand-written copy", () => {
    const src = readFileSync(resolve(__dirname, "SettingsLandscapeView.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(src).toContain("miningSoftwareLineup()");
    expect(src).not.toMatch(/"RandomX \(CPU\)"|"KawPow \(GPU\)"|"Octopus \(GPU\)"/);
  });
});
