/**
 * The browser sandbox answers every Sui call the wallet makes (operator
 * request, 2026-10-01).
 *
 * Since 2026-10-01 Sui's balance, history, by-hash read and whole send go
 * over GraphQL (`wallets/sui-wallet.ts`, `session-send.ts::executeSuiTransfer`).
 * The sandbox mock (`lib/tauri-mocks.ts`) answered the balance and the gas
 * price only: its history was in a typed layout the adapter no longer reads
 * (one row, no amount), the by-hash read, the send's state read, dry run,
 * submit and status lookup answered 503 "no mock", and a send stopped before
 * any of them, at the wrong-key guard, because the mocked session address
 * was a placeholder.
 *
 * These tests run the real adapter and the real send against the real mock
 * dispatcher (`getMock`, as `p2pHistorySandbox.test.ts` does), so what the
 * lead sees under `wallet_populated`, `degraded` and the unfunded default is
 * pinned here first.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getMock: null as null | ((cmd: string, args?: unknown) => unknown) }));

vi.mock("../../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => h.getMock!(cmd, args)),
}));

import {
  readSuiSendState,
  suiAdapter,
  suiTransactionStatus,
} from "../../wallets/sui-wallet";
import { executeSuiTransfer } from "./session-send";

/** The bypass's Sui account: the public BIP39 test seed's. */
const ME = suiAdapter.deriveFromMnemonic(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
).address;
const TO = "0x" + "ab".repeat(32);

beforeAll(async () => {
  vi.stubEnv("VITE_MOCK_STATE", "wallet_populated");
  h.getMock = (await import("../../lib/tauri-mocks")).getMock;
});
afterAll(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.stubEnv("VITE_MOCK_STATE", "wallet_populated");
  vi.restoreAllMocks();
});

describe("wallet_populated: every Sui call has an answer, in the live layout", () => {
  it("the balance, and a history whose rows have amounts (the send's gas as its fee)", async () => {
    await expect(suiAdapter.getBalance(ME)).resolves.toBe("60.000000000");
    const { items } = await suiAdapter.getTransactionHistory(ME);
    // Was one row with amount "" (the old typed layout).
    expect(items.map((r) => [r.direction, r.amount, r.fee])).toEqual([
      ["out", "0.499880120", "0.000119880"],
      ["in", "60.500000000", undefined],
    ]);
    expect(items[0].counterparty).toBe("0x" + "d2".repeat(32));
    expect(items[1].counterparty).toBe("0x" + "c1".repeat(32));
  });

  it("the details' by-hash read names both sides; an unknown digest is null", async () => {
    const [send] = (await suiAdapter.getTransactionHistory(ME)).items;
    await expect(suiAdapter.getTransactionParties!(send.hash, ME)).resolves.toEqual({
      from: [ME],
      to: ["0x" + "d2".repeat(32)],
      source: "graphql.mainnet.sui.io",
    });
    await expect(suiAdapter.getTransactionParties!("7DHu9w6TDmXTkUJTMZoyWcBGpuBWxKu2TcFvWzaDrSTU", ME)).resolves.toBeNull();
  });

  it("the send runs through every call: state, dry run, sign, submit; the status lookup knows its digest", async () => {
    await expect(readSuiSendState(ME)).resolves.toMatchObject({
      referenceGasPrice: 100n,
      coinBalance: 60_000_000_000n,
      addressBalance: 0n,
      coins: [{ balance: 60_000_000_000n }],
    });
    const warn = vi.spyOn(console, "warn");
    // Was: "Sending from this Sui wallet isn't supported yet…" (the
    // placeholder session address), before any chain call.
    const { txHash } = await executeSuiTransfer({ sessionId: "sandbox", fromAddress: ME, to: TO, amount: "0.1" });
    expect(txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    // The mocked submit answered the digest the send computed (no
    // "[sui] GraphQL returned digest …" warning), and recorded it.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("[sui] GraphQL returned digest"))).toBe(false);
    await expect(suiTransactionStatus(txHash)).resolves.toEqual({ status: "SUCCESS" });
  });
});

describe("degraded: every Sui call fails, so the UI shows its data-absent states", () => {
  it("balance, history, details and send each fail instead of answering", async () => {
    vi.stubEnv("VITE_MOCK_STATE", "degraded");
    await expect(suiAdapter.getBalance(ME)).rejects.toThrow(/HTTP 503 sandbox-degraded/);
    await expect(suiAdapter.getTransactionHistory(ME)).rejects.toThrow(/Sui history could not be read/);
    await expect(
      suiAdapter.getTransactionParties!("548jb4wcUtpbNS1TAva8TXJmeXd5QpCCXUzNVogwpzMR", ME),
    ).rejects.toThrow(/could not be read/);
    await expect(executeSuiTransfer({ sessionId: "sandbox", fromAddress: ME, to: TO, amount: "0.1" })).rejects.toThrow(
      /^Sui could not be read to prepare the transfer \(.*503.*\)\. Nothing was sent\.$/,
    );
  });
});

describe("unfunded (the default scenario): a real zero, and a send refused before signing", () => {
  it("balance 0, no history, and the send says there is no SUI for the fee", async () => {
    vi.stubEnv("VITE_MOCK_STATE", "idle");
    await expect(suiAdapter.getBalance(ME)).resolves.toBe("0.000000000");
    await expect(suiAdapter.getTransactionHistory(ME)).resolves.toEqual({ items: [] });
    await expect(executeSuiTransfer({ sessionId: "sandbox", fromAddress: ME, to: TO, amount: "0.1" })).rejects.toThrow(
      "This Sui account has no SUI to pay the network fee. Nothing was sent.",
    );
  });
});
