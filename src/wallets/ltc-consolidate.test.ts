/**
 * The consolidation PLANNER — every case here is a refusal, because the
 * refusals are the whole safety surface.
 *
 * `consolidateLtcAccount` itself signs and broadcasts, so it is not unit-
 * tested here (it would need a signing fixture and three mocked explorers).
 * What IS testable, and what actually protects the user, is the pure decision
 * in front of it: whether a consolidation should happen at all. Each `blocked`
 * branch below corresponds to a way an automatic or careless sweep would cost
 * someone money — which is why every surveyed wallet keeps consolidation
 * manual (see `planLtcConsolidation`'s own doc for the survey).
 */
import { describe, it, expect } from "vitest";
import {
  planLtcConsolidation,
  estimateConsolidationVBytes,
  type ConsolidationInput,
} from "./ltc-wallet";

const DEST = "ltc1qdestination000000000000000000000000";

function src(
  index: number,
  balanceSat: number,
  chainIndex: 0 | 1 = 1,
  address?: string,
): ConsolidationInput {
  return {
    path: `m/84'/2'/0'/${chainIndex}/${index}`,
    address: address ?? `ltc1qsource${chainIndex}x${index}`,
    chainIndex,
    index,
    balanceSat,
  };
}

describe("planLtcConsolidation — the refusals", () => {
  it("REFUSES while a swap is in flight, ahead of every other check", () => {
    // The one genuinely destructive case: those outputs may be committed to a
    // running swap. It must outrank even "nothing to do", so the user is told
    // the real reason rather than a cosmetic one.
    const plan = planLtcConsolidation({
      destination: DEST,
      entries: [src(1, 500_000), src(20, 402_888_049)],
      feePerVB: 5,
      swapInFlight: true,
    });
    expect(plan.blocked).toMatch(/swap is still running/i);
  });

  it("REFUSES when everything already sits at the destination", () => {
    const plan = planLtcConsolidation({
      destination: DEST,
      entries: [src(0, 900_000, 0, DEST)],
      feePerVB: 5,
    });
    expect(plan.sources).toHaveLength(0);
    expect(plan.blocked).toMatch(/already at your main address/i);
  });

  it("REFUSES a single-output sweep — that is a fee for no structural gain", () => {
    const plan = planLtcConsolidation({
      destination: DEST,
      entries: [src(20, 402_888_049)],
      feePerVB: 5,
    });
    expect(plan.blocked).toMatch(/only one address/i);
  });

  it("REFUSES when the fee would eat the whole amount", () => {
    // Two dust outputs at an absurd fee rate: the arithmetic, not a guess.
    const plan = planLtcConsolidation({
      destination: DEST,
      entries: [src(1, 800), src(2, 800)],
      feePerVB: 500,
    });
    expect(plan.netSat).toBeLessThanOrEqual(546);
    expect(plan.blocked).toMatch(/fee would consume/i);
  });

  it("never spends the destination's own output back into itself", () => {
    const plan = planLtcConsolidation({
      destination: DEST,
      entries: [src(0, 1_000_000, 0, DEST), src(1, 500_000), src(20, 402_888_049)],
      feePerVB: 2,
    });
    expect(plan.sources.map((s) => s.address)).not.toContain(DEST);
    expect(plan.totalSat).toBe(500_000 + 402_888_049);
  });
});

describe("planLtcConsolidation — the happy path", () => {
  it("allows a real multi-address consolidation and reports honest arithmetic", () => {
    const plan = planLtcConsolidation({
      destination: DEST,
      entries: [src(1, 500_000), src(20, 402_888_049), src(3, 250_000, 0)],
      feePerVB: 2,
    });
    expect(plan.blocked).toBeNull();
    expect(plan.sources).toHaveLength(3);
    // Largest first — fewer inputs survive if a caller ever truncates.
    expect(plan.sources[0].balanceSat).toBe(402_888_049);
    expect(plan.totalSat).toBe(500_000 + 402_888_049 + 250_000);
    expect(plan.feeSat).toBe(Math.ceil(2 * estimateConsolidationVBytes(3)));
    expect(plan.netSat).toBe(plan.totalSat - plan.feeSat);
  });

  it("ignores zero-balance addresses — used-but-empty is not a source", () => {
    const plan = planLtcConsolidation({
      destination: DEST,
      entries: [src(0, 0, 0), src(1, 500_000), src(20, 402_888_049)],
      feePerVB: 2,
    });
    expect(plan.sources).toHaveLength(2);
  });
});

describe("estimateConsolidationVBytes", () => {
  it("grows per input and matches the P2WPKH shape", () => {
    // 11 overhead + 68/input + 31 for the single output.
    expect(estimateConsolidationVBytes(1)).toBe(110);
    expect(estimateConsolidationVBytes(5)).toBe(382);
    expect(
      estimateConsolidationVBytes(6) - estimateConsolidationVBytes(5),
    ).toBe(68);
  });
});
