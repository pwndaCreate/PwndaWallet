/**
 * The pool-account view model (2026-09-18: "I cannot easily find ... my
 * current balance ... for any given pool that I am mining to").
 *
 * Numbers are the live pwnda ZEPH response for the operator's address that
 * day: balance 8783940898, paid 36178000000000 (atomic, 1e12).
 */
import { describe, expect, it } from "vitest";
import {
  poolAccountView,
  poolReportsAccountThreshold,
  thresholdSourceFor,
  type PoolAccountInput,
} from "./poolAccount";
import { getPoolById } from "./pools";
import { atomicToNumber } from "./pool-stats/format";
import type { MinerStats } from "./pool-stats";

const zephStats: MinerStats = {
  pendingBalance: "8783940898",
  immatureBalance: null,
  totalPaid: "36178000000000",
  payoutThreshold: null,
  hashrate: 13424,
  hashrate1h: 13748,
  hashrate6h: null,
  hashrate24h: null,
  validShares: null,
  invalidShares: null,
  staleShares: null,
  lastShare: 1789704158,
  workersOnline: 1,
  fetchedAt: 1789704200,
};

function input(over: Partial<PoolAccountInput> = {}): PoolAccountInput {
  return {
    coin: "zephyr",
    ticker: "ZEPH",
    pool: getPoolById("pwnda-zephyr") ?? null,
    minPayoutLabel: "0.01 ZEPH",
    address: "ZEPHYR2qTEST",
    statsAdapter: { id: "pwnda-zephyr", recommendedPollMs: 30_000 },
    optedIn: true,
    stats: zephStats,
    loading: false,
    error: null,
    priceUsd: 2,
    ...over,
  };
}

describe("poolAccountView", () => {
  it("reads unpaid, paid, the pool minimum and the progress toward it", () => {
    const v = poolAccountView(input());
    expect(v.status).toBe("ok");
    expect(v.unpaid).toBeCloseTo(0.008783940898, 12);
    expect(v.paid).toBeCloseTo(36.178, 9);
    expect(v.threshold).toBe(0.01);
    // pwnda offers no per-account level, so its minimum IS the account's.
    expect(v.thresholdSource).toBe("pool-fixed");
    expect(v.progress).toBeCloseTo(0.8784, 3);
    expect(v.unpaidUsd).toBeCloseTo(0.0175679, 6);
    expect(v.paidUsd).toBeCloseTo(72.356, 3);
    expect(v.note).toBeNull();
  });

  it("warns when a pool allows custom levels its API does not report", () => {
    // WoolyPooly: a ZANO account paid ~0.50 against the 0.25 minimum (audit).
    const v = poolAccountView(
      input({
        coin: "zano",
        ticker: "ZANO",
        pool: getPoolById("woolypooly-zano") ?? null,
        minPayoutLabel: "0.25 ZANO",
        statsAdapter: { id: "woolypooly-zano", recommendedPollMs: 30_000 },
      }),
    );
    expect(v.thresholdSource).toBe("pool");
    expect(v.note).toMatch(/pool minimum/);
  });

  it("links the pwnda MY STATS page with the address filled in", () => {
    const v = poolAccountView(input({ address: "xel:abc" }));
    expect(v.statsPageUrl).toBe("https://pwnda.org/pool?address=xel%3Aabc");
  });

  it("says why there is no number, in each case", () => {
    expect(poolAccountView(input({ statsAdapter: null })).status).toBe("unsupported");
    expect(poolAccountView(input({ address: null })).status).toBe("no-address");
    expect(poolAccountView(input({ optedIn: false })).status).toBe("needs-optin");
    expect(poolAccountView(input({ stats: null, loading: true })).status).toBe("loading");
    const err = poolAccountView(input({ stats: null, error: "timeout" }));
    expect(err.status).toBe("error");
    expect(err.error).toBe("timeout");
    // The payout level is still known without an account read.
    expect(poolAccountView(input({ optedIn: false })).threshold).toBe(0.01);
  });

  it("explains an all-zero pwnda account as PPLNS, not as a broken read", () => {
    // pwnda XEL, 2026-09-18: `num_blocks_found: 0`, so every account is zero.
    const v = poolAccountView(
      input({
        coin: "xelis",
        ticker: "XEL",
        pool: getPoolById("pwnda-xelis") ?? null,
        minPayoutLabel: "0.05 XEL",
        stats: { ...zephStats, pendingBalance: "0", totalPaid: "0", hashrate: 0 },
      }),
    );
    expect(v.status).toBe("ok");
    expect(v.unpaid).toBe(0);
    expect(v.note).toMatch(/PPLNS/);
  });

  it("shows a HeroMiners account's custom level, not the pool minimum", () => {
    // Live ZANO account, 2026-09-18: `minPayoutLevel` 2 ZANO vs 0.2 minimum.
    const v = poolAccountView(
      input({
        coin: "zano",
        ticker: "ZANO",
        pool: getPoolById("herominers-zano") ?? null,
        minPayoutLabel: "0.2 ZANO",
        statsAdapter: { id: "herominers-zano", recommendedPollMs: 30_000 },
        stats: { ...zephStats, pendingBalance: "130612500481", payoutThreshold: "2000000000000" },
      }),
    );
    expect(v.threshold).toBe(2);
    expect(v.thresholdSource).toBe("account");
    expect(v.progress).toBeCloseTo(0.0653, 3);
  });

  it("prefers the account's own threshold where the pool reports it", () => {
    expect(poolReportsAccountThreshold("hashvault-monero")).toBe(true);
    expect(poolReportsAccountThreshold("herominers-zano")).toBe(true);
    // K1Pool's `payoutThreshold` stayed 3 on an account paid ~0.23 (audit).
    expect(poolReportsAccountThreshold("k1pool-xelis-gpu")).toBe(false);
    expect(thresholdSourceFor("k1pool-xelis-gpu")).toBe("pool");
    expect(thresholdSourceFor("pwnda-zano")).toBe("pool-fixed");
    const v = poolAccountView(
      input({
        coin: "monero",
        ticker: "XMR",
        pool: getPoolById("hashvault-monero") ?? null,
        minPayoutLabel: "0.01 XMR",
        statsAdapter: { id: "hashvault-monero", recommendedPollMs: 30_000 },
        stats: { ...zephStats, payoutThreshold: "50000000000" }, // 0.05 XMR set by the miner
      }),
    );
    expect(v.threshold).toBe(0.05);
    expect(v.thresholdSource).toBe("account");
    expect(v.note).toBeNull();
  });
});

describe("atomicToNumber", () => {
  it("uses each coin's decimals, including ZANO's 12", () => {
    expect(atomicToNumber("200000000000", "zano")).toBe(0.2);
    expect(atomicToNumber("5000000", "xelis")).toBe(0.05);
    expect(atomicToNumber(null, "monero")).toBeNull();
    expect(atomicToNumber("1", "bitcoin")).toBeNull();
  });
});
