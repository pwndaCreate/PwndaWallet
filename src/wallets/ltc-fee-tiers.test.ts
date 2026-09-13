/**
 * LTC fee tiers, 2026-09-12. Every LTC fee decision fell back to a hardcoded
 * 10 sat/vB because BlockCypher answered `429 {"error": "Limits reached."}` and
 * the second source was litecoinspace `/fee-estimates`, which that mempool.space
 * instance answers with `404 endpoint does not exist "/fee-estimates"`. The
 * working endpoint is `/v1/fees/recommended`; these pin each parser against the
 * shapes the sources actually return.
 *
 * Later the same day the operator's send still used the DEFAULT: litecoinspace
 * `/v1/fees/recommended` was `503 Service Unavailable` while BlockCypher was
 * `429`. Bitcore became the third source — its parser is pinned below.
 */
import { describe, it, expect } from "vitest";
import {
  parseBitcoreFeeTiers,
  parseBlockcypherTiers,
  parseMempoolRecommended,
  LTC_DEFAULT_FEE_RATE,
  LTC_TYPICAL_TX_VBYTES,
} from "./ltc-wallet";

describe("parseMempoolRecommended (litecoinspace /v1/fees/recommended)", () => {
  it("reads the tiers from the live response shape", () => {
    // Captured from litecoinspace.org on 2026-09-12.
    const live = { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
    expect(parseMempoolRecommended(live)).toEqual({ slow: 1, normal: 1, fast: 1 });
  });

  it("rounds fractional rates up, never below 1 sat/vB", () => {
    expect(parseMempoolRecommended({ fastestFee: 3.2, halfHourFee: 2.01, hourFee: 0.4 })).toEqual({
      slow: 1,
      normal: 3,
      fast: 4,
    });
  });

  it("throws on the old esplora /fee-estimates shape instead of guessing", () => {
    expect(() => parseMempoolRecommended({ "1": 2, "6": 1 })).toThrow(/tiers missing/);
  });
});

describe("parseBitcoreFeeTiers (Bitcore /api/LTC/mainnet/fee/<blocks>)", () => {
  it("reads the live response: 0.00001 LTC/kB is 1 sat/vB, not 2", () => {
    // Captured from api.bitcore.io on 2026-09-12 for targets 12, 6 and 2.
    // 0.00001 * 1e8 is 1000.0000000000001 in floating point — ceil'ing that
    // without rounding to whole litoshis first would report 2 sat/vB.
    const r = (blocks: number) => ({ feerate: 0.00001, blocks });
    expect(parseBitcoreFeeTiers(r(12), r(6), r(2))).toEqual({ slow: 1, normal: 1, fast: 1 });
  });

  it("converts LTC/kB to sat/vB and rounds up", () => {
    expect(
      parseBitcoreFeeTiers({ feerate: 0.00001 }, { feerate: 0.0000234 }, { feerate: 0.0001 }),
    ).toEqual({ slow: 1, normal: 3, fast: 10 });
  });

  it("throws when a target cannot be estimated", () => {
    expect(() =>
      parseBitcoreFeeTiers({ feerate: -1 }, { feerate: 0.00001 }, { feerate: 0.00001 }),
    ).toThrow(/no usable slow feerate/);
    expect(() => parseBitcoreFeeTiers({ feerate: 0.00001 }, null, {})).toThrow(/bitcore/);
  });
});

describe("parseBlockcypherTiers (BlockCypher chain info)", () => {
  it("converts satoshi per kB to sat/vB", () => {
    expect(
      parseBlockcypherTiers({ low_fee_per_kb: 1000, medium_fee_per_kb: 2500, high_fee_per_kb: 9000 }),
    ).toEqual({ slow: 1, normal: 3, fast: 9 });
  });

  it("throws on the 429 body, which carries no tiers", () => {
    expect(() => parseBlockcypherTiers({ error: "Limits reached." })).toThrow(/tiers missing/);
  });
});

it("the typical LTC send size is the 1-in / 2-out P2WPKH figure", () => {
  // 11 overhead + 68 input + 2 × 31 output (P2WPKH_SIZING).
  expect(LTC_TYPICAL_TX_VBYTES).toBe(141);
  expect(LTC_DEFAULT_FEE_RATE).toBeGreaterThanOrEqual(1);
});
