/**
 * The browser sandbox can show the BTC "Speed up" panel (operator request,
 * 2026-10-01): under `wallet_populated`, the real wallet code — history,
 * account merge, the speed-up's reads, the fee estimate — runs against the
 * real mock dispatcher (`tauri-mocks.ts`, as `suiSandbox.test.ts` does) and
 * finds one unconfirmed, replaceable BTC send and the pending swap whose
 * deposit it is. Nothing here may reach a network: a URL the mock does not
 * answer fails the test instead of passing through.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getMock: null as null | ((cmd: string, args?: unknown) => unknown),
  getFetchMock: null as null | ((url: string, method: string, body: unknown) => { status: number; body: string } | null),
}));

vi.mock("../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => h.getMock!(cmd, args)),
}));
// tauri-plugin-store, routed to the mock's own store handler — what the
// browser sandbox's `__TAURI_INTERNALS__` shim does.
vi.mock("@tauri-apps/plugin-store", () => {
  const open = async (path: string) => {
    const rid = h.getMock!("plugin:store|load", { path }) as number;
    return {
      get: async (key: string) => {
        const [v, ok] = h.getMock!("plugin:store|get", { rid, key }) as [unknown, boolean];
        return ok ? v : undefined;
      },
      set: async (key: string, value: unknown) => {
        h.getMock!("plugin:store|set", { rid, key, value });
      },
      save: async () => {},
      entries: async () => h.getMock!("plugin:store|entries", { rid }) as [string, unknown][],
    };
  };
  return { Store: { load: open }, load: open };
});

import { btcAdapter } from "../wallets/btc-wallet";
import { quoteBtcSpeedUp, speedUpBtcTransaction } from "../wallets/btc-rbf";
import { accountTxHistory } from "../wallets/utxo-account-history";
import { withoutReplacedRows } from "../wallets/tx-replacements";
import { DEFAULT_SPEED_UP_DEPS, speedUpCandidate } from "./btcSpeedUp";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FROM = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const CHANGE = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
const DEPOSIT = "bc1qe5xk329xk5tfz3ldvfqxqxahajdva5jl4jzcmy";
const TXID = "317a82a5ddce9b6c997ae6fd6491d0e6e010f2db84ebcf5b0b32d9918615d703";

beforeAll(async () => {
  vi.stubEnv("VITE_MOCK_STATE", "wallet_populated");
  const mocks = await import("./tauri-mocks");
  h.getMock = mocks.getMock;
  h.getFetchMock = mocks.getFetchMock;
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const r = h.getFetchMock!(url, String(init?.method ?? "GET"), init?.body);
    if (!r) throw new Error(`the sandbox has no answer for ${url}; a test must not reach the network`);
    return new Response(r.body, { status: r.status });
  });
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("wallet_populated: a stuck BTC send the panel can speed up", () => {
  it("the history lists it pending at the displayed address and at its change address", async () => {
    const atFrom = (await btcAdapter.getTransactionHistory(FROM)).items;
    const atChange = (await btcAdapter.getTransactionHistory(CHANGE)).items;
    expect(atFrom[0]).toMatchObject({ hash: TXID, direction: "pending", confirmations: 0 });
    expect(atChange.map((t) => t.hash)).toEqual([TXID]);
    // The account merge: 0.01 BTC out and a 282 sat fee — what the row shows,
    // and a row the details offer "Speed up" for.
    const [merged] = accountTxHistory({ [`bitcoin:${FROM}`]: atFrom, [`bitcoin:${CHANGE}`]: atChange }, "bitcoin");
    expect(merged).toMatchObject({ hash: TXID, direction: "pending", amount: "0.01000000", fee: "0.00000282", counterparty: DEPOSIT });
    expect(speedUpCandidate(merged)).toBe(true);
  });

  it("the account scan finds the change address used — so its history is read — and the balance is unchanged", async () => {
    const { resolveUtxoAccountBalance } = await import("../wallets/utxo-account-balance");
    const s = await resolveUtxoAccountBalance("bitcoin", btcAdapter.utxoAccounts!, SEED, FROM);
    expect(s.complete).toBe(true);
    expect(s.entries.find((e) => e.address === CHANGE)).toMatchObject({ path: "m/84'/0'/0'/1/0", used: true });
    expect(s.totalSat).toBe(12_500_000); // the documented 0.125 BTC of the funded mock
  });

  it("the speed-up's reads all answer: 2.0 sat/vB now, the fast rate 14 sat/vB, the change pays", async () => {
    expect(await DEFAULT_SPEED_UP_DEPS.fastRate()).toBe(14);
    const quote = await quoteBtcSpeedUp({ txid: TXID, secret: { mnemonic: SEED }, targetRate: 14 });
    expect(quote).toMatchObject({
      currentRate: 2,
      newFeeSat: 14 * 141,
      extraFeeSat: 14 * 141 - 282,
      change: { address: CHANGE, beforeSat: 999_718, afterSat: 999_718 - (14 * 141 - 282) },
      recipients: [{ vout: 0, address: DEPOSIT, valueSat: 1_000_000 }],
    });
  });

  it("the pending BTC → USDC-ETH swap whose deposit it is", async () => {
    const { loadSwapHistory } = await import("../features/swap/swap-history-store");
    const rows = await loadSwapHistory();
    expect(rows.find((r) => r.sourceTxHash === TXID)).toMatchObject({
      fromAsset: "BTC",
      toAsset: "USDC-ETH",
      status: "pending",
      depositAddress: DEPOSIT,
    });
  });

  it("a confirmed press: the mock's broadcast takes the replacement, and the original leaves the wallet's history", async () => {
    const quote = await quoteBtcSpeedUp({ txid: TXID, secret: { mnemonic: SEED }, targetRate: 14 });
    const r = await speedUpBtcTransaction({
      txid: TXID,
      secret: { mnemonic: SEED },
      targetRate: 14,
      expectFeeSat: quote.newFeeSat,
    });
    expect(r).toMatchObject({ pending: true, replaces: TXID });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    const rows = (await btcAdapter.getTransactionHistory(FROM)).items;
    expect(rows[0].hash).toBe(TXID); // the mock keeps listing it…
    expect(withoutReplacedRows("bitcoin", rows).map((t) => t.hash)).not.toContain(TXID); // …the wallet does not
  });
});

describe("every other scenario: no such send", () => {
  it("idle: the BTC history is empty", async () => {
    vi.stubEnv("VITE_MOCK_STATE", "idle");
    try {
      expect((await btcAdapter.getTransactionHistory(FROM)).items).toEqual([]);
    } finally {
      vi.stubEnv("VITE_MOCK_STATE", "wallet_populated");
    }
  });
});
