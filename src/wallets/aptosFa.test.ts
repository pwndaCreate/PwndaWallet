/**
 * The Aptos fungible-asset legs — USDT and USDC on Aptos (2026-10-06;
 * operator request 2026-10-01): balance, the send (APT's own sign-once,
 * settle-by-hash steps with a `primary_fungible_store::transfer` payload),
 * the Send modal's APT check, and the token's history.
 *
 * The SDK's `Aptos` client is faked as in `aptSend.test.ts`; the REST API,
 * the views and the indexer are scripted with the layouts read live on
 * 2026-10-06 (USDt/USDC transfers: `primary_fungible_store::transfer`,
 * arguments `[{inner: metadata}, recipient, amount]`). Addresses invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apt = vi.hoisted(() => ({
  HASH: "0x" + "7a".repeat(32),
  builds: [] as any[],
  sims: [] as any[],
  signed: 0,
  simResult: {} as any,
  submit: (async () => ({})) as () => Promise<any>,
}));

vi.mock("@aptos-labs/ts-sdk", async (importOriginal) => {
  const actual: any = await importOriginal();
  class FakeAptos {
    transaction = {
      build: {
        simple: async (args: any) => {
          apt.builds.push(args);
          return { rawTransaction: { sequence_number: 3n }, built: args };
        },
      },
      simulate: {
        simple: async (args: any) => {
          apt.sims.push(args);
          return [apt.simResult];
        },
      },
      sign: () => {
        apt.signed++;
        return { authenticator: true };
      },
      submit: { simple: () => apt.submit() },
    };
  }
  return { ...actual, Aptos: FakeAptos, generateUserTransactionHash: () => apt.HASH };
});

import { APT_CONFIRM, aptAdapter, aptosHistoryRow, clearAptosHistoryCache, normalizeAptosAddress } from "./apt-wallet";
import {
  aptosFaRefusalText,
  aptosFaSendCostOctas,
  clearAptosFaCaches,
  usdcAptosAdapter,
  usdtAptosAdapter,
} from "./aptos-fa-wallet";
import { aptosFaHistoryAsset } from "./apt-wallet";

const API = "https://api.mainnet.aptoslabs.com/v1";
const USDT_META = "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b";
const USDC_META = "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";
const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const me = usdtAptosAdapter.deriveFromMnemonic(ABANDON);
const ME = normalizeAptosAddress(me.address);
const THEM = "0x" + "ab".repeat(32);

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Net {
  /** Token units by `${metadata}|${owner}`. */
  fa: Record<string, string>;
  /** Owners with a primary store, by `${metadata}|${owner}`. */
  stores: Set<string>;
  /** APT octas by owner, for `coin::balance`. */
  apt: Record<string, string>;
  viewStatus: number;
  byHash: "ok" | "failed";
  views: any[];
}
let net: Net;

async function aptosFetch(input: unknown, init?: { body?: unknown }) {
  const url = String(input);
  if (url === `${API}/view`) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    net.views.push(body);
    if (net.viewStatus !== 200) return reply(net.viewStatus, { message: "down" });
    const [owner, meta] = body.arguments as string[];
    if (body.function === "0x1::primary_fungible_store::balance") return reply(200, [net.fa[`${meta}|${owner}`] ?? "0"]);
    if (body.function === "0x1::primary_fungible_store::primary_store_exists") return reply(200, [net.stores.has(`${meta}|${owner}`)]);
    if (body.function === "0x1::coin::balance") return reply(200, [net.apt[owner] ?? "0"]);
  }
  if (url === `${API}/estimate_gas_price`) return reply(200, { gas_estimate: 100 });
  if (url === API) return reply(200, { ledger_timestamp: String(BigInt(Math.floor(Date.now() / 1000)) * 1_000_000n) });
  if (url === `${API}/transactions/by_hash/${apt.HASH}`) {
    return reply(200, {
      type: "user_transaction",
      hash: apt.HASH,
      success: net.byHash === "ok",
      vm_status: net.byHash === "ok" ? "Executed successfully" : "Move abort in 0x1::fungible_asset: EINSUFFICIENT_BALANCE(0x10004)",
    });
  }
  throw new Error(`unscripted fetch ${url}`);
}

const savedConfirm = { ...APT_CONFIRM };
beforeEach(() => {
  apt.builds = [];
  apt.sims = [];
  apt.signed = 0;
  apt.simResult = { success: true, vm_status: "Executed successfully", gas_used: "153", gas_unit_price: "100" };
  apt.submit = async () => ({ hash: apt.HASH });
  net = {
    fa: { [`${USDT_META}|${ME}`]: "48250000" },
    stores: new Set([`${USDT_META}|${ME}`]),
    apt: { [ME]: "100000000" }, // 1 APT
    viewStatus: 200,
    byHash: "ok",
    views: [],
  };
  Object.assign(APT_CONFIRM, { pollMs: 2, expirySecs: 1, ledgerMarginSecs: 0, graceMs: 30 });
  clearAptosFaCaches();
  vi.stubGlobal("fetch", vi.fn(aptosFetch));
});
afterEach(() => {
  Object.assign(APT_CONFIRM, savedConfirm);
  vi.unstubAllGlobals();
  clearAptosHistoryCache();
});

describe("balance", () => {
  it("reads the primary store of the leg's own metadata object", async () => {
    expect(await usdtAptosAdapter.getBalance(me.address)).toBe("48.25");
    expect(net.views.at(-1)).toEqual({
      function: "0x1::primary_fungible_store::balance",
      type_arguments: ["0x1::fungible_asset::Metadata"],
      arguments: [ME, USDT_META],
    });
    // Another asset's store is another balance: none held.
    expect(await usdcAptosAdapter.getBalance(me.address)).toBe("0");
  });

  it("throws on a node failure — never a zero", async () => {
    net.viewStatus = 503;
    await expect(usdtAptosAdapter.getBalance(me.address)).rejects.toThrow(/HTTP 503/);
  });
});

describe("sending", () => {
  it("is primary_fungible_store::transfer of the metadata, priced by simulation, signed once, settled by hash", async () => {
    await expect(usdtAptosAdapter.sendTransaction(me.privateKey, THEM, "12.5")).resolves.toEqual({ hash: apt.HASH });
    expect(apt.builds).toHaveLength(2); // the simulated draft, then the one that is signed
    for (const b of apt.builds) {
      expect(b.data).toEqual({
        function: "0x1::primary_fungible_store::transfer",
        typeArguments: ["0x1::fungible_asset::Metadata"],
        functionArguments: [USDT_META, THEM, 12_500_000n],
      });
    }
    expect(apt.sims).toHaveLength(1);
    expect(apt.signed).toBe(1);
    // APT's own gas rule: 1.5x the simulated use, never below 2,000 units.
    expect(apt.builds[1].options).toMatchObject({ maxGasAmount: 2_000, gasUnitPrice: 100, accountSequenceNumber: 3n });
  });

  it("refuses a recipient that is not a full Aptos address before anything is built", async () => {
    await expect(usdtAptosAdapter.sendTransaction(me.privateKey, "0x" + "ab".repeat(20), "1")).rejects.toThrow(/Ethereum address/);
    await expect(usdtAptosAdapter.sendTransaction(me.privateKey, THEM, "0")).rejects.toThrow(/greater than zero/);
    await expect(usdtAptosAdapter.sendTransaction(me.privateKey, THEM, "1.0000001")).rejects.toThrow();
    expect(apt.builds).toHaveLength(0);
    expect(apt.signed).toBe(0);
  });

  it("a simulation that refuses is worded for a TOKEN send, and nothing is signed", async () => {
    apt.simResult = { success: false, vm_status: "Move abort in 0x1::fungible_asset: EINSUFFICIENT_BALANCE(0x10004)", gas_used: "0", gas_unit_price: "100" };
    await expect(usdtAptosAdapter.sendTransaction(me.privateKey, THEM, "1")).rejects.toThrow(/Not enough USDT on Aptos/);
    apt.simResult = { success: false, vm_status: "INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE", gas_used: "0", gas_unit_price: "100" };
    await expect(usdtAptosAdapter.sendTransaction(me.privateKey, THEM, "1")).rejects.toThrow(/Not enough APT to pay the network fee/);
    expect(apt.signed).toBe(0);
    // APT's own wording would have said the amount was APT.
    expect(aptosFaRefusalText("INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE", "USDC")).not.toMatch(/APT for this amount/);
  });

  it("committed and failed: an error naming the hash", async () => {
    net.byHash = "failed";
    const err = await usdtAptosAdapter.sendTransaction(me.privateKey, THEM, "1").catch((e) => e);
    expect(err.message).toMatch(/committed the transaction but it failed/);
    expect(err.message).toContain(apt.HASH);
  });

  it("APT itself still sends aptos_account::transfer through the same steps", async () => {
    await expect(aptAdapter.sendTransaction(me.privateKey, THEM, "0.5")).resolves.toEqual({ hash: apt.HASH });
    expect(apt.builds[0].data).toEqual({ function: "0x1::aptos_account::transfer", functionArguments: [THEM, 50_000_000n] });
  });
});

describe("the Send modal's APT check", () => {
  it("a recipient with no store: the bigger fee, said before Send", async () => {
    const g = await usdtAptosAdapter.getGasBudget!(me.address, { to: THEM });
    expect(g).toMatchObject({ ticker: "APT", chainName: "Aptos", includesAmount: false, sufficient: true });
    // maxGas 1.5 x 6,000 units at 100 octas, held up front.
    expect(g.required).toBe("0.009");
    expect(g.notice).toMatch(/has never held USDT on Aptos[\s\S]*creates its USDT store/);
  });

  it("a recipient with a store: APT's minimum gas, no notice", async () => {
    net.stores.add(`${USDT_META}|${THEM}`);
    const g = await usdtAptosAdapter.getGasBudget!(me.address, { to: THEM });
    expect(g.required).toBe("0.002");
    expect(g.notice).toBeUndefined();
  });

  it("no APT: a definite no; an unreadable node: unknown", async () => {
    net.apt[ME] = "0";
    expect((await usdtAptosAdapter.getGasBudget!(me.address, { to: THEM })).sufficient).toBe(false);
    net.viewStatus = 503;
    expect((await usdcAptosAdapter.getGasBudget!(me.address, { to: THEM })).sufficient).toBeNull();
  });

  it("without a recipient: no only below the cheapest case, unknown between", async () => {
    net.apt[ME] = "500000"; // 0.005 APT: a transfer to an existing store, not a new one
    const g = await usdtAptosAdapter.getGasBudget!(me.address, {});
    expect(g.required).toBe("0.002");
    expect(g.sufficient).toBeNull();
    expect(aptosFaSendCostOctas(100n, false)).toBe(200_000n);
    expect(aptosFaSendCostOctas(100n, true)).toBe(900_000n);
  });
});

describe("history: transfers of this asset only", () => {
  const usdt = aptosFaHistoryAsset("usdt-aptos", USDT_META, 6);
  const tx = (sender: string, payload: unknown, over: Record<string, unknown> = {}) => ({
    type: "user_transaction",
    version: "7507173326",
    hash: "0x" + "5b".repeat(32),
    sender,
    success: true,
    vm_status: "Executed successfully",
    gas_used: "153",
    gas_unit_price: "100",
    timestamp: "1791298243000000",
    payload,
    ...over,
  });
  const faTransfer = (meta: string, to: string, amount: string) => ({
    function: "0x1::primary_fungible_store::transfer",
    type_arguments: ["0x1::fungible_asset::Metadata"],
    arguments: [{ inner: meta }, to, amount],
  });

  it("reads a USDT send and a USDT receipt, in the token's 6 decimals, with the gas in APT", () => {
    const sent = aptosHistoryRow(tx(ME, faTransfer(USDT_META, THEM, "12500000")), ME, 0n, usdt);
    expect(sent).toMatchObject({ chain: "usdt-aptos", direction: "out", amount: "12.5", counterparty: THEM, fee: "0.000153" });
    const got = aptosHistoryRow(tx(THEM, faTransfer(USDT_META, ME, "2000000")), ME, 0n, usdt);
    expect(got).toMatchObject({ chain: "usdt-aptos", direction: "in", amount: "2", counterparty: THEM });
    expect(got!.fee).toBeUndefined();
  });

  it("another asset's transfer is not a USDT row, and a USDT transfer is not an APT row", () => {
    expect(aptosHistoryRow(tx(ME, faTransfer(USDC_META, THEM, "1")), ME, 0n, usdt)).toBeNull();
    expect(aptosHistoryRow(tx(ME, { function: "0x1::aptos_account::transfer", arguments: [THEM, "5"] }), ME, 0n, usdt)).toBeNull();
    expect(aptosHistoryRow(tx(ME, faTransfer(USDT_META, THEM, "12500000")), ME)).toBeNull();
  });

  it("a failed USDT send is a failed row, its gas still paid", () => {
    const row = aptosHistoryRow(
      tx(ME, faTransfer(USDT_META, THEM, "5"), { success: false, vm_status: "Move abort in 0x1::fungible_asset: EINSUFFICIENT_BALANCE(0x10004)" }),
      ME,
      0n,
      usdt,
    );
    expect(row).toMatchObject({ direction: "failed", meta: { intended: "out" } });
  });
});
