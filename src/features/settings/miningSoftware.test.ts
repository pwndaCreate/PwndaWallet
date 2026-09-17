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
  it("names the three binaries the launcher runs", () => {
    expect(lineup.map((m) => m.name)).toEqual(["XMRig", "SRBMiner-MULTI", "lolMiner"]);
  });

  it("lists SRBMiner's CPU lane, which the old copy left out", () => {
    expect(laneText("SRBMiner-MULTI", "CPU")).toContain("XelisHash v3 (XEL)");
  });

  it("lists every SRBMiner GPU algorithm, not just KawPow", () => {
    const gpu = laneText("SRBMiner-MULTI", "GPU");
    for (const s of ["KawPow (RVN)", "Autolykos2 (ERG)", "ProgPowZ (ZANO)", "XelisHash v3 (XEL)"]) {
      expect(gpu).toContain(s);
    }
  });

  it("keeps XMRig on RandomX and lolMiner on Octopus", () => {
    expect(laneText("XMRig", "CPU")).toBe("RandomX (XMR, ZEPH)");
    expect(laneText("lolMiner", "GPU")).toBe("Octopus (CFX)");
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
