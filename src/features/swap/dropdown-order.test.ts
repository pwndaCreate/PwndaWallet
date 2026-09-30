import { describe, expect, it } from "vitest";
import { getDropdownTickers } from "./swap-data";
import { assetRank } from "../../wallets/coin-metadata";

/**
 * Regression lock for the 2026-06-21 "Smart" swap-picker ordering. The
 * dropdowns used to render in chronological add-order (BTC, ETH, SOL, LTC,
 * …, ADA last) which felt random; they now render in the shared canonical
 * market-cap order with stablecoins grouped last.
 */
describe("getDropdownTickers — canonical market-cap order", () => {
  it("leads with BTC then ETH on both sides", () => {
    expect(getDropdownTickers({ sourceOnly: true }).slice(0, 2)).toEqual([
      "BTC",
      "ETH",
    ]);
    expect(getDropdownTickers({ sourceOnly: false }).slice(0, 2)).toEqual([
      "BTC",
      "ETH",
    ]);
  });

  it("is sorted strictly by assetRank", () => {
    for (const sourceOnly of [true, false]) {
      const list = getDropdownTickers({ sourceOnly });
      const ranks = list.map((t) => assetRank(t));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it("groups stablecoins (USDC/USDT/DAI) at the very end", () => {
    const list = getDropdownTickers({ sourceOnly: true });
    const stables = new Set(["USDC", "USDT", "DAI"]);
    const lastNonStable = Math.max(
      ...list.filter((t) => !stables.has(t)).map((t) => list.indexOf(t))
    );
    for (const s of stables) {
      if (list.includes(s)) expect(list.indexOf(s)).toBeGreaterThan(lastNonStable);
    }
  });

  it("offers USDT and USDC near the top, not below every native", () => {
    // Reversed 2026-09-29: stablecoins used to be last, which is where the
    // operator did not find them. USDT legs now follow ETH, USDC legs follow
    // XRP, and ADA comes after both. Legs, not bare symbols (since 2026-09-09).
    const list = getDropdownTickers({ sourceOnly: true, router: "intents" });
    const firstUsdt = list.findIndex((x) => /^USDT/.test(x));
    const firstUsdc = list.findIndex((x) => /^USDC/.test(x));
    expect(firstUsdt).toBeGreaterThanOrEqual(0);
    expect(firstUsdc).toBeGreaterThanOrEqual(0);
    expect(list.indexOf("ETH")).toBeLessThan(firstUsdt);
    expect(firstUsdt).toBeLessThan(list.indexOf("SOL"));
    expect(firstUsdc).toBeLessThan(list.indexOf("ADA"));
  });
});

/**
 * The pwnda-desk roster contribution (2026-07-19).
 *
 * Before the desk, XMR and ZEPH had no route at all (null on both
 * aggregators) and were deliberately excluded from these dropdowns —
 * "XMR routes through the atomic modal and Zephyr through its own card".
 * The desk gives them a route, so they now appear on BOTH sides. The
 * membership is derived from `ASSET_CAPABILITIES[...].atomicDesk` rather
 * than a hardcoded second list, so these assertions also lock the
 * registry-derived wiring.
 */
describe("getDropdownTickers — pwnda-desk roster contribution", () => {
  it("surfaces the desk followers (XMR/ZEPH) on both sides", () => {
    for (const opts of [{ sourceOnly: true }, {}]) {
      const list = getDropdownTickers(opts);
      expect(list, `sourceOnly=${!!opts.sourceOnly}`).toContain("XMR");
      expect(list, `sourceOnly=${!!opts.sourceOnly}`).toContain("ZEPH");
    }
  });

  it("keeps the desk leaders present (they were already routable via other venues)", () => {
    const src = getDropdownTickers({ sourceOnly: true });
    for (const t of ["ADA", "AVAX", "LTC"]) expect(src).toContain(t);
  });

  it("does not duplicate a ticker that is both desk-tradable and aggregator-routable", () => {
    for (const opts of [{ sourceOnly: true }, {}]) {
      const list = getDropdownTickers(opts);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("does not pull the Zephyr ECOSYSTEM assets into the dropdown — only native ZEPH is desk-tradable", () => {
    const list = getDropdownTickers();
    for (const t of ["ZEPHUSD", "ZEPHRSV", "ZEPHYRS"]) {
      expect(list).not.toContain(t);
    }
  });
});

describe("leg keys rank as their symbol, not as unknowns", () => {
  it("ranks USDC-ARB exactly where USDC ranks", () => {
    // They used to sort last only because `assetRank` did not recognise them
    // and returned MAX_SAFE_INTEGER — the right position for the wrong
    // reason, and indistinguishable from a typo'd ticker.
    expect(assetRank("USDC-ARB")).toBe(assetRank("USDC"));
    expect(assetRank("USDC-BASE")).toBe(assetRank("USDC"));
  });

  it("resolves USDT0 legs through USDT", () => {
    // `USDT0` has no row of its own in the canonical order; it is USD₮0,
    // the same money, and must not sort as an unknown.
    expect(assetRank("USDT0-ARB")).toBe(assetRank("USDT"));
  });

  it("still sorts a genuinely unknown ticker last", () => {
    expect(assetRank("NOTACOIN")).toBe(Number.MAX_SAFE_INTEGER);
    expect(assetRank("NOPE-CHAIN")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
