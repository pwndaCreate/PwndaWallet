/**
 * `getBalance` must REJECT on failure — never resolve to a zero.
 *
 * Reported 2026-08-13 as "my ADA balance isn't refreshing". It was refreshing
 * fine; the fetch was failing and `ada-wallet.ts` was catching the error and
 * returning "0.000000". Five adapters shared the pattern (ADA, ALGO, CFX,
 * HBAR, SUI), and it is worse than a cosmetic bug:
 *
 *   1. It states something false about the user's money. "0.000000 ADA" and
 *      "we couldn't reach Koios" are very different claims, and a user can act
 *      on the first one.
 *   2. It defeats the error path. `App.tsx::refreshAllBalances` writes "—"
 *      only when `getBalance` REJECTS — a resolved zero is indistinguishable
 *      from a real balance, so the UI can never show "unknown".
 *   3. It defeats the retry. The 60s balance poll added the same day re-runs
 *      the fetch, re-swallows the failure, and writes the same zero forever —
 *      which is exactly why it looked like the value was frozen.
 *
 * A genuinely empty address must still report zero. That case is proven
 * separately below, so these tests can't be satisfied by making everything
 * throw unconditionally.
 *
 * NOT covered here, deliberately: `probeCurrentXmrHeight` and
 * `getLegacyAdaBalanceLovelace` still return 0 on failure. Both are PROBES
 * whose callers ask "is there anything here?" during a scan — "couldn't check"
 * and "nothing here" are legitimately the same answer for them, and both
 * document it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_proxy", () => ({
  proxyGetJson: vi.fn(),
  proxyPostJson: vi.fn(),
  httpProxyCall: vi.fn(),
}));

import { proxyPostJson, httpProxyCall } from "./_proxy";
import { adaAdapter } from "./ada-wallet";
import { algoAdapter } from "./algo-wallet";
import { hbarAdapter } from "./hbar-wallet";
import { suiAdapter } from "./sui-wallet";

const mockPost = proxyPostJson as unknown as ReturnType<typeof vi.fn>;
const mockProxyCall = httpProxyCall as unknown as ReturnType<typeof vi.fn>;

/** A plausible mainnet-shaped address per chain; never actually contacted. */
const ADDR = {
  ada: "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv",
  algo: "MFRGG424XZH2FGHM4E5EIVFPP4WMFBGYHKQXO2MAMPLE7MTQKEXAMPLE4",
  hbar: "0x302a300506032b6570032100aabbccddeeff00112233445566778899aabbccddeeff001122334455667788",
  sui: "0x0000000000000000000000000000000000000000000000000000000000000001",
};

beforeEach(() => {
  vi.restoreAllMocks();
  mockPost.mockReset();
  mockProxyCall.mockReset();
});

describe("getBalance rejects on lookup failure (never a fake zero)", () => {
  it("ADA — Koios unreachable", async () => {
    mockPost.mockRejectedValue(new Error("network down"));
    await expect(adaAdapter.getBalance(ADDR.ada)).rejects.toThrow();
  });

  it("ALGO — indexer returns 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    );
    await expect(algoAdapter.getBalance(ADDR.algo)).rejects.toThrow();
  });

  it("HBAR — mirror node returns 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }))
    );
    await expect(hbarAdapter.getBalance(ADDR.hbar)).rejects.toThrow();
  });

  it("SUI — RPC call fails", async () => {
    mockProxyCall.mockRejectedValue(new Error("connection refused"));
    await expect(suiAdapter.getBalance(ADDR.sui)).rejects.toThrow();
  });
});

describe("a genuinely empty address still reports zero", () => {
  // Without these, the tests above could be satisfied by throwing always —
  // which would replace one wrong answer with a different wrong answer.

  it("ADA — Koios returns no row for an unused address", async () => {
    mockPost.mockResolvedValue([]);
    await expect(adaAdapter.getBalance(ADDR.ada)).resolves.toBe("0.000000");
  });

  it("ADA — Koios returns an explicit zero balance", async () => {
    mockPost.mockResolvedValue([{ balance: "0" }]);
    await expect(adaAdapter.getBalance(ADDR.ada)).resolves.toBe("0.000000");
  });

  it("ALGO — 404 means never funded, not a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    );
    await expect(algoAdapter.getBalance(ADDR.algo)).resolves.toBe("0.000000");
  });

  it("HBAR — a successful query with no account keeps its own distinct message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accounts: [] }) }))
    );
    await expect(hbarAdapter.getBalance(ADDR.hbar)).resolves.toBe(
      "No account (create on network)"
    );
  });
});
