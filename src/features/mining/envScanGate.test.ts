/**
 * 2026-09-25: the Mining view's Defender-check storm (a PowerShell every ~2.5 s)
 * and the UAC prompt on every mining start. See envScanGate.ts and
 * PwndaWalletVault/log.md 2026-09-25.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldAutoScanEnv, shouldPromptDefender } from "./envScanGate";

describe("shouldAutoScanEnv", () => {
  const base = { focus: "mining", hasPlan: false, scanning: false, attempted: false };

  it("scans once on the Mining tab", () => {
    expect(shouldAutoScanEnv(base)).toBe(true);
  });

  it("does not retry after an attempt — a failing scan must not loop", () => {
    // The loop: plan still null, scanning back to false after a failure.
    expect(shouldAutoScanEnv({ ...base, attempted: true })).toBe(false);
  });

  it("not while one is running, not with a plan, not off the Mining tab", () => {
    expect(shouldAutoScanEnv({ ...base, scanning: true })).toBe(false);
    expect(shouldAutoScanEnv({ ...base, hasPlan: true })).toBe(false);
    expect(shouldAutoScanEnv({ ...base, focus: "miner-setup" })).toBe(false);
    expect(shouldAutoScanEnv({ ...base, focus: "other" })).toBe(false);
  });
});

describe("shouldPromptDefender", () => {
  const base = { supported: true, excluded: false as boolean | null, declinedThisSession: false };

  it("asks when the exclusion is not known to be in place", () => {
    expect(shouldPromptDefender(base)).toBe(true);
    expect(shouldPromptDefender({ ...base, excluded: null })).toBe(true);
  });

  it("never asks once it is confirmed — the prompt on every start", () => {
    expect(shouldPromptDefender({ ...base, excluded: true })).toBe(false);
  });

  it("asks at most once per session after a decline, and never off Windows", () => {
    expect(shouldPromptDefender({ ...base, declinedThisSession: true })).toBe(false);
    expect(shouldPromptDefender({ ...base, supported: false })).toBe(false);
  });
});

describe("useMiner wiring (structural)", () => {
  const src = readFileSync(resolve(__dirname, "useMiner.ts"), "utf8").replace(/\r\n/g, "\n");

  it("the miner/Defender status check depends on focus only, not on scan state", () => {
    const at = src.indexOf("checkMinerStatus();\n      invoke<number>(\"get_cpu_thread_count\")");
    expect(at).toBeGreaterThan(-1);
    const deps = src.slice(at, src.indexOf("]);", at) + 3);
    expect(deps).toMatch(/\}, \[focus, checkMinerStatus\]\);$/);
  });

  it("the automatic env scan goes through the once-per-session gate", () => {
    expect(src).toContain("shouldAutoScanEnv({");
    expect(src).not.toMatch(/if \(focus === "mining" && !hashrateFixPlan && !scanningEnv\)/);
  });

  it("the mining start asks through the prompt gate", () => {
    expect(src).toContain("shouldPromptDefender({");
  });
});
