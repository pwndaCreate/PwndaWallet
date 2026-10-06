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
 *
 * 2026-10-06 (`@mysten/sui` 2.x): the mock's 60 SUI are 5 in a coin and 55 in
 * the address balance, so a sandbox send can be paid from the coin, from the
 * address balance, or from both; each is built by the real SDK and decoded.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getMock: null as null | ((cmd: string, args?: unknown) => unknown) }));

vi.mock("../../lib/tauri", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => h.getMock!(cmd, args)),
}));

import { bcs } from "@mysten/sui/bcs";
import { invoke } from "../../lib/tauri";
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
    // 2026-10-06: the 60 SUI are 5 in a coin and 55 in the address balance,
    // with the chain id and the epoch an address-balance transfer names.
    await expect(readSuiSendState(ME)).resolves.toMatchObject({
      referenceGasPrice: 100n,
      epoch: 1272n,
      chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
      coinBalance: 5_000_000_000n,
      addressBalance: 55_000_000_000n,
      coins: [{ balance: 5_000_000_000n }],
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

  // 2026-10-06 (`@mysten/sui` 2.x): what the lead can send in the sandbox, and
  // which way each is paid. The budget is the mock's dry run: 0.002176 SUI.
  it.each([
    ["0.1", "the coin", (tx: any) => {
      expect(tx.gasData.payment).toHaveLength(1);
      expect(tx.expiration).toEqual({ None: true, $kind: "None" });
      expect(tx.kind.ProgrammableTransaction.commands[0]).toHaveProperty("SplitCoins");
    }],
    ["10", "the address balance", (tx: any) => {
      expect(tx.gasData.payment).toEqual([]);
      expect(tx.expiration.ValidDuring).toMatchObject({ minEpoch: "1272", maxEpoch: "1273" });
      expect(tx.kind.ProgrammableTransaction.inputs[0].FundsWithdrawal.reservation.MaxAmountU64).toBe("10000000000");
    }],
    ["59", "both", (tx: any) => {
      expect(tx.gasData.payment).toHaveLength(1);
      // 59 SUI + the budget - the 5 SUI coin.
      expect(tx.kind.ProgrammableTransaction.inputs[0].FundsWithdrawal.reservation.MaxAmountU64).toBe("54002176000");
      expect(tx.kind.ProgrammableTransaction.commands[1]).toHaveProperty("MergeCoins");
    }],
  ] as const)("a send of %s SUI is paid from %s, and runs to sent", async (amount, _source, check) => {
    vi.mocked(invoke).mockClear();
    const { txHash } = await executeSuiTransfer({ sessionId: "sandbox", fromAddress: ME, to: TO, amount });
    const signed = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "swap_sign_sui_tx");
    expect(signed).toHaveLength(1);
    const b64 = (signed[0][1] as { input: { txBytesBase64: string } }).input.txBytesBase64;
    check(bcs.TransactionData.parse(Buffer.from(b64, "base64")).V1);
    await expect(suiTransactionStatus(txHash)).resolves.toEqual({ status: "SUCCESS" });
  });

  it("past what both hold with the fee: refused before signing, saying where the SUI is", async () => {
    vi.mocked(invoke).mockClear();
    await expect(executeSuiTransfer({ sessionId: "sandbox", fromAddress: ME, to: TO, amount: "59.999" })).rejects.toThrow(
      "This Sui account holds 60 SUI (5 in coin objects, 55 in its address balance), not enough to send 59.999 SUI " +
        "and pay the network fee (up to 0.002176 SUI). Nothing was sent.",
    );
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "swap_sign_sui_tx")).toBe(false);
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
