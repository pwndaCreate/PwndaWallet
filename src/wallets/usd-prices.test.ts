/**
 * fetchUsdPrices — provider-merge + last-known-good cache.
 *
 * Regression lock for the 2026-06-17 "balance but no USD price" bug:
 * coins (ERG/FLR/HBAR/ZEPH) rendered "—" whenever CoinGecko was on its
 * 429 cooldown and the code fell through to CoinPaprika, because
 *   (a) CoinPaprika ids for those coins were stale / absent, and
 *   (b) `fetchUsdPrices` returned the FIRST provider with any result and
 *       cached that partial answer as if it were complete.
 *
 * These tests pin the fixed behavior: providers are merged per-ticker,
 * and a price never regresses to "missing" once we've seen it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Rust-proxy JSON fetcher. Each test sets the dispatcher.
vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
}));

import { proxyGetJson } from "./_proxy";
import {
  fetchUsdPrices,
  fetchUsdPriceHistory,
  _resetCachesForTests,
} from "./usd-prices";

const mockProxy = proxyGetJson as unknown as ReturnType<typeof vi.fn>;

/** Build a CoinGecko /simple/price body from a {cgId: usd} map. */
function cgBody(prices: Record<string, number>) {
  const out: Record<string, { usd: number }> = {};
  for (const [id, usd] of Object.entries(prices)) out[id] = { usd };
  return out;
}

/** Build a CoinPaprika /v1/tickers body from {id,symbol,price} rows. */
function paprikaBody(rows: Array<{ id: string; symbol: string; price: number }>) {
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    quotes: { USD: { price: r.price } },
  }));
}

function httpError(status: number): never {
  throw new Error(`HTTP ${status} from https://example: rate limited`);
}

beforeEach(() => {
  _resetCachesForTests();
  mockProxy.mockReset();
});

describe("fetchUsdPrices — merge across providers", () => {
  it("backfills CoinPaprika gaps when CoinGecko is rate-limited (the reported bug)", async () => {
    // CoinGecko 429 (cooldown), CoinPaprika answers with the now-correct ids
    // for the four formerly-broken coins (ERG/FLR/HBAR) plus CFX/RVN. ZEPH is
    // not on CoinPaprika and CryptoCompare 401s — ZEPH simply absent this round.
    mockProxy.mockImplementation((url: string) => {
      if (url.includes("/simple/price")) return httpError(429);
      if (url.includes("coinpaprika")) {
        return Promise.resolve(
          paprikaBody([
            { id: "cfx-conflux-network", symbol: "CFX", price: 0.05 },
            { id: "rvn-ravencoin", symbol: "RVN", price: 0.0044 },
            { id: "efyt-ergo", symbol: "ERG", price: 0.22 },
            { id: "flr-flare-network", symbol: "FLR", price: 0.0077 },
            { id: "hbar-hedera-hashgraph", symbol: "HBAR", price: 0.08 },
          ])
        );
      }
      if (url.includes("cryptocompare")) return httpError(401);
      throw new Error(`unexpected url ${url}`);
    });

    const prices = await fetchUsdPrices(["CFX", "RVN", "ERG", "FLR", "HBAR", "ZEPH"]);
    // The four coins that used to blank now have prices.
    expect(prices.ERG).toBeCloseTo(0.22);
    expect(prices.FLR).toBeCloseTo(0.0077);
    expect(prices.HBAR).toBeCloseTo(0.08);
    expect(prices.CFX).toBeCloseTo(0.05);
    expect(prices.RVN).toBeCloseTo(0.0044);
  });

  it("does not call fallback providers when CoinGecko covers everything", async () => {
    mockProxy.mockImplementation((url: string) => {
      if (url.includes("/simple/price")) {
        return Promise.resolve(
          cgBody({
            "conflux-token": 0.05,
            ergo: 0.22,
            "zephyr-protocol": 0.41,
          })
        );
      }
      throw new Error(`should not reach ${url}`);
    });

    const prices = await fetchUsdPrices(["CFX", "ERG", "ZEPH"], { force: true });
    expect(prices.CFX).toBeCloseTo(0.05);
    expect(prices.ERG).toBeCloseTo(0.22);
    expect(prices.ZEPH).toBeCloseTo(0.41);
    // Only the CoinGecko call happened — no CoinPaprika/CryptoCompare.
    expect(mockProxy).toHaveBeenCalledTimes(1);
  });
});

describe("fetchUsdPrices — last-known-good never regresses", () => {
  it("keeps a coin's last price when a later round can't cover it", async () => {
    // Round 1: CoinGecko healthy → prices ZEPH.
    mockProxy.mockImplementation((url: string) => {
      if (url.includes("/simple/price")) {
        return Promise.resolve(cgBody({ "zephyr-protocol": 0.41, ergo: 0.22 }));
      }
      throw new Error(`should not reach ${url}`);
    });
    const first = await fetchUsdPrices(["ZEPH", "ERG"], { force: true });
    expect(first.ZEPH).toBeCloseTo(0.41);

    // Round 2: CoinGecko 429, CoinPaprika has ERG but NOT ZEPH, CryptoCompare 401.
    mockProxy.mockImplementation((url: string) => {
      if (url.includes("/simple/price")) return httpError(429);
      if (url.includes("coinpaprika")) {
        return Promise.resolve(paprikaBody([{ id: "efyt-ergo", symbol: "ERG", price: 0.25 }]));
      }
      if (url.includes("cryptocompare")) return httpError(401);
      throw new Error(`unexpected url ${url}`);
    });
    const second = await fetchUsdPrices(["ZEPH", "ERG"], { force: true });
    // ERG refreshed to the newer value...
    expect(second.ERG).toBeCloseTo(0.25);
    // ...and ZEPH did NOT vanish — it holds its last-known-good price.
    expect(second.ZEPH).toBeCloseTo(0.41);
  });
});

/**
 * History fallback must stay bounded.
 *
 * The per-ticker fallback is sequential with a 1.5s sleep between calls, and
 * it only runs for tickers the batched `/coins/markets` request didn't cover.
 * Those two facts compose badly: a batch 429 puts CoinGecko on a 5-minute
 * cooldown, during which EVERY ticker falls through to the fallback. Uncapped,
 * a ~19-asset wallet then spent ~28s per refresh for five minutes — hammering
 * the provider that just rate-limited it, to fill in decorative sparklines.
 *
 * Capped at HISTORY_FALLBACK_MAX (4), the worst case is ~6s and successive
 * sweeps make progress via the 15-minute history cache.
 */
describe("fetchUsdPriceHistory — fallback is capped", () => {
  it("issues at most HISTORY_FALLBACK_MAX per-ticker calls when the batch returns nothing", async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      mockProxy.mockImplementation(async (url: string) => {
        seen.push(url);
        // Batched /coins/markets -> empty (simulates a 429'd / unhelpful batch).
        if (url.includes("/coins/markets")) return [];
        // Per-ticker /market_chart -> also empty, so nothing gets cached and
        // the cap is the only thing bounding the loop.
        return { prices: [] };
      });

      const many = [
        "BTC", "ETH", "SOL", "ADA", "XMR", "ZEPH",
        "LTC", "DOGE", "BCH", "DASH", "XRP", "TRX",
      ];
      const p = fetchUsdPriceHistory(many);
      await vi.runAllTimersAsync();
      await p;

      const perTicker = seen.filter((u) => u.includes("market_chart"));
      expect(
        perTicker.length,
        `fallback made ${perTicker.length} sequential calls; the cap exists so a ` +
          `429'd batch can't turn into a ~28s serial sweep`
      ).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
