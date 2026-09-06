/**
 * `bchUtxoAccounts[0].probe` — the dashboard's balance path for BCH.
 *
 * ## Why this test exists
 *
 * On 2026-09-04 a user's wallet showed `0` / `$0.00` for BCH while the same
 * panel's derivation scan showed `0.45230786 BCH` **at the same address**. The
 * two are not the same code path: the scan calls `adapter.getBalance()`, which
 * had a three-source ladder; the dashboard routes `utxoAccounts` chains through
 * this probe, which had exactly one source — Blockchair — and Blockchair was
 * answering HTTP 430 ("Your IP address is temporary blacklisted"). The comment
 * on `getBalance` had named that exact hazard, and the hardening had been
 * applied to one of the two halves only.
 *
 * So the thing worth pinning is not "the probe returns a number". It is that
 * the probe **survives its primary source failing**, which is invisible to any
 * test that lets every source succeed.
 *
 * ## What each case is for
 *
 * - Blockchair down, Bitcore up → the real-world case, and the regression.
 * - The negative control: every source down must REJECT, never resolve 0. A
 *   probe that reported zero on a total outage would put "you have no money"
 *   in front of someone who does — the original bug, one layer down.
 * - A never-used address must come back `used: false` so the gap walk still
 *   terminates, and a spent-empty one `used: true` so it does not truncate.
 *   `used`, not the balance, drives that walk (see `utxo-account.ts` and the
 *   2026-08-22 LTC incident where funds sat at change index 20) — this is the
 *   half a "just add a fallback" fix gets wrong.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyGetJson } from "./_proxy";
import { bchUtxoAccounts } from "./bch-wallet";

const ADDRESS = "bitcoincash:qrrzf9lungem8cteqd38fy39wqwm2h04054c4sswwx";
const BARE = "qrrzf9lungem8cteqd38fy39wqwm2h04054c4sswwx";
/** The real figure Bitcore returned for this address while the UI showed 0. */
const REAL_SATS = 63891881;

const probe = bchUtxoAccounts[0].probe!;

/**
 * Resolve the mock at call time.
 *
 * ## No `beforeEach` here, deliberately
 *
 * Every case in this file failed with `unexpected URL in test: undefined` —
 * the routing implementation ran but received NO arguments — purely because of
 * a `beforeEach(() => mock.mockClear())`. Removing that line turned 7 failures
 * into 7 passes with no change to the assertions or to the code under test.
 *
 * It is worth recording because the symptom is indistinguishable from a real
 * defect: the module under test was demonstrably passing correct URLs the whole
 * time (verified separately by asserting on `mock.calls`), so the failure read
 * as "the probe is broken" when the harness was. Each test installs its own
 * implementation, which is all the isolation this file needs.
 */
const mockFn = () => proxyGetJson as any;

/**
 * Route by URL, so the test exercises the ladder's ORDER rather than assuming
 * it. `blockchair` is verbatim the 430 body the live API returned.
 */
function route(handlers: {
  blockchair?: () => unknown;
  bitcoreBalance?: () => unknown;
  bitcoreTxs?: () => unknown;
}) {
  mockFn().mockImplementation(async (...args: any[]) => {
    const url = String(args[0]);
    if (url.includes("blockchair.com")) {
      if (!handlers.blockchair) throw new Error("blockchair HTTP 430");
      return handlers.blockchair();
    }
    if (url.includes("bitcore.io") && url.includes("/balance")) {
      if (!handlers.bitcoreBalance) throw new Error("bitcore balance down");
      return handlers.bitcoreBalance();
    }
    if (url.includes("bitcore.io") && url.includes("/txs")) {
      if (!handlers.bitcoreTxs) throw new Error("bitcore txs down");
      return handlers.bitcoreTxs();
    }
    throw new Error(`unexpected URL in test: ${url}`);
  });
}

describe("BCH dashboard probe — survives Blockchair's 430", () => {

  it("reports the real balance when Blockchair is blacklisted and Bitcore is up", async () => {
    // `/txs` is asked FIRST (see `bitcoreProbe`): a non-empty coin record
    // settles `used`, and only then is `/balance` consulted.
    route({
      bitcoreTxs: () => [{ mintTxid: "ab".repeat(32), mintIndex: 0, value: REAL_SATS }],
      bitcoreBalance: () => ({ confirmed: REAL_SATS, unconfirmed: 0 }),
    });
    await expect(probe(ADDRESS)).resolves.toEqual({
      balanceSat: REAL_SATS,
      used: true,
    });
  });

  it("asks Bitcore with the BARE cashaddr — the prefixed form returns 0", async () => {
    const seen: string[] = [];
    mockFn().mockImplementation(async (url: string) => {
      seen.push(url);
      if (url.includes("blockchair.com")) throw new Error("430");
      // `/txs` first, then `/balance` once history is established.
      if (url.includes("/txs")) {
        return [{ mintTxid: "ab".repeat(32), mintIndex: 0, value: REAL_SATS }];
      }
      return { confirmed: REAL_SATS, unconfirmed: 0 };
    });
    await probe(ADDRESS);
    const bitcoreCall = seen.find((u) => u.includes("bitcore.io"))!;
    expect(bitcoreCall).toContain(BARE);
    expect(bitcoreCall).not.toContain("bitcoincash:");
  });

  it("costs ONE request for an unused address — the gap walk's common case", async () => {
    // The reorder exists for this. A gap walk only terminates after a run of
    // consecutive unused addresses, so unused is what it probes most; asking
    // /balance first made every one of them cost two requests.
    const seen: string[] = [];
    mockFn().mockImplementation(async (url: string) => {
      seen.push(url);
      if (url.includes("blockchair.com")) throw new Error("430");
      if (url.includes("/txs")) return [];
      throw new Error("/balance must NOT be called for an address with no history");
    });
    await expect(probe(ADDRESS)).resolves.toEqual({ balanceSat: 0, used: false });
    expect(seen.filter((u) => u.includes("bitcore.io"))).toHaveLength(1);
  });

  it("RETRIES a 429 instead of failing the probe", async () => {
    // The bug this pins: a gap walk is 80+ requests and bitcore throttles at
    // roughly 10, so 429s are routine. `resolveUtxoAccountBalance` bails the
    // whole walk on one failed probe and App.tsx throws on an incomplete scan,
    // so treating "slow down" as "no" showed 0 BCH over real funds -- and it
    // could not self-heal, because a deep scan that never completes is never
    // persisted, so the next refresh repeats it.
    let calls = 0;
    mockFn().mockImplementation(async (url: string) => {
      if (url.includes("blockchair.com")) throw new Error("blockchair HTTP 430");
      calls++;
      if (calls === 1) throw new Error("HTTP 429 from bitcore: Rate Limited");
      if (url.includes("/txs")) return [];
      throw new Error("unexpected");
    });
    await expect(probe(ADDRESS)).resolves.toEqual({ balanceSat: 0, used: false });
    expect(calls).toBeGreaterThan(1); // it retried rather than giving up
  }, 20000);

  it("does NOT retry a non-throttle error — that is a real answer", async () => {
    // A 404/500/parse error must rotate to the next source immediately rather
    // than burn four backoffs first.
    let bitcoreCalls = 0;
    mockFn().mockImplementation(async (url: string) => {
      if (url.includes("blockchair.com")) throw new Error("blockchair HTTP 430");
      // haskoin (ahead of bitcore since 2026-09-04) is down in this case.
      if (!url.includes("bitcore.io")) throw new Error("HTTP 503 haskoin");
      bitcoreCalls++;
      throw new Error("HTTP 500 from bitcore: boom");
    });
    await expect(probe(ADDRESS)).rejects.toThrow();
    expect(bitcoreCalls).toBe(1);
  }, 20000);

  it("REJECTS when every source is down — never resolves a zero balance", async () => {
    route({});
    await expect(probe(ADDRESS)).rejects.toThrow();
  });

  it("a never-used address is used:false, so the gap walk still terminates", async () => {
    route({
      bitcoreBalance: () => ({ confirmed: 0, unconfirmed: 0 }),
      bitcoreTxs: () => [],
    });
    await expect(probe(ADDRESS)).resolves.toEqual({ balanceSat: 0, used: false });
  });

  it("a spent-empty address is used:true, so the walk is NOT truncated", async () => {
    route({
      bitcoreBalance: () => ({ confirmed: 0, unconfirmed: 0 }),
      // One coin record: the address received and spent everything.
      bitcoreTxs: () => [{ mintTxid: "ab".repeat(32), mintIndex: 0, value: 1000 }],
    });
    await expect(probe(ADDRESS)).resolves.toEqual({ balanceSat: 0, used: true });
  });

  it("rotates rather than guessing when the coin-record shape is unrecognisable", async () => {
    route({
      bitcoreBalance: () => ({ confirmed: 0, unconfirmed: 0 }),
      bitcoreTxs: () => ({ not: "an array" }),
    });
    // Bitcore cannot establish `used`; Blockchair is down; so the whole probe
    // fails rather than reporting an unproven `used: false`.
    await expect(probe(ADDRESS)).rejects.toThrow();
  });

  it("still uses Blockchair when it is healthy (the fallback is additive)", async () => {
    route({
      blockchair: () => ({
        data: { [BARE]: { address: { balance: 123, transaction_count: 4 } } },
      }),
      bitcoreBalance: () => {
        throw new Error("bitcore must not be needed when blockchair answers");
      },
    });
    // Bitcore is tried FIRST by design, so a healthy Blockchair is reached only
    // after Bitcore declines — assert the ladder still lands on a real answer.
    mockFn().mockImplementation(async (url: string) => {
      if (url.includes("bitcore.io")) throw new Error("bitcore down");
      return { data: { [BARE]: { address: { balance: 123, transaction_count: 4 } } } };
    });
    await expect(probe(ADDRESS)).resolves.toEqual({ balanceSat: 123, used: true });
  });
});

// =========================================================================
// 2026-09-04 — haskoin ahead of Bitcore, and the batch probe
// =========================================================================
//
// The Bitcore ladder above was the fix for "0 over real funds"; it worked
// and it was too slow — 98 requests and 13.7 s per deep scan, serialized
// behind Bitcore's rate limit. haskoin now answers first (balance AND used
// in one row, no second request) and answers a whole block via `probeMany`.
// The cases above still pass because haskoin is mocked as DOWN in them,
// which is exactly the fallback they exist to prove.

const HASKOIN_ROW = { address: ADDRESS, confirmed: REAL_SATS, unconfirmed: 0, utxo: 4, txs: 4, received: REAL_SATS };

describe("BCH probe — haskoin first (2026-09-04)", () => {
  it("answers from haskoin in ONE request and never touches Bitcore", async () => {
    const seen: string[] = [];
    mockFn().mockImplementation(async (url: string) => {
      seen.push(url);
      if (url.includes("haskoin-store/bch/address/") && url.endsWith("/balance")) return HASKOIN_ROW;
      throw new Error(`should not have been asked: ${url}`);
    });
    await expect(probe(ADDRESS)).resolves.toEqual({ balanceSat: REAL_SATS, used: true });
    expect(seen).toHaveLength(1);
  });

  it("rotates to the SECOND haskoin deployment, then Bitcore, when the first is down", async () => {
    const seen: string[] = [];
    mockFn().mockImplementation(async (url: string) => {
      seen.push(url);
      if (url.includes("api.blockchain.info")) throw new Error("HTTP 503");
      if (url.includes("api.haskoin.com")) return HASKOIN_ROW;
      throw new Error(`should not have been asked: ${url}`);
    });
    await expect(probe(ADDRESS)).resolves.toEqual({ balanceSat: REAL_SATS, used: true });
    expect(seen.map((u) => u.split("/")[2])).toEqual(["api.blockchain.info", "api.haskoin.com"]);
  });

  it("probeMany asks ONE haskoin batch for a whole block", async () => {
    const seen: string[] = [];
    const block = [ADDRESS, "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6"];
    mockFn().mockImplementation(async (url: string) => {
      seen.push(url);
      if (url.includes("/address/balances?addresses=")) {
        return [HASKOIN_ROW, { address: block[1], confirmed: 0, unconfirmed: 0, utxo: 0, txs: 0, received: 0 }];
      }
      throw new Error(`should not have been asked: ${url}`);
    });
    const r = await bchUtxoAccounts[0].probeMany!(block);
    expect(seen).toHaveLength(1);
    expect(r).toEqual([
      { balanceSat: REAL_SATS, used: true },
      { balanceSat: 0, used: false },
    ]);
  });
});
