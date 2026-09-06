/**
 * Tab switch → pair reconciliation (2026-09-04).
 *
 * The operator's report: "I switched from auto to near to p2p and it still
 * showed an eth>btc swap even though eth isn't a coin selection for p2p."
 * These pin the rule in `routerPairs.ts` against the real routability
 * helpers, so a registry change that makes a default pair unroutable shows
 * up here rather than as a dead tab.
 */
import { describe, expect, it } from "vitest";
import { coercePairForRouter } from "./routerPairs";
import { isBasicswapRoutable } from "../swap-sidecar";
import { isIntentsRoutable } from "./swap-data";

describe("coercePairForRouter — P2P", () => {
  it("replaces a NEAR-only source with the book's best counterpart and keeps the other side", () => {
    // The reported case. BTC has a book; ETH does not.
    const next = coercePairForRouter("basicswap", { from: "ETH", to: "BTC" });
    expect(next).not.toBeNull();
    expect(next!.to).toBe("BTC");
    expect(isBasicswapRoutable(next!.from, next!.to)).toBe(true);
    expect(next!.from).toBe("XMR");
  });

  it("keeps a pair the book can hold", () => {
    expect(coercePairForRouter("basicswap", { from: "LTC", to: "XMR" })).toBeNull();
    expect(coercePairForRouter("basicswap", { from: "xmr", to: "ltc" })).toBeNull();
  });

  it("falls back to XMR → LTC when neither side has a book", () => {
    expect(coercePairForRouter("basicswap", { from: "ETH", to: "SOL" })).toEqual({
      from: "XMR",
      to: "LTC",
    });
  });

  it("two scriptless coins are not a pair — one side gives way", () => {
    const next = coercePairForRouter("basicswap", { from: "XMR", to: "ZEPH" });
    expect(next).not.toBeNull();
    expect(isBasicswapRoutable(next!.from, next!.to)).toBe(true);
  });
});

describe("coercePairForRouter — NEAR and Auto", () => {
  it("keeps a NEAR-routable pair", () => {
    expect(coercePairForRouter("intents", { from: "ETH", to: "BTC" })).toBeNull();
    expect(coercePairForRouter("auto", { from: "ETH", to: "BTC" })).toBeNull();
  });

  it("swaps out a side NEAR cannot route and keeps the one it can", () => {
    // ZANO has no NEAR asset; BTC does.
    const next = coercePairForRouter("intents", { from: "ZANO", to: "BTC" });
    expect(next).not.toBeNull();
    expect(next!.to).toBe("BTC");
    expect(isIntentsRoutable(next!.from, next!.to)).toBe(true);
  });

  it("auto accepts a pair any venue can quote — a P2P pair stays put", () => {
    expect(coercePairForRouter("auto", { from: "XMR", to: "LTC" })).toBeNull();
  });
});

describe("coercePairForRouter — Zephyr desk", () => {
  it("moves to a desk pair when the current one is not one", () => {
    // The desk settles XMR/ADA and ZEPH/ADA only (one vendored engine).
    const next = coercePairForRouter("pwnda-desk", { from: "ETH", to: "BTC" });
    expect(next).toEqual({ from: "XMR", to: "ADA" });
    expect(coercePairForRouter("pwnda-desk", { from: "ZEPH", to: "ADA" })).toBeNull();
    expect(coercePairForRouter("pwnda-desk", { from: "ADA", to: "XMR" })).toBeNull();
  });
});
