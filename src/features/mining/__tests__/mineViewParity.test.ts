import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MiningProjection } from "../../../types/mining";
import { capabilityFor } from "../minedAssetCapability";
import { minedAssetView } from "../minedAssetView";
import { MINING_COINS } from "../miningCoins";
import {
  cpuLaneMiner,
  cpuThreadsLabel,
  laneHasIntensity,
  laneIntensityLabel,
  runButtonState,
  showsXmrigDiagnostics,
  startBlocker,
} from "../miningLane";
import { enableMiningAndOpenSetup, openMinerSetup } from "../minerSetupEntry";

/**
 * Portrait and landscape Mine views render the SAME shared pieces.
 *
 * Modelled on `swap/landscapeRouterParity.test.ts`, and written for the same
 * reason: the portrait-vs-landscape parity audit of 2026-09-16 found eight
 * places where one Mine surface had decided something for itself and another
 * had decided it differently —
 *
 *   1. landscape PRO multiplied XEL earnings by an XMR→target rate;
 *   2. landscape PRO and SIMPLE let START be pressed with no payout address,
 *      and rendered none of `useMiner`'s errors;
 *   3. portrait PRO never offered EARN;
 *   4. landscape PRO had no GPU intensity control and printed raw core counts;
 *   5. portrait offered xmrig fixes to a XelisHash (SRBMiner) CPU session;
 *   6. landscape's device panel had no prices;
 *   7. only landscape refreshed miner status after the setup wizard;
 *   (+) SIMPLE priced earnings from hardcoded chain constants, PRO from live ones.
 *
 * Every one type-checked. A shared component only prevents drift while both
 * layouts keep USING it, so each block below asserts the real invariant —
 * the decision is made in one place and no view makes it again — rather than
 * a string that happens to sit next to it. Behaviour of the shared pieces is
 * tested directly underneath each source check.
 */
const SIMPLE = "src/features/mining/MineSimpleView.tsx";
const LANDSCAPE = "src/features/mining/MineLandscapeView.tsx";
const PORTRAIT = "src/features/mining/MiningView.tsx";
const LANDSCAPE_ROOT = "src/features/landscape/LandscapeRoot.tsx";
const VIEW_ROUTER = "src/ViewRouter.tsx";

const VIEWS = [
  ["simple", SIMPLE],
  ["landscape PRO", LANDSCAPE],
  ["portrait PRO", PORTRAIT],
] as const;
const PRO_VIEWS = [
  ["landscape PRO", LANDSCAPE],
  ["portrait PRO", PORTRAIT],
] as const;
const HOSTS = [
  ["landscape", LANDSCAPE_ROOT],
  ["portrait", VIEW_ROUTER],
] as const;

/** Source with comments removed, so prose about a pattern cannot satisfy or trip a check. */
function code(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every `<Tag … />` element in a source, attributes included. */
function elements(src: string, tag: string): string[] {
  return src.match(new RegExp(`<${tag}\\b[\\s\\S]*?\\/>`, "g")) ?? [];
}

const btc = (over: Partial<MiningProjection> = {}): MiningProjection => ({
  targetTicker: "BTC",
  ratePerXmr: 0.0021,
  xmrPriceUsd: 150,
  fromEarnTarget: false,
  ...over,
});

describe("#1 the mined-asset decision is made once", () => {
  for (const [label, rel] of VIEWS) {
    it(`${label} reads the XMR rate nowhere — only through useMinedAssetView`, () => {
      const src = code(rel);
      expect(src).toContain("useMinedAssetView(");
      expect(
        src.includes("ratePerXmr"),
        `${label} reads \`ratePerXmr\` itself. That rate is XMR→target and only ` +
          "applies to a coin with a route; landscape PRO applied it to XEL. Use the " +
          "asset view's toDisplay/formatDisplay.",
      ).toBe(false);
    });
  }

  it("the helper reads the rate in exactly one place, behind canProject", () => {
    const reads = code("src/features/mining/minedAssetView.ts")
      .split("\n")
      .filter((l) => /\.ratePerXmr\b/.test(l));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("canProject");
  });

  it("SIMPLE's hero is handed the decided projection, not the injected one", () => {
    const [hero] = elements(code(SIMPLE), "BalanceHero");
    expect(hero).toBeDefined();
    expect(hero).toMatch(/projection=\{asset\.projection\}/);
    expect(hero).toMatch(/minedAmount=\{asset\.minedAmount\}/);
  });

  const noRoute = MINING_COINS.filter((c) => capabilityFor(c.chain).kind !== "route");

  it("the roster still has coins without a route (otherwise this block tests nothing)", () => {
    expect(noRoute.map((c) => c.sym)).toContain("XEL");
  });

  for (const c of noRoute) {
    it(`${c.sym}: native figures, no XMR rate, no XMR balance, and the note`, () => {
      const a = minedAssetView({
        miningCoin: c.chain,
        projection: btc({ ratePerXmr: 1234 }),
        minedAmount: 5,
        pricesByTicker: { [c.sym]: 2 },
      });
      expect(a.canProject).toBe(false);
      expect(a.displayTicker).toBe(c.sym);
      expect(a.isNative).toBe(true);
      expect(a.toDisplay(2.5)).toBe(2.5);
      expect(a.formatDisplay(2.5)).toContain(c.sym);
      expect(a.formatDisplay(2.5)).not.toMatch(/BTC|≈/);
      // The injected balance is XMR's; it must not be shown as this coin's.
      expect(a.minedAmount).toBeNull();
      expect(a.capabilityNote).toBe(
        (capabilityFor(c.chain) as { note: string }).note,
      );
      expect(a.usdPerDay(3)).toBe(6);
      expect(a.routeFailureText).toBeNull();
      expect(a.routeLoading).toBe(false);
    });
  }

  it("XEL — the reported case — reads in XEL whatever the display coin", () => {
    const a = minedAssetView({ miningCoin: "xelis", projection: btc() });
    expect(a.formatDisplay(0.04)).toBe("0.04000 XEL");
  });

  it("XMR is projected through the rate, marked approximate", () => {
    const a = minedAssetView({ miningCoin: "monero", projection: btc(), minedAmount: 2 });
    expect(a.canProject).toBe(true);
    expect(a.displayTicker).toBe("BTC");
    expect(a.toDisplay(2)).toBeCloseTo(0.0042, 10);
    expect(a.formatDisplay(2)).toMatch(/^≈ .* BTC$/);
    expect(a.minedAmount).toBe(2);
    expect(a.capabilityNote).toBeNull();
  });

  it("XMR with an unknown rate renders —, never 0", () => {
    const a = minedAssetView({ miningCoin: "monero", projection: btc({ ratePerXmr: null }) });
    expect(a.toDisplay(1)).toBeNull();
    expect(a.formatDisplay(1)).toBe("—");
  });

  it("XMR in XMR is not a conversion, and needs no rate", () => {
    const a = minedAssetView({
      miningCoin: "monero",
      projection: btc({ targetTicker: "XMR", ratePerXmr: null }),
    });
    expect(a.isNative).toBe(true);
    expect(a.formatDisplay(0.5)).toBe("0.50000 XMR");
  });

  it("XMR with no projection at all (PwndaLite) falls back to native", () => {
    const a = minedAssetView({ miningCoin: "monero" });
    expect(a.displayTicker).toBe("XMR");
    expect(a.formatDisplay(1)).toBe("1.0000 XMR");
  });

  it("a zero or missing price is unknown, not free", () => {
    const a = minedAssetView({ miningCoin: "xelis", pricesByTicker: { XEL: 0 } });
    expect(a.minedPriceUsd).toBeNull();
    expect(a.usdPerDay(1)).toBeNull();
  });
});

describe("#2 the run control and its status lines are shared", () => {
  for (const [label, rel] of VIEWS) {
    it(`${label} renders the shared run control and status banner`, () => {
      const src = code(rel);
      expect(src).toContain("<MineRunButton");
      expect(src).toContain("<MinerStatusBanner");
      expect(src).toContain("startBlocker(");
      // The two shapes the silent START had: a raw onClick straight into
      // startMining, and a disabled check that only knew about the miners.
      expect(src).not.toMatch(/onClick=\{[^}]*startMining/);
      expect(src).not.toMatch(/disabled=\{!minersReady/);
    });

    it(`${label} passes the error and info lines through`, () => {
      const [banner] = elements(code(rel), "MinerStatusBanner");
      expect(banner).toMatch(/error=\{minerError\}/);
      expect(banner).toMatch(/info=\{minerInfo\}/);
    });
  }

  it("no payout address blocks START and names the coin", () => {
    const blockedBy = startBlocker({ minersReady: true, payoutAddress: null });
    expect(blockedBy).toBe("address");
    const s = runButtonState({
      mining: false,
      starting: false,
      blockedBy,
      coinTicker: "XEL",
      canOpenSetup: true,
    });
    expect(s.kind).toBe("blocked-address");
    expect(s.disabled).toBe(true);
    expect(s.action).toBeNull();
    expect(s.blockedLabel).toBe("► No XEL payout address");
  });

  it("missing miners outranks a missing address", () => {
    expect(startBlocker({ minersReady: false, payoutAddress: null })).toBe("miners");
    expect(startBlocker({ minersReady: true, payoutAddress: "x" })).toBeNull();
  });

  it("'Set up miners' is live only when the host can open Miner Setup", () => {
    const base = { mining: false, starting: false, blockedBy: "miners" as const, coinTicker: "XMR" };
    expect(runButtonState({ ...base, canOpenSetup: true })).toMatchObject({
      disabled: false,
      action: "setup",
    });
    // PwndaLite passes no onSetup: the state is shown, not offered.
    expect(runButtonState({ ...base, canOpenSetup: false })).toMatchObject({
      disabled: true,
      action: null,
    });
  });

  it("a running lane can always be stopped", () => {
    const s = runButtonState({
      mining: true,
      starting: false,
      blockedBy: "address",
      coinTicker: "XEL",
      canOpenSetup: false,
    });
    expect(s).toMatchObject({ kind: "stop", disabled: false, action: "stop" });
  });

  it("a startable lane starts, and is locked while starting", () => {
    const base = { mining: false, blockedBy: null, coinTicker: "XMR", canOpenSetup: true };
    expect(runButtonState({ ...base, starting: false })).toMatchObject({ action: "start", disabled: false });
    expect(runButtonState({ ...base, starting: true })).toMatchObject({ kind: "starting", disabled: true });
  });
});

describe("#4 lane controls and labels are shared", () => {
  for (const [label, rel] of PRO_VIEWS) {
    it(`${label} renders the shared lane tuning block`, () => {
      const src = code(rel);
      // 2026-09-16 sliders: both PRO views mount ONE block that owns the CPU
      // thread slider, the GPU device picker and the GPU intensity slider.
      expect(src).toContain("<LaneTuningControls");
      expect(src).toContain("laneHasIntensity(");
      // Neither view builds its own copy of a control the block owns.
      expect(src).not.toMatch(/<(LoadSlider|GpuIntensityControl|CpuThreadsControl|GpuDevicePicker)\b/);
      // Portrait's four hand-written buttons are what landscape never got.
      expect(src).not.toMatch(/setGpuIntensity\(\s*"/);
    });

    it(`${label} takes its thread and intensity labels from the lane helpers`, () => {
      const src = code(rel);
      expect(src).toContain("cpuThreadsLabel(");
      expect(src).toContain("laneIntensityLabel(");
      expect(src).not.toMatch(/cpuThreadsPreLaunchLabel|srbCpuThreadsPreLaunchLabel/);
      // Landscape's raw core count, in both of its old spellings.
      expect(src).not.toMatch(/\$\{cpuThreadCount\}/);
    });
  }

  it("landscape PRO hands the block the DISPLAYED lane", () => {
    const [block] = elements(code(LANDSCAPE), "LaneTuningControls");
    expect(block).toBeDefined();
    expect(block).toMatch(/hardware=\{miningHardware\}/);
    expect(block).toMatch(/laneMining=\{isMining\}/);
  });

  it("the block shows the CPU slider only on the CPU lane, and the GPU pair otherwise", () => {
    const src = code("src/features/mining/components/LaneTuningControls.tsx");
    const cpuAt = src.indexOf("<CpuThreadsControl");
    expect(cpuAt).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, cpuAt - 200), cpuAt)).toMatch(/hardware === "cpu"/);
    expect(src).toContain("<GpuDevicePicker");
    expect(src).toContain("<GpuIntensityControl");
    // lolMiner's lane keeps the slider, locked with the reason.
    expect(src).toMatch(/unsupportedReason=\{hasIntensity \? null : LOLMINER_NO_INTENSITY\}/);
  });

  it("SIMPLE uses the shared GPU picker, not its own device list", () => {
    const src = code(SIMPLE);
    expect(src).toContain("<GpuDevicePicker");
    expect(src).not.toMatch(/gpus\.map\(/);
  });

  it("only lolMiner's lane has no intensity control", () => {
    expect(laneHasIntensity("cpu", "octopus")).toBe(true);
    expect(laneHasIntensity("gpu", "octopus")).toBe(false);
    for (const alg of ["kawpow", "autolykos", "progpowz", "xelishashv3"] as const) {
      expect(laneHasIntensity("gpu", alg)).toBe(true);
    }
  });

  it("the GPU lane reports the GPU tier, not the CPU one", () => {
    const args = { miningIntensity: "low" as const, gpuIntensity: "auto" as const };
    expect(laneIntensityLabel({ hardware: "gpu", ...args })).toBe("Auto");
    expect(laneIntensityLabel({ hardware: "cpu", ...args })).toBe("Low");
    expect(laneIntensityLabel({ hardware: "gpu", ...args }, "short")).toBe("AUTO");
  });

  it("the thread label follows the binary that will launch", () => {
    const base = { mining: false, intensity: "medium" as const, cpuThreadCount: 32 };
    expect(cpuThreadsLabel({ ...base, cpuMiner: "xmrig" })).toBe("~16 threads (auto)");
    expect(cpuThreadsLabel({ ...base, cpuMiner: "SRBMiner-MULTI" })).toBe("16 threads");
    expect(
      cpuThreadsLabel({ ...base, mining: true, threadsActive: 12, cpuMiner: "xmrig" }),
    ).toBe("12 threads");
  });
});

describe("#5 xmrig diagnostics are gated on xmrig", () => {
  for (const [label, rel] of PRO_VIEWS) {
    it(`${label} mounts the gated panel, never the raw one`, () => {
      const src = code(rel);
      expect(src).toContain("<XmrigHashrateFix");
      expect(src).not.toContain("HashrateFixPanel");
    });
  }

  it("a XelisHash CPU lane is not offered xmrig fixes", () => {
    const cpuMiner = cpuLaneMiner({ cpuAlgorithm: "xelishashv3" });
    expect(cpuMiner).toBe("SRBMiner-MULTI");
    expect(showsXmrigDiagnostics({ hardware: "cpu", cpuMiner })).toBe(false);
  });

  it("a RandomX CPU lane is, and a GPU lane never is", () => {
    const cpuMiner = cpuLaneMiner({ cpuAlgorithm: "randomx" });
    expect(showsXmrigDiagnostics({ hardware: "cpu", cpuMiner })).toBe(true);
    expect(showsXmrigDiagnostics({ hardware: "gpu", cpuMiner })).toBe(false);
  });

  it("while the lane mines, the backend's answer beats the algorithm state", () => {
    expect(
      cpuLaneMiner({ cpuAlgorithm: "randomx", isMiningCpu: true, runningCpuMiner: "SRBMiner-MULTI" }),
    ).toBe("SRBMiner-MULTI");
    // Idle: a stale running value is ignored.
    expect(
      cpuLaneMiner({ cpuAlgorithm: "randomx", isMiningCpu: false, runningCpuMiner: "SRBMiner-MULTI" }),
    ).toBe("xmrig");
  });
});

describe("(+) one earnings path", () => {
  for (const [label, rel] of VIEWS) {
    it(`${label} prices earnings through useMiningEarnings`, () => {
      const src = code(rel);
      expect(src).toContain("useMiningEarnings(");
      expect(
        src.includes("estimateEarningsForChain("),
        `${label} calls the estimator directly. SIMPLE did, with {} (hardcoded ` +
          "chain constants), and disagreed with PRO about the same session.",
      ).toBe(false);
    });
  }
});

describe("#6 / #7 the layout hosts pass the same mining props", () => {
  for (const [label, rel] of HOSTS) {
    it(`${label} gives Miner Setup the price table`, () => {
      const setups = elements(code(rel), "MinerSetupView");
      expect(setups.length).toBeGreaterThan(0);
      for (const el of setups) expect(el).toContain("pricesByTicker={pricesByTicker}");
    });

    it(`${label} finishes the setup wizard through the shared handler`, () => {
      const wizards = elements(code(rel), "MiningSetupWizard");
      expect(wizards.length).toBeGreaterThan(0);
      for (const el of wizards) {
        expect(el, "every wizard must refresh miner status on the way in").toContain(
          "enableMiningAndOpenSetup(",
        );
        expect(el).toContain("checkMinerStatus");
      }
    });
  }

  it("both Mine views get a Miner Setup route from their host", () => {
    const [landscapeMine] = elements(code(LANDSCAPE_ROOT), "MineLandscapeView");
    const [portraitMine] = elements(code(VIEW_ROUTER), "MiningView");
    for (const el of [landscapeMine, portraitMine]) {
      expect(el).toBeDefined();
      expect(el).toMatch(/onSetup=\{/);
      expect(el).toContain("openMinerSetup(");
    }
  });

  for (const [label, rel] of PRO_VIEWS) {
    it(`${label} hands SIMPLE the address seam and the setup route`, () => {
      const [simple] = elements(code(rel), "MineSimpleView");
      expect(simple).toContain("addressFor={addressFor}");
      expect(simple).toContain("onSetup={onSetup}");
    });
  }

  it("the shared handler enables, refreshes, then navigates — in that order", async () => {
    const calls: string[] = [];
    await enableMiningAndOpenSetup({
      enableMining: async () => {
        calls.push("enable");
      },
      checkMinerStatus: () => calls.push("check"),
      showMinerSetup: () => calls.push("show"),
    });
    expect(calls).toEqual(["enable", "check", "show"]);
  });

  it("a failed opt-in leaves the user where they were", async () => {
    const check = vi.fn();
    const show = vi.fn();
    await expect(
      enableMiningAndOpenSetup({
        enableMining: () => Promise.reject(new Error("store write failed")),
        checkMinerStatus: check,
        showMinerSetup: show,
      }),
    ).rejects.toThrow("store write failed");
    expect(check).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it("opening Miner Setup always refreshes the status first", () => {
    const calls: string[] = [];
    openMinerSetup({
      checkMinerStatus: () => calls.push("check"),
      showMinerSetup: () => calls.push("show"),
    });
    expect(calls).toEqual(["check", "show"]);
  });
});
