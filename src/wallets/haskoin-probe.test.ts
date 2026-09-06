/**
 * haskoin-store probes — the batch source the UTXO account walk leans on
 * (2026-09-04).
 *
 * Why these exist: the gap walk asks ~90 addresses per refresh, and on
 * 2026-09-04 the per-address sources could not carry that (bitcore 429 after
 * ~10, Blockchair 430-blacklisted), which left a funded BCH account reading 0.
 * `haskoinProbeMany` answers a whole block in one request — but only if it
 * answers HONESTLY: a row missing from the reply must rotate, never read as
 * "unused", because "unused" is what stops a gap walk.
 *
 * Every response shape below is copied from the live capture the same day
 * (`api.blockchain.info/haskoin-store/bch/address/balances`, both
 * deployments), not from documentation.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyGetJson } from "./_proxy";
import { haskoinProbe, haskoinProbeMany, parseHaskoinBalance } from "./_utxo-probes";

const BASE = "https://api.blockchain.info/haskoin-store/bch";
const A = "bitcoincash:qrrzf9lungem8cteqd38fy39wqwm2h04054c4sswwx";
const B = "bitcoincash:qzrjx6ycse63kxt2r6x0m0m2ux6yz2q9s5pjw2k9qg";
const C = "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6";

/** The row the live API returned for the operator's funded address. */
const LIVE_FUNDED = { address: A, confirmed: 63891881, unconfirmed: 0, utxo: 4, txs: 4, received: 63891881 };
const LIVE_UNUSED = { address: B, confirmed: 0, unconfirmed: 0, utxo: 0, txs: 0, received: 0 };

const mockFn = () => proxyGetJson as any;

describe("parseHaskoinBalance", () => {
  it("reads balance and used from one live-shaped row", () => {
    expect(parseHaskoinBalance(LIVE_FUNDED)).toEqual({ balanceSat: 63891881, used: true });
    expect(parseHaskoinBalance(LIVE_UNUSED)).toEqual({ balanceSat: 0, used: false });
  });

  it("a spent-empty address (txs > 0, balance 0) is USED — the walk must not truncate on it", () => {
    // The 2026-08-22 LTC shape: receive/0 funded, then emptied, change at index 20.
    expect(parseHaskoinBalance({ ...LIVE_UNUSED, txs: 2, received: 432_888_299 })).toEqual({
      balanceSat: 0,
      used: true,
    });
  });

  it("counts unconfirmed into the balance", () => {
    expect(parseHaskoinBalance({ ...LIVE_FUNDED, unconfirmed: 1000 }).balanceSat).toBe(63892881);
  });

  it("THROWS on a row without txs — 'used' cannot be guessed", () => {
    expect(() => parseHaskoinBalance({ address: A, confirmed: 0 })).toThrow(/confirmed\/txs/);
    expect(() => parseHaskoinBalance(null)).toThrow();
  });
});

describe("haskoinProbeMany", () => {
  it("one request for the whole block, results in REQUEST order", async () => {
    const seen: string[] = [];
    mockFn().mockImplementation(async (url: string) => {
      seen.push(url);
      // Deliberately reordered vs the request, to prove matching is by address.
      return [LIVE_UNUSED, LIVE_FUNDED];
    });
    const r = await haskoinProbeMany(BASE, [A, B]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`${BASE}/address/balances?addresses=${A},${B}`);
    expect(r).toEqual([
      { balanceSat: 63891881, used: true },
      { balanceSat: 0, used: false },
    ]);
  });

  it("matches the bare CashAddr to the prefixed row haskoin echoes", async () => {
    mockFn().mockImplementation(async () => [LIVE_FUNDED]);
    const r = await haskoinProbeMany(BASE, [A.split(":")[1]]);
    expect(r[0].balanceSat).toBe(63891881);
  });

  it("THROWS when any requested address is missing — a missing row is not a zero", async () => {
    mockFn().mockImplementation(async () => [LIVE_FUNDED]);
    await expect(haskoinProbeMany(BASE, [A, C])).rejects.toThrow(/1 of 2 addresses missing/);
  });

  it("THROWS on a non-array body (an HTML error page, a rate-limit object)", async () => {
    mockFn().mockImplementation(async () => ({ error: "rate limited" }));
    await expect(haskoinProbeMany(BASE, [A])).rejects.toThrow(/not an array/);
  });

  it("an empty request makes no call", async () => {
    mockFn().mockImplementation(async () => {
      throw new Error("must not be called");
    });
    await expect(haskoinProbeMany(BASE, [])).resolves.toEqual([]);
  });
});

describe("haskoinProbe (single)", () => {
  it("reads the per-address endpoint", async () => {
    mockFn().mockImplementation(async (url: string) => {
      expect(url).toBe(`${BASE}/address/${A}/balance`);
      return LIVE_FUNDED;
    });
    await expect(haskoinProbe(BASE, A)).resolves.toEqual({ balanceSat: 63891881, used: true });
  });
});
