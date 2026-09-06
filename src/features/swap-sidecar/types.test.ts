/**
 * `types.ts`'s coin-identity helpers — direct coverage for the ZANO
 * additions and the `SIDECAR_ONLY_TICKERS` / `SIDECAR_SCRIPTLESS_TICKERS`
 * split (Grove expansion plan, Phase C unit C-T1, 2026-09-03).
 *
 * No dedicated test file existed for `types.ts` before this — the coin
 * tables were previously only exercised indirectly through
 * `basicswapPickerTickers.test.ts`. Added here because the two new/changed
 * constants (`SIDECAR_SCRIPTLESS_TICKERS`, `COIN_NAME_TO_TICKER.ZANO`,
 * `COIN_DECIMALS.ZANO`) are load-bearing for other Phase C units (C-T2,
 * C-T3) that read them by name — see this unit's followups.
 */
import { describe, it, expect } from "vitest";
import {
  COIN_DECIMALS,
  COIN_NAME_TO_TICKER,
  SIDECAR_ONLY_TICKERS,
  SIDECAR_SCRIPTLESS_TICKERS,
  decimalsForCoin,
  tickerForCoin,
} from "./types";

describe("ZANO coin identity", () => {
  it("COIN_NAME_TO_TICKER resolves upstream's display name ('Zano', chainparams.py's name.capitalize()) to the ticker", () => {
    expect(COIN_NAME_TO_TICKER.ZANO).toBe("ZANO");
  });

  it("COIN_DECIMALS is 12 — matches chainparams.py's Coins.ZANO decimal_places AND the live wallet's asset_info.decimal_point", () => {
    expect(COIN_DECIMALS.ZANO).toBe(12);
  });

  it("tickerForCoin resolves 'Zano' (offer display name), 'zano' (chainparams name), and 'ZANO' (ticker) to the same ticker", () => {
    expect(tickerForCoin("Zano")).toBe("ZANO");
    expect(tickerForCoin("zano")).toBe("ZANO");
    expect(tickerForCoin("ZANO")).toBe("ZANO");
  });

  it("decimalsForCoin resolves ZANO to 12 without a live /json/coins table", () => {
    expect(decimalsForCoin("ZANO")).toBe(12);
    expect(decimalsForCoin("Zano")).toBe(12);
  });

  it("the live /json/coins table still wins over the static fallback for ZANO, same as every other coin", () => {
    const liveCoins = [
      { id: 16, ticker: "ZANO", name: "zano", active: true, decimal_places: 12 },
    ];
    expect(tickerForCoin("zano", liveCoins)).toBe("ZANO");
    expect(decimalsForCoin("zano", liveCoins)).toBe(12);
  });
});

describe("SIDECAR_ONLY_TICKERS vs SIDECAR_SCRIPTLESS_TICKERS — two different questions, must not be conflated", () => {
  it("SIDECAR_ONLY_TICKERS stays XMR-only — ZEPH/ZANO have their own non-sidecar surfaces", () => {
    expect(SIDECAR_ONLY_TICKERS).toEqual(["XMR"]);
  });

  it("SIDECAR_SCRIPTLESS_TICKERS carries all three CryptoNote-family coins Grove ships", () => {
    expect(new Set(SIDECAR_SCRIPTLESS_TICKERS)).toEqual(new Set(["XMR", "ZEPH", "ZANO"]));
  });

  it("every SIDECAR_ONLY ticker is also SIDECAR_SCRIPTLESS — the narrower list is a subset, not a disjoint one", () => {
    for (const t of SIDECAR_ONLY_TICKERS) {
      expect(SIDECAR_SCRIPTLESS_TICKERS, t).toContain(t);
    }
  });
});
