/**
 * Legacy→modern LTC migration: the planner and the derived destination.
 *
 * The two silent money bugs the planner tests exist for: an underestimated
 * size becomes a stuck low-fee transaction, and a missed dust check becomes a
 * sweep that burns most of a tiny balance as fees without asking. The
 * destination test pins that the migration target is DERIVED — the same
 * BIP-84 vector three other implementations in this repo already assert
 * (`derivation-paths.test.ts`, `scripts/swap/verify-account-key-patches.py`,
 * `swapAccountKey.test.ts`) — because a typo there sends the user's whole LTC
 * balance to a valid-looking address nobody owns.
 */
import { describe, it, expect } from "vitest";
import {
  planLegacyLtcSweep,
  modernLtcAddressFromMnemonic,
  type LegacySweepUtxo,
} from "./ltc-wallet";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const utxo = (value: number, i = 0): LegacySweepUtxo => ({
  txid: `${"ab".repeat(31)}${String(i).padStart(2, "0")}`,
  vout: i,
  value,
});

describe("modernLtcAddressFromMnemonic — the destination is derived, never typed", () => {
  it("matches the published BIP-84 LTC vector", () => {
    // ltc1qjmxnz78… is what ltc-wallet's own adapter, the engine-side suite,
    // and swapAccountKey all derive for this mnemonic. Four implementations,
    // one constant.
    expect(modernLtcAddressFromMnemonic(MNEMONIC)).toBe(
      "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh",
    );
  });
});

describe("planLegacyLtcSweep", () => {
  it("sweeps every input — nothing stays at the legacy address", () => {
    const coins = [utxo(100_000_000, 0), utxo(50_000_000, 1), utxo(3_000_000, 2)];
    const plan = planLegacyLtcSweep(coins, 10);
    expect(plan.inputs).toHaveLength(3);
    expect(plan.sendValue + plan.fee).toBe(153_000_000);
  });

  it("sizes P2PKH inputs at legacy weight, not segwit weight", () => {
    // 1 input: 10 + 148 + 31 + 20 = 209 vB. A segwit-sized estimate (~129)
    // would underpay by ~40% and strand the sweep in the mempool.
    const plan = planLegacyLtcSweep([utxo(10_000_000)], 10);
    expect(plan.estimatedVBytes).toBe(209);
    expect(plan.fee).toBe(2_090);
  });

  it("fee scales with input count", () => {
    const one = planLegacyLtcSweep([utxo(10_000_000)], 10);
    const three = planLegacyLtcSweep(
      [utxo(10_000_000, 0), utxo(10_000_000, 1), utxo(10_000_000, 2)],
      10,
    );
    expect(three.fee - one.fee).toBe(2 * 148 * 10);
  });

  it("refuses a balance that dust+fee would consume", () => {
    // 2500 lits minus the ~2090-lit fee leaves 410 — under the 546 dust
    // floor. Sweeping would burn 84% of the balance as fees. Refusal, not a
    // silent tiny send.
    expect(() => planLegacyLtcSweep([utxo(2_500)], 10)).toThrow(/dust/i);
    // And just ABOVE the line it goes through — pinning the boundary, not
    // merely one side of it.
    expect(planLegacyLtcSweep([utxo(2_700)], 10).sendValue).toBe(610);
  });

  it("refuses an empty input set and a nonsense fee rate", () => {
    expect(() => planLegacyLtcSweep([], 10)).toThrow(/no spendable/i);
    expect(() => planLegacyLtcSweep([utxo(10_000_000)], 0)).toThrow(/fee rate/i);
    expect(() => planLegacyLtcSweep([utxo(10_000_000)], NaN)).toThrow(/fee rate/i);
    expect(() => planLegacyLtcSweep([utxo(10_000_000)], -3)).toThrow(/fee rate/i);
  });

  it("the operator's actual case: 4.33 LTC in one coin clears easily", () => {
    const plan = planLegacyLtcSweep([utxo(432_890_000)], 10);
    expect(plan.sendValue).toBe(432_890_000 - 2_090);
    // Fee under a cent at any plausible LTC price.
    expect(plan.fee / 1e8).toBeLessThan(0.0001);
  });
});
