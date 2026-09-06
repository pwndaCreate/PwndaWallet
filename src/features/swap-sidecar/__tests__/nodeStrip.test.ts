/**
 * Regression tests for the two faults the operator reported on 2026-08-28,
 * both visible in one screenshot of the Settings swap-node card:
 *
 *   1. `PART 99%` on a node that was demonstrably caught up — live offers were
 *      visible in the BasicSwap console at the same moment.
 *   2. Coin dots and DEX tiles that never lit, whatever was configured. The
 *      card read `DEX COINS · 0 OF 5 ON` while the section directly below it
 *      read `DEX COINS · 4 OF 7 ENABLED`.
 *
 * # Why these are unit tests and not a rendering check
 *
 * Both were pure derivation faults sitting inline in a component with a poll,
 * a start/stop machine and four hooks around them — nothing about the React
 * tree was involved in either. Extracting the derivations (see `nodeStrip.ts`)
 * is what made them testable at all, and the extraction is most of the fix:
 * an expression that can be exercised is an expression whose wrongness can be
 * demonstrated.
 *
 * # The one that matters more
 *
 * The ticker-vs-name confusion is a CLASS, not an instance. `status.coins`
 * holds engine names; every comparison of it against a ticker is silently
 * false forever, type-checks, and renders. The `configuredTickersFrom` cases
 * below are the guard for the class, not just for the two dots that had it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChainSync, CoinEnableStatus } from "../../../api/basicswap";
import {
  STRIP_DOT_TICKERS,
  STRIP_TICKERS,
  configuredTickersFrom,
  dexTilesFrom,
  partSyncReading,
} from "../nodeStrip";

function chain(over: Partial<ChainSync>): ChainSync {
  return {
    coin: "particl",
    ticker: "PART",
    blocks: 0,
    headers: 0,
    verifiedPct: 0,
    error: null,
    ...over,
  };
}

function coinRow(over: Partial<CoinEnableStatus>): CoinEnableStatus {
  return {
    coin: "bitcoin",
    ticker: "BTC",
    enabled: false,
    binaryPresent: true,
    configured: false,
    adoption: "none",
    descriptorsImported: false,
    mode: "local",
    configuredMode: null,
    ...over,
  } as CoinEnableStatus;
}

describe("partSyncReading — a caught-up chain must read 100%", () => {
  /**
   * THE reported bug. A real synced daemon reports verificationprogress
   * 0.9999982, which is 99.99982% — and `Math.floor` pinned that to 99 with no
   * way out, because the value never actually reaches 100.
   */
  it("reads 100% when blocks have caught up, even at 99.99982% verified", () => {
    const r = partSyncReading(
      chain({ blocks: 2226731, headers: 2226731, verifiedPct: 99.99982 }),
    );
    expect(r.synced).toBe(true);
    expect(r.pct).toBe(100);
  });

  it("still reads the real percentage mid-sync", () => {
    const r = partSyncReading(
      chain({ blocks: 349745, headers: 2226731, verifiedPct: 13.73 }),
    );
    expect(r.synced).toBe(false);
    expect(r.pct).toBe(13);
  });

  /**
   * The asymptote runs both ways. A daemon can report 100.0% verified with
   * blocks still behind — `ChainSync`'s own doc warns that a chain with no
   * blocks reports 100% verified. Rendering "100%" beside a warn tone would be
   * the cell contradicting itself.
   */
  it("clamps to 99 when the daemon claims 100% but blocks are behind", () => {
    const r = partSyncReading(
      chain({ blocks: 2226000, headers: 2226731, verifiedPct: 100 }),
    );
    expect(r.synced).toBe(false);
    expect(r.pct).toBe(99);
  });

  it("is not synced when the chain reports no headers at all", () => {
    // The exact case ChainSync's doc calls out: no blocks, 100% verified.
    const r = partSyncReading(chain({ blocks: 0, headers: 0, verifiedPct: 100 }));
    expect(r.synced).toBe(false);
  });

  it("reports nothing rather than zero when the chain has not answered", () => {
    expect(partSyncReading(null)).toEqual({ pct: null, synced: false });
    expect(partSyncReading(undefined).pct).toBeNull();
  });
});

describe("configuredTickersFrom — engine NAMES are not tickers", () => {
  /**
   * The shape of the original bug, kept verbatim as the thing that must never
   * pass again: `"MONERO".startsWith("XMR")` is false, so the XMR dot was
   * unlit by construction on every node that had Monero configured.
   */
  it("translates the chainclients names a real node reports", () => {
    const got = configuredTickersFrom([
      "particl",
      "bitcoin",
      "litecoin",
      "monero",
    ]);
    expect([...got].sort()).toEqual(["BTC", "LTC", "PART", "XMR"]);
  });

  it("the naive comparison this replaced would have found nothing", () => {
    // Demonstrates the fault rather than describing it: this is what the card
    // used to do, and it yields an empty set on a fully-configured node.
    const coins = ["particl", "bitcoin", "litecoin", "monero"];
    const naive = ["BTC", "LTC", "XMR"].filter((t) =>
      coins.some((c) => c.toUpperCase() === t),
    );
    expect(naive).toEqual([]);
    // The fix finds all three.
    const fixed = ["BTC", "LTC", "XMR"].filter((t) =>
      configuredTickersFrom(coins).has(t),
    );
    expect(fixed).toEqual(["BTC", "LTC", "XMR"]);
  });

  it("accepts a ticker that arrives as a ticker", () => {
    // `tickerForCoin` tolerates both directions; a future backend that reports
    // tickers must not silently blank the strip.
    expect([...configuredTickersFrom(["BTC", "XMR"])].sort()).toEqual([
      "BTC",
      "XMR",
    ]);
  });

  it("drops names it cannot identify instead of guessing", () => {
    expect(configuredTickersFrom(["a coin that does not exist"]).size).toBe(0);
  });

  it("survives an absent coins list", () => {
    expect(configuredTickersFrom(null).size).toBe(0);
    expect(configuredTickersFrom(undefined).size).toBe(0);
  });
});

describe("dexTilesFrom — one source of truth with the DEX COINS section", () => {
  const statuses = [
    coinRow({ coin: "particl", ticker: "PART", enabled: true }),
    coinRow({ coin: "monero", ticker: "XMR", enabled: true }),
    coinRow({ coin: "bitcoin", ticker: "BTC", enabled: true }),
    coinRow({ coin: "litecoin", ticker: "LTC", enabled: true }),
    coinRow({ coin: "dash", ticker: "DASH", enabled: false }),
    coinRow({ coin: "bitcoincash", ticker: "BCH", enabled: false }),
    coinRow({ coin: "dogecoin", ticker: "DOGE", enabled: false, binaryPresent: false }),
    coinRow({ coin: "zephyr", ticker: "ZEPH", enabled: true }),
    coinRow({ coin: "zano", ticker: "ZANO", enabled: true }),
  ];

  it("reflects the authority's enabled flags rather than a hardcoded list", () => {
    const tiles = dexTilesFrom(statuses, STRIP_TICKERS);
    expect(tiles).toEqual([
      { ticker: "BTC", enabled: true },
      { ticker: "LTC", enabled: true },
      { ticker: "DASH", enabled: false },
      { ticker: "BCH", enabled: false },
    ]);
  });

  it("omits coins the strip above already reports", () => {
    const tickers = dexTilesFrom(statuses, STRIP_TICKERS).map((t) => t.ticker);
    for (const t of ["PART", ...STRIP_DOT_TICKERS]) expect(tickers).not.toContain(t);
  });

  // 2026-09-04: ZANO was added to the card's dot loop but not to the tile
  // exclusion, so one card showed a hollow `zano` dot AND a filled ZANO tile.
  // Two lists for one fact; these two cases make them one.
  it("excludes every dotted ticker — the dot loop and the tile filter share one list", () => {
    for (const t of STRIP_DOT_TICKERS) expect(STRIP_TICKERS.has(t)).toBe(true);
    expect(STRIP_DOT_TICKERS).toEqual(["XMR", "ZEPH", "ZANO"]);
  });

  it("the status card loops over STRIP_DOT_TICKERS rather than spelling its own list", () => {
    const src = readFileSync(join(__dirname, "..", "SidecarStatusCard.tsx"), "utf8");
    expect(src).toMatch(/for \(const t of STRIP_DOT_TICKERS\)/);
    expect(src).not.toMatch(/\["XMR", "ZEPH"(, "ZANO")?\] as const/);
  });

  it("omits a coin with no daemon binary — it is not an option, not an off tile", () => {
    expect(dexTilesFrom(statuses, STRIP_TICKERS).map((t) => t.ticker)).not.toContain(
      "DOGE",
    );
  });

  it("returns empty before the first read, so the card can render nothing", () => {
    // Not "0 of 0 on": a count of zero reads as a finding when the truth is
    // "not loaded yet". The card hides the block on an empty list.
    expect(dexTilesFrom([], STRIP_TICKERS)).toEqual([]);
    expect(dexTilesFrom(null, STRIP_TICKERS)).toEqual([]);
  });
});
