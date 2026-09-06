/**
 * The fee-reserve rule, pinned against `FEE.md` and `sidecar_fees/schedule.rs`.
 *
 * The case that mattered on 2026-09-05: the operator took an offer selling
 * 0.05 BCH for XMR. Chargeable — scripted leg sent, scriptless leg received,
 * taker, completed. Had they pressed MAX with fees on, the whole balance would
 * have gone into the swap and the fee could never have been collected.
 */
import { describe, it, expect } from "vitest";
import {
  FEE_SCRIPTED_TICKERS,
  SCRIPTLESS_TICKERS,
  feeAppliesToSend,
  spendableAfterReserve,
} from "./feeReserve";

describe("feeAppliesToSend", () => {
  it("is true only for a P2P swap sending a scripted leg for a scriptless one", () => {
    expect(feeAppliesToSend({ router: "basicswap", fromTicker: "BCH", toTicker: "XMR" })).toBe(true);
    expect(feeAppliesToSend({ router: "basicswap", fromTicker: "ltc", toTicker: "zano" })).toBe(true);
  });

  it("is false when the scripted leg is RECEIVED — nothing to hold back", () => {
    expect(feeAppliesToSend({ router: "basicswap", fromTicker: "XMR", toTicker: "BCH" })).toBe(false);
  });

  it("is false for two transparent coins and for two scriptless coins", () => {
    expect(feeAppliesToSend({ router: "basicswap", fromTicker: "BTC", toTicker: "LTC" })).toBe(false);
    expect(feeAppliesToSend({ router: "basicswap", fromTicker: "XMR", toTicker: "ZEPH" })).toBe(false);
  });

  it("is false off the peer-to-peer route entirely — Intents swaps are free", () => {
    for (const router of ["intents", "auto", "desk", null, undefined]) {
      expect(feeAppliesToSend({ router, fromTicker: "BCH", toTicker: "XMR" })).toBe(false);
    }
  });

  it("keeps the two coin sets disjoint", () => {
    for (const s of SCRIPTLESS_TICKERS) {
      expect((FEE_SCRIPTED_TICKERS as readonly string[]).includes(s)).toBe(false);
    }
  });
});

describe("spendableAfterReserve", () => {
  it("subtracts the reserve", () => {
    expect(spendableAfterReserve(0.63891881, 0.00025)).toBeCloseTo(0.63866881, 8);
  });

  it("never goes negative, and passes the balance through when there is no fee", () => {
    expect(spendableAfterReserve(0.0001, 0.5)).toBe(0);
    expect(spendableAfterReserve(1, 0)).toBe(1);
    expect(spendableAfterReserve(0, 0.1)).toBe(0);
  });
});
