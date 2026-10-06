/**
 * The Monero / Zephyr fee estimate's arithmetic (operator request, 2026-10-01:
 * show an estimate that builds nothing instead of rebuilding the transaction
 * for every preview).
 *
 * Pinned three ways: against the C++ it ports (wallet2's `estimate_rct_tx_size`
 * / `estimate_tx_weight` / `calculate_fee_from_weight`, hand-evaluated below),
 * against weights measured on chain on 2026-10-06 (read-only public node RPC,
 * aggregate figures only), and against the replies public nodes gave to
 * `get_fee_estimate` the same day.
 */
import { describe, expect, it } from "vitest";
import {
  MONERO_TYPICAL_SEND_WEIGHT,
  ZEPHYR_TYPICAL_CONVERSION_WEIGHT,
  ZEPHYR_TYPICAL_SEND_WEIGHT,
  daemonFeeRateFrom,
  feeForWeight,
  rctTxWeight,
  typicalFee,
} from "./cryptonote-fee";

describe("rctTxWeight (wallet2's estimate, ported)", () => {
  it("Monero 1-in/2-out is 1,536 and 2-in/2-out 2,215 (the C++, term by term)", () => {
    // 7 + 71·n + 2·38 + 44 + 1 + 643 (BP+, 2 outputs) + 576·n + 2 + 32·n + 16 + 64 + 4
    expect(rctTxWeight({ inputs: 1, outputs: 2, ringSize: 16, extraBytes: 44 })).toBe(1536);
    expect(rctTxWeight({ inputs: 2, outputs: 2, ringSize: 16, extraBytes: 44 })).toBe(2215);
    expect(MONERO_TYPICAL_SEND_WEIGHT).toBe(2215);
  });

  it("a one-output transfer is priced as two, as wallet2 pads it", () => {
    expect(rctTxWeight({ inputs: 2, outputs: 1, ringSize: 16, extraBytes: 44 })).toBe(2215);
  });

  it("Zephyr adds 4 bytes per input and output for the asset tag", () => {
    expect(rctTxWeight({ inputs: 1, outputs: 2, ringSize: 16, extraBytes: 44, assetTagBytes: 4 })).toBe(1548);
    expect(ZEPHYR_TYPICAL_SEND_WEIGHT).toBe(2231);
  });

  it("charges the Bulletproof clawback above two outputs (460 at four)", () => {
    // A Zephyr conversion's shape: 2,450 bytes + 460 = 2,910 by Zephyr's own estimate.
    expect(rctTxWeight({ inputs: 2, outputs: 4, ringSize: 16, extraBytes: 33, assetTagBytes: 4 })).toBe(2910);
  });

  it("lands inside what the chains actually weigh (2026-10-06)", () => {
    // Monero, blocks 3,778,147-3,778,206: 1-in/2-out 1,510-1,603 (n=1,102); 2-in/2-out 2,177-2,234 (n=584).
    expect(rctTxWeight({ inputs: 1, outputs: 2, ringSize: 16, extraBytes: 44 })).toBeGreaterThanOrEqual(1510);
    expect(MONERO_TYPICAL_SEND_WEIGHT).toBeGreaterThanOrEqual(2177);
    expect(MONERO_TYPICAL_SEND_WEIGHT).toBeLessThanOrEqual(2234);
    // Zephyr, blocks 875,501-879,500: 2-in/2-out sends 2,217-2,237 (n=975);
    // 2-in conversions 2,970-2,982 (n=15).
    expect(ZEPHYR_TYPICAL_SEND_WEIGHT).toBeGreaterThanOrEqual(2217);
    expect(ZEPHYR_TYPICAL_SEND_WEIGHT).toBeLessThanOrEqual(2237);
    expect(ZEPHYR_TYPICAL_CONVERSION_WEIGHT).toBeGreaterThanOrEqual(2970);
    expect(ZEPHYR_TYPICAL_CONVERSION_WEIGHT).toBeLessThanOrEqual(2982);
  });
});

describe("feeForWeight (calculate_fee_from_weight)", () => {
  it("multiplies, then rounds UP to the quantization mask", () => {
    expect(feeForWeight(2215, 20_000n, 10_000n)).toBe(44_300_000n);
    expect(feeForWeight(2215, 20_001n, 10_000n)).toBe(44_310_000n); // 44,302,215 rounded up
    expect(feeForWeight(1, 1n, 10_000n)).toBe(10_000n);
  });

  it("treats a mask of 0 as no rounding instead of dividing by zero", () => {
    expect(feeForWeight(3, 7n, 0n)).toBe(21n);
  });
});

describe("daemonFeeRateFrom (the Rust reply)", () => {
  // What public nodes answered on 2026-10-06 (`get_fee_estimate`, grace_blocks 10).
  const MONERO = { fees: [20_000, 80_000, 320_000, 4_000_000], quantization_mask: 10_000 };
  const ZEPHYR = { fees: [210_000, 820_000, 3_300_000, 41_000_000], quantization_mask: 10_000 };

  it("reads both networks' live replies", () => {
    expect(daemonFeeRateFrom(MONERO)).toEqual({
      perByte: [20_000n, 80_000n, 320_000n, 4_000_000n],
      quantizationMask: 10_000n,
    });
    expect(daemonFeeRateFrom(ZEPHYR).perByte[0]).toBe(210_000n);
  });

  it("prices a typical send: 0.0000443 XMR usually, 0.0001772 when the network is busy", () => {
    expect(typicalFee(daemonFeeRateFrom(MONERO), MONERO_TYPICAL_SEND_WEIGHT)).toEqual({
      usual: 44_300_000n,
      busy: 177_200_000n,
    });
    expect(typicalFee(daemonFeeRateFrom(ZEPHYR), ZEPHYR_TYPICAL_SEND_WEIGHT)).toEqual({
      usual: 468_510_000n,
      busy: 1_829_420_000n,
    });
  });

  it("a node that reports one rate gives an estimate with no busy figure", () => {
    expect(typicalFee(daemonFeeRateFrom({ fees: [20_000], quantization_mask: 10_000 }), 2215)).toEqual({
      usual: 44_300_000n,
      busy: null,
    });
  });

  it.each([
    ["nothing", undefined],
    ["no fees", { quantization_mask: 10_000 }],
    ["an empty list", { fees: [], quantization_mask: 10_000 }],
    ["a zero rate", { fees: [0, 80_000], quantization_mask: 10_000 }],
    ["a fractional rate", { fees: [20_000.5], quantization_mask: 10_000 }],
    ["a string rate", { fees: ["20000"], quantization_mask: 10_000 }],
    ["a zero mask", { fees: [20_000], quantization_mask: 0 }],
    ["no mask", { fees: [20_000] }],
  ])("refuses %s rather than estimating from it", (_label, raw) => {
    expect(() => daemonFeeRateFrom(raw)).toThrow(/no usable/);
  });
});
