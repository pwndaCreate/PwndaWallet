/**
 * Zephyr history rows name, and price, the asset they moved (2026-09-15).
 *
 * `zph-wallet.ts` has always put `asset_type` in `ChainTx.meta`, and every
 * renderer printed the adapter ticker instead: a ZEPHUSD receipt read "ZEPH",
 * and landscape Activity valued it at ZEPH's price.
 */
import { describe, it, expect } from "vitest";
import type { ChainTx } from "./types";
import type { ZphLiveStats } from "./zph-scanner-api";
import {
  sendAssetTicker,
  sendAssetUsdPrice,
  txDisplayTicker,
  txFeeTicker,
  txUsdPrice,
  zphTxAsset,
} from "./tx-display";

describe("txFeeTicker", () => {
  const row = (direction: ChainTx["direction"], asset_type?: string): ChainTx => ({
    chain: "zephyr",
    hash: "h",
    direction,
    amount: "1",
    fee: "0.0000254",
    meta: asset_type ? { asset_type } : {},
  });

  it("charges an outgoing Zephyr row's fee in the asset it sent", () => {
    expect(txFeeTicker(row("out", "ZSD"), "ZEPH")).toBe("ZEPHUSD");
    expect(txFeeTicker(row("pending", "ZRS"), "ZEPH")).toBe("ZEPHRSV");
    expect(txFeeTicker(row("out", "ZPH"), "ZEPH")).toBe("ZEPH");
  });

  it("gives an incoming row, or one with no asset, no fee ticker rather than a guess", () => {
    expect(txFeeTicker(row("in", "ZSD"), "ZEPH")).toBeNull();
    expect(txFeeTicker(row("out"), "ZEPH")).toBeNull();
  });

  it("keeps the adapter ticker on every other chain", () => {
    const btc: ChainTx = { chain: "bitcoin", hash: "h", direction: "in", amount: "1", fee: "0.0001" };
    expect(txFeeTicker(btc, "BTC")).toBe("BTC");
  });
});

const STATS = {
  zeph_price: 0.3409,
  zsd_price: 1,
  zrs_price: 0.4183,
  zys_price: 1.931,
} as ZphLiveStats;

const PRICES = { ZEPH: 0.3409, XLM: 0.11 };

const zphTx = (asset_type?: unknown): ChainTx => ({
  chain: "zephyr",
  hash: "abc",
  direction: "in",
  amount: "25",
  meta: asset_type === undefined ? {} : { asset_type },
});

describe("txDisplayTicker", () => {
  it("labels ZSD / ZRS / ZYS rows with their UI ticker, not ZEPH", () => {
    expect(txDisplayTicker(zphTx("ZSD"), "ZEPH")).toBe("ZEPHUSD");
    expect(txDisplayTicker(zphTx("ZRS"), "ZEPH")).toBe("ZEPHRSV");
    expect(txDisplayTicker(zphTx("ZYS"), "ZEPH")).toBe("ZEPHYRS");
    expect(txDisplayTicker(zphTx("ZPH"), "ZEPH")).toBe("ZEPH");
  });

  it("keeps the adapter ticker when a row does not say, or says something unknown", () => {
    expect(txDisplayTicker(zphTx(), "ZEPH")).toBe("ZEPH");
    expect(txDisplayTicker(zphTx("ZEPHUSD"), "ZEPH")).toBe("ZEPH");
    expect(zphTxAsset(zphTx(42))).toBeNull();
  });

  it("ignores asset_type on any other chain (Stellar uses the same key)", () => {
    const xlm: ChainTx = { chain: "stellar", hash: "h", direction: "in", amount: "1", meta: { asset_type: "ZSD" } };
    expect(txDisplayTicker(xlm, "XLM")).toBe("XLM");
    expect(txUsdPrice(xlm, "XLM", PRICES, STATS)).toBe(0.11);
  });
});

describe("txUsdPrice", () => {
  it("prices ZEPHUSD from the oracle, never from ZEPH's price", () => {
    expect(txUsdPrice(zphTx("ZSD"), "ZEPH", PRICES, STATS)).toBe(1);
    expect(txUsdPrice(zphTx("ZYS"), "ZEPH", PRICES, STATS)).toBe(1.931);
  });

  it("has NO price for an asset row when the oracle stats are not loaded", () => {
    expect(txUsdPrice(zphTx("ZRS"), "ZEPH", PRICES, null)).toBeNull();
    expect(txUsdPrice(zphTx("ZSD"), "ZEPH", PRICES)).toBeNull();
  });

  it("uses the ticker price for ZEPH rows", () => {
    expect(txUsdPrice(zphTx("ZPH"), "ZEPH", PRICES, null)).toBe(0.3409);
    expect(txUsdPrice(zphTx(), "ZEPH", PRICES, null)).toBe(0.3409);
  });

  it("returns null rather than a zero or missing price", () => {
    expect(txUsdPrice(zphTx("ZPH"), "ZEPH", {}, STATS)).toBeNull();
    expect(txUsdPrice(zphTx("ZPH"), "ZEPH", { ZEPH: 0 }, STATS)).toBeNull();
  });
});

describe("Send modal asset label and price", () => {
  it("names the Zephyr asset being sent", () => {
    expect(sendAssetTicker("zephyr", "ZEPH", "ZSD")).toBe("ZEPHUSD");
    expect(sendAssetTicker("zephyr", "ZEPH", undefined)).toBe("ZEPH");
    expect(sendAssetTicker("zephyr", "ZEPH", "ZPH")).toBe("ZEPH");
  });

  it("never labels an unknown Zephyr selector as ZEPH", () => {
    expect(sendAssetTicker("zephyr", "ZEPH", "BOGUS")).toBe("BOGUS");
  });

  it("leaves every other chain on its own ticker", () => {
    expect(sendAssetTicker("litecoin", "LTC", undefined)).toBe("LTC");
    expect(sendAssetTicker("litecoin", "LTC", "ZSD")).toBe("LTC");
  });

  it("prices an ecosystem asset from the oracle and nothing else", () => {
    expect(sendAssetUsdPrice("zephyr", "ZRS", STATS)).toBe(0.4183);
    expect(sendAssetUsdPrice("zephyr", "ZPH", STATS)).toBeUndefined();
    expect(sendAssetUsdPrice("zephyr", undefined, STATS)).toBeUndefined();
    expect(sendAssetUsdPrice("zephyr", "ZSD", null)).toBeUndefined();
    expect(sendAssetUsdPrice("monero", "ZSD", STATS)).toBeUndefined();
  });
});
