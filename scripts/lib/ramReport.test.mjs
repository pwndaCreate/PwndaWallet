// scripts/lib/ramReport.test.mjs — pins scripts/lib/ram-report.mjs, the RAM
// plan Phase 4 reader. Two cases below are real mistakes the first version of
// the report made on real sessions (2026-09-26), kept so they stay fixed.

import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLES_TO_JUDGE,
  configOf,
  coveredHours,
  metricsOf,
  parseSession,
  slopePerHour,
  summarize,
  verdicts,
} from "./ram-report.mjs";

const MIN = 60_000;

/** A mem_watch sample. `roles`/`commit` are MB by role; `names` are MB by process. */
function sample(t, { roles = {}, commit = null, names = {} } = {}) {
  const byRole = { webviewMb: 0, walletRpcMb: 0, swapNodeMb: 0, otherMb: 0, minersMb: 0, ...roles };
  const s = {
    t,
    treeMb: Object.values(byRole).reduce((a, b) => a + b, 0),
    byRole,
    byName: Object.entries(names).map(([name, mb]) => ({ name, mb, count: 1 })),
  };
  if (commit) {
    const commitByRole = { webviewMb: 0, walletRpcMb: 0, swapNodeMb: 0, otherMb: 0, minersMb: 0, ...commit };
    s.commitByRole = commitByRole;
    s.treeCommitMb = Object.values(commitByRole).reduce((a, b) => a + b, 0);
  }
  return s;
}

const run = (n, make, start = 0) => Array.from({ length: n }, (_, i) => make(start + i * MIN));

describe("configOf", () => {
  it("reads the configuration from which roles are present", () => {
    expect(configOf(sample(0, { roles: { webviewMb: 300 } }))).toEqual({ base: "none", mining: false });
    expect(configOf(sample(0, { roles: { walletRpcMb: 200 } }))).toEqual({ base: "wallet", mining: false });
    expect(configOf(sample(0, { roles: { walletRpcMb: 200, swapNodeMb: 1500 } }))).toEqual({ base: "swap", mining: false });
    expect(configOf(sample(0, { roles: { swapNodeMb: 1500, minersMb: 300 } }))).toEqual({ base: "swap", mining: true });
  });
  it("skips a sample written before per-role data existed", () => {
    expect(configOf({ t: 0, treeMb: 900 })).toBeNull();
  });
});

describe("metricsOf", () => {
  it("excludes miners always, and particld exactly on working set", () => {
    const m = metricsOf(sample(0, { roles: { webviewMb: 229, walletRpcMb: 379, swapNodeMb: 1484, otherMb: 125, minersMb: 238 }, names: { "particld.exe": 1428 } }));
    expect(m.ws).toBe(229 + 379 + 1484 + 125);
    expect(m.wsExParticld).toBe(229 + 379 + 1484 + 125 - 1428);
  });
  it("estimates committed-excluding-particld as the swap-node role minus python", () => {
    // The 2026-09-26 22:19 session's medians.
    const m = metricsOf(
      sample(0, {
        roles: { swapNodeMb: 1484, minersMb: 238 },
        commit: { webviewMb: 282, walletRpcMb: 539, swapNodeMb: 912, otherMb: 39, minersMb: 2346 },
        names: { "particld.exe": 1428, "python.exe": 57 },
      }),
    );
    expect(m.commit).toBe(282 + 539 + 912 + 39);
    expect(m.commitExParticld).toBe(282 + 539 + 39 + 57);
  });
});

describe("verdicts", () => {
  it("judges on committed memory when the session has it, and says so", () => {
    // Working set far over the limit (not trimmed yet), committed under it.
    const ss = run(20, (t) => sample(t, { roles: { webviewMb: 900 }, commit: { webviewMb: 270 } }));
    const [v] = verdicts(summarize(ss));
    expect(v).toMatchObject({ config: "none", metric: "committed", medianMb: 270, pass: true });
  });

  it("judges the swap node target WITHOUT particld (restated 2026-09-26)", () => {
    const ss = run(20, (t) =>
      sample(t, {
        roles: { webviewMb: 229, walletRpcMb: 379, swapNodeMb: 1484, otherMb: 125 },
        commit: { webviewMb: 282, walletRpcMb: 539, swapNodeMb: 912, otherMb: 39 },
        names: { "particld.exe": 1428, "python.exe": 57 },
      }),
    );
    const v = verdicts(summarize(ss)).find((x) => x.config === "swap");
    expect(v).toMatchObject({ metric: "committed", medianMb: 282 + 539 + 39 + 57, pass: true });
  });

  // Real mistake #1: the 22:19 session has ONE `wallet` sample (the minute
  // between unlock and the swap node starting) and the first version judged
  // it "❌ 744 MB" as if someone had run that configuration.
  it("never judges a transition", () => {
    const ss = [
      ...run(MIN_SAMPLES_TO_JUDGE, (t) => sample(t, { roles: { webviewMb: 250 } })),
      sample(MIN_SAMPLES_TO_JUDGE * MIN, { roles: { webviewMb: 600, walletRpcMb: 200 } }),
    ];
    const v = verdicts(summarize(ss)).find((x) => x.config === "wallet");
    expect(v.pass).toBeNull();
    expect(v.why).toMatch(/transition/);
  });

  // Real mistake #2: on the 2026-09-24 session (working set only) the first
  // version reported mining overhead as -914 MB, "✅" — WebView2's working set
  // had been trimmed on blur during the mining window. Mining costs nothing
  // like -914 MB; the figure measured focus, not memory.
  it("leaves WebView2 out of a working-set mining comparison", () => {
    const idle = run(30, (t) => sample(t, { roles: { webviewMb: 1928, walletRpcMb: 257, swapNodeMb: 1589, otherMb: 512 } }));
    const mining = run(30, (t) => sample(t, { roles: { webviewMb: 1040, walletRpcMb: 257, swapNodeMb: 1594, otherMb: 519, minersMb: 310 } }), 30 * MIN);
    const v = verdicts(summarize([...idle, ...mining])).find((x) => x.config === "swap+mining");
    expect(v.metric).toBe("working set, WebView2 excluded");
    expect(v.medianMb).toBe(12);
    expect(v.pass).toBe(true);
  });

  it("compares mining on committed memory when both sides have it", () => {
    const idle = run(20, (t) => sample(t, { roles: { swapNodeMb: 1500 }, commit: { webviewMb: 260, swapNodeMb: 900 } }));
    const mining = run(20, (t) => sample(t, { roles: { swapNodeMb: 1500, minersMb: 300 }, commit: { webviewMb: 400, swapNodeMb: 900, minersMb: 2300 } }), 20 * MIN);
    const v = verdicts(summarize([...idle, ...mining])).find((x) => x.config === "swap+mining");
    expect(v).toMatchObject({ metric: "committed", medianMb: 140, pass: false });
  });

  it("does not judge mining with no idle stretch of the same configuration", () => {
    const ss = run(20, (t) => sample(t, { roles: { swapNodeMb: 1500, minersMb: 300 } }));
    const v = verdicts(summarize(ss)).find((x) => x.config === "swap+mining");
    expect(v.pass).toBeNull();
    expect(v.why).toMatch(/no idle stretch/);
  });
});

describe("time", () => {
  it("counts covered hours without the gaps where the app was closed", () => {
    const ss = [...run(61, (t) => sample(t)), ...run(61, (t) => sample(t), 10 * 3_600_000)];
    expect(coveredHours(ss)).toBeCloseTo(2, 5);
  });
  it("fits a slope in MB per hour", () => {
    const pts = Array.from({ length: 121 }, (_, i) => ({ t: i * MIN, y: 20 + (100 * i) / 60 }));
    expect(slopePerHour(pts)).toBeCloseTo(100, 5);
    expect(slopePerHour(pts.slice(0, 5))).toBeNull();
  });
});

describe("parseSession", () => {
  it("tolerates the torn last line of a live session and sorts by time", () => {
    const text = [JSON.stringify(sample(2 * MIN)), JSON.stringify(sample(MIN)), '{"t":3,"treeM'].join("\r\n");
    const ss = parseSession(text);
    expect(ss.map((s) => s.t)).toEqual([MIN, 2 * MIN]);
  });
});
