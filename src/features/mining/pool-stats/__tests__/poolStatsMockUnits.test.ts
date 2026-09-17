/**
 * The sandbox's `fetch_pool_stats` mock must speak the same units as the
 * Rust parsers it stands in for: balances as ATOMIC digit strings.
 *
 * Found 2026-09-16. The `xelis_mining_active` mock returned whole-coin
 * strings ("0.41822"), and its comment said that was what
 * `pool_stats.rs::parse_k1pool_miner` returns. It isn't: that parser returns
 * "41822000" (see `k1pool_tests`). `formatAtomic` therefore rendered the
 * K1Pool panel as
 *
 *     PENDING 0.000418 XEL · min 0 XEL · MATURING 0.000378 XEL
 *
 * The `mining_active_24hr` XMR branch had the same fault and rendered "0".
 * Nobody saw the XEL case because the panel needs an XEL address, which
 * this scenario only has after the Xelis wallet has been opened once.
 *
 * These go through `getMock`, the dispatcher the sandbox really uses.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { formatAtomic } from "../format";
import type { MinerStats } from "../types";

async function statsFor(scenario: string, poolId: string): Promise<MinerStats | null> {
  vi.stubEnv("VITE_MOCK_STATE", scenario);
  const { getMock } = await import("../../../../lib/tauri-mocks");
  return getMock<MinerStats | null>("fetch_pool_stats", { poolId, address: "addr" });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const ATOMIC = /^\d+$/;

function expectAtomic(s: MinerStats) {
  for (const k of ["pendingBalance", "immatureBalance", "totalPaid", "payoutThreshold"] as const) {
    const v = s[k];
    if (v !== null) expect(v, k).toMatch(ATOMIC);
  }
}

describe("fetch_pool_stats mock — atomic units, as the Rust parsers return", () => {
  it("K1Pool XEL renders the whole-coin numbers the mock means", async () => {
    const s = (await statsFor("xelis_mining_active", "k1pool-xelis-cpu"))!;
    expectAtomic(s);
    expect(formatAtomic(s.pendingBalance, "xelis")).toBe("0.41822");
    expect(formatAtomic(s.immatureBalance, "xelis")).toBe("0.37876");
    expect(formatAtomic(s.totalPaid, "xelis")).toBe("2.59861");
    expect(formatAtomic(s.payoutThreshold, "xelis")).toBe("3");
  });

  it("Pwnda XEL has its own shape: balances, hashrate, and nothing it doesn't publish", async () => {
    const s = (await statsFor("xelis_mining_active", "pwnda-xelis"))!;
    expectAtomic(s);
    expect(formatAtomic(s.pendingBalance, "xelis")).toBe("0.0412");
    expect(formatAtomic(s.immatureBalance, "xelis")).toBe("0.00731");
    expect(formatAtomic(s.totalPaid, "xelis")).toBe("1.25");
    expect(formatAtomic(s.payoutThreshold, "xelis")).toBe("0.05");
    expect(s.hashrate24h).toBeNull();
    expect(s.lastShare).toBeNull();
    expect(s.workersOnline).toBeNull();
  });

  it("the CPU (XMR/ZEPH) mining scenario renders non-zero balances", async () => {
    const s = (await statsFor("mining_active_24hr", "hashvault-monero"))!;
    expectAtomic(s);
    expect(formatAtomic(s.pendingBalance, "monero")).toBe("0.00231");
    expect(formatAtomic(s.payoutThreshold, "monero")).toBe("0.005");
  });
});
