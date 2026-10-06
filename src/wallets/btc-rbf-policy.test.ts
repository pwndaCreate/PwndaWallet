/**
 * The replacement rules a BTC speed-up keeps (operator request, 2026-10-01).
 * Pure numbers: what a transaction signals, how big a replacement can be once
 * signed, the least it may pay, and how the extra fee comes out of the change.
 * The end-to-end replacement is in `btc-rbf.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  BTC_RBF_SEQUENCE,
  INCREMENTAL_RELAY_SAT_PER_VB,
  minimumReplacementFeeSat,
  planBtcFeeBump,
  replacementRuleViolation,
  signalsRbf,
  signedVsizeUpperBound,
} from "./btc-rbf-policy";
import { P2PKH_SIZING, P2SH_P2WPKH_SIZING, P2WPKH_SIZING } from "./utxo-account";

describe("BIP125 signalling", () => {
  it("0xfffffffd signals; 0xfffffffe and 0xffffffff (bitcoinjs-lib's default) do not", () => {
    expect(BTC_RBF_SEQUENCE).toBe(0xfffffffd);
    expect(signalsRbf([0xffffffff])).toBe(false);
    expect(signalsRbf([0xfffffffe])).toBe(false);
    expect(signalsRbf([0xfffffffd])).toBe(true);
    expect(signalsRbf([0])).toBe(true);
  });

  it("one signalling input is enough (BIP125: any input)", () => {
    expect(signalsRbf([0xffffffff, 0xfffffffd])).toBe(true);
    expect(signalsRbf([])).toBe(false);
  });

  it("0xfffffffd has BIP68's disable bit set: no relative lock time comes with it", () => {
    expect(BTC_RBF_SEQUENCE & 0x80000000).not.toBe(0);
  });
});

describe("signedVsizeUpperBound: the most a signed transaction can weigh", () => {
  it("agrees with the send planner's sizing for each input type (68 / 91 / 148 vB)", () => {
    const two = (k: "p2wpkh" | "p2sh-p2wpkh" | "p2pkh") => signedVsizeUpperBound([k, k], [22]);
    const one = (k: "p2wpkh" | "p2sh-p2wpkh" | "p2pkh") => signedVsizeUpperBound([k], [22]);
    expect(two("p2wpkh") - one("p2wpkh")).toBe(P2WPKH_SIZING.inputVB);
    expect(two("p2sh-p2wpkh") - one("p2sh-p2wpkh")).toBe(P2SH_P2WPKH_SIZING.inputVB);
    expect(two("p2pkh") - one("p2pkh")).toBe(P2PKH_SIZING.inputVB);
  });

  it("one P2WPKH input, two P2WPKH outputs: 141 vB, the BTC estimate's typical size", () => {
    expect(signedVsizeUpperBound(["p2wpkh"], [22, 22])).toBe(141);
  });

  it("a legacy-only transaction carries no witness at all; a mixed one gives the legacy input an empty one", () => {
    // 10 + 148 + 34 = 192 vB for one P2PKH input and one P2PKH output.
    expect(signedVsizeUpperBound(["p2pkh"], [25])).toBe(192);
    const mixed = signedVsizeUpperBound(["p2pkh", "p2wpkh"], [22]);
    const witnessOnly = signedVsizeUpperBound(["p2wpkh"], [22]);
    // 148 more for the legacy input, plus its empty-stack byte (0.25 vB, rounded up with the rest).
    expect(mixed - witnessOnly).toBeGreaterThanOrEqual(148);
    expect(mixed - witnessOnly).toBeLessThanOrEqual(149);
  });
});

describe("minimumReplacementFeeSat: rules 3, 4 and 6", () => {
  it("rule 4 decides at a low rate: the original's fee plus 1 sat per replacement vbyte", () => {
    expect(INCREMENTAL_RELAY_SAT_PER_VB).toBe(1);
    // 2 sat/vB × 141 = 282; +141 = 423, and 423/141 = 3 > 2.
    expect(minimumReplacementFeeSat(282, 141, 141)).toBe(423);
  });

  it("rule 6 decides when the replacement is larger than the original at a high rate", () => {
    // 100 sat/vB on 140 vB = 14 000; a 142 vB replacement needs more than
    // 14 000 × 142/140 = 14 200 (rule 6), while rule 4 asks only 14 142.
    expect(minimumReplacementFeeSat(14_000, 140, 142)).toBe(14_201);
  });
});

describe("planBtcFeeBump: the extra fee comes out of the change, never below dust", () => {
  const base = { originalFeeSat: 282, originalVsize: 141, replacementVsize: 141, changeValueSat: 999_718, dustSat: 546 };

  it("pays the target rate when it is above the minimum", () => {
    const r = planBtcFeeBump({ ...base, targetRate: 14 });
    expect(r).toEqual({
      ok: true,
      plan: { minimumFeeSat: 423, newFeeSat: 1974, extraFeeSat: 1692, newChangeSat: 998_026, atMinimum: false },
    });
  });

  it("pays the minimum when the target is below it, or absent", () => {
    const low = planBtcFeeBump({ ...base, targetRate: 2 });
    expect(low.ok && low.plan).toMatchObject({ newFeeSat: 423, extraFeeSat: 141, atMinimum: true });
    const none = planBtcFeeBump({ ...base, targetRate: null });
    expect(none.ok && none.plan).toMatchObject({ newFeeSat: 423, atMinimum: true });
  });

  it("refuses when the change would be left at or below dust; one satoshi more is enough", () => {
    // Extra fee at 14 sat/vB is 1692: change of 546 + 1692 leaves exactly 546.
    const atDust = planBtcFeeBump({ ...base, changeValueSat: 546 + 1692, targetRate: 14 });
    expect(atDust).toMatchObject({ ok: false, reason: "dust", extraFeeSat: 1692, changeSat: 2238 });
    const above = planBtcFeeBump({ ...base, changeValueSat: 547 + 1692, targetRate: 14 });
    expect(above.ok && above.plan.newChangeSat).toBe(547);
  });

  it("refuses nonsense sizes instead of planning on them", () => {
    expect(() => planBtcFeeBump({ ...base, originalVsize: 0 })).toThrow(/originalVsize/);
    expect(() => planBtcFeeBump({ ...base, changeValueSat: 1.5 })).toThrow(/changeValueSat/);
  });

  it("a fractional rate is priced without float noise", () => {
    // 2.3 × 100 is 229.99999999999997 in floating point.
    const r = planBtcFeeBump({ ...base, originalFeeSat: 100, originalVsize: 100, replacementVsize: 100, targetRate: 2.3 });
    expect(r.ok && r.plan.newFeeSat).toBe(230);
  });
});

describe("replacementRuleViolation: the signed replacement, checked on its real size", () => {
  const ok = { originalFeeSat: 282, originalVsize: 141, replacementFeeSat: 1974, replacementVsize: 141 };

  it("passes a replacement that keeps every rule", () => {
    expect(replacementRuleViolation(ok)).toBeNull();
  });

  it("names rule 3, 4 or 6, whichever it breaks", () => {
    expect(replacementRuleViolation({ ...ok, replacementFeeSat: 282 })).toMatch(/rule 3/);
    expect(replacementRuleViolation({ ...ok, replacementFeeSat: 282 + 140 })).toMatch(/rule 4/);
    expect(
      replacementRuleViolation({ originalFeeSat: 14_000, originalVsize: 140, replacementFeeSat: 14_200, replacementVsize: 142 }),
    ).toMatch(/rule 6/);
  });
});
