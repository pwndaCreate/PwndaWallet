/**
 * Derivation-selection semantics for every chain that probes balances.
 *
 * Reported against ADA, but BTC / LTC / SOL / ALGO shared the defect.
 *
 * The scanner DOES auto-select — it picks the highest-balance candidate and
 * only falls back to the standard CIP-1852 path when nothing is funded. The
 * bug reported 2026-08-13 ("my ADA address has no balance, but the derivation
 * panel shows one that does") wasn't a missing feature; it was the fallback
 * firing for the wrong reason.
 *
 * Every probe reported 0 on error, so a Koios outage during import was
 * indistinguishable from "all derivations are empty". The scan then committed
 * the user to the standard path silently and permanently. By the time they
 * opened the panel, Koios was reachable again and their funded address was
 * sitting there in 9px grey text.
 *
 * These tests pin both halves: the auto-selection still works, AND a failed
 * sweep is reported as inconclusive rather than as "nothing found".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../wallets/_proxy", () => ({
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyPostJson } from "../../wallets/_proxy";
import { detectAda } from "./derivation-detector";

const mockPost = proxyPostJson as unknown as ReturnType<typeof vi.fn>;

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * Koios `/address_info` echoes the address it was asked about, so a fake can
 * fund one specific address and report every other as empty.
 */
function koiosFunding(fundedAddress: string | null, lovelace: string) {
  return async (_url: string, body: { _addresses: string[] }) => {
    const asked = body._addresses[0];
    if (fundedAddress && asked === fundedAddress) {
      return [{ address: asked, balance: lovelace }];
    }
    return [{ address: asked, balance: "0" }];
  };
}

beforeEach(() => {
  mockPost.mockReset();
});

describe("detectAda — auto-selection", () => {
  it("falls back to the standard path when every address is genuinely empty", async () => {
    mockPost.mockImplementation(koiosFunding(null, "0"));
    const r = await detectAda(MNEMONIC);
    expect(r.recommendedId).toBe("cip1852");
    // Genuinely empty — we DID look. Must not be flagged inconclusive, or the
    // UI would nag about connectivity that is fine.
    expect(r.probesInconclusive).toBe(false);
  });

  it("auto-selects the funded derivation over the standard default", async () => {
    // Find whichever non-default candidate the scan produces, fund it, re-run.
    mockPost.mockImplementation(koiosFunding(null, "0"));
    const first = await detectAda(MNEMONIC);
    const nonDefault = first.candidates.find((c) => !c.isDefault);
    expect(nonDefault, "expected at least one non-default candidate").toBeTruthy();

    mockPost.mockImplementation(koiosFunding(nonDefault!.address, "123456789"));
    const r = await detectAda(MNEMONIC);

    expect(r.recommendedId).toBe(nonDefault!.id);
    expect(r.recommendedId).not.toBe("cip1852");
    const picked = r.candidates.find((c) => c.id === r.recommendedId)!;
    expect(picked.hasActivity).toBe(true);
    expect(picked.balance).toBeCloseTo(123.456789, 6);
  });

  it("picks the RICHEST when several derivations are funded", async () => {
    mockPost.mockImplementation(koiosFunding(null, "0"));
    const first = await detectAda(MNEMONIC);
    const [a, b] = first.candidates;
    expect(b, "need two candidates for this test").toBeTruthy();

    mockPost.mockImplementation(async (_u: string, body: { _addresses: string[] }) => {
      const asked = body._addresses[0];
      if (asked === a.address) return [{ address: asked, balance: "1000000" }]; // 1 ADA
      if (asked === b.address) return [{ address: asked, balance: "9000000" }]; // 9 ADA
      return [{ address: asked, balance: "0" }];
    });

    const r = await detectAda(MNEMONIC);
    expect(r.recommendedId).toBe(b.id);
    expect(r.ambiguous).toBe(true); // more than one funded → user should confirm
  });
});

describe("detectAda — a failed sweep is not 'nothing found'", () => {
  it("flags probesInconclusive when every lookup throws", async () => {
    mockPost.mockRejectedValue(new Error("Koios unreachable"));
    const r = await detectAda(MNEMONIC);

    // Still recommends the default — there is nothing better to pick — but
    // the caller can now tell this apart from a verified empty result, which
    // is the whole point. Before this flag existed, an outage during import
    // silently locked the user onto the wrong derivation.
    expect(r.recommendedId).toBe("cip1852");
    expect(r.probesInconclusive).toBe(true);
    expect(r.candidates.every((c) => c.probeFailed === true)).toBe(true);
  });

  it("does NOT flag inconclusive when a probe succeeded and found funds", async () => {
    mockPost.mockImplementation(koiosFunding(null, "0"));
    const first = await detectAda(MNEMONIC);
    const target = first.candidates[0];

    mockPost.mockImplementation(koiosFunding(target.address, "5000000"));
    const r = await detectAda(MNEMONIC);
    expect(r.probesInconclusive).toBe(false);
  });
});

describe("detectAda — retries a blind sweep", () => {
  it("recovers the funded derivation when the FIRST sweep fails entirely", async () => {
    // The exact reported scenario: Koios is briefly unreachable while the
    // import spinner is up, then recovers. Without the retry the scan would
    // conclude "nothing funded", pick CIP-1852, and never look again.
    mockPost.mockImplementation(koiosFunding(null, "0"));
    const probe = await detectAda(MNEMONIC);
    const funded = probe.candidates.find((c) => !c.isDefault)!;

    let sweep = 0;
    mockPost.mockImplementation(async (_u: string, body: { _addresses: string[] }) => {
      // Each sweep issues one call per candidate; fail every call in the first.
      if (sweep++ < probe.candidates.length) throw new Error("Koios unreachable");
      const asked = body._addresses[0];
      return asked === funded.address
        ? [{ address: asked, balance: "42000000" }]
        : [{ address: asked, balance: "0" }];
    });

    const r = await detectAda(MNEMONIC);
    expect(r.probesInconclusive).toBe(false);
    expect(r.recommendedId).toBe(funded.id);
    expect(r.recommendedId).not.toBe("cip1852");
  });

  it("does not retry when the first sweep was conclusive", async () => {
    // A genuinely-empty wallet must not pay the retry delay on every import.
    mockPost.mockImplementation(koiosFunding(null, "0"));
    mockPost.mockClear();
    const before = mockPost.mock.calls.length;
    const r = await detectAda(MNEMONIC);
    const calls = mockPost.mock.calls.length - before;

    expect(r.probesInconclusive).toBe(false);
    expect(
      calls,
      "a conclusive sweep should probe each candidate exactly once"
    ).toBe(r.candidates.length);
  });
});

/**
 * The same guarantee, for every chain that probes balances.
 *
 * ADA was reported, but BTC / LTC / SOL / ALGO had the identical
 * `catch { return 0 }` defect: a failed sweep was indistinguishable from an
 * empty wallet, so an RPC blip during import silently selected the default
 * derivation. These assert the shared contract rather than re-testing each
 * chain's candidate list.
 *
 * SOL / LTC / ALGO probe through their wallet adapters, so failure is injected
 * by making the adapter's own network layer throw; BTC probes `fetch` directly.
 */
describe("every balance-probing detector reports a blind sweep", () => {
  it("SOL — all RPCs failing is inconclusive, not 'unfunded'", async () => {
    mockPost.mockRejectedValue(new Error("rpc down"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rpc down"); }));
    const { detectSol } = await import("./derivation-detector");
    const r = await detectSol(MNEMONIC);
    expect(r.probesInconclusive).toBe(true);
    // Still returns a usable recommendation — there is nothing better to pick.
    expect(r.recommendedId).toBeTruthy();
  }, 20_000);

  it("BTC — every explorer failing is inconclusive, not 'unfunded'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("explorer down"); }));
    const { detectBtc } = await import("./derivation-detector");
    const r = await detectBtc(MNEMONIC);
    expect(r.probesInconclusive).toBe(true);
    expect(r.recommendedId).toBeTruthy();
  }, 20_000);

  it("BTC — a successful probe of an empty address is NOT inconclusive", async () => {
    // The distinction the whole change rests on: we looked, and it's empty.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
          mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
        }),
      }))
    );
    const { detectBtc } = await import("./derivation-detector");
    const r = await detectBtc(MNEMONIC);
    expect(r.probesInconclusive).toBe(false);
  }, 20_000);
});
